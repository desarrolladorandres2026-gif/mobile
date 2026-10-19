import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { Types } from 'mongoose';
import { payoutService } from '../services/payout.service';
import { refundService, allocateRefund, driverCancellationPay, netFinance } from '../services/refund.service';
import { orderService } from '../services/order.service';
import { ledgerService } from '../services/ledger.service';
import { paymentService, setPaymentProvider, SandboxPaymentProvider } from '../services/payments';
import { Payout, Order, Refund } from '../models';
import { Permission } from '../security/rbac';
import {
  PayoutBeneficiary, PayoutStatus, PaymentMethod, OrderStatus, UserRole, RefundKind, RefundCause,
  LedgerAccount, CancelledBy, SettlementPaymentMethod,
} from '../types';
import {
  makeUser, makeBusiness, makeProduct, makeDriver, makePricingConfig, makeStaff, authHeader,
  offsetKm, GARZON, runDelivery, pickUpOrder,
} from './factories';

/**
 * M-013 — el reembolso al cliente no es el pago del domiciliario.
 *
 * Antes, un reembolso TOTAL de un pedido ya entregado le quitaba al domiciliario
 * su pago si aún no estaba en una liquidación, y se lo dejaba (a costa de ZIPP)
 * si ya lo estaba: el mismo reembolso trataba distinto al domiciliario según el
 * día en que se emitiera. Ahora:
 *
 *  · entregado + reembolso total → conserva TODO su pago, siempre; lo asume ZIPP;
 *  · posible responsabilidad suya → igual, y queda en revisión de una persona;
 *  · reembolso parcial → nunca lo toca;
 *  · cancelación antes de entregar → según hasta dónde llegó y la configuración.
 *
 * Con el domiciliario a $4.300 de base y comisión de 10 %.
 */

const DESTINATION = offsetKm(GARZON, 1);
const RECEIPT = 'https://example.com/comprobante.jpg';

afterEach(() => setPaymentProvider(new SandboxPaymentProvider()));

async function world(config: Record<string, unknown> = {}) {
  setPaymentProvider(new SandboxPaymentProvider());
  await makePricingConfig({ driverBaseFee: 4300, driverMinFee: 4300, deliveryMarginFixed: 500, serviceFeeFixed: 1000, ...config });
  const client = await makeUser();
  const owner = await makeUser({ role: UserRole.BUSINESS });
  const business = await makeBusiness(owner._id, { commissionRateBps: 1000 });
  const product = await makeProduct(business._id, { price: 30000 });
  const driverUser = await makeUser({ role: UserRole.DRIVER });
  const driver = await makeDriver(driverUser._id, { currentFund: 50000 });
  const admin = await makeUser({ role: UserRole.ADMIN, isFinanceAdmin: true });

  const placeAndPay = async (method: PaymentMethod = PaymentMethod.ONLINE) => {
    const order = await orderService.create({
      clientId: client._id.toString(),
      businessId: business._id.toString(),
      items: [{ productId: product._id.toString(), quantity: 1 }],
      paymentMethod: method,
      deliveryAddress: 'Cra 10 #5-23',
      deliveryLatitude: DESTINATION.lat,
      deliveryLongitude: DESTINATION.lng,
      ...(method === PaymentMethod.CASH_ON_DELIVERY ? { cashPayment: { needsChange: false } } : {}),
    } as never);
    if (method === PaymentMethod.ONLINE) {
      await paymentService.initiate({
        orderId: order._id.toString(),
        userId: client._id.toString(),
        amount: order.finance.customerTotal,
        description: 'Prueba',
        customer: { name: 'Cliente', phone: '3101234567' },
      });
    }
    for (const s of [OrderStatus.ACCEPTED, OrderStatus.PREPARING, OrderStatus.READY]) {
      await orderService.updateStatus(order._id.toString(), s, owner._id.toString(), UserRole.BUSINESS);
    }
    await orderService.assignDriver(order._id.toString(), driver._id.toString());
    return order;
  };

  const delivered = async () => {
    const order = await placeAndPay();
    await runDelivery(order._id.toString(), driverUser);
    return (await Order.findById(order._id))!;
  };

  return { client, owner, business, driver, driverUser, admin, placeAndPay, delivered };
}

const bal = async (account: LedgerAccount, orderId: Types.ObjectId) =>
  (await ledgerService.accountBalance(account, { orderId })).balance;

describe('Pedido entregado y reembolsado en total', () => {
  it('antes de liquidar: el domiciliario conserva su pago, ZIPP lo asume y el libro cuadra', async () => {
    const w = await world();
    const order = await w.delivered();
    const driverPayout = order.finance.driverPayout;

    const refund = await refundService.issue({
      orderId: order._id.toString(), reason: 'Producto en mal estado', kind: RefundKind.FULL, cause: RefundCause.MERCHANT,
    });

    // Al cliente se le devuelve todo.
    expect(refund.amount).toBe(order.finance.customerTotal);
    expect(refund.allocation.fromDriverPayout).toBe(0);
    expect(refund.allocation.driverRetained).toBe(driverPayout);
    expect(refund.cause).toBe(RefundCause.MERCHANT);
    expect(refund.driverPay).toMatchObject({ policy: 'kept', retained: driverPayout, costBearer: 'platform' });
    expect(refund.driverPay?.review ?? null).toBeNull();

    // Su payout no se tocó y sigue siendo liquidable.
    const payout = (await Payout.findOne({ orderId: order._id, beneficiary: PayoutBeneficiary.DRIVER }))!;
    expect(payout.reversedAmount).toBe(0);
    expect(payout.status).not.toBe(PayoutStatus.REVERSED);

    // Libro: la deuda con el domiciliario sigue ahí y su costo es gasto de ZIPP.
    expect(await bal(LedgerAccount.DRIVER_PAYABLE, order._id)).toBe(-driverPayout);
    expect(await bal(LedgerAccount.DRIVER_FEE_ABSORBED_EXPENSE, order._id)).toBe(driverPayout);
    expect(await ledgerService.isBalanced({ orderId: order._id })).toBe(true);
  });

  it('antes y después de liquidar el domiciliario termina con exactamente lo mismo', async () => {
    // Antes de liquidar.
    const a = await world();
    const early = await a.delivered();
    await refundService.issue({ orderId: early._id.toString(), reason: 'Reclamo del cliente', kind: RefundKind.FULL });
    await payoutService.release(early._id);
    const settledEarly = await payoutService.settle({
      beneficiary: PayoutBeneficiary.DRIVER, driverId: a.driver._id.toString(), createdBy: a.admin._id.toString(),
    });

    // Después de liquidar.
    const b = await world();
    const late = await b.delivered();
    await payoutService.release(late._id);
    const settledLate = await payoutService.settle({
      beneficiary: PayoutBeneficiary.DRIVER, driverId: b.driver._id.toString(), createdBy: b.admin._id.toString(),
    });
    await payoutService.registerPayment({
      settlementId: String(settledLate.settlement!._id), method: SettlementPaymentMethod.BANK_TRANSFER,
      reference: 'T-DRV', receiptUrl: RECEIPT, paidBy: b.admin._id.toString(),
    });
    await refundService.issue({ orderId: late._id.toString(), reason: 'Reclamo del cliente', kind: RefundKind.FULL });

    expect(settledEarly.settlement!.netAmount).toBe(early.finance.driverPayout);
    expect(settledLate.settlement!.netAmount).toBe(late.finance.driverPayout);
    expect(settledEarly.settlement!.netAmount).toBe(settledLate.settlement!.netAmount);
  });

  it('la causa del domiciliario no le retira el pago: lo conserva y el caso queda en revisión', async () => {
    const w = await world();
    const order = await w.delivered();
    const refund = await refundService.issue({
      orderId: order._id.toString(), reason: 'El pedido llegó volcado', kind: RefundKind.FULL, cause: RefundCause.DRIVER,
    });
    expect(refund.driverPay?.policy).toBe('kept');
    expect(refund.driverPay?.review).toMatchObject({ status: 'pending' });
    expect(await bal(LedgerAccount.DRIVER_PAYABLE, order._id)).toBe(-order.finance.driverPayout);
    expect(await ledgerService.isBalanced({ orderId: order._id })).toBe(true);

    const queue = await refundService.listAll({ driverReview: 'pending' });
    expect(queue.items.map((i) => i._id)).toEqual([String(refund._id)]);
  });

  it('el contracargo lo ordena la pasarela, no el domiciliario: lo conserva', async () => {
    const w = await world();
    const order = await w.delivered();
    const refund = await refundService.recordChargeback({ orderId: order._id.toString(), reference: 'CB-1' });
    expect(refund.cause).toBe(RefundCause.GATEWAY);
    expect(refund.driverPay).toMatchObject({ policy: 'kept', costBearer: 'platform' });
    expect(refund.driverPay?.review ?? null).toBeNull();
  });

  it('un reembolso parcial nunca toca al domiciliario', async () => {
    const w = await world();
    const order = await w.delivered();
    const refund = await refundService.issue({ orderId: order._id.toString(), amount: 5000, reason: 'Falta un producto' });
    expect(refund.allocation.fromDriverPayout).toBe(0);
    expect(refund.allocation.driverRetained ?? 0).toBe(0);
    expect(refund.driverPay?.policy).toBe('none');
    expect(await ledgerService.isBalanced({ orderId: order._id })).toBe(true);
  });

  it('dos reembolsos totales no existen: el segundo se rechaza y el pago se conserva una sola vez', async () => {
    const w = await world();
    const order = await w.delivered();
    await refundService.issue({ orderId: order._id.toString(), reason: 'Reclamo', kind: RefundKind.FULL });
    await expect(refundService.issue({ orderId: order._id.toString(), reason: 'Otra vez', kind: RefundKind.FULL }))
      .rejects.toMatchObject({ statusCode: 409 });
    expect(await bal(LedgerAccount.DRIVER_FEE_ABSORBED_EXPENSE, order._id)).toBe(order.finance.driverPayout);
    expect(await ledgerService.isBalanced({ orderId: order._id })).toBe(true);
    expect((await Order.findById(order._id))!.paymentStatus).toBe('refunded');
  });

  it('el efectivo por rendir no cambia: lo conservado no cuenta como parte viva del pedido', () => {
    const finance = { customerTotal: 40000, businessPayout: 27000, driverPayout: 4300, merchantCommission: 3000, customerServiceFee: 1000, deliveryMargin: 500, taxPayable: 0, platformPromotionExpense: 0 } as never;
    const full = allocateRefund(finance, 40000, RefundKind.FULL, undefined, 'all');
    const net = netFinance(finance, full, 40000);
    expect(net.driverPayout).toBe(0);
    expect(net.cashToRemit).toBe(0);
  });
});

describe('Revisar el pago del domiciliario', () => {
  const resolve = async (staff: any, refundId: string, body: Record<string, unknown>) =>
    request(app).patch(`/api/v1/payments/refunds/${refundId}/driver-review`).set(await authHeader(staff)).send(body);

  it('confirmar o escalar deja constancia y se decide una sola vez; no mueve dinero', async () => {
    const w = await world();
    const order = await w.delivered();
    const refund = await refundService.issue({ orderId: order._id.toString(), reason: 'Llegó volcado', kind: RefundKind.FULL, cause: RefundCause.DRIVER });
    const finance = await makeStaff({ roleSlug: 'super_admin' });

    const before = await ledgerService.accountBalance(LedgerAccount.DRIVER_FEE_ABSORBED_EXPENSE, { orderId: order._id });
    const res = await resolve(finance, String(refund._id), { decision: 'keep', note: 'La evidencia muestra que no fue su culpa.' });
    expect(res.status).toBe(200);
    expect(res.body.data.driverPay.review).toMatchObject({ status: 'kept', note: 'La evidencia muestra que no fue su culpa.' });
    expect(String(res.body.data.driverPay.review.decidedBy)).toBe(String(finance._id));
    expect(await ledgerService.accountBalance(LedgerAccount.DRIVER_FEE_ABSORBED_EXPENSE, { orderId: order._id })).toEqual(before);

    expect((await resolve(finance, String(refund._id), { decision: 'escalate', note: 'Intento de cambiarla después.' })).status).toBe(409);
  });

  it('exige motivo y permiso de reembolsos', async () => {
    const w = await world();
    const order = await w.delivered();
    const refund = await refundService.issue({ orderId: order._id.toString(), reason: 'Llegó volcado', kind: RefundKind.FULL, cause: RefundCause.DRIVER });
    const finance = await makeStaff({ roleSlug: 'super_admin' });
    expect((await resolve(finance, String(refund._id), { decision: 'keep', note: 'ok' })).status).toBe(400);
    expect((await resolve(w.owner, String(refund._id), { decision: 'keep', note: 'Soy el comercio, me autorizo.' })).status).toBe(403);
    // Con permiso de ver reembolsos, pero no de crearlos, tampoco.
    const viewer = await makeStaff({ roleSlug: 'soporte', permissions: [Permission.REFUNDS_VIEW] });
    expect((await resolve(viewer, String(refund._id), { decision: 'keep', note: 'Solo puedo ver, no decidir.' })).status).toBe(403);
    expect((await Refund.findById(refund._id))!.driverPay?.review?.status).toBe('pending');
  });

  it('el reembolso por HTTP acepta la causa y la deja en la auditoría', async () => {
    const w = await world();
    const order = await w.delivered();
    const finance = await makeStaff({ roleSlug: 'super_admin' });
    const res = await request(app).post(`/api/v1/payments/orders/${order._id}/refund`).set(await authHeader(finance))
      .send({ reason: 'El producto llegó mal', cause: 'merchant' });
    expect(res.status).toBe(201);
    expect(res.body.data.cause).toBe('merchant');
    expect(res.body.data.driverPay.policy).toBe('kept');
    const bad = await request(app).post(`/api/v1/payments/orders/${order._id}/refund`).set(await authHeader(finance))
      .send({ reason: 'x'.repeat(10), cause: 'cualquiera' });
    expect(bad.status).toBe(400);
  });
});

describe('Cancelar antes de entregar', () => {
  const cancel = (orderId: string, by: CancelledBy, admin: any) =>
    orderService.updateStatus(
      orderId, OrderStatus.CANCELLED, admin._id.toString(), UserRole.ADMIN, 'Cancelado', {}, 'other' as never,
      { cancelledBy: by, canRefund: true }
    );

  /** En camino: el único estado después de recoger desde el que `VALID_TRANSITIONS` permite cancelar. */
  const onTheWay = async (orderId: string, driverUser: any) => {
    await pickUpOrder(orderId, driverUser);
    await orderService.updateStatus(orderId, OrderStatus.ON_WAY, driverUser._id.toString(), UserRole.DRIVER);
  };

  it('con la configuración de fábrica (0 %) todo sigue como siempre: el domiciliario no conserva nada', async () => {
    const w = await world();
    const order = await w.placeAndPay();
    await onTheWay(order._id.toString(), w.driverUser);
    await cancel(order._id.toString(), CancelledBy.CLIENT, w.admin);

    const payout = (await Payout.findOne({ orderId: order._id, beneficiary: PayoutBeneficiary.DRIVER }))!;
    expect(payout.status).toBe(PayoutStatus.REVERSED);
    expect((await Order.findById(order._id))!.driverCancelPay ?? null).toBeNull();
    expect(await ledgerService.isBalanced({ orderId: order._id })).toBe(true);
  });

  it('ya recogido: conserva el porcentaje configurado de su tarifa, lo asume ZIPP, y al cliente se le devuelve todo', async () => {
    const w = await world({ driverCancelPayAssignedBps: 2000, driverCancelPayPickedUpBps: 5000 });
    const order = await w.placeAndPay();
    await onTheWay(order._id.toString(), w.driverUser);
    await cancel(order._id.toString(), CancelledBy.CLIENT, w.admin);

    const after = (await Order.findById(order._id))!;
    const expected = Math.floor(after.finance.driverDeliveryPayout * 0.5);
    expect(after.driverCancelPay).toMatchObject({ amount: expected, tier: 'picked_up', bps: 5000, previousStatus: 'on_way' });

    const refunds = await Refund.find({ orderId: order._id });
    expect(refunds).toHaveLength(1);
    expect(refunds[0].amount).toBe(after.finance.customerTotal);
    expect(refunds[0]).toMatchObject({ cause: RefundCause.CUSTOMER });
    expect(refunds[0].driverPay).toMatchObject({ policy: 'partial', retained: expected, costBearer: 'platform' });

    const payout = (await Payout.findOne({ orderId: order._id, beneficiary: PayoutBeneficiary.DRIVER }))!;
    expect(payout.amount - payout.reversedAmount).toBe(expected);
    expect(payout.status).toBe(PayoutStatus.PAYABLE);
    expect(await bal(LedgerAccount.DRIVER_PAYABLE, order._id)).toBe(-expected);
    expect(await bal(LedgerAccount.DRIVER_FEE_ABSORBED_EXPENSE, order._id)).toBe(expected);
    expect(await ledgerService.isBalanced({ orderId: order._id })).toBe(true);
  });

  it('lo que el domiciliario conserva es dato interno de ZIPP: ni el cliente ni el comercio lo reciben', async () => {
    const w = await world({ driverCancelPayAssignedBps: 5000, driverCancelPayPickedUpBps: 5000 });
    const order = await w.placeAndPay();
    await cancel(order._id.toString(), CancelledBy.BUSINESS, w.admin);
    expect((await Order.findById(order._id))!.driverCancelPay).toBeTruthy();

    const asClient = await request(app).get(`/api/v1/orders/${order._id}`).set(await authHeader(w.client));
    const asOwner = await request(app).get(`/api/v1/orders/${order._id}`).set(await authHeader(w.owner));
    const asAdmin = await request(app).get(`/api/v1/orders/${order._id}`).set(await authHeader(await makeStaff({ roleSlug: 'super_admin' })));
    expect(asClient.status).toBe(200);
    expect(asOwner.status).toBe(200);
    expect(JSON.stringify(asClient.body)).not.toContain('driverCancelPay');
    expect(JSON.stringify(asOwner.body)).not.toContain('driverCancelPay');
    expect(asAdmin.body.data.driverCancelPay).toMatchObject({ tier: 'assigned' });
  });

  it('asignado y sin recoger: usa el otro porcentaje', async () => {
    const w = await world({ driverCancelPayAssignedBps: 2000, driverCancelPayPickedUpBps: 5000 });
    const order = await w.placeAndPay();
    await cancel(order._id.toString(), CancelledBy.BUSINESS, w.admin);
    const after = (await Order.findById(order._id))!;
    expect(after.driverCancelPay).toMatchObject({ tier: 'assigned', bps: 2000, amount: Math.floor(after.finance.driverDeliveryPayout * 0.2) });
    expect(await ledgerService.isBalanced({ orderId: order._id })).toBe(true);
  });

  it('si cancela el propio domiciliario no conserva nada, aunque haya porcentaje', async () => {
    const w = await world({ driverCancelPayAssignedBps: 2000, driverCancelPayPickedUpBps: 5000 });
    const order = await w.placeAndPay();
    await onTheWay(order._id.toString(), w.driverUser);
    await cancel(order._id.toString(), CancelledBy.DRIVER, w.admin);
    expect((await Order.findById(order._id))!.driverCancelPay ?? null).toBeNull();
    expect((await Payout.findOne({ orderId: order._id, beneficiary: PayoutBeneficiary.DRIVER }))!.status).toBe(PayoutStatus.REVERSED);
  });

  it('también en efectivo (nada cobrado): lo que conserva lo asume ZIPP y el libro cuadra', async () => {
    const w = await world({ cashOnDeliveryEnabled: true, cashOnDeliveryMaxAmount: 1_000_000, driverCancelPayAssignedBps: 5000 });
    const order = await w.placeAndPay(PaymentMethod.CASH_ON_DELIVERY);
    await cancel(order._id.toString(), CancelledBy.BUSINESS, w.admin);

    const after = (await Order.findById(order._id))!;
    const expected = Math.floor(after.finance.driverDeliveryPayout * 0.5);
    expect(after.driverCancelPay).toMatchObject({ amount: expected, tier: 'assigned' });
    const payout = (await Payout.findOne({ orderId: order._id, beneficiary: PayoutBeneficiary.DRIVER }))!;
    expect(payout.amount - payout.reversedAmount).toBe(expected);
    expect(payout.status).toBe(PayoutStatus.PAYABLE);
    expect(await bal(LedgerAccount.DRIVER_FEE_ABSORBED_EXPENSE, order._id)).toBe(expected);
    expect(await ledgerService.isBalanced({ orderId: order._id })).toBe(true);
  });

  it('sin domiciliario asignado no hay a quién pagar', () => {
    const order = { driverId: null, finance: { driverDeliveryPayout: 4300 }, cancelledBy: CancelledBy.CLIENT } as never;
    expect(driverCancellationPay(order, OrderStatus.READY, { driverCancelPayAssignedBps: 5000 })).toBeNull();
  });

  it('nunca supera su tarifa aunque el porcentaje sea del 100 %', () => {
    const order = { driverId: new Types.ObjectId(), finance: { driverDeliveryPayout: 4300 }, cancelledBy: CancelledBy.CLIENT } as never;
    expect(driverCancellationPay(order, OrderStatus.ON_WAY, { driverCancelPayPickedUpBps: 10_000 })?.amount).toBe(4300);
  });
});
