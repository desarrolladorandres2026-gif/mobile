import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { Types } from 'mongoose';
import app from '../app';
import { BusinessStaff, BusinessRole, BusinessPermission, Order, ShiftClosing } from '../models';
import { OrderKind, OrderStatus, PaymentMethod, PaymentStatus, UserRole } from '../types';
import { cashHandover, roleSummaryFor } from '../services/businessRoleSummary.service';
import { businessDailySummaryService } from '../services/businessDailySummary.service';
import { shiftClosingService } from '../services/shiftClosing.service';
import type { BusinessAccess } from '../services/businessStaff.service';
import { makeUser, makeBusiness, makePricingConfig, authHeader, GARZON } from './factories';

/**
 * Efectivo esperado en el cierre de caja.
 *
 * El domiciliario le paga al comercio `finance.businessPayout` (valor del
 * producto menos comisión y descuento que financió el comercio), no el
 * subtotal. Comparar lo contado contra el subtotal daba un faltante falso por
 * pedido. Aquí se prueba la cifra correcta, quién la ve y el corte entre
 * cierres.
 */

let owner: any;
let business: any;
let client: any;
const businessId = () => business._id as Types.ObjectId;
const closings = () => `/api/v1/businesses/${business._id}/shift-closings`;
const roleSummaryUrl = () => `/api/v1/businesses/${business._id}/role-summary`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const ago = (ms: number) => new Date(Date.now() - ms);
const HOUR = 3_600_000;

/** Ventana amplia para probar `cashHandover` sin depender de la hora del día. */
const wide = () => ({ from: ago(72 * HOUR), to: new Date(Date.now() + 60_000) });

const OWNER_ACCESS: BusinessAccess = {
  role: BusinessRole.OWNER,
  permissions: [BusinessPermission.ORDERS_VIEW, BusinessPermission.SHIFT_VIEW, BusinessPermission.SHIFT_CLOSE, BusinessPermission.FINANCIAL_VIEW],
};

interface Spec {
  status?: OrderStatus;
  payout: number;
  subtotal?: number;
  commission?: number;
  merchantDiscount?: number;
  tip?: number;
  deliveryFee?: number;
  paymentMethod?: PaymentMethod | null;
  kind?: OrderKind;
  pickedUpAt?: Date | null;
  deliveredAt?: Date | null;
  createdAt?: Date;
  /** Simula un pedido anterior a `finance`: solo existe el campo plano `businessPayout`. */
  legacy?: boolean;
}

/** Un pedido contra entrega recogido hace un segundo, salvo que el caso diga otra cosa. */
async function mk(spec: Spec) {
  const status = spec.status ?? OrderStatus.DELIVERED;
  const subtotal = spec.subtotal ?? spec.payout;
  const tip = spec.tip ?? 0;
  const deliveryFee = spec.deliveryFee ?? 4000;
  const pickedUpAt = spec.pickedUpAt === undefined ? ago(1000) : spec.pickedUpAt;
  const order = await Order.create({
    orderNumber: `ZIPP-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    clientId: client._id,
    businessId: business._id,
    ...(spec.kind ? { kind: spec.kind } : {}),
    items: [],
    status,
    // `null` = pedido viejo sin `paymentMethod`: el esquema lo exige, así que se quita después.
    paymentMethod: spec.paymentMethod ?? PaymentMethod.CASH_ON_DELIVERY,
    paymentStatus: PaymentStatus.PENDING_CASH,
    deliveryAddress: 'Calle falsa 123',
    deliveryLocation: { type: 'Point', coordinates: [GARZON.lng, GARZON.lat] },
    subtotal,
    deliveryFee,
    tip,
    total: subtotal + deliveryFee + tip,
    platformCommission: spec.commission ?? 0,
    businessPayout: spec.payout,
    driverPayout: deliveryFee,
    pickedUpAt: pickedUpAt ?? undefined,
    deliveredAt: spec.deliveredAt ?? undefined,
    finance: {
      productSubtotal: subtotal,
      merchantCommission: spec.commission ?? 0,
      merchantFundedDiscount: spec.merchantDiscount ?? 0,
      tip,
      businessPayout: spec.payout,
      customerTotal: subtotal + deliveryFee + tip,
    },
  });
  const unset: Record<string, 1> = {};
  if (spec.legacy) unset.finance = 1;
  if (spec.paymentMethod === null) unset.paymentMethod = 1;
  const set: Record<string, unknown> = {};
  if (spec.createdAt) set.createdAt = spec.createdAt;
  if (Object.keys(unset).length || Object.keys(set).length) {
    await Order.collection.updateOne(
      { _id: order._id },
      { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) },
    );
  }
  return order;
}

async function member(role: BusinessRole) {
  const user = await makeUser({ role: UserRole.BUSINESS });
  await BusinessStaff.create({ businessId: business._id, userId: user._id, role });
  return user;
}

beforeEach(async () => {
  await makePricingConfig({});
  owner = await makeUser({ role: UserRole.BUSINESS });
  client = await makeUser({ role: UserRole.CLIENT });
  business = await makeBusiness(owner._id);
});

describe('cashHandover: efectivo que debe haber en caja', () => {
  it('suma lo que el domiciliario pagó al comercio, no el subtotal', async () => {
    // 20.000 de producto, 2.000 de comisión y 1.000 de descuento del comercio: el domiciliario pagó 17.000.
    await mk({ subtotal: 20000, commission: 2000, merchantDiscount: 1000, payout: 17000 });
    await mk({ subtotal: 10000, commission: 1000, payout: 9000 });

    const result = await cashHandover(businessId(), wide().from, wide().to);
    expect(result.expectedCash).toBe(26000);
    expect(result.cashOrders).toBe(2);
    expect(result.inTransit).toEqual({ count: 0, amount: 0 });
    expect(result.cancelledAfterPickup).toEqual({ count: 0, amount: 0 });
  });

  it('el envío gratis que paga el comercio reduce el esperado', async () => {
    await mk({ subtotal: 20000, commission: 2000, payout: 18000 });
    // Mismo producto, pero el comercio asumió 3.000 del domicilio gratis: paga menos.
    await mk({ subtotal: 20000, commission: 2000, merchantDiscount: 3000, payout: 15000 });

    expect((await cashHandover(businessId(), wide().from, wide().to)).expectedCash).toBe(33000);
  });

  it('propina y domicilio no entran', async () => {
    await mk({ subtotal: 20000, commission: 2000, payout: 18000, tip: 5000, deliveryFee: 6000 });

    const result = await cashHandover(businessId(), wide().from, wide().to);
    expect(result.expectedCash).toBe(18000);
  });

  it('un pedido recogido y en camino cuenta, y se informa como en camino', async () => {
    await mk({ status: OrderStatus.DELIVERED, payout: 18000 });
    await mk({ status: OrderStatus.PICKED_UP, payout: 7000 });
    await mk({ status: OrderStatus.ON_WAY, payout: 5000 });

    const result = await cashHandover(businessId(), wide().from, wide().to);
    expect(result.expectedCash).toBe(30000);
    expect(result.cashOrders).toBe(3);
    expect(result.inTransit).toEqual({ count: 2, amount: 12000 });
  });

  it('aún no recogido no cuenta', async () => {
    await mk({ status: OrderStatus.READY, payout: 18000, pickedUpAt: null });
    await mk({ status: OrderStatus.PREPARING, payout: 18000, pickedUpAt: null });
    expect((await cashHandover(businessId(), wide().from, wide().to)).expectedCash).toBe(0);
  });

  it('un programado creado ayer y recogido hoy cuenta en la ventana de hoy', async () => {
    await mk({ payout: 12000, createdAt: ago(30 * HOUR), pickedUpAt: ago(1000) });
    // Creado hoy pero recogido antes de la ventana: no.
    await mk({ payout: 9000, createdAt: ago(30 * HOUR), pickedUpAt: ago(26 * HOUR) });

    const result = await cashHandover(businessId(), ago(5 * HOUR), new Date(Date.now() + 60_000));
    expect(result.expectedCash).toBe(12000);
  });

  it('sin pickedUpAt usa deliveredAt y después createdAt', async () => {
    await mk({ payout: 4000, pickedUpAt: null, deliveredAt: ago(500), createdAt: ago(40 * HOUR) });
    await mk({ payout: 6000, pickedUpAt: null, deliveredAt: null, createdAt: ago(500) });
    await mk({ payout: 9000, pickedUpAt: null, deliveredAt: null, createdAt: ago(40 * HOUR) });

    const result = await cashHandover(businessId(), ago(5 * HOUR), new Date(Date.now() + 60_000));
    expect(result.expectedCash).toBe(10000);
  });

  it('un cancelado después de recoger se excluye y se informa aparte', async () => {
    await mk({ status: OrderStatus.DELIVERED, payout: 18000 });
    await mk({ status: OrderStatus.CANCELLED, payout: 8000 });
    // Cancelado antes de recoger: nunca hubo efectivo, ni siquiera se informa.
    await mk({ status: OrderStatus.CANCELLED, payout: 5000, pickedUpAt: null });

    const result = await cashHandover(businessId(), wide().from, wide().to);
    expect(result.expectedCash).toBe(18000);
    expect(result.cashOrders).toBe(1);
    expect(result.cancelledAfterPickup).toEqual({ count: 1, amount: 8000 });
  });

  it('un reembolso tardío no cambia el esperado', async () => {
    const order = await mk({ subtotal: 20000, commission: 2000, payout: 18000 });
    const before = await cashHandover(businessId(), wide().from, wide().to);

    await Order.updateOne({ _id: order._id }, { paymentStatus: PaymentStatus.REFUNDED });
    const after = await cashHandover(businessId(), wide().from, wide().to);

    expect(after).toEqual(before);
    expect(after.expectedCash).toBe(18000);
  });

  it('pedido anterior a finance usa businessPayout; el mandado y el pago en línea quedan fuera', async () => {
    await mk({ payout: 14000, legacy: true });
    // Sin paymentMethod: los pedidos viejos eran contra entrega.
    await mk({ payout: 3000, legacy: true, paymentMethod: null });
    await mk({ payout: 99000, paymentMethod: PaymentMethod.ONLINE });
    await mk({ payout: 88000, kind: OrderKind.ERRAND });

    const result = await cashHandover(businessId(), wide().from, wide().to);
    expect(result.expectedCash).toBe(17000);
    expect(result.cashOrders).toBe(2);
  });

  it('no mezcla pedidos de otro comercio', async () => {
    await mk({ payout: 10000 });
    const otherOwner = await makeUser({ role: UserRole.BUSINESS });
    const other = await makeBusiness(otherOwner._id);
    expect((await cashHandover(other._id as Types.ObjectId, wide().from, wide().to)).expectedCash).toBe(0);
  });
});

describe('quién ve la cifra esperada', () => {
  it('la portada del empleado sigue sin claves financieras y sin expectedCash', async () => {
    await mk({ subtotal: 20000, commission: 2000, payout: 18000 });

    const res = await request(app).get(roleSummaryUrl()).set(await authHeader(await member(BusinessRole.EMPLOYEE)));
    expect(res.status).toBe(200);
    expect(res.body.data.kind).toBe('shift');
    const text = JSON.stringify(res.body);
    for (const key of ['merchantCommission', 'businessPayout', 'merchantFundedDiscount', 'platformCommission', 'expectedCash']) {
      expect(text).not.toContain(key);
    }
  });

  it('con financial:view la portada de turno trae expectedCash', async () => {
    await mk({ payout: 18000 });
    const summary = await roleSummaryFor(OWNER_ACCESS, business._id.toString());
    expect(summary?.kind).toBe('shift');
    expect(summary && 'expectedCash' in summary ? summary.expectedCash : undefined).toBe(18000);
  });

  it('el empleado que cierra sin declarar no recibe la cifra; al declarar sí, con la diferencia', async () => {
    await mk({ subtotal: 20000, commission: 2000, payout: 18000 });
    const headers = await authHeader(await member(BusinessRole.EMPLOYEE));

    const blind = await request(app).post(closings()).set(headers).send({});
    expect(blind.status).toBe(201);
    expect(blind.body.data).toMatchObject({ declaredCash: null, expectedCash: null, difference: null });

    const declared = await request(app).post(closings()).set(headers).send({ declaredCash: 0 });
    // El primer cierre ya se llevó los 18.000; este corte nuevo no tiene nada.
    expect(declared.body.data).toMatchObject({ expectedCash: 0, declaredCash: 0, difference: 0 });

    const list = await request(app).get(closings()).set(headers);
    const byCreated = [...list.body.data].reverse();
    expect(byCreated[0]).toMatchObject({ declaredCash: null, expectedCash: null, difference: null, inTransit: null });
    expect(byCreated[1].expectedCash).toBe(0);
  });

  it('quien tiene financial:view ve la cifra aunque no declare', async () => {
    await mk({ payout: 18000 });
    const closing = await shiftClosingService.close(business._id.toString(), owner._id.toString(), OWNER_ACCESS, {});
    expect(closing).toMatchObject({ expectedCash: 18000, declaredCash: null, difference: null });
    const listed = await shiftClosingService.listForDay(business._id.toString(), closing.date, OWNER_ACCESS);
    expect(listed[0].expectedCash).toBe(18000);
    // Sin saber quién consulta, el listado aplica la regla estricta.
    const strict = await shiftClosingService.listForDay(business._id.toString(), closing.date);
    expect(strict[0].expectedCash).toBeNull();
  });

  it('declarar contra la cifra correcta cuadra; contar de menos es faltante', async () => {
    await mk({ subtotal: 20000, commission: 2000, merchantDiscount: 1000, payout: 17000 });
    const headers = await authHeader(await member(BusinessRole.EMPLOYEE));
    const res = await request(app).post(closings()).set(headers).send({ declaredCash: 16000 });
    expect(res.body.data).toMatchObject({ expectedCash: 17000, cashSales: 20000, difference: -1000 });
  });

  it('un cierre anterior a expectedCash conserva su diferencia y no inventa la cifra', async () => {
    await ShiftClosing.collection.insertOne({
      businessId: business._id,
      closedBy: owner._id,
      closedByName: 'Antiguo',
      closedByRole: BusinessRole.EMPLOYEE,
      date: '2026-01-02',
      sales: 50000,
      ordersDelivered: 2,
      ordersCancelled: 0,
      cashSales: 20000,
      onlineSales: 30000,
      declaredCash: 18000,
      difference: -2000,
      note: '',
      createdAt: new Date('2026-01-02T20:00:00Z'),
    });
    const [old] = await shiftClosingService.listForDay(business._id.toString(), '2026-01-02');
    expect(old).toMatchObject({ expectedCash: null, difference: -2000, cashSales: 20000 });
  });
});

describe('una sola cifra para portada, cierre y resumen del día', () => {
  it('dan el mismo expectedCash para la misma ventana', async () => {
    await mk({ subtotal: 20000, commission: 2000, merchantDiscount: 500, payout: 17500 });
    await mk({ status: OrderStatus.ON_WAY, payout: 6000 });
    await mk({ status: OrderStatus.CANCELLED, payout: 9000 });

    const portada = await roleSummaryFor(OWNER_ACCESS, business._id.toString());
    const resumen = await businessDailySummaryService.summaryFor(business._id.toString());
    const cierre = await shiftClosingService.close(business._id.toString(), owner._id.toString(), OWNER_ACCESS, {});

    const fromPortada = portada && 'expectedCash' in portada ? portada.expectedCash : undefined;
    expect(fromPortada).toBe(23500);
    expect(resumen.today.cashHandedOver).toBe(23500);
    expect(cierre.expectedCash).toBe(23500);
    expect(cierre.cancelledAfterPickup).toEqual({ count: 1, amount: 9000 });
    expect(cierre.inTransit).toEqual({ count: 1, amount: 6000 });
  });

  it('el resumen del día separa lo cobrado al cliente de lo que queda en caja', async () => {
    await mk({ subtotal: 20000, commission: 2000, payout: 18000, tip: 1000, deliveryFee: 4000 });
    const { today } = await businessDailySummaryService.summaryFor(business._id.toString());
    expect(today.payCashAmount).toBe(25000);
    expect(today.cashHandedOver).toBe(18000);
  });
});

describe('cortes entre cierres del mismo día', () => {
  it('el segundo cierre cubre solo desde el primero, sin contar dos veces', async () => {
    const id = business._id.toString();
    await mk({ payout: 18000 });

    const first = await shiftClosingService.close(id, owner._id.toString(), OWNER_ACCESS, { declaredCash: 18000 });
    expect(first).toMatchObject({ expectedCash: 18000, difference: 0 });

    await sleep(10);
    await mk({ payout: 7000, pickedUpAt: new Date() });
    await sleep(10);

    const second = await shiftClosingService.close(id, owner._id.toString(), OWNER_ACCESS, { declaredCash: 7000 });
    expect(second).toMatchObject({ expectedCash: 7000, difference: 0 });

    const third = await shiftClosingService.close(id, owner._id.toString(), OWNER_ACCESS, { declaredCash: 0 });
    expect(third).toMatchObject({ expectedCash: 0, difference: 0 });
  });

  it('el instante del cierre queda como createdAt y el siguiente corte arranca justo después', async () => {
    const id = business._id.toString();
    await shiftClosingService.close(id, owner._id.toString(), OWNER_ACCESS, {});
    const [saved] = await ShiftClosing.find({ businessId: business._id });
    await sleep(5);
    await shiftClosingService.close(id, owner._id.toString(), OWNER_ACCESS, {});
    const rows = await ShiftClosing.find({ businessId: business._id }).sort({ createdAt: 1 });
    expect(rows[1].coversFrom!.getTime()).toBe(saved.createdAt.getTime() + 1);
  });
});
