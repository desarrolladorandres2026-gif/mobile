import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../app';
import { Order } from '../models';
import { CouponFundedBy, CouponType, UserRole } from '../types';
import { customerQuoteView, CUSTOMER_QUOTE_FIELDS } from '../services/profileMasking';
import {
  GARZON, offsetKm, makeUser, makeBusiness, makeProduct, makeCoupon, authHeader, makePricingConfig,
} from './factories';

/**
 * Auditoría 2026-10-19 · `POST /orders/quote` devolvía el `Quote` interno
 * entero. Estas pruebas fijan las dos mitades del contrato: lo que el
 * checkout necesita SIGUE llegando, y lo que es de ZIPP (margen, pago al
 * domiciliario, ingresos, subsidios) NO sale nunca.
 */

const DESTINATION = offsetKm(GARZON, 2);

/** Todo campo interno del `Quote`: ninguno puede aparecer en la respuesta HTTP, a ningún nivel. */
const INTERNAL_KEYS = [
  'platformGrossRevenue', 'platformNetRevenueBeforeOperatingCosts', 'platformPromotionExpense',
  'platformCommission', 'merchantCommission', 'appliedCommissionBps', 'businessPayout',
  'driverPayout', 'driverDeliveryPayout', 'deliveryMargin', 'deliveryCustomerFee',
  'merchantFundedDiscount', 'platformFundedDiscount', 'subsidioPlataforma', 'subsidioComercio',
  'taxPayable', 'taxStatus', 'taxBreakdown', 'pricingConfigVersion', 'zoneId', 'zoneVersion',
  'cashToRemit', 'appliedAutoPromotions',
  // Anidados:
  'couponId', 'merchantFunded', 'platformFunded', 'minimumContributionMargin', 'campaignApproved',
  'marginWithFullBenefit', 'marginApplied',
];

function keysDeep(value: unknown, acc = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => keysDeep(v, acc));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) { acc.add(k); keysDeep(v, acc); }
  }
  return acc;
}

async function scenario() {
  await makePricingConfig();
  const client = await makeUser({ role: UserRole.CLIENT });
  const owner = await makeUser({ role: UserRole.BUSINESS });
  const business = await makeBusiness(owner._id);
  const product = await makeProduct(business._id, { price: 20000 });
  return { client, owner, business, product };
}

const body = (business: any, product: any, extra: Record<string, unknown> = {}) => ({
  businessId: business._id.toString(),
  items: [{ productId: product._id.toString(), quantity: 2 }],
  paymentMethod: 'online',
  deliveryLatitude: DESTINATION.lat,
  deliveryLongitude: DESTINATION.lng,
  ...extra,
});

const quote = async (user: any, payload: unknown) =>
  request(app).post('/api/v1/orders/quote').set(await authHeader(user)).send(payload as object);

describe('POST /orders/quote · campos permitidos y ausencia de internos', () => {
  it('devuelve lo que el checkout pinta y suma', async () => {
    const { client, business, product } = await scenario();
    const res = await quote(client, body(business, product, { tip: 1000 })).then((r) => { expect(r.status).toBe(200); return r; });
    const q = res.body.data;

    for (const k of [
      'subtotal', 'deliveryFee', 'deliveryPayable', 'freeDeliveryApplied', 'customerServiceFee',
      'tip', 'tax', 'total', 'discount', 'currency', 'minOrder', 'etaMinutesMin', 'etaMinutesMax',
      'deliveryDistanceKm', 'requiresAgeVerification', 'suggestedCoupon', 'coupon', 'items',
      'proDeliveryDiscount', 'proServiceFeeDiscount', 'promotionDiscount',
    ]) expect(q, `falta ${k}`).toHaveProperty(k);

    expect(q.subtotal).toBe(40000);
    expect(q.tip).toBe(1000);
    expect(q.total).toBe(q.subtotal + q.deliveryFee + q.customerServiceFee + q.tax + q.tip - q.discount);
    expect(q.items[0]).toMatchObject({ quantity: 2, unitPrice: 20000, totalPrice: 40000 });
    expect(q.items[0].productName).toBeTruthy();
  });

  it('ningún campo interno sale, a ningún nivel', async () => {
    const { client, business, product } = await scenario();
    const res = await quote(client, body(business, product));
    expect(res.status).toBe(200);
    const present = keysDeep(res.body.data);
    expect(INTERNAL_KEYS.filter((k) => present.has(k))).toEqual([]);
  });

  it('con cupón de plataforma solo salen sus importes visibles, no quién absorbe qué', async () => {
    const { client, business, product } = await scenario();
    await makeCoupon({ code: 'ZIPP5K', type: CouponType.FIXED, value: 5000, fundedBy: CouponFundedBy.PLATFORM });

    const res = await quote(client, body(business, product, { couponCode: 'ZIPP5K' }));
    expect(res.status).toBe(200);
    const q = res.body.data;
    expect(q.coupon).toMatchObject({ code: 'ZIPP5K', totalDiscount: 5000 });
    expect(Object.keys(q.coupon).sort()).toEqual([
      'code', 'deliveryDiscount', 'fundedBy', 'productDiscount', 'scope', 'serviceFeeDiscount',
      'title', 'totalDiscount', 'type',
    ].sort());
    expect(INTERNAL_KEYS.filter((k) => keysDeep(q).has(k))).toEqual([]);
  });

  it('el precio que mande el cliente se ignora y los adicionales se recalculan en el servidor', async () => {
    const { client, business, product } = await scenario();
    const res = await quote(client, body(business, product, {
      items: [{ productId: product._id.toString(), quantity: 1, selectedExtras: [{ name: 'Inexistente', price: -999999 }] }],
      total: 1, subtotal: 1, driverPayout: 99999999,
    }));
    // Un adicional que el producto no ofrece se rechaza (o se ignora): jamás baja el precio.
    if (res.status === 200) expect(res.body.data.subtotal).toBe(20000);
    else expect([400, 422]).toContain(res.status);
  });

  it('la cotización no guarda nada', async () => {
    const { client, business, product } = await scenario();
    await quote(client, body(business, product));
    expect(await Order.countDocuments()).toBe(0);
  });
});

describe('POST /orders/quote · autenticación, autorización y entradas', () => {
  it('sin sesión: 401', async () => {
    const { business, product } = await scenario();
    await request(app).post('/api/v1/orders/quote').send(body(business, product)).expect(401);
  });

  it('solo el cliente cotiza: comercio y admin reciben 403', async () => {
    const { owner, business, product } = await scenario();
    const admin = await makeUser({ role: UserRole.ADMIN });
    expect((await quote(owner, body(business, product))).status).toBe(403);
    expect((await quote(admin, body(business, product))).status).toBe(403);
  });

  it('un producto de otro comercio no se cotiza dentro de este', async () => {
    const { client, business } = await scenario();
    const otherOwner = await makeUser({ role: UserRole.BUSINESS });
    const otherBusiness = await makeBusiness(otherOwner._id);
    const foreign = await makeProduct(otherBusiness._id, { price: 1000 });
    const res = await quote(client, body(business, foreign));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('negocio inexistente: 404; coordenadas fuera de rango: 400; id mal formado: 4xx', async () => {
    const { client, business, product } = await scenario();
    expect((await quote(client, body({ _id: '64b7f0f0f0f0f0f0f0f0f0f0' }, product))).status).toBe(404);
    expect((await quote(client, body(business, product, { deliveryLatitude: 95 }))).status).toBe(400);
    const bad = await quote(client, body({ _id: 'no-es-un-id' }, product));
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(bad.status).toBeLessThan(500);
  });

  it('el código de cupón de otro cliente no revela nada interno', async () => {
    const { client, business, product } = await scenario();
    const res = await quote(client, body(business, product, { couponCode: 'NOEXISTE' }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(JSON.stringify(res.body)).not.toMatch(/platformGrossRevenue|driverPayout|merchantFunded/);
  });
});

describe('customerQuoteView', () => {
  it('es una lista blanca: un campo nuevo del Quote interno no sale hasta que se autorice aquí', () => {
    const out = customerQuoteView({
      subtotal: 10, total: 12, campoInternoFuturo: 999, platformGrossRevenue: 5,
      items: [{ productName: 'x', quantity: 1, unitPrice: 10, totalPrice: 10, costoInterno: 3, selectedExtras: [{ name: 'a', price: 1, quantity: 1, margen: 1 }] }],
      coupon: { code: 'A', title: 't', type: 'fixed', fundedBy: 'platform', scope: 'product', productDiscount: 1, deliveryDiscount: 0, serviceFeeDiscount: 0, totalDiscount: 1, platformFunded: 1, couponId: 'z' },
      proBenefitNotice: { code: 'PRO_NEGATIVE_MARGIN', skipped: ['delivery'], message: 'm', marginApplied: -1, marginWithFullBenefit: -9 },
      suggestedCoupon: { code: 'B', title: 't', discount: 3, couponId: 'q' },
    });
    expect(out).toMatchObject({ subtotal: 10, total: 12 });
    const present = keysDeep(out);
    for (const k of ['campoInternoFuturo', 'platformGrossRevenue', 'costoInterno', 'margen', 'platformFunded', 'couponId', 'marginApplied', 'marginWithFullBenefit']) {
      expect(present.has(k), k).toBe(false);
    }
    expect(Object.keys(out).every((k) => (CUSTOMER_QUOTE_FIELDS as readonly string[]).includes(k) || ['items', 'coupon', 'suggestedCoupon', 'proBenefitNotice'].includes(k))).toBe(true);
  });

  it('conserva null explícito en cupón y aviso de Pro (el checkout distingue "sin cupón")', () => {
    const out = customerQuoteView({ coupon: null, suggestedCoupon: null, proBenefitNotice: null, items: [] });
    expect(out.coupon).toBeNull();
    expect(out.suggestedCoupon).toBeNull();
    expect(out.proBenefitNotice).toBeNull();
  });
});
