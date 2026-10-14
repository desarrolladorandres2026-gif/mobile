import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import {
  Order, Coupon, CouponRedemption, LedgerEntry, Business, Role, PricingConfigAudit, Payout,
} from '../models';
import { AuditAction, AuditLog } from '../security/audit';
import { Permission, STAFF_ROLE_PERMISSIONS } from '../security/rbac';
import { CouponType, CouponFundedBy, PaymentMethod, UserRole } from '../types';
import { pricingService } from '../services/pricing.service';
import { orderService } from '../services/order.service';
import { featureFlagService } from '../services/featureFlag.service';
import { PRO_PLAN } from '../config/pro';
import { config } from '../config';
import { localClock } from '../utils/businessHours';
import { ProSubscription, ProSubscriptionStatus } from '../models';
import {
  GARZON, makeUser, makeStaff, makeBusiness, makeProduct, makeCoupon, makePricingConfig, authHeader,
} from './factories';

/**
 * Configuración de extremo a extremo.
 *
 * Una opción del panel que solo guarda un dato es peor que no tenerla. Cada
 * caso de aquí recorre el camino completo: un usuario autorizado cambia el
 * valor por la API, el backend lo valida y lo guarda, la lectura lo devuelve,
 * y —lo que importa— el cobro y la elegibilidad cambian de verdad.
 */

const VALID_UNTIL = () => new Date(Date.now() + 30 * 24 * 3600_000).toISOString();

async function setup(opts: { price?: number; config?: Record<string, unknown> } = {}) {
  await makePricingConfig(opts.config ?? {});
  const client = await makeUser({ role: UserRole.CLIENT });
  const owner = await makeUser({ role: UserRole.BUSINESS });
  const business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
  const product = await makeProduct(business._id, { price: opts.price ?? 20000 });
  return { client, owner, business, product };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

const quoteFor = (ctx: Pick<Ctx, 'client' | 'business' | 'product'>, quantity: number, extra: Record<string, unknown> = {}) =>
  pricingService.quote({
    userId: ctx.client._id.toString(),
    businessId: ctx.business._id.toString(),
    items: [{ productId: ctx.product._id.toString(), quantity }],
    paymentMethod: PaymentMethod.ONLINE,
    deliveryLatitude: GARZON.lat,
    deliveryLongitude: GARZON.lng,
    ...extra,
  } as never);

const createOrder = (ctx: Pick<Ctx, 'client' | 'business' | 'product'>, quantity: number, extra: Record<string, unknown> = {}) =>
  orderService.create({
    clientId: ctx.client._id.toString(),
    businessId: ctx.business._id.toString(),
    items: [{ productId: ctx.product._id.toString(), quantity }],
    paymentMethod: PaymentMethod.ONLINE,
    deliveryAddress: 'Calle 5 # 3-21',
    deliveryLatitude: GARZON.lat,
    deliveryLongitude: GARZON.lng,
    ...extra,
  } as never);

/** Las auditorías se escriben sin esperar (`void logAudit`): se sondea un instante. */
async function waitForAudit(filter: Record<string, unknown>) {
  for (let i = 0; i < 40; i += 1) {
    const found = await AuditLog.findOne(filter).sort({ createdAt: -1 }).lean();
    if (found) return found;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

async function createPromotion(ctx: Ctx, body: Record<string, unknown>) {
  const res = await request(app)
    .post(`/api/v1/coupons/business/${ctx.business._id}`)
    .set(await authHeader(ctx.owner))
    .send({ validUntil: VALID_UNTIL(), ...body });
  return res;
}

const patchPromotion = async (ctx: Ctx, id: string, body: Record<string, unknown>) =>
  request(app).patch(`/api/v1/coupons/business/${id}`).set(await authHeader(ctx.owner)).send(body);

describe('Business: una promoción cambia lo que se cobra', () => {
  let ctx: Ctx;
  beforeEach(async () => { ctx = await setup(); });

  it('crear, leer, y que el valor guardado sea el que descuenta', async () => {
    const created = await createPromotion(ctx, {
      code: 'VEINTE', title: '20 % hoy', type: 'percentage', value: 20,
      validDays: [0, 1, 2, 3, 4, 5, 6], validFromTime: '00:00', validUntilTime: '23:59',
      maxDiscountAmount: 5000, minOrderAmount: 10000, perUserLimit: 0, firstOrderOnly: false,
    });
    expect(created.status).toBe(201);

    const list = await request(app)
      .get(`/api/v1/coupons/business/${ctx.business._id}`)
      .set(await authHeader(ctx.owner));
    const stored = list.body.data.find((c: any) => c.code === 'VEINTE');
    expect(stored).toMatchObject({
      value: 20, maxDiscountAmount: 5000, minOrderAmount: 10000,
      validFromTime: '00:00', validUntilTime: '23:59', fundedBy: 'business',
    });

    // 20 % de 40.000 = 8.000, pero el tope guardado es 5.000.
    const quote = await quoteFor(ctx, 2, { couponCode: 'VEINTE' });
    expect(quote.coupon!.productDiscount).toBe(5000);
  });

  it('editar el porcentaje cambia el siguiente cálculo; el tope lo sigue limitando', async () => {
    const created = await createPromotion(ctx, { code: 'CAMBIA', title: 'Cambia', type: 'percentage', value: 10 });
    const id = created.body.data._id;
    expect((await quoteFor(ctx, 2, { couponCode: 'CAMBIA' })).coupon!.productDiscount).toBe(4000);

    const edit = await patchPromotion(ctx, id, { value: 25 });
    expect(edit.status).toBe(200);

    expect((await quoteFor(ctx, 2, { couponCode: 'CAMBIA' })).coupon!.productDiscount).toBe(10000);

    await patchPromotion(ctx, id, { maxDiscountAmount: 6000 });
    expect((await quoteFor(ctx, 2, { couponCode: 'CAMBIA' })).coupon!.productDiscount).toBe(6000);
  });

  it('cambiar la compra mínima cambia la elegibilidad', async () => {
    const created = await createPromotion(ctx, { code: 'MINIMO', title: 'Mínimo', type: 'fixed', value: 2000 });
    const id = created.body.data._id;
    await expect(quoteFor(ctx, 1, { couponCode: 'MINIMO' })).resolves.toBeDefined();

    await patchPromotion(ctx, id, { minOrderAmount: 30000 });

    await expect(quoteFor(ctx, 1, { couponCode: 'MINIMO' })).rejects.toThrow(/pedido mínimo/i);
  });

  it('desactivarla la saca de la cotización y del sugeridor', async () => {
    const created = await createPromotion(ctx, {
      code: 'APAGAME', title: 'Apágame', type: 'fixed', value: 3000, isPublic: true,
    });
    const id = created.body.data._id;
    expect((await quoteFor(ctx, 2)).suggestedCoupon?.code).toBe('APAGAME');

    const off = await request(app)
      .patch(`/api/v1/coupons/business/${id}/deactivate`)
      .set(await authHeader(ctx.owner));
    expect(off.status).toBe(200);

    expect((await quoteFor(ctx, 2)).suggestedCoupon).toBeNull();
    await expect(quoteFor(ctx, 2, { couponCode: 'APAGAME' })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('una promoción automática desactivada deja de aplicarse en la siguiente cotización', async () => {
    const created = await createPromotion(ctx, {
      autoApply: true, title: 'Auto', type: 'percentage', value: 10, productIds: [ctx.product._id.toString()],
    });
    expect((await quoteFor(ctx, 2)).promotionDiscount).toBe(4000);

    await request(app).patch(`/api/v1/coupons/business/${created.body.data._id}/deactivate`).set(await authHeader(ctx.owner));

    expect((await quoteFor(ctx, 2)).promotionDiscount).toBe(0);
  });

  it('el tope de usos se comprueba al aceptar nuevos canjes aunque cambie después de crear la promoción', async () => {
    const created = await createPromotion(ctx, { code: 'DOSUSOS', title: 'Dos', type: 'fixed', value: 1000, usageLimit: 5 });
    const id = created.body.data._id;
    const other = await makeUser({ role: UserRole.CLIENT });

    await createOrder(ctx, 2, { couponCode: 'DOSUSOS' });
    await patchPromotion(ctx, id, { usageLimit: 1 });

    await expect(createOrder({ ...ctx, client: other }, 2, { couponCode: 'DOSUSOS' })).rejects.toThrow(/límite de usos/i);
    expect((await Coupon.findById(id))!.usedCount).toBe(1);
  });

  it('el presupuesto editado se respeta, y no puede quedar por debajo de lo gastado', async () => {
    const created = await createPromotion(ctx, { code: 'PRESUP', title: 'Presupuesto', type: 'fixed', value: 3000, budgetLimit: 20000 });
    const id = created.body.data._id;
    await createOrder(ctx, 2, { couponCode: 'PRESUP' });
    expect((await Coupon.findById(id))!.budgetSpent).toBe(3000);

    // Lo que el panel pinta en su barra de consumo sale de este mismo dato.
    const list = await request(app).get(`/api/v1/coupons/business/${ctx.business._id}`).set(await authHeader(ctx.owner));
    expect(list.body.data.find((c: any) => c._id === id)).toMatchObject({ budgetLimit: 20000, budgetSpent: 3000, usedCount: 1 });

    const tooLow = await patchPromotion(ctx, id, { budgetLimit: 1000 });
    expect(tooLow.status).toBe(409);

    await patchPromotion(ctx, id, { budgetLimit: 4000 });
    const other = await makeUser({ role: UserRole.CLIENT });
    // Quedan 1.000: un descuento de 3.000 ya no cabe.
    await expect(quoteFor({ ...ctx, client: other }, 2, { couponCode: 'PRESUP' })).rejects.toThrow(/presupuesto/i);
  });

  it('promoción de primer pedido configurada desde el panel se cumple al cobrar', async () => {
    const created = await createPromotion(ctx, {
      autoApply: true, title: 'Primer pedido', type: 'percentage', value: 10,
      productIds: [ctx.product._id.toString()], firstOrderOnly: true,
    });
    expect(created.status).toBe(201);
    expect(created.body.data.perUserLimit).toBe(1);

    expect((await quoteFor(ctx, 2)).promotionDiscount).toBe(4000);
    await createOrder(ctx, 2);
    expect((await quoteFor(ctx, 2)).promotionDiscount).toBe(0);
  });
});

describe('Business: lo que el servidor rechaza aunque la interfaz no lo ofrezca', () => {
  let ctx: Ctx;
  beforeEach(async () => { ctx = await setup(); });

  it('un cupón de envío gratis del comercio no existe', async () => {
    const res = await createPromotion(ctx, { code: 'ENVIO', title: 'Envío', type: 'free_delivery', value: 0 });
    expect(res.status).toBe(400);
  });

  it('el alcance de domicilio ni se lee: la promoción sale sobre productos', async () => {
    const res = await createPromotion(ctx, { code: 'ALCANCE', title: 'Alcance', type: 'fixed', value: 1000, scope: 'delivery' });
    expect(res.status).toBe(201);
    expect(res.body.data.scope).toBe('product');
  });

  it('quién financia no se puede elegir', async () => {
    const res = await createPromotion(ctx, {
      code: 'MIA', title: 'Mía', type: 'fixed', value: 1000, fundedBy: 'platform', campaignApproved: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.data.fundedBy).toBe('business');
    expect(res.body.data.campaignApproved).toBe(false);
  });

  it.each([
    ['más del 90 %', { type: 'percentage', value: 95 }],
    ['una franja con una sola hora', { type: 'fixed', value: 1000, validFromTime: '10:00' }],
    ['una franja que cruza la medianoche', { type: 'fixed', value: 1000, validFromTime: '22:00', validUntilTime: '02:00' }],
    ['un tope de descuento en un monto fijo', { type: 'fixed', value: 1000, maxDiscountAmount: 500 }],
    ['un monto con decimales', { type: 'fixed', value: 1000.5 }],
    ['un presupuesto negativo', { type: 'fixed', value: 1000, budgetLimit: -1 }],
  ])('rechaza %s', async (_name, body) => {
    const res = await createPromotion(ctx, { code: 'RARA', title: 'Rara', ...body });
    expect(res.status).toBe(400);
  });

  it('un comercio ajeno no puede editarla ni simularla', async () => {
    const created = await createPromotion(ctx, { code: 'AJENA', title: 'Ajena', type: 'fixed', value: 1000 });
    const stranger = await makeUser({ role: UserRole.BUSINESS });
    await makeBusiness(stranger._id);

    const edit = await request(app)
      .patch(`/api/v1/coupons/business/${created.body.data._id}`)
      .set(await authHeader(stranger))
      .send({ value: 9000 });
    expect([403, 404]).toContain(edit.status);

    const preview = await request(app)
      .post(`/api/v1/coupons/business/${ctx.business._id}/preview`)
      .set(await authHeader(stranger))
      .send({ freeDeliveryThreshold: 30000 });
    expect(preview.status).toBe(403);

    expect((await Coupon.findById(created.body.data._id))!.value).toBe(1000);
  });

  it('las modificaciones dejan auditoría con el antes y el después', async () => {
    const created = await createPromotion(ctx, { code: 'AUDITA', title: 'Audita', type: 'percentage', value: 10 });
    await patchPromotion(ctx, created.body.data._id, { value: 30 });

    const entry = await waitForAudit({
      action: AuditAction.PROMOTION_UPDATED,
      entityId: created.body.data._id,
    });
    expect(entry).not.toBeNull();
    expect((entry!.metadata as any).changes.value).toEqual({ before: 10, after: 30 });
  });
});

describe('Business: el envío gratis configurado cambia el checkout', () => {
  let ctx: Ctx;
  beforeEach(async () => { ctx = await setup({ price: 10000 }); });

  const putBusiness = async (body: Record<string, unknown>) =>
    request(app).put(`/api/v1/businesses/${ctx.business._id}`).set(await authHeader(ctx.owner)).send(body);

  it('el umbral guardado es el que aplica, y al cambiarlo cambia el resultado', async () => {
    expect((await quoteFor(ctx, 3)).freeDeliveryApplied).toBe(false);

    expect((await putBusiness({ freeDeliveryThreshold: 30000 })).status).toBe(200);
    expect((await quoteFor(ctx, 3)).freeDeliveryApplied).toBe(true);

    await putBusiness({ freeDeliveryThreshold: 50000 });
    expect((await quoteFor(ctx, 3)).freeDeliveryApplied).toBe(false);

    await putBusiness({ freeDeliveryThreshold: 0 });
    expect((await quoteFor(ctx, 5)).freeDeliveryApplied).toBe(false);
  });

  it('con una promoción que baja el subtotal pagado, el nuevo umbral se mide en neto', async () => {
    await putBusiness({ freeDeliveryThreshold: 30000 });
    await makeCoupon({
      autoApply: true, productIds: [ctx.product._id], fundedBy: CouponFundedBy.BUSINESS,
      businessId: ctx.business._id, campaignApproved: false, type: CouponType.FIXED, value: 5000, perUserLimit: 0,
    });
    expect((await quoteFor(ctx, 3)).freeDeliveryApplied).toBe(false);
  });

  it('los días guardados se obedecen: fuera de ellos no se regala, dentro sí', async () => {
    const today = localClock(new Date(), config.settlement.timezone).day;
    const others = [0, 1, 2, 3, 4, 5, 6].filter((d) => d !== today);

    await putBusiness({ freeDeliveryThreshold: 30000, freeDeliveryValidDays: others });
    expect((await quoteFor(ctx, 3)).freeDeliveryApplied).toBe(false);

    await putBusiness({ freeDeliveryValidDays: [today] });
    expect((await quoteFor(ctx, 3)).freeDeliveryApplied).toBe(true);
  });

  it('una franja horaria que no incluye este momento apaga el envío gratis', async () => {
    const { minutes } = localClock(new Date(), config.settlement.timezone);
    // Una franja de 30 minutos que empieza dos horas antes o después; si cae
    // cruzando medianoche se corre al otro lado del día.
    const startMin = minutes >= 12 * 60 ? minutes - 3 * 60 : minutes + 3 * 60;
    const fmt = (m: number) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');

    await putBusiness({
      freeDeliveryThreshold: 30000,
      freeDeliveryValidFromTime: fmt(startMin),
      freeDeliveryValidUntilTime: fmt(startMin + 30),
    });
    expect((await quoteFor(ctx, 3)).freeDeliveryApplied).toBe(false);
  });

  it.each([
    ['una sola hora', { freeDeliveryThreshold: 30000, freeDeliveryValidFromTime: '10:00' }],
    ['una franja que cruza la medianoche', { freeDeliveryThreshold: 30000, freeDeliveryValidFromTime: '22:00', freeDeliveryValidUntilTime: '02:00' }],
    ['una vigencia al revés', { freeDeliveryThreshold: 30000, freeDeliveryValidFrom: '2030-01-10', freeDeliveryValidUntil: '2030-01-01' }],
    ['un umbral negativo', { freeDeliveryThreshold: -1 }],
  ])('rechaza %s', async (_name, body) => {
    expect((await putBusiness(body)).status).toBe(400);
  });

  it('el cambio queda auditado con el antes y el después', async () => {
    await putBusiness({ freeDeliveryThreshold: 25000 });
    const entry = await waitForAudit({ action: AuditAction.BUSINESS_UPDATED, entityId: ctx.business._id.toString() });
    expect(entry).not.toBeNull();
    expect((entry!.metadata as any).changes.freeDeliveryThreshold).toEqual({ before: 0, after: 25000 });
  });
});

describe('Administración: la configuración global cambia la lógica real', () => {
  let ctx: Ctx;
  let admin: any;

  beforeEach(async () => {
    await featureFlagService.remove('rbac_enforce');
    ctx = await setup({ price: 20000 });
    admin = await makeStaff({ roleSlug: 'super_admin' });
  });

  const putConfig = async (body: Record<string, unknown>, who: any = admin) =>
    request(app)
      .put('/api/v1/finance/config')
      .set(await authHeader(who))
      .send({ reason: 'Prueba de configuración', ...body });

  it('el margen mínimo editado por el panel es el que decide si una campaña de ZIPP pasa', async () => {
    await makeCoupon({ code: 'CAMPANA', type: CouponType.FIXED, value: 1000, campaignApproved: false, minimumContributionMargin: -1 });
    // 20.000 al 10 % = 2.000 de ingreso − 1.000 = 1.000 de margen.
    await expect(quoteFor(ctx, 1, { couponCode: 'CAMPANA' })).resolves.toBeDefined();

    expect((await putConfig({ defaultMinimumContributionMargin: 1500 })).status).toBe(200);
    await expect(quoteFor(ctx, 1, { couponCode: 'CAMPANA' })).rejects.toMatchObject({ statusCode: 422 });

    expect((await putConfig({ defaultMinimumContributionMargin: 500 })).status).toBe(200);
    await expect(quoteFor(ctx, 1, { couponCode: 'CAMPANA' })).resolves.toBeDefined();
  });

  it('el tope de subsidio por cupón editado limita el descuento del siguiente pedido', async () => {
    await makeCoupon({ code: 'GRANDE', type: CouponType.FIXED, value: 8000 });
    expect((await quoteFor(ctx, 1, { couponCode: 'GRANDE' })).coupon!.productDiscount).toBe(8000);

    await putConfig({ couponSubsidyLimit: 3000 });

    expect((await quoteFor(ctx, 1, { couponCode: 'GRANDE' })).coupon!.productDiscount).toBe(3000);
  });

  it('el presupuesto global de campañas editado corta los canjes de ZIPP', async () => {
    await makeCoupon({ code: 'GLOBAL', type: CouponType.FIXED, value: 4000, budgetLimit: 100000 });
    await expect(quoteFor(ctx, 1, { couponCode: 'GLOBAL' })).resolves.toBeDefined();

    await putConfig({ campaignBudgetTotal: 3000 });

    await expect(quoteFor(ctx, 1, { couponCode: 'GLOBAL' })).rejects.toThrow(/agotaron/i);
  });

  it('las tarifas de la pasarela editadas cambian la validación del margen, solo en línea', async () => {
    await makeCoupon({ code: 'PASARELA', type: CouponType.FIXED, value: 1500, campaignApproved: false, minimumContributionMargin: -1 });
    await putConfig({ cashOnDeliveryEnabled: true });
    await expect(quoteFor(ctx, 1, { couponCode: 'PASARELA' })).resolves.toBeDefined();

    await putConfig({ gatewayCardBps: 300, gatewayCardFixed: 700, gatewayFeeVatBps: 1900 });

    await expect(quoteFor(ctx, 1, { couponCode: 'PASARELA' })).rejects.toMatchObject({ statusCode: 422 });
    await expect(
      quoteFor(ctx, 1, { couponCode: 'PASARELA', paymentMethod: PaymentMethod.CASH_ON_DELIVERY })
    ).resolves.toBeDefined();
  });

  it('el cambio queda en el historial versionado y no altera pedidos ya creados', async () => {
    // Sin tarifa propia del negocio: manda la global.
    await Business.updateOne({ _id: ctx.business._id }, { commissionRateBps: -1 });
    const before = await createOrder(ctx, 1);
    const snapshot = JSON.stringify(before.finance);

    await putConfig({ merchantCommissionBps: 2000 });

    const after = await Order.findById(before._id);
    expect(JSON.stringify(after!.toObject().finance)).toBe(JSON.stringify(JSON.parse(snapshot)));
    const audit = await PricingConfigAudit.findOne({ toVersion: 2 });
    expect(audit!.changes.merchantCommissionBps).toEqual({ before: 1000, after: 2000 });
    // Y la cotización siguiente sí usa la nueva.
    expect((await quoteFor(ctx, 1)).appliedCommissionBps).toBe(2000);
  });

  it('un comercio no puede tocar la configuración global', async () => {
    const res = await putConfig({ couponSubsidyLimit: 999999 }, ctx.owner);
    expect(res.status).toBe(403);
  });

  it('el personal sin el permiso de finanzas tampoco', async () => {
    await featureFlagService.upsert('rbac_enforce', { audience: 'staff' });
    const support = await makeStaff({ roleSlug: 'soporte' });
    expect(STAFF_ROLE_PERMISSIONS.soporte.permissions).not.toContain(Permission.FINANCE_MANAGE);
    const res = await putConfig({ couponSubsidyLimit: 1 }, support);
    expect(res.status).toBe(403);
  });
});

describe('Previsualización antes de activar', () => {
  let ctx: Ctx;
  beforeEach(async () => { ctx = await setup({ price: 20000 }); });

  const preview = async (body: Record<string, unknown>) =>
    request(app)
      .post(`/api/v1/coupons/business/${ctx.business._id}/preview`)
      .set(await authHeader(ctx.owner))
      .send(body);

  it('da las mismas cifras que el cobro real de esa misma promoción', async () => {
    const draft = { type: 'percentage', value: 20, maxDiscountAmount: 5000 };
    const sim = await preview({ draft, subtotals: [40000], distanceKm: 0 });
    expect(sim.status).toBe(200);
    const scenario = sim.body.data.scenarios[0];

    await makeCoupon({
      code: 'REAL', type: CouponType.PERCENTAGE, value: 20, maxDiscountAmount: 5000,
      fundedBy: CouponFundedBy.BUSINESS, businessId: ctx.business._id, campaignApproved: false,
    });
    const real = await quoteFor(ctx, 2, { couponCode: 'REAL' });

    expect(scenario.customerTotal).toBe(real.customerTotal);
    expect(scenario.merchantPayout).toBe(real.businessPayout);
    expect(scenario.merchantFunded).toBe(real.merchantFundedDiscount);
    expect(scenario.merchantCommission).toBe(real.merchantCommission);
    expect(scenario.driverPayout).toBe(real.driverPayout);
    expect(scenario.deliveryFee).toBe(real.deliveryCustomerFee);
  });

  it('no crea pedidos, cupones, canjes, asientos ni pagos', async () => {
    const counts = async () => [
      await Order.countDocuments(), await Coupon.countDocuments(), await CouponRedemption.countDocuments(),
      await LedgerEntry.countDocuments(), await Payout.countDocuments(),
    ];
    const before = await counts();

    await preview({ draft: { type: 'fixed', value: 3000, budgetLimit: 10000 }, subtotals: [20000, 40000] });
    await preview({ freeDeliveryThreshold: 30000 });

    expect(await counts()).toEqual(before);
  });

  it('avisa de una promoción inválida con el mensaje del modelo, sin guardarla', async () => {
    const res = await preview({ draft: { type: 'percentage', value: 95 } });
    expect(res.status).toBe(200);
    expect(res.body.data.valid).toBe(false);
    expect(res.body.data.errors.join(' ')).toMatch(/90/);
  });

  it('avisa cuando el envío gratis no se podría pagar, igual que lo haría el cobro', async () => {
    await Business.updateOne({ _id: ctx.business._id }, { freeDeliveryThreshold: 1000 });
    const res = await preview({ freeDeliveryThreshold: 1000, subtotals: [1000, 20000] });
    const [pequeno, grande] = res.body.data.scenarios;

    expect(pequeno.freeDeliveryApplied).toBe(false);
    expect(pequeno.warnings.map((w: any) => w.code)).toContain('FREE_DELIVERY_UNAFFORDABLE');
    expect(grande.freeDeliveryApplied).toBe(true);
    expect(grande.merchantPayout).toBeGreaterThanOrEqual(0);
  });

  it('un umbral borrador cambia la simulación sin tocar el guardado', async () => {
    const res = await preview({ freeDeliveryThreshold: 30000, subtotals: [20000, 40000] });
    const [bajo, alto] = res.body.data.scenarios;

    expect(bajo.freeDeliveryApplied).toBe(false);
    expect(alto.freeDeliveryApplied).toBe(true);
    expect((await Business.findById(ctx.business._id))!.freeDeliveryThreshold).toBe(0);
  });

  it('el comercio solo simula lo que él paga: no puede pedir una campaña de ZIPP', async () => {
    const res = await preview({ draft: { type: 'fixed', value: 3000, fundedBy: 'platform' } });
    // `strict()` rechaza el campo; no se ignora en silencio.
    expect(res.status).toBe(400);
  });

  it('el administrador simula una campaña financiada por ZIPP y ve el subsidio y el margen con la pasarela', async () => {
    await makePricingConfig({ gatewayCardBps: 300, gatewayCardFixed: 700, gatewayFeeVatBps: 1900 });
    await featureFlagService.remove('rbac_enforce');
    const admin = await makeStaff({ roleSlug: 'super_admin' });

    const res = await request(app)
      .post('/api/v1/coupons/preview')
      .set(await authHeader(admin))
      .send({
        businessId: ctx.business._id.toString(),
        draft: { type: 'fixed', value: 1500, fundedBy: 'platform', campaignApproved: false },
        subtotals: [20000],
        distanceKm: 0,
      });

    expect(res.status).toBe(200);
    const [s] = res.body.data.scenarios;
    expect(s.platformFunded).toBe(1500);
    expect(s.estimatedGatewayFee).toBeGreaterThan(0);
    expect(s.platformNetAfterGateway).toBe(s.platformNet - s.estimatedGatewayFee);
    expect(s.warnings.map((w: any) => w.code)).toContain('MARGIN_BELOW_FLOOR');
  });
});

describe('Zipp Pro: la venta sigue restringida hasta que ZIPP la abra', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setup();
    await featureFlagService.remove('pro_subscriptions_open');
  });

  const subscribeBody = {
    instrument: { kind: 'saved_card', savedCardId: '507f1f77bcf86cd799439011', installments: 1 },
    acceptanceToken: 'token-de-prueba-de-aceptacion-0001',
  };

  it('por defecto el estado dice que no está abierta', async () => {
    const res = await request(app).get('/api/v1/pro').set(await authHeader(ctx.client));
    expect(res.status).toBe(200);
    expect(res.body.data.open).toBe(false);
  });

  it('suscribirse devuelve 403 PRO_NOT_OPEN y no crea ninguna suscripción ni cobro', async () => {
    const res = await request(app)
      .post('/api/v1/pro/subscribe')
      .set(await authHeader(ctx.client))
      .send(subscribeBody);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PRO_NOT_OPEN');
    expect(await ProSubscription.countDocuments()).toBe(0);
  });

  it('encender el interruptor desde administración abre la venta', async () => {
    await featureFlagService.upsert('pro_subscriptions_open', { audience: 'all' });
    const res = await request(app).get('/api/v1/pro').set(await authHeader(ctx.client));
    expect(res.body.data.open).toBe(true);
  });

  it('quien ya es socio conserva sus beneficios aunque la venta esté cerrada', async () => {
    await ProSubscription.create({
      userId: ctx.client._id,
      status: ProSubscriptionStatus.ACTIVE,
      planId: PRO_PLAN.id,
      price: PRO_PLAN.price,
      currency: PRO_PLAN.currency,
      startedAt: new Date(),
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 15 * 24 * 3600_000),
      autoRenew: true,
    });
    const product = await makeProduct(ctx.business._id, { price: PRO_PLAN.benefits.freeDelivery.minSubtotal + 1000 });

    const quote = await quoteFor({ ...ctx, product }, 1);
    expect(quote.proDeliveryDiscount).toBeGreaterThan(0);
  });
});

describe('Zipp Pro: simulación de rentabilidad', () => {
  it('usa el motor de precios: el coste por pedido coincide con una cotización real de un socio', async () => {
    const ctx = await setup({ price: PRO_PLAN.benefits.freeDelivery.minSubtotal + 5000 });
    await ProSubscription.create({
      userId: ctx.client._id,
      status: ProSubscriptionStatus.ACTIVE,
      planId: PRO_PLAN.id,
      price: PRO_PLAN.price,
      currency: PRO_PLAN.currency,
      startedAt: new Date(),
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 15 * 24 * 3600_000),
      autoRenew: true,
    });
    const real = await quoteFor(ctx, 1);

    await featureFlagService.remove('rbac_enforce');
    const admin = await makeStaff({ roleSlug: 'super_admin' });
    const res = await request(app)
      .get('/api/v1/admin/growth/pro/simulation')
      .query({ averageSubtotal: PRO_PLAN.benefits.freeDelivery.minSubtotal + 5000, averageDistanceKm: 0, eligibleShare: 1, orders: '2,8' })
      .set(await authHeader(admin));

    expect(res.status).toBe(200);
    const sim = res.body.data;
    expect(sim.perOrder.benefitCost).toBe(real.proDeliveryDiscount + real.proServiceFeeDiscount);
    expect(sim.rows).toHaveLength(2);
    expect(sim.rows[1].benefitCost).toBe(8 * sim.perOrder.benefitCost);
    expect(sim.rows[1].contributionBeforeUnknowns).toBe(sim.fee.net - sim.rows[1].benefitCost);
    // Lo que no se sabe se dice, y no se inventa ninguna tarifa.
    expect(sim.missingData.length).toBeGreaterThan(3);
    expect(sim.fee.gatewayConfigured).toBe(false);
    expect(sim.fee.gatewayFee).toBe(0);
  });
});
