import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../app';
import { Order, CouponRedemption } from '../models';
import { CouponType, CouponFundedBy, OrderStatus, PaymentMethod, PaymentStatus, UserRole } from '../types';
import {
  GARZON, offsetKm, makeUser, makeBusiness, makeProduct, makeCoupon, makePricingConfig, authHeader,
} from './factories';

/**
 * Descubrir un cupón y poder usarlo son dos cosas distintas.
 *
 * La pestaña de Descuentos enseñaba cupones que no eran para quien los
 * miraba —ya gastados, de primer pedido para quien lleva veinte— y otros
 * que sí eran suyos pero solo servían a cierta hora, sin decirlo. Aquí se
 * fija qué se anuncia, qué se esconde y qué se responde cuando alguien
 * pregunta si un cupón es suyo.
 */

const DESTINATION = offsetKm(GARZON, 2);

async function scenario() {
  await makePricingConfig({ couponSubsidyLimit: 0 });
  const client = await makeUser({ role: UserRole.CLIENT });
  const owner = await makeUser({ role: UserRole.BUSINESS });
  const business = await makeBusiness(owner._id);
  const product = await makeProduct(business._id, { price: 20000 });
  return { client, owner, business, product };
}

const quoteBody = (business: any, product: any, extra: Record<string, unknown> = {}) => ({
  businessId: business._id.toString(),
  items: [{ productId: product._id.toString(), quantity: 2 }],
  paymentMethod: 'online',
  deliveryAddress: 'Calle 5 # 3-21, Garzón',
  deliveryLatitude: DESTINATION.lat,
  deliveryLongitude: DESTINATION.lng,
  ...extra,
});

describe('GET /api/v1/offers — qué sale y qué no', () => {
  it('no expone la economía de la campaña', async () => {
    await makeCoupon({
      isPublic: true,
      budgetLimit: 500_000,
      budgetSpent: 120_000,
      minimumContributionMargin: 3000,
      fundedBy: CouponFundedBy.PLATFORM,
    });

    const res = await request(app)
      .get('/api/v1/offers')
      .query({ lat: GARZON.lat, lng: GARZON.lng })
      .expect(200);

    const [coupon] = res.body.data.coupons;
    expect(coupon.code).toBeTruthy();

    // Cuánto subsidia Zipp y con qué margen no es asunto de quien pide
    // comida. `/coupons/public` ya lo escondía; `/offers` mandaba el
    // documento entero.
    for (const leak of [
      'budgetLimit', 'budgetSpent', 'fundedBy',
      'minimumContributionMargin', 'campaignApproved', 'restrictedToUserId',
    ]) {
      expect(coupon).not.toHaveProperty(leak);
    }

    // El cupo sí: es la escasez que el cliente necesita ver.
    expect(coupon).toHaveProperty('usedCount');
    expect(coupon).toHaveProperty('availability');
  });

  it('anuncia la franja horaria en vez de callársela', async () => {
    await makeCoupon({
      isPublic: true,
      validFromTime: '03:30',
      validUntilTime: '03:31',
    });

    const res = await request(app)
      .get('/api/v1/offers')
      .query({ lat: GARZON.lat, lng: GARZON.lng })
      .expect(200);

    const [coupon] = res.body.data.coupons;

    // Antes este cupón salía sin horario y fallaba al pagar; ahora dice a
    // qué hora sirve, esté abierto o cerrado en este instante.
    expect(coupon.availability.window).toEqual({ from: '03:30', to: '03:31', days: [] });
    expect(['active', 'scheduled']).toContain(coupon.availability.state);
  });

  it('un cupón sin cupo desaparece de la lista', async () => {
    await makeCoupon({ isPublic: true, usageLimit: 5, usedCount: 5 });

    const res = await request(app)
      .get('/api/v1/offers')
      .query({ lat: GARZON.lat, lng: GARZON.lng })
      .expect(200);

    expect(res.body.data.coupons).toHaveLength(0);
  });
});

describe('GET /api/v1/coupons/eligibility', () => {
  it('exige sesión', async () => {
    await request(app).get('/api/v1/coupons/eligibility').expect(401);
  });

  it('dice que sí cuando el cupón es usable', async () => {
    const { client } = await scenario();
    const coupon = await makeCoupon({ isPublic: true });

    const res = await request(app)
      .get('/api/v1/coupons/eligibility')
      .set(await authHeader(client))
      .expect(200);

    expect(res.body.data).toEqual([
      { couponId: coupon._id.toString(), usable: true },
    ]);
  });

  it('marca el que ya se gastó, con su motivo', async () => {
    const { client } = await scenario();
    const coupon = await makeCoupon({ isPublic: true, perUserLimit: 1 });
    const someOrder = await makeUser();

    await CouponRedemption.create({
      couponId: coupon._id,
      userId: client._id,
      orderId: someOrder._id,
      discountAmount: 2000,
    });

    const res = await request(app)
      .get('/api/v1/coupons/eligibility')
      .set(await authHeader(client))
      .expect(200);

    expect(res.body.data[0]).toEqual({
      couponId: coupon._id.toString(),
      usable: false,
      reason: 'already_used',
    });
  });

  it('marca el de primer pedido para quien ya pidió', async () => {
    const { client, business, product } = await scenario();
    await makeCoupon({ isPublic: true, firstOrderOnly: true });

    await Order.create({
      clientId: client._id,
      businessId: business._id,
      items: [{
        productId: product._id,
        productName: product.name,
        quantity: 1,
        unitPrice: 20000,
        totalPrice: 20000,
      }],
      status: OrderStatus.DELIVERED,
      paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
      paymentStatus: PaymentStatus.PAID,
      subtotal: 20000,
      deliveryFee: 3000,
      total: 23000,
      businessPayout: 17000,
      driverPayout: 3000,
      platformCommission: 3000,
      deliveryAddress: 'Calle 5',
      deliveryLatitude: GARZON.lat,
      deliveryLongitude: GARZON.lng,
    } as never);

    const res = await request(app)
      .get('/api/v1/coupons/eligibility')
      .set(await authHeader(client))
      .expect(200);

    expect(res.body.data[0].reason).toBe('not_first_order');
  });

  it('nunca devuelve una cifra', async () => {
    const { client } = await scenario();
    await makeCoupon({ isPublic: true, type: CouponType.FIXED, value: 7000 });

    const res = await request(app)
      .get('/api/v1/coupons/eligibility')
      .set(await authHeader(client))
      .expect(200);

    // `/coupons/validate` se desactivó justo por aceptar y devolver dinero
    // fuera de la cotización. Esta ruta no puede reintroducirlo por la
    // puerta de atrás.
    const serialized = JSON.stringify(res.body.data);
    expect(serialized).not.toContain('7000');
    expect(serialized).not.toMatch(/discount|value|amount/i);
  });
});

describe('El mejor cupón para el carrito', () => {
  it('sugiere el que más ahorra, no el primero que encuentra', async () => {
    const { client, business, product } = await scenario();

    await makeCoupon({ code: 'PEQUENO', isPublic: true, type: CouponType.FIXED, value: 2000 });
    const big = await makeCoupon({
      code: 'GRANDE', isPublic: true, type: CouponType.FIXED, value: 9000,
    });

    const res = await request(app)
      .post('/api/v1/orders/quote')
      .set(await authHeader(client))
      .send(quoteBody(business, product))
      .expect(200);

    expect(res.body.data.suggestedCoupon).toMatchObject({
      code: big.code,
      discount: 9000,
    });
  });

  it('no sugiere nada cuando el cliente ya trajo cupón', async () => {
    const { client, business, product } = await scenario();
    const coupon = await makeCoupon({ isPublic: true, type: CouponType.FIXED, value: 3000 });

    const res = await request(app)
      .post('/api/v1/orders/quote')
      .set(await authHeader(client))
      .send(quoteBody(business, product, { couponCode: coupon.code }))
      .expect(200);

    expect(res.body.data.coupon.code).toBe(coupon.code);
    expect(res.body.data.suggestedCoupon).toBeNull();
  });

  it('nunca sugiere uno que el suelo de margen va a rechazar', async () => {
    const { client, business, product } = await scenario();

    // Se come todo el ingreso de la plataforma y no está aprobado: si se
    // ofreciera, aplicarlo devolvería 422 y el botón "Aplicar" rompería el
    // checkout en la cara del cliente.
    await makeCoupon({
      code: 'IMPOSIBLE',
      isPublic: true,
      type: CouponType.FIXED,
      value: 30000,
      minimumContributionMargin: 50_000,
      campaignApproved: false,
      fundedBy: CouponFundedBy.PLATFORM,
    });

    const quote = await request(app)
      .post('/api/v1/orders/quote')
      .set(await authHeader(client))
      .send(quoteBody(business, product))
      .expect(200);

    expect(quote.body.data.suggestedCoupon).toBeNull();

    // Y en efecto: aplicarlo a mano lo rechaza.
    await request(app)
      .post('/api/v1/orders/quote')
      .set(await authHeader(client))
      .send(quoteBody(business, product, { couponCode: 'IMPOSIBLE' }))
      .expect(422);
  });

  it('tiene en cuenta los cupones propios, que no salen en ninguna lista pública', async () => {
    const { client, business, product } = await scenario();

    const own = await makeCoupon({
      code: 'PTSMIO',
      isPublic: false,
      type: CouponType.FIXED,
      value: 5000,
      restrictedToUserId: client._id,
    });

    const res = await request(app)
      .post('/api/v1/orders/quote')
      .set(await authHeader(client))
      .send(quoteBody(business, product))
      .expect(200);

    expect(res.body.data.suggestedCoupon.code).toBe(own.code);
  });
});

describe('Techo global de gasto promocional', () => {
  async function budgetScenario(campaignBudgetTotal: number) {
    await makePricingConfig({ couponSubsidyLimit: 0, campaignBudgetTotal });
    const client = await makeUser({ role: UserRole.CLIENT });
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id);
    const product = await makeProduct(business._id, { price: 20000 });
    return { client, business, product };
  }

  it('frena un cupón de plataforma cuando el presupuesto de todas se agotó', async () => {
    const { client, business, product } = await budgetScenario(10_000);

    // Otra campaña ya se gastó el presupuesto global. Antes esto no lo
    // miraba nadie: con veinte campañas de dos millones el tope real eran
    // cuarenta, no el número que finanzas creía haber puesto.
    await makeCoupon({ code: 'GASTADA', fundedBy: CouponFundedBy.PLATFORM, budgetSpent: 10_000 });

    const coupon = await makeCoupon({
      code: 'NUEVA', type: CouponType.FIXED, value: 4000, fundedBy: CouponFundedBy.PLATFORM,
    });

    const res = await request(app)
      .post('/api/v1/orders/quote')
      .set(await authHeader(client))
      .send(quoteBody(business, product, { couponCode: coupon.code }))
      .expect(400);

    expect(res.body.message).toMatch(/promociones/i);
  });

  it('en 0 no hay techo, que es el valor de fábrica', async () => {
    const { client, business, product } = await budgetScenario(0);

    await makeCoupon({ code: 'GASTADA2', fundedBy: CouponFundedBy.PLATFORM, budgetSpent: 9_000_000 });
    const coupon = await makeCoupon({
      code: 'NUEVA2', type: CouponType.FIXED, value: 4000, fundedBy: CouponFundedBy.PLATFORM,
    });

    const res = await request(app)
      .post('/api/v1/orders/quote')
      .set(await authHeader(client))
      .send(quoteBody(business, product, { couponCode: coupon.code }))
      .expect(200);

    expect(res.body.data.coupon.code).toBe(coupon.code);
  });
});
