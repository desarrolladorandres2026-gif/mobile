import { describe, it, expect, afterEach, vi } from 'vitest';
import { Types } from 'mongoose';
import { refundService, allocateRefund, netFinance } from '../services/refund.service';
import { orderService } from '../services/order.service';
import { ledgerService } from '../services/ledger.service';
import { paymentService, setPaymentProvider, SandboxPaymentProvider } from '../services/payments';
import { Payout, Order, Refund, LedgerEntry } from '../models';
import {
  PayoutBeneficiary, PaymentMethod, OrderStatus, UserRole, RefundKind, RefundStatus, LedgerAccount, PaymentStatus,
} from '../types';
import {
  makeUser, makeBusiness, makeProduct, makeDriver, makePricingConfig, offsetKm, GARZON, runDelivery, pickUpOrder,
} from './factories';

/**
 * Auditoría 2026-10-19 · reembolsos acumulados.
 *
 * Qué significa «total» en el modelo: un reembolso que AGOTA lo que todavía se
 * puede devolver (`customerTotal − Σ reembolsos completados`). Se decide por
 * importes, no por la etiqueta de la operación anterior ni por la de la
 * petición. El dinero que sale hacia el cliente (`amount`) es una cosa; de qué
 * cuenta sale (comercio, comisión, fee, margen, impuesto, gasto promocional) y
 * qué pasa con el pago del domiciliario son otras, y quedan en `allocation` /
 * `driverPay` de cada fila.
 *
 * Con el domiciliario a $4.300, comisión del 10 %, fee de servicio $1.000.
 */

const DESTINATION = offsetKm(GARZON, 1);

afterEach(() => { vi.restoreAllMocks(); setPaymentProvider(new SandboxPaymentProvider()); });

async function world() {
  setPaymentProvider(new SandboxPaymentProvider());
  await makePricingConfig({ driverBaseFee: 4300, driverMinFee: 4300, deliveryMarginFixed: 500, serviceFeeFixed: 1000 });
  const client = await makeUser();
  const owner = await makeUser({ role: UserRole.BUSINESS });
  const business = await makeBusiness(owner._id, { commissionRateBps: 1000 });
  const product = await makeProduct(business._id, { price: 30000 });
  const driverUser = await makeUser({ role: UserRole.DRIVER });
  const driver = await makeDriver(driverUser._id, { currentFund: 50000 });

  const placeAndPay = async () => {
    const order = await orderService.create({
      clientId: client._id.toString(),
      businessId: business._id.toString(),
      items: [{ productId: product._id.toString(), quantity: 1 }],
      paymentMethod: PaymentMethod.ONLINE,
      deliveryAddress: 'Cra 10 #5-23',
      deliveryLatitude: DESTINATION.lat,
      deliveryLongitude: DESTINATION.lng,
    } as never);
    await paymentService.initiate({
      orderId: order._id.toString(), userId: client._id.toString(), amount: order.finance.customerTotal,
      description: 'Prueba', customer: { name: 'Cliente', phone: '3101234567' },
    });
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
  const pickedUp = async () => {
    const order = await placeAndPay();
    await pickUpOrder(order._id.toString(), driverUser);
    return (await Order.findById(order._id))!;
  };
  return { client, owner, business, driver, driverUser, delivered, pickedUp };
}

const bal = async (account: LedgerAccount, orderId: Types.ObjectId) =>
  (await ledgerService.accountBalance(account, { orderId })).balance;

const completed = (orderId: Types.ObjectId) => Refund.find({ orderId, status: RefundStatus.COMPLETED }).sort({ createdAt: 1 });
const sum = (rows: Array<{ amount: number }>) => rows.reduce((s, r) => s + r.amount, 0);

describe('Reembolso total posterior a uno parcial', () => {
  it('pedido entregado: el resto, pedido con monto explícito y etiqueta «parcial», cierra el pedido y el domiciliario conserva TODO su pago', async () => {
    const w = await world();
    const order = await w.delivered();
    const { customerTotal, driverPayout, businessPayout } = order.finance;

    const first = await refundService.issue({ orderId: order._id.toString(), amount: 8000, reason: 'Falta un producto', kind: RefundKind.PARTIAL });
    expect(first.kind).toBe(RefundKind.PARTIAL);
    expect(first.allocation.fromDriverPayout).toBe(0);

    // Antes: este «resto» se trataba como otro parcial, no podía tocar el pago del
    // domiciliario y reventaba con «usa un reembolso total».
    const rest = await refundService.issue({
      orderId: order._id.toString(), amount: customerTotal - 8000, reason: 'Reclamo del cliente', kind: RefundKind.PARTIAL,
    });

    // El nombre lo decide el importe: agotó el saldo, así que cerró el pedido.
    expect(rest.kind).toBe(RefundKind.FULL);
    expect(rest.allocation.fromDriverPayout).toBe(0);
    expect(rest.allocation.driverRetained).toBe(driverPayout);
    expect(rest.driverPay).toMatchObject({ policy: 'kept', retained: driverPayout, costBearer: 'platform' });

    // Al cliente se le devolvió exactamente lo pagado, ni un peso de más.
    const rows = await completed(order._id);
    expect(sum(rows)).toBe(customerTotal);

    // Comercio: lo que se le devolvió en los dos reembolsos suma todo su neto.
    expect(sum(rows.map((r) => ({ amount: r.allocation.fromMerchantPayout })))).toBe(businessPayout);

    // Domiciliario: su payout intacto y la deuda con él sigue en el libro.
    const payout = (await Payout.findOne({ orderId: order._id, beneficiary: PayoutBeneficiary.DRIVER }))!;
    expect(payout.reversedAmount).toBe(0);
    expect(await bal(LedgerAccount.DRIVER_PAYABLE, order._id)).toBe(-driverPayout);
    expect(await bal(LedgerAccount.DRIVER_FEE_ABSORBED_EXPENSE, order._id)).toBe(driverPayout);

    expect(await ledgerService.isBalanced({ orderId: order._id })).toBe(true);
    expect((await Order.findById(order._id))!.paymentStatus).toBe(PaymentStatus.REFUNDED);
  });

  it('sin indicar monto (el «resto») da exactamente el mismo reparto que con monto explícito', async () => {
    const a = await world();
    const o1 = await a.delivered();
    await refundService.issue({ orderId: o1._id.toString(), amount: 8000, reason: 'Falta un producto' });
    const viaDefault = await refundService.issue({ orderId: o1._id.toString(), reason: 'Resto' });

    const b = await world();
    const o2 = await b.delivered();
    await refundService.issue({ orderId: o2._id.toString(), amount: 8000, reason: 'Falta un producto' });
    const viaExplicit = await refundService.issue({ orderId: o2._id.toString(), amount: o2.finance.customerTotal - 8000, reason: 'Resto', kind: RefundKind.PARTIAL });

    const strip = (r: any) => ({ kind: r.kind, amount: r.amount, allocation: { ...r.allocation.toObject?.() ?? r.allocation } });
    expect(strip(viaDefault)).toEqual(strip(viaExplicit));
  });

  it('pedido NO entregado: el cierre sí revierte lo que queda del pago del domiciliario (la regla de cancelación es otra)', async () => {
    const w = await world();
    const order = await w.pickedUp();
    const { customerTotal, driverPayout } = order.finance;

    await refundService.issue({ orderId: order._id.toString(), amount: 5000, reason: 'Parcial' });
    const rest = await refundService.issue({ orderId: order._id.toString(), amount: customerTotal - 5000, reason: 'Resto', kind: RefundKind.PARTIAL });

    expect(rest.kind).toBe(RefundKind.FULL);
    expect(rest.allocation.fromDriverPayout).toBe(driverPayout);
    expect(rest.allocation.driverRetained ?? 0).toBe(0);
    const payout = (await Payout.findOne({ orderId: order._id, beneficiary: PayoutBeneficiary.DRIVER }))!;
    expect(payout.reversedAmount).toBe(driverPayout);
    expect(await ledgerService.isBalanced({ orderId: order._id })).toBe(true);
  });

  it('total directo (sin parcial previo): igual que siempre', async () => {
    const w = await world();
    const order = await w.delivered();
    const refund = await refundService.issue({ orderId: order._id.toString(), reason: 'Reclamo', kind: RefundKind.FULL });
    expect(refund.kind).toBe(RefundKind.FULL);
    expect(refund.amount).toBe(order.finance.customerTotal);
    expect(refund.allocation.driverRetained).toBe(order.finance.driverPayout);
    expect(await ledgerService.isBalanced({ orderId: order._id })).toBe(true);
  });

  it('un «total» pedido por kind=FULL con un importe menor al saldo es un parcial: no toca al domiciliario ni desbalancea el libro', async () => {
    const w = await world();
    const order = await w.delivered();
    const refund = await refundService.issue({ orderId: order._id.toString(), amount: 6000, reason: 'Mal rotulado', kind: RefundKind.FULL });
    expect(refund.kind).toBe(RefundKind.PARTIAL);
    expect(refund.allocation.fromDriverPayout).toBe(0);
    expect(refund.allocation.driverRetained ?? 0).toBe(0);
    expect(await ledgerService.isBalanced({ orderId: order._id })).toBe(true);
  });

  it('el externo (Wompi no hace parciales por API) y el contracargo parcial siguen la misma regla de cierre', async () => {
    const w = await world();
    const order = await w.delivered();
    const { customerTotal, driverPayout } = order.finance;

    await refundService.issueExternal({ orderId: order._id.toString(), amount: 7000, reason: 'Parcial por dashboard', externalReference: 'W-1', requestedBy: String(w.client._id) });
    const rest = await refundService.issueExternal({ orderId: order._id.toString(), amount: customerTotal - 7000, reason: 'Resto por dashboard', externalReference: 'W-2', requestedBy: String(w.client._id) });
    expect(rest.kind).toBe(RefundKind.EXTERNAL);
    expect(rest.allocation.driverRetained).toBe(driverPayout);
    expect(sum(await completed(order._id))).toBe(customerTotal);
    expect(await ledgerService.isBalanced({ orderId: order._id })).toBe(true);

    const w2 = await world();
    const o2 = await w2.delivered();
    await refundService.recordChargeback({ orderId: o2._id.toString(), amount: 4000, reference: 'CB-A' });
    const cb = await refundService.recordChargeback({ orderId: o2._id.toString(), amount: o2.finance.customerTotal - 4000, reference: 'CB-B' });
    expect(cb.kind).toBe(RefundKind.CHARGEBACK);
    expect(cb.allocation.driverRetained).toBe(o2.finance.driverPayout);
    expect(await ledgerService.isBalanced({ orderId: o2._id })).toBe(true);
  });
});

describe('Duplicados, reintentos y solicitudes simultáneas', () => {
  it('reintento con la misma clave: devuelve el mismo reembolso y el libro se mueve una sola vez', async () => {
    const w = await world();
    const order = await w.delivered();
    const a = await refundService.issue({ orderId: order._id.toString(), amount: 8000, reason: 'Parcial', idempotencyKey: 'k-1' });
    const entriesAfterFirst = await LedgerEntry.countDocuments({ orderId: order._id });
    const b = await refundService.issue({ orderId: order._id.toString(), amount: 8000, reason: 'Parcial', idempotencyKey: 'k-1' });
    expect(String(b._id)).toBe(String(a._id));
    expect(await LedgerEntry.countDocuments({ orderId: order._id })).toBe(entriesAfterFirst);
    expect(await Refund.countDocuments({ orderId: order._id })).toBe(1);
  });

  it('dos cierres simultáneos del mismo saldo: uno solo se completa, no se devuelve dos veces', async () => {
    const w = await world();
    const order = await w.delivered();
    const results = await Promise.allSettled([
      refundService.issue({ orderId: order._id.toString(), reason: 'Cierre A', idempotencyKey: 'a' }),
      refundService.issue({ orderId: order._id.toString(), reason: 'Cierre B', idempotencyKey: 'b' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(sum(await completed(order._id))).toBe(order.finance.customerTotal);
    expect(await ledgerService.isBalanced({ orderId: order._id })).toBe(true);
    // Nada queda colgado en PENDING.
    expect(await Refund.countDocuments({ orderId: order._id, status: RefundStatus.PENDING })).toBe(0);
  });

  it('lectura vieja del saldo: otro reembolso terminó entre el cálculo y el cerrojo → se recalcula y se rechaza, no devuelve dos veces', async () => {
    const w = await world();
    const order = await w.delivered();
    await refundService.issue({ orderId: order._id.toString(), reason: 'Primero', idempotencyKey: 'first' });

    // La segunda solicitud «vio» el pedido sin reembolsos (lectura vieja); bajo el cerrojo lee la verdad.
    const real = refundService.refundedTotal.bind(refundService);
    let calls = 0;
    vi.spyOn(refundService, 'refundedTotal').mockImplementation(async (id) => (calls++ === 0 ? 0 : real(id)));

    await expect(refundService.issue({ orderId: order._id.toString(), reason: 'Segundo', idempotencyKey: 'second' }))
      .rejects.toMatchObject({ statusCode: 409 });

    expect(sum(await completed(order._id))).toBe(order.finance.customerTotal);
    expect(await Refund.countDocuments({ orderId: order._id })).toBe(1); // el cerrojo descartado no deja fila
    expect(await ledgerService.isBalanced({ orderId: order._id })).toBe(true);
  });

  it('lectura vieja que sigue siendo válida pero con otro reparto: la fila se corrige antes de tocar el libro', async () => {
    const w = await world();
    const order = await w.delivered();
    const { customerTotal } = order.finance;
    await refundService.issue({ orderId: order._id.toString(), amount: 8000, reason: 'Parcial' });

    // Cálculo previo «viejo»: sin parciales (saldo = total) → pediría un cierre por el total completo, que ya no cabe.
    const real = refundService.refundedTotal.bind(refundService);
    let calls = 0;
    vi.spyOn(refundService, 'refundedTotal').mockImplementation(async (id) => (calls++ === 0 ? 0 : real(id)));
    await expect(refundService.issue({ orderId: order._id.toString(), amount: customerTotal, reason: 'Total viejo' }))
      .rejects.toMatchObject({ statusCode: 422 });
    expect(sum(await completed(order._id))).toBe(8000);
    expect(await ledgerService.isBalanced({ orderId: order._id })).toBe(true);
  });

  it('un reembolso mayor al saldo se rechaza y no deja rastro', async () => {
    const w = await world();
    const order = await w.delivered();
    await refundService.issue({ orderId: order._id.toString(), amount: 8000, reason: 'Parcial' });
    await expect(refundService.issue({ orderId: order._id.toString(), amount: order.finance.customerTotal, reason: 'De más' }))
      .rejects.toMatchObject({ statusCode: 422 });
    expect(await Refund.countDocuments({ orderId: order._id })).toBe(1);
  });
});

describe('allocateRefund con el saldo reembolsable (puro)', () => {
  const finance = {
    customerTotal: 35800, businessPayout: 27000, driverPayout: 4300, merchantCommission: 3000,
    customerServiceFee: 1000, deliveryMargin: 500, taxPayable: 0, platformPromotionExpense: 0,
  } as never;

  it('cada cuenta y el domiciliario cuadran con el importe: lo devuelto + lo conservado = el pedido', () => {
    const first = allocateRefund(finance, 8000, RefundKind.PARTIAL, undefined, 'all', 35800);
    const rest = allocateRefund(finance, 27800, RefundKind.PARTIAL, first, 'all', 27800);

    expect(rest.fromDriverPayout).toBe(0);
    expect(rest.driverRetained).toBe(4300);
    const parts = (a: typeof first) => a.fromMerchantPayout + a.fromCommission + a.fromServiceFee + a.fromDeliveryMargin + a.fromTax + a.fromPlatform + a.fromDriverPayout + (a.driverRetained ?? 0);
    expect(parts(first) + parts(rest)).toBe(35800);
    // Nada queda vivo salvo lo que el domiciliario conserva.
    const net = netFinance(finance, {
      fromMerchantPayout: first.fromMerchantPayout + rest.fromMerchantPayout,
      fromDriverPayout: first.fromDriverPayout + rest.fromDriverPayout,
      fromCommission: first.fromCommission + rest.fromCommission,
      fromServiceFee: first.fromServiceFee + rest.fromServiceFee,
      fromDeliveryMargin: first.fromDeliveryMargin + rest.fromDeliveryMargin,
      fromTax: first.fromTax + rest.fromTax,
      fromPlatform: first.fromPlatform + rest.fromPlatform,
      driverRetained: (first.driverRetained ?? 0) + (rest.driverRetained ?? 0),
    }, 35800);
    expect(net).toMatchObject({ customerTotal: 0, businessPayout: 0, driverPayout: 0, merchantCommission: 0, cashToRemit: 0 });
  });

  it('el defecto original: sin el saldo, el «resto» tras un parcial se trata como parcial y no puede cuadrar', () => {
    const first = allocateRefund(finance, 8000, RefundKind.PARTIAL, undefined, 'all');
    expect(() => allocateRefund(finance, 27800, RefundKind.PARTIAL, first, 'all')).toThrow(/Usa un reembolso total/);
  });

  it('sin el saldo (llamada heredada) sigue valiendo el comportamiento de siempre', () => {
    const legacy = allocateRefund(finance, 35800, RefundKind.FULL, undefined, 'all');
    expect(legacy.driverRetained).toBe(4300);
    const partial = allocateRefund(finance, 5000, RefundKind.PARTIAL);
    expect(partial.fromDriverPayout).toBe(0);
  });
});
