import { describe, it, expect, afterEach } from 'vitest';
import { payoutService } from '../services/payout.service';
import { refundService } from '../services/refund.service';
import { orderService } from '../services/order.service';
import { ledgerService } from '../services/ledger.service';
import { paymentService, setPaymentProvider, SandboxPaymentProvider } from '../services/payments';
import { Payout, Order, Refund } from '../models';
import {
  PayoutBeneficiary, PayoutStatus, PaymentMethod, PaymentStatus, OrderStatus, UserRole, RefundKind, RefundStatus,
} from '../types';
import {
  makeUser, makeBusiness, makeProduct, makeDriver, makeSettleableBusinessId, makePricingConfig, offsetKm, GARZON,
} from './factories';

/**
 * Cancelar un pedido ya cobrado cuando la pasarela no puede anular el pago
 * (PSE, Nequi, tarjeta ya liquidada) deja el pedido CANCELLED con el dinero
 * todavía cobrado. Mientras el reembolso no conste, los payouts de ese pedido
 * no pueden ser liquidables: si no, la siguiente corrida le paga al comercio
 * un pedido cancelado y no devuelto (auditoría financiera 2026-10-09, P0).
 *
 * No cambia el reparto ni los importes: solo cuándo se pueden pagar.
 */

const DESTINATION = offsetKm(GARZON, 1);

/** Una pasarela que acepta el cobro y, mientras `cannotVoid` esté activo, no puede anular. */
class FlakyVoidProvider extends SandboxPaymentProvider {
  cannotVoid = false;
  async refund(paymentId: string, ...rest: any[]) {
    if (this.cannotVoid) throw new Error('Wompi: esta transacción no se puede anular');
    return (super.refund as any)(paymentId, ...rest);
  }
}

let gateway: FlakyVoidProvider;

afterEach(() => setPaymentProvider(new SandboxPaymentProvider()));

async function paidOrder() {
  gateway = new FlakyVoidProvider();
  setPaymentProvider(gateway);
  await makePricingConfig({ driverBaseFee: 4300, driverMinFee: 4300, deliveryMarginFixed: 500, serviceFeeFixed: 1000 });
  const client = await makeUser();
  const owner = await makeUser({ role: UserRole.BUSINESS });
  const business = await makeBusiness(owner._id, { commissionRateBps: 1000 });
  const product = await makeProduct(business._id, { price: 30000 });
  const driverUser = await makeUser({ role: UserRole.DRIVER });
  const driver = await makeDriver(driverUser._id, { currentFund: 50000 });
  const order = await orderService.create({
    clientId: client._id.toString(),
    businessId: business._id.toString(),
    items: [{ productId: product._id.toString(), quantity: 1 }],
    paymentMethod: PaymentMethod.ONLINE,
    deliveryAddress: 'Cra 10 #5-23',
    deliveryLatitude: DESTINATION.lat,
    deliveryLongitude: DESTINATION.lng,
  });
  await paymentService.initiate({
    orderId: order._id.toString(),
    userId: client._id.toString(),
    amount: order.finance.customerTotal,
    description: 'Prueba',
    customer: { name: 'Cliente', phone: '3101234567' },
  });
  return { order, owner, business, driver };
}

const cancel = (orderId: string, ownerId: string) =>
  orderService.updateStatus(orderId, OrderStatus.CANCELLED, ownerId, UserRole.BUSINESS, 'Se acabó el producto', {}, 'other' as any);

describe('Cancelar un pedido cobrado cuyo reembolso falla', () => {
  it('los payouts quedan retenidos (no liquidables) hasta que el reembolso conste', async () => {
    const { order, owner, business } = await paidOrder();
    expect((await Payout.find({ orderId: order._id })).every((p) => p.status === PayoutStatus.PAYABLE)).toBe(true);

    gateway.cannotVoid = true;
    await cancel(order._id.toString(), owner._id.toString());

    const after = (await Order.findById(order._id))!;
    expect(after.status).toBe(OrderStatus.CANCELLED);
    // El dinero sigue cobrado: la cancelación no es el reembolso.
    expect(after.paymentStatus).toBe(PaymentStatus.PAID);
    const refunds = await Refund.find({ orderId: order._id });
    expect(refunds.every((r) => r.status !== RefundStatus.COMPLETED)).toBe(true);

    const payouts = await Payout.find({ orderId: order._id });
    expect(payouts.length).toBeGreaterThan(0);
    for (const p of payouts) {
      expect(p.status, String(p.beneficiary)).toBe(PayoutStatus.ACCRUED);
      expect(p.becamePayableAt ?? null).toBeNull();
    }

    // La corrida de liquidación no ve nada que pagarle al comercio por este pedido.
    const bizId = await makeSettleableBusinessId();
    void bizId;
    const run = await payoutService.settle({
      beneficiary: PayoutBeneficiary.BUSINESS,
      businessId: business._id.toString(),
      createdBy: owner._id.toString(),
    }).catch((err: any) => ({ settlement: null, error: err }));
    expect((run as any).settlement ?? null).toBeNull();
  });

  it('al reintentar el reembolso se revierte lo retenido, sin duplicar y con el libro cuadrado', async () => {
    const { order, owner } = await paidOrder();
    gateway.cannotVoid = true;
    await cancel(order._id.toString(), owner._id.toString());

    gateway.cannotVoid = false;
    await refundService.issue({ orderId: order._id.toString(), reason: 'Reintento', kind: RefundKind.FULL });

    const payouts = await Payout.find({ orderId: order._id, isClawback: { $ne: true } });
    for (const p of payouts) expect(p.status).toBe(PayoutStatus.REVERSED);
    expect(await Payout.countDocuments({ orderId: order._id, isClawback: true })).toBe(0);
    expect(await refundService.refundedTotal(order._id)).toBe(order.finance.customerTotal);
    expect(await ledgerService.isBalanced({ orderId: order._id })).toBe(true);
  });

  it('con la pasarela que sí anula, todo sigue igual: reembolsado y payouts revertidos', async () => {
    const { order, owner } = await paidOrder();
    await cancel(order._id.toString(), owner._id.toString());

    expect((await Order.findById(order._id))!.paymentStatus).toBe(PaymentStatus.REFUNDED);
    const payouts = await Payout.find({ orderId: order._id });
    for (const p of payouts) expect(p.status).toBe(PayoutStatus.REVERSED);
    expect(await ledgerService.isBalanced({ orderId: order._id })).toBe(true);
  });
});
