import { describe, it, expect } from 'vitest';
import { orderService } from '../services/order.service';
import { ledgerService } from '../services/ledger.service';
import { refundService, netFinance } from '../services/refund.service';
import { cashHandover } from '../services/cashHandover.service';
import { summaryFor } from '../services/businessDailySummary.service';
import { paymentService } from '../services/payments';
import { Order, Payout, Payment, Driver, CashReconciliation, LedgerEntry } from '../models';
import {
  PaymentMethod,
  PaymentStatus,
  OrderStatus,
  UserRole,
  RefundKind,
  LedgerAccount,
  CancellationReason,
  PayoutStatus,
} from '../types';
import {
  GARZON,
  offsetKm,
  makeUser,
  makeBusiness,
  makeProduct,
  makeDriver,
  makePricingConfig,
  runDelivery,
} from './factories';

/**
 * Reembolso PARCIAL en un pedido en efectivo antes de cobrar (P0).
 *
 * `order.finance` es el techo inmutable; lo vivo es `finance − Σ allocation`
 * (`refundService.netOf`). Antes, cancelar o entregar después de un parcial
 * leía `finance` en bruto: el total cuadraba (`isBalanced` daba true) pero
 * RECEIVABLE quedaba en negativo y MERCHANT_PAYABLE en positivo.
 *
 * Pedido de la fixture: productos 32.000, comisión 10 % (3.200), fee de
 * servicio 1.000, domicilio 4.500 (repartidor 4.000, margen 500).
 *   total 37.500 · pago al comercio 28.800 · efectivo por rendir 4.700.
 * Parcial de 12.000, reparto a prorrata (pool 33.500): comercio 10.317,
 * comisión 1.146, fee 358, margen 179.
 *   neto: total 25.500 · comercio 18.483 · efectivo por rendir 3.017.
 */

const DEST = offsetKm(GARZON, 1);
const FUND = 100_000;

async function setup() {
  await makePricingConfig({
    cashOnDeliveryEnabled: true,
    cashOnDeliveryMaxAmount: 1_000_000,
    serviceFeeFixed: 1000,
    deliveryMarginFixed: 500,
  });
  const client = await makeUser({ role: UserRole.CLIENT });
  const owner = await makeUser({ role: UserRole.BUSINESS });
  const business = await makeBusiness(owner._id, { commissionRateBps: 1000 });
  const a = await makeProduct(business._id, { price: 20000 });
  const b = await makeProduct(business._id, { price: 12000 });
  const driverUser = await makeUser({ role: UserRole.DRIVER });
  const driver = await makeDriver(driverUser._id, { currentFund: FUND });
  const order = await orderService.create({
    clientId: client._id.toString(),
    businessId: business._id.toString(),
    items: [
      { productId: a._id.toString(), quantity: 1 },
      { productId: b._id.toString(), quantity: 1 },
    ],
    paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
    cashPayment: { needsChange: false } as any,
    deliveryAddress: 'Cra 10 #5-23',
    deliveryLatitude: DEST.lat,
    deliveryLongitude: DEST.lng,
  } as any);
  return { owner, business, order, driver, driverUser, id: order._id.toString() };
}

const ACCOUNTS = [
  LedgerAccount.RECEIVABLE,
  LedgerAccount.MERCHANT_PAYABLE,
  LedgerAccount.COMMISSION_REVENUE,
  LedgerAccount.SERVICE_FEE_REVENUE,
  LedgerAccount.DELIVERY_MARGIN_REVENUE,
  LedgerAccount.DRIVER_PAYABLE,
  LedgerAccount.CASH_IN_TRANSIT,
  LedgerAccount.TAX_PAYABLE,
] as const;

/** Saldo (débito − crédito) por cuenta, solo de este pedido. */
async function bal(orderId: unknown) {
  const out = {} as Record<string, number>;
  for (const acc of ACCOUNTS) {
    out[acc] = (await ledgerService.accountBalance(acc, { orderId })).balance;
  }
  return out;
}

const fundOf = async (driverId: unknown) => (await Driver.findById(driverId))!.currentFund;

async function toReady(setupResult: Awaited<ReturnType<typeof setup>>) {
  const { owner, id, driver } = setupResult;
  for (const s of [OrderStatus.ACCEPTED, OrderStatus.PREPARING, OrderStatus.READY]) {
    await orderService.updateStatus(id, s, owner._id.toString(), UserRole.BUSINESS);
  }
  await orderService.assignDriver(id, driver._id.toString());
}

const partial = (id: string, amount: number) =>
  refundService.issue({ orderId: id, amount, reason: 'faltante', kind: RefundKind.PARTIAL });

const cancelOrder = (id: string, ownerId: string) =>
  orderService.updateStatus(
    id,
    OrderStatus.CANCELLED,
    ownerId,
    UserRole.BUSINESS,
    'sin stock',
    {},
    CancellationReason.BUSINESS_OUT_OF_STOCK
  );

describe('netFinance (pura)', () => {
  const finance: any = {
    customerTotal: 37500,
    businessPayout: 28800,
    driverPayout: 4000,
    merchantCommission: 3200,
    customerServiceFee: 1000,
    deliveryMargin: 500,
    taxPayable: 0,
    platformPromotionExpense: 0,
  };
  const zero = {
    fromMerchantPayout: 0, fromDriverPayout: 0, fromCommission: 0,
    fromDeliveryMargin: 0, fromServiceFee: 0, fromTax: 0, fromPlatform: 0,
  };

  it('sin reembolsos devuelve el snapshot tal cual', () => {
    const n = netFinance(finance, zero, 0);
    expect(n.customerTotal).toBe(37500);
    expect(n.businessPayout).toBe(28800);
    expect(n.cashToRemit).toBe(4700);
    expect(n.platformGrossRevenue).toBe(4700);
  });

  it('resta lo reembolsado cuenta por cuenta y mantiene la identidad', () => {
    const n = netFinance(
      finance,
      { ...zero, fromMerchantPayout: 10317, fromCommission: 1146, fromServiceFee: 358, fromDeliveryMargin: 179 },
      12000
    );
    expect(n.customerTotal).toBe(25500);
    expect(n.businessPayout).toBe(18483);
    expect(n.cashToRemit).toBe(3017);
    expect(n.cashToRemit).toBe(n.customerTotal - n.businessPayout - n.driverPayout);
  });
});

describe('reembolso parcial en efectivo antes de cobrar', () => {
  it('a) parcial + CANCELACIÓN: RECEIVABLE y MERCHANT_PAYABLE quedan en 0 y el fondo intacto', async () => {
    const s = await setup();
    await toReady(s);
    expect(await fundOf(s.driver._id)).toBe(FUND - 28800);

    const r = await partial(s.id, 12000);
    expect(r.allocation.fromMerchantPayout).toBe(10317);
    // El cobro a la puerta ya es el neto.
    expect((await Payment.findOne({ orderId: s.order._id }))!.amount).toBe(25500);

    const afterPartial = await bal(s.order._id);
    expect(afterPartial[LedgerAccount.RECEIVABLE]).toBe(25500);
    expect(afterPartial[LedgerAccount.MERCHANT_PAYABLE]).toBe(-18483);

    await cancelOrder(s.id, s.owner._id.toString());

    const b = await bal(s.order._id);
    for (const acc of ACCOUNTS) expect(b[acc], acc).toBe(0);
    expect(await ledgerService.isBalanced({ orderId: s.order._id })).toBe(true);

    // Payout del comercio: 10.317 (parcial) + 18.483 (cancelación) = todo.
    const payout = (await Payout.findOne({ orderId: s.order._id, beneficiary: 'business' }))!;
    expect(payout.reversedAmount).toBe(payout.amount);
    expect(payout.status).toBe(PayoutStatus.REVERSED);

    // Fondo simétrico: reserva bruta, devolución bruta.
    expect(await fundOf(s.driver._id)).toBe(FUND);
    const order = (await Order.findById(s.id))!;
    expect(order.paymentStatus).toBe(PaymentStatus.FAILED);
  });

  it('b) parcial + ENTREGA: cuentas en neto, efectivo por rendir neto, cobro neto y fondo de vuelta', async () => {
    const s = await setup();
    await toReady(s);
    await partial(s.id, 12000);
    expect(await fundOf(s.driver._id)).toBe(FUND - 28800);

    await runDelivery(s.id, s.driverUser);

    const b = await bal(s.order._id);
    expect(b[LedgerAccount.RECEIVABLE]).toBe(0);
    expect(b[LedgerAccount.MERCHANT_PAYABLE]).toBe(0);
    expect(b[LedgerAccount.DRIVER_PAYABLE]).toBe(0);
    expect(b[LedgerAccount.CASH_IN_TRANSIT]).toBe(3017);
    // Lo que ZIPP conserva: comisión + fee + margen netos (crédito = saldo negativo).
    expect(b[LedgerAccount.COMMISSION_REVENUE]).toBe(-(3200 - 1146));
    expect(b[LedgerAccount.SERVICE_FEE_REVENUE]).toBe(-(1000 - 358));
    expect(b[LedgerAccount.DELIVERY_MARGIN_REVENUE]).toBe(-(500 - 179));
    expect(await ledgerService.isBalanced({ orderId: s.order._id })).toBe(true);

    const rec = (await CashReconciliation.findOne({ orderId: s.order._id }))!;
    expect(rec.amount).toBe(3017);
    expect(rec.amount).toBe(b[LedgerAccount.CASH_IN_TRANSIT]);

    const pay = (await Payment.findOne({ orderId: s.order._id }))!;
    expect(pay.amount).toBe(25500);

    // El cobro a la puerta se puede confirmar con el neto.
    const confirmed = await paymentService.confirmCashCollection({
      orderId: s.id,
      driverId: s.driver._id.toString(),
      actorUserId: s.driverUser._id.toString(),
      received: true,
    });
    expect(confirmed.payment.status).toBe(PaymentStatus.PAID);

    expect(await fundOf(s.driver._id)).toBe(FUND);
    const payout = (await Payout.findOne({ orderId: s.order._id, beneficiary: 'business' }))!;
    expect(payout.status).toBe(PayoutStatus.SETTLED);
    expect(payout.amount - payout.reversedAmount).toBe(18483);
  });

  it('c) sin reembolso: nada cambia respecto a hoy (regresión)', async () => {
    const s = await setup();
    await toReady(s);
    await runDelivery(s.id, s.driverUser);

    const b = await bal(s.order._id);
    expect(b[LedgerAccount.RECEIVABLE]).toBe(0);
    expect(b[LedgerAccount.MERCHANT_PAYABLE]).toBe(0);
    expect(b[LedgerAccount.DRIVER_PAYABLE]).toBe(0);
    expect(b[LedgerAccount.CASH_IN_TRANSIT]).toBe(4700);
    expect((await CashReconciliation.findOne({ orderId: s.order._id }))!.amount).toBe(4700);
    expect((await Payment.findOne({ orderId: s.order._id }))!.amount).toBe(37500);
    expect(await fundOf(s.driver._id)).toBe(FUND);
    expect(await ledgerService.isBalanced({ orderId: s.order._id })).toBe(true);

    const net = await refundService.netOf((await Order.findById(s.id))!);
    expect(net.customerTotal).toBe(37500);
    expect(net.businessPayout).toBe(28800);
    expect(net.cashToRemit).toBe(4700);
  });

  it('c2) cancelar sin reembolso previo sigue deshaciendo todo (regresión)', async () => {
    const s = await setup();
    await toReady(s);
    await cancelOrder(s.id, s.owner._id.toString());
    const b = await bal(s.order._id);
    for (const acc of ACCOUNTS) expect(b[acc], acc).toBe(0);
    expect(await fundOf(s.driver._id)).toBe(FUND);
  });

  it('d) cashHandover: el efectivo esperado del comercio es el neto si el parcial fue antes de recoger', async () => {
    const s = await setup();
    await toReady(s);
    await partial(s.id, 12000);
    await runDelivery(s.id, s.driverUser);

    const from = new Date(Date.now() - 3600_000);
    const to = new Date(Date.now() + 3600_000);
    const h = await cashHandover(s.business._id, from, to);
    expect(h.cashOrders).toBe(1);
    expect(h.expectedCash).toBe(18483);

    // El resumen diario del comercio también lo ve neto.
    const summary = await summaryFor(s.business._id.toString());
    expect(summary.today.businessPayout).toBe(18483);
    expect(summary.today.merchantCommission).toBe(3200 - 1146);
    expect(summary.today.payCashAmount).toBe(25500);
    expect(summary.today.cashHandedOver).toBe(18483);
  });

  it('d2) cashHandover: un reembolso POSTERIOR a la recogida no saca billetes del cajón', async () => {
    const s = await setup();
    await toReady(s);
    await runDelivery(s.id, s.driverUser);
    await partial(s.id, 12000);

    const h = await cashHandover(
      s.business._id,
      new Date(Date.now() - 3600_000),
      new Date(Date.now() + 3600_000)
    );
    expect(h.expectedCash).toBe(28800);
  });

  it('d3) cashHandover sin reembolsos: igual que antes', async () => {
    const s = await setup();
    await toReady(s);
    await runDelivery(s.id, s.driverUser);
    const h = await cashHandover(
      s.business._id,
      new Date(Date.now() - 3600_000),
      new Date(Date.now() + 3600_000)
    );
    expect(h.expectedCash).toBe(28800);
  });

  it('e) un parcial que reembolsa TODO el total + ENTREGA: sin negativos ni doble reversión', async () => {
    const s = await setup();
    await toReady(s);
    await partial(s.id, 37500);

    const order = (await Order.findById(s.id))!;
    expect(order.paymentStatus).toBe(PaymentStatus.REFUNDED);
    const net = await refundService.netOf(order);
    expect(net.customerTotal).toBe(0);
    expect(net.businessPayout).toBe(0);
    expect(net.cashToRemit).toBe(0);

    await runDelivery(s.id, s.driverUser);

    const b = await bal(s.order._id);
    for (const acc of ACCOUNTS) expect(b[acc], acc).toBe(0);
    expect(await ledgerService.isBalanced({ orderId: s.order._id })).toBe(true);
    // Ningún asiento de entrega: no había nada que asentar.
    expect(await LedgerEntry.countDocuments({ orderId: s.order._id, event: 'order_delivered' })).toBe(0);
    expect(await fundOf(s.driver._id)).toBe(FUND);
    const pay = (await Payment.findOne({ orderId: s.order._id }))!;
    expect(pay.amount).toBe(0);
    const rec = await CashReconciliation.findOne({ orderId: s.order._id });
    expect(rec?.amount ?? 0).toBe(0);
  });

  it('e2) parcial por TODO el total + CANCELACIÓN: no revierte dos veces', async () => {
    const s = await setup();
    await toReady(s);
    await partial(s.id, 37500);
    const before = await LedgerEntry.countDocuments({ orderId: s.order._id });

    await cancelOrder(s.id, s.owner._id.toString());

    expect(await LedgerEntry.countDocuments({ orderId: s.order._id })).toBe(before);
    const b = await bal(s.order._id);
    for (const acc of ACCOUNTS) expect(b[acc], acc).toBe(0);
    expect(await fundOf(s.driver._id)).toBe(FUND);
    expect((await Order.findById(s.id))!.paymentStatus).toBe(PaymentStatus.FAILED);
  });

  it('f) dos parciales + CANCELACIÓN: revierte solo el resto', async () => {
    const s = await setup();
    await toReady(s);
    await partial(s.id, 12000);
    await partial(s.id, 5000);
    expect((await Payment.findOne({ orderId: s.order._id }))!.amount).toBe(20500);

    await cancelOrder(s.id, s.owner._id.toString());

    const b = await bal(s.order._id);
    for (const acc of ACCOUNTS) expect(b[acc], acc).toBe(0);
    expect(await fundOf(s.driver._id)).toBe(FUND);
  });
});
