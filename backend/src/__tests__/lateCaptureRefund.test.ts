import { describe, it, expect, beforeEach } from 'vitest';
import { orderService } from '../services/order.service';
import { paymentService, setPaymentProvider, SandboxPaymentProvider } from '../services/payments';
import { config } from '../config';
import { ledgerService } from '../services/ledger.service';
import { refundService } from '../services/refund.service';
import { Refund, Order, Payment } from '../models';
import { PaymentMethod, PaymentStatus, OrderStatus, UserRole, LedgerAccount } from '../types';
import { makeUser, makeBusiness, makeProduct, makePricingConfig, GARZON, offsetKm } from './factories';

/**
 * M-001 (CEREBRO, confirmado por sonda el 2026-10-16): cancelar un pedido en
 * línea sin cobrar deshace el libro sin fila `Refund`; si el cliente paga
 * después el enlace viejo y Finanzas lo reembolsa, `issue()` veía el pedido
 * entero como reembolsable y revertía el libro OTRA vez: comisión negativa,
 * comercio deudor, domiciliario deudor. Desde el 2026-10-17 ese reembolso solo
 * devuelve el cobro tardío y no toca el libro.
 */

const DEST = offsetKm(GARZON, 1);
const ACCOUNTS = [
  LedgerAccount.MERCHANT_PAYABLE, LedgerAccount.COMMISSION_REVENUE, LedgerAccount.DRIVER_PAYABLE,
  LedgerAccount.REFUND, LedgerAccount.CUSTOMER_PAYMENT, LedgerAccount.RECEIVABLE,
];

const books = async (orderId: unknown) => {
  const out: Record<string, number> = {};
  for (const a of ACCOUNTS) out[a] = (await ledgerService.accountBalance(a, { orderId: orderId as never })).balance;
  return out;
};

let provider: SandboxPaymentProvider;

async function cancelledThenPaidLate() {
  await makePricingConfig();
  const client = await makeUser();
  const owner = await makeUser({ role: UserRole.BUSINESS });
  const business = await makeBusiness(owner._id, { commissionRateBps: 1000 });
  const product = await makeProduct(business._id, { price: 30000 });
  const order = await orderService.create({
    clientId: client._id.toString(), businessId: business._id.toString(),
    items: [{ productId: product._id.toString(), quantity: 1 }], paymentMethod: PaymentMethod.ONLINE,
    deliveryAddress: 'Cra 10 #5-23', deliveryLatitude: DEST.lat, deliveryLongitude: DEST.lng,
  });
  const { intent } = await paymentService.initiate({
    orderId: order._id.toString(), userId: client._id.toString(), amount: order.finance.customerTotal,
    description: 'x', customer: { name: 'C', phone: '3101234567' },
  });
  await orderService.updateStatus(order._id.toString(), OrderStatus.CANCELLED, owner._id.toString(), UserRole.BUSINESS, 'El cliente no completó el pago');
  const afterCancel = await books(order._id);
  const payload = JSON.stringify({ eventId: `evt-${order._id}`, paymentId: intent.id, status: 'approved', amount: order.finance.customerTotal });
  await paymentService.handleWebhook(payload, provider.sign(payload));
  return { order, afterCancel };
}

describe('Reembolso de un cobro que llegó después de cancelar (M-001)', () => {
  let autoApprove: boolean;
  beforeEach(() => {
    provider = new SandboxPaymentProvider();
    setPaymentProvider(provider);
    autoApprove = config.payments.sandbox.autoApprove;
    config.payments.sandbox.autoApprove = false;
    return () => { config.payments.sandbox.autoApprove = autoApprove; };
  });

  it('devuelve el cobro y deja el libro exactamente como lo dejó la cancelación', async () => {
    const { order, afterCancel } = await cancelledThenPaidLate();
    const late = await Payment.findOne({ orderId: order._id, status: PaymentStatus.PAID }).lean();
    expect(late?.metadata?.requiresReview).toBe(true);

    const refund = await refundService.issue({ orderId: order._id.toString(), reason: 'cobro tardío' });

    expect(refund.status).toBe('completed');
    expect(refund.amount).toBe(order.finance.customerTotal);
    expect(Object.values(refund.allocation).every((v) => v === 0)).toBe(true);
    expect(await books(order._id)).toEqual(afterCancel);
    expect(await ledgerService.isBalanced({ orderId: order._id })).toBe(true);
    expect((await Order.findById(order._id))!.paymentStatus).toBe(PaymentStatus.REFUNDED);
  });

  it('un segundo reembolso del mismo cobro no pasa', async () => {
    const { order } = await cancelledThenPaidLate();
    await refundService.issue({ orderId: order._id.toString(), reason: 'cobro tardío' });
    await expect(refundService.issue({ orderId: order._id.toString(), reason: 'otra vez' })).rejects.toMatchObject({ statusCode: 409 });
    expect(await Refund.countDocuments({ orderId: order._id })).toBe(1);
  });

  it('se devuelve completo: un parcial sobre un pedido que ya no existe no tiene sentido', async () => {
    const { order } = await cancelledThenPaidLate();
    await expect(refundService.issue({ orderId: order._id.toString(), reason: 'parcial', amount: 1000 }))
      .rejects.toMatchObject({ statusCode: 422, code: 'LATE_CAPTURE_FULL_ONLY' });
  });

  it('la vía externa (reembolso hecho en el dashboard de Wompi) tampoco revierte otra vez', async () => {
    const { order, afterCancel } = await cancelledThenPaidLate();
    const admin = await makeUser({ role: UserRole.ADMIN });
    const refund = await refundService.issueExternal({
      orderId: order._id.toString(), amount: order.finance.customerTotal, reason: 'devuelto en Wompi',
      externalReference: 'WMP-778899', requestedBy: admin._id.toString(),
    });
    expect(refund.status).toBe('completed');
    expect(await books(order._id)).toEqual(afterCancel);
  });

  it('cancelado sin cobro y sin cobro tardío: no hay nada que reembolsar', async () => {
    await makePricingConfig();
    const client = await makeUser();
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id);
    const product = await makeProduct(business._id, { price: 20000 });
    const order = await orderService.create({
      clientId: client._id.toString(), businessId: business._id.toString(),
      items: [{ productId: product._id.toString(), quantity: 1 }], paymentMethod: PaymentMethod.ONLINE,
      deliveryAddress: 'Cra 10 #5-23', deliveryLatitude: DEST.lat, deliveryLongitude: DEST.lng,
    });
    await orderService.updateStatus(order._id.toString(), OrderStatus.CANCELLED, owner._id.toString(), UserRole.BUSINESS, 'No pagó');
    await expect(refundService.issue({ orderId: order._id.toString(), reason: 'x' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'ORDER_ALREADY_UNWOUND' });
  });
});
