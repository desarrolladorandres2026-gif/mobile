// SONDA TEMPORAL DE CEREBRO — se borra tras ejecutarla. No forma parte de ZIPP.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { orderService } from '../services/order.service';
import { paymentService, setPaymentProvider, SandboxPaymentProvider } from '../services/payments';
import { config } from '../config';
import { ledgerService } from '../services/ledger.service';
import { refundService } from '../services/refund.service';
import { Payment, Payout, Refund, Order } from '../models';
import { PaymentMethod, PaymentStatus, OrderStatus, UserRole, LedgerAccount } from '../types';
import { makeUser, makeBusiness, makeProduct, makePricingConfig, GARZON, offsetKm } from './factories';

const DEST = offsetKm(GARZON, 1);

async function scenario() {
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
  return { client, owner, business, order };
}
const initiateFor = (order: any, client: any) =>
  paymentService.initiate({ orderId: order._id.toString(), userId: client._id.toString(), amount: order.finance.customerTotal, description: 'x', customer: { name: 'C', phone: '3101234567' } });

const net = async (orderId: any) => {
  const out: Record<string, number> = {};
  for (const a of [LedgerAccount.MERCHANT_PAYABLE, LedgerAccount.COMMISSION_REVENUE, LedgerAccount.DRIVER_PAYABLE, LedgerAccount.REFUND, LedgerAccount.CUSTOMER_PAYMENT, LedgerAccount.RECEIVABLE]) {
    out[a] = (await ledgerService.accountBalance(a, { orderId })).balance;
  }
  return out;
};

describe('SONDA', () => {
  let provider: SandboxPaymentProvider;
  beforeEach(() => { provider = new SandboxPaymentProvider(); setPaymentProvider(provider); });

  it('H1: cancelar impago, cobro tardío y reembolsar por el panel ¿revierte dos veces?', async () => {
    const auto = config.payments.sandbox.autoApprove;
    config.payments.sandbox.autoApprove = false;
    try {
      const { client, owner, order } = await scenario();
      const { intent } = await initiateFor(order, client);
      await orderService.updateStatus(order._id.toString(), OrderStatus.CANCELLED, owner._id.toString(), UserRole.BUSINESS, 'El cliente no completó el pago');
      const afterCancel = await net(order._id);
      const payload = JSON.stringify({ eventId: 'evt-t', paymentId: intent.id, status: 'approved', amount: order.finance.customerTotal });
      await paymentService.handleWebhook(payload, provider.sign(payload));
      const afterLate = await net(order._id);
      let issueError: string | null = null;
      let refund: any = null;
      try { refund = await refundService.issue({ orderId: order._id.toString(), reason: 'cobro tardío', kind: undefined }); } catch (e: any) { issueError = e.message; }
      const afterRefund = await net(order._id);
      const refundRows = await Refund.countDocuments({ orderId: order._id });
      console.log('H1 JSON', JSON.stringify({ afterCancel, afterLate, afterRefund, issueError, refundStatus: refund?.status, refundRows, payoutsReversed: (await Payout.find({ orderId: order._id })).map((p) => ({ b: p.beneficiary, a: p.amount, r: p.reversedAmount, s: p.status })), balanced: await ledgerService.isBalanced({ orderId: order._id }) }));
      expect(true).toBe(true);
    } finally { config.payments.sandbox.autoApprove = auto; }
  });

  it('H2: el reembolso llama a la pasarela y luego falla el asiento → ¿queda PENDING y bloqueado?', async () => {
    const { client, order } = await scenario();
    await initiateFor(order, client); // sandbox aprueba al crear
    const paid = await Payment.findOne({ orderId: order._id });
    expect(paid!.status).toBe(PaymentStatus.PAID);
    const spy = vi.spyOn(ledgerService, 'recordReversal').mockRejectedValueOnce(new Error('caída de Mongo simulada'));
    let first: string | null = null;
    try { await refundService.issue({ orderId: order._id.toString(), reason: 'prueba', idempotencyKey: 'k1' }); } catch (e: any) { first = e.message; }
    spy.mockRestore();
    const row = await Refund.findOne({ orderId: order._id });
    let retry: string | null = null;
    try { await refundService.issue({ orderId: order._id.toString(), reason: 'prueba', idempotencyKey: 'k1' }); } catch (e: any) { retry = `${e.code ?? ''} ${e.message}`; }
    let retryNewKey: string | null = null;
    try { await refundService.issue({ orderId: order._id.toString(), reason: 'prueba2', idempotencyKey: 'k2' }); } catch (e: any) { retryNewKey = `${e.code ?? ''} ${e.message}`; }
    const o = await Order.findById(order._id);
    console.log('H2 JSON', JSON.stringify({ first, refundStatus: row?.status, refundTx: row?.transactionId, retry, retryNewKey, orderPayment: o!.paymentStatus }));
    expect(true).toBe(true);
  });
});
