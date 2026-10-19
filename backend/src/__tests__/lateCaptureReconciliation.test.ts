import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { orderService } from '../services/order.service';
import { paymentService, setPaymentProvider, SandboxPaymentProvider } from '../services/payments';
import { config } from '../config';
import { ledgerService } from '../services/ledger.service';
import { refundService } from '../services/refund.service';
import { Refund, Order, Payment, LedgerEntry } from '../models';
import { PaymentMethod, PaymentStatus, OrderStatus, UserRole, LedgerAccount, RefundStatus } from '../types';
import { makeUser, makeBusiness, makeProduct, makePricingConfig, GARZON, offsetKm } from './factories';

/**
 * Auditoría 2026-10-19 · un cobro que llega DESPUÉS de cancelar el pedido.
 *
 * El dinero entró en Wompi y el libro no lo conoce (no hay ingreso, comisión ni
 * liquidación). Lo que se comprueba aquí es lo que faltaba: qué queda pendiente y
 * por qué, que el costo de la pasarela se asiente como gasto real SOLO cuando el
 * cobro se devuelve, que no se asuma que Wompi devuelve su comisión, y que un
 * reembolso fallido o un evento repetido no dejen el pedido en un estado falso.
 */

const DEST = offsetKm(GARZON, 1);
const FEES = { gatewayOtherBps: 265, gatewayOtherFixed: 700, gatewayFeeVatBps: 1900, gatewayRefundFixed: 500 };

let provider: SandboxPaymentProvider;

async function lateCapture(extraConfig: Record<string, unknown> = {}) {
  await makePricingConfig(extraConfig);
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
  await orderService.updateStatus(order._id.toString(), OrderStatus.CANCELLED, owner._id.toString(), UserRole.BUSINESS, 'No completó el pago');

  const approved = JSON.stringify({ eventId: `evt-${order._id}`, paymentId: intent.id, status: 'approved', amount: order.finance.customerTotal });
  const deliver = (payload = approved) => paymentService.handleWebhook(payload, provider.sign(payload));
  await deliver();
  const payment = async () => (await Payment.findOne({ orderId: order._id, status: PaymentStatus.PAID }))! as any;
  return { order, intent, deliver, approved, payment, client };
}

const accountSum = async (orderId: unknown, account: LedgerAccount) =>
  (await ledgerService.accountBalance(account, { orderId: orderId as never }));

describe('Cobro tardío sobre un pedido cancelado', () => {
  let autoApprove: boolean;
  beforeEach(() => {
    provider = new SandboxPaymentProvider();
    setPaymentProvider(provider);
    autoApprove = config.payments.sandbox.autoApprove;
    config.payments.sandbox.autoApprove = false;
  });
  afterEach(() => { config.payments.sandbox.autoApprove = autoApprove; vi.restoreAllMocks(); });

  it('al llegar: queda retenido con el importe pendiente, el motivo y la conciliación; el libro y el pedido no se mueven', async () => {
    const t = await lateCapture(FEES);
    const p = await t.payment();

    expect(p.metadata?.requiresReview).toBe(true);
    expect(p.metadata?.lateCapture).toMatchObject({
      state: 'pending_refund', pendingAmount: t.order.finance.customerTotal, reconciliation: 'pending',
    });
    expect(p.metadata?.lateCapture.reason).toMatch(/cancelado/);
    expect(p.metadata?.lateCapture.gatewayFee.total).toBeGreaterThan(0);

    // Nada se reconoce: ni ingreso, ni gasto de pasarela todavía, ni pedido pagado.
    expect(await LedgerEntry.countDocuments({ orderId: t.order._id, account: LedgerAccount.PAYMENT_PROCESSING_EXPENSE })).toBe(0);
    expect(await LedgerEntry.countDocuments({ orderId: t.order._id, account: LedgerAccount.CUSTOMER_PAYMENT, direction: 'debit' })).toBe(0);
    const order = (await Order.findById(t.order._id))!;
    expect(order.status).toBe(OrderStatus.CANCELLED);
    expect(order.paymentStatus).not.toBe(PaymentStatus.PAID);
  });

  it('el mismo evento entregado dos veces y un «declinado» fuera de orden no cambian nada', async () => {
    const t = await lateCapture(FEES);
    const before = JSON.stringify((await t.payment()).metadata?.lateCapture);

    await t.deliver(); // duplicado exacto
    const declined = JSON.stringify({ eventId: `evt-late-declined-${t.order._id}`, paymentId: t.intent.id, status: 'declined', amount: t.order.finance.customerTotal });
    await t.deliver(declined); // llega tarde y fuera de orden

    expect(await Payment.countDocuments({ orderId: t.order._id, status: PaymentStatus.PAID })).toBe(1);
    expect(JSON.stringify((await t.payment()).metadata?.lateCapture)).toBe(before);
    expect(await LedgerEntry.countDocuments({ orderId: t.order._id, account: LedgerAccount.PAYMENT_PROCESSING_EXPENSE })).toBe(0);
  });

  it('al devolverlo: se asienta como gasto de ZIPP la comisión + el costo de la anulación (sin asumir que Wompi devuelve la comisión) y se cierra la revisión', async () => {
    const t = await lateCapture(FEES);
    const fee = (await t.payment()).metadata!.lateCapture.gatewayFee.total as number;
    const opCost = 500 + Math.round(500 * 0.19);

    const refund = await refundService.issue({ orderId: t.order._id.toString(), reason: 'cobro tardío', requestedBy: String(t.client._id) });
    expect(refund.status).toBe(RefundStatus.COMPLETED);

    const p = await t.payment();
    expect(p.metadata?.lateCapture).toMatchObject({
      state: 'refunded', pendingAmount: 0, reconciliation: 'estimated',
      gatewayCost: { fee, feeReturned: 0, operationCost: opCost, booked: fee + opCost, feeRefundPolicyDefined: false },
    });
    expect(p.metadata?.reviewResolvedAt).toBeTruthy(); // sale de la bandeja de incidentes

    const expense = await accountSum(t.order._id, LedgerAccount.PAYMENT_PROCESSING_EXPENSE);
    expect(expense.balance).toBe(fee + opCost);
    expect((await accountSum(t.order._id, LedgerAccount.GATEWAY_WITHHELD)).balance).toBe(-(fee + opCost));
    expect(await ledgerService.isBalanced({ orderId: t.order._id })).toBe(true);
    // Sigue sin haber ingreso, comisión ni deuda con el comercio.
    for (const a of [LedgerAccount.COMMISSION_REVENUE, LedgerAccount.MERCHANT_PAYABLE, LedgerAccount.DRIVER_PAYABLE]) {
      expect((await accountSum(t.order._id, a)).balance).toBe(0);
    }
    expect((await Order.findById(t.order._id))!.paymentStatus).toBe(PaymentStatus.REFUNDED);
  });

  it('si el contrato define que Wompi devuelve su comisión, solo se asienta el costo de la anulación', async () => {
    const t = await lateCapture({ ...FEES, gatewayFeeRefundBps: 10_000 });
    const fee = (await t.payment()).metadata!.lateCapture.gatewayFee.total as number;
    await refundService.issue({ orderId: t.order._id.toString(), reason: 'cobro tardío' });
    const p = await t.payment();
    expect(p.metadata?.lateCapture.gatewayCost).toMatchObject({ fee, feeReturned: fee, booked: 595, feeRefundPolicyDefined: true });
    expect((await accountSum(t.order._id, LedgerAccount.PAYMENT_PROCESSING_EXPENSE)).balance).toBe(595);
  });

  it('con las tarifas sin configurar no se inventa ningún costo: nada se asienta y queda «unconfigured»', async () => {
    const t = await lateCapture({});
    await refundService.issue({ orderId: t.order._id.toString(), reason: 'cobro tardío' });
    expect((await t.payment()).metadata?.lateCapture).toMatchObject({ state: 'refunded', reconciliation: 'unconfigured', gatewayCost: { booked: 0 } });
    expect(await LedgerEntry.countDocuments({ orderId: t.order._id, account: LedgerAccount.PAYMENT_PROCESSING_EXPENSE })).toBe(0);
  });

  it('la pasarela rechaza el reembolso: el importe sigue pendiente con su motivo, no se asienta nada y el reintento funciona', async () => {
    const t = await lateCapture(FEES);
    vi.spyOn(provider, 'refund').mockRejectedValueOnce(new Error('Wompi: transacción ya liquidada'));

    await expect(refundService.issue({ orderId: t.order._id.toString(), reason: 'cobro tardío', idempotencyKey: 'late-1' }))
      .rejects.toMatchObject({ statusCode: 502 });

    const failed = await t.payment();
    expect(failed.metadata?.requiresReview).toBe(true);
    expect(failed.metadata?.reviewResolvedAt).toBeUndefined();
    expect(failed.metadata?.lateCapture).toMatchObject({
      state: 'refund_failed', pendingAmount: t.order.finance.customerTotal, reconciliation: 'pending_manual',
    });
    expect(failed.metadata?.lateCapture.lastError).toMatch(/liquidada/);
    expect(await LedgerEntry.countDocuments({ orderId: t.order._id, account: LedgerAccount.PAYMENT_PROCESSING_EXPENSE })).toBe(0);
    expect((await Order.findById(t.order._id))!.paymentStatus).not.toBe(PaymentStatus.REFUNDED);
    expect(await Refund.countDocuments({ orderId: t.order._id, status: RefundStatus.FAILED })).toBe(1);

    // Reintento (otra clave: la FAILED con la clave anterior se devuelve tal cual).
    const retry = await refundService.issue({ orderId: t.order._id.toString(), reason: 'cobro tardío', idempotencyKey: 'late-2' });
    expect(retry.status).toBe(RefundStatus.COMPLETED);
    expect((await t.payment()).metadata?.lateCapture.state).toBe('refunded');
  });

  it('doble solicitud o reintento: un solo reembolso y un solo asiento de costo', async () => {
    const t = await lateCapture(FEES);
    const results = await Promise.allSettled([
      refundService.issue({ orderId: t.order._id.toString(), reason: 'A', idempotencyKey: 'x1' }),
      refundService.issue({ orderId: t.order._id.toString(), reason: 'B', idempotencyKey: 'x2' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    await expect(refundService.issue({ orderId: t.order._id.toString(), reason: 'C' })).rejects.toMatchObject({ statusCode: 409 });
    expect(await Refund.countDocuments({ orderId: t.order._id, status: RefundStatus.COMPLETED })).toBe(1);
    expect(await LedgerEntry.countDocuments({ orderId: t.order._id, account: LedgerAccount.PAYMENT_PROCESSING_EXPENSE })).toBe(1);
  });

  it('devuelto por fuera (dashboard de Wompi): mismo tratamiento, marcado como externo', async () => {
    const t = await lateCapture(FEES);
    const admin = await makeUser({ role: UserRole.ADMIN });
    await refundService.issueExternal({
      orderId: t.order._id.toString(), amount: t.order.finance.customerTotal, reason: 'devuelto en Wompi',
      externalReference: 'WMP-1', requestedBy: admin._id.toString(),
    });
    const p = await t.payment();
    expect(p.metadata?.lateCapture).toMatchObject({ state: 'refunded_external', reconciliation: 'estimated' });
    expect(p.metadata?.reviewResolvedBy).toBe(String(admin._id));
  });

  it('cerrarlo a mano no lo da por conciliado', async () => {
    const t = await lateCapture(FEES);
    const admin = await makeUser({ role: UserRole.ADMIN });
    await paymentService.resolveReview({ paymentId: String((await t.payment())._id), adminId: String(admin._id), note: 'Devuelto por fuera, pendiente de extracto' });
    expect((await t.payment()).metadata?.lateCapture).toMatchObject({ state: 'resolved_manually', reconciliation: 'manual_pending' });
  });
});
