import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../app';
import { couponService } from '../services/coupon.service';
import { Coupon, CouponRedemption, Order } from '../models';
import { CouponType, PaymentMethod, PaymentStatus, UserRole } from '../types';
import {
  makeUser, makeBusiness, makeCoupon, makePricingConfig, makeProduct,
  GARZON, offsetKm, authHeader,
} from './factories';

async function context(userId: string, businessId: string, overrides = {}) {
  return {
    userId,
    businessId,
    subtotal: 20000,
    deliveryFee: 5000,
    serviceFee: 0,
    ...overrides,
  };
}

/**
 * Coupon maths now depends on the platform's subsidy ceilings, so every
 * case needs a config. `couponSubsidyLimit: 0` means "no ceiling", which
 * keeps these tests measuring the coupon rules rather than the cap.
 */
async function pricingConfig(overrides: Record<string, unknown> = {}) {
  return makePricingConfig({ couponSubsidyLimit: 0, ...overrides });
}

describe('CouponService.computeDiscount', () => {
  it('aplica un porcentaje sobre el subtotal', async () => {
    const user = await makeUser();
    const owner = await makeUser();
    const business = await makeBusiness(owner._id);
    const coupon = await makeCoupon({ type: CouponType.PERCENTAGE, value: 25 });

    const applied = couponService.computeDiscount(
      coupon,
      await context(user._id.toString(), business._id.toString())
    , await pricingConfig());

    expect(applied.productDiscount).toBe(5000);
    expect(applied.deliveryDiscount).toBe(0);
  });

  it('respeta el tope maxDiscount de un cupón porcentual', async () => {
    const user = await makeUser();
    const owner = await makeUser();
    const business = await makeBusiness(owner._id);
    const coupon = await makeCoupon({
      type: CouponType.PERCENTAGE, value: 50, maxDiscount: 4000,
    });

    const applied = couponService.computeDiscount(
      coupon,
      await context(user._id.toString(), business._id.toString())
    , await pricingConfig());

    expect(applied.productDiscount).toBe(4000);
  });

  it('un cupón fijo nunca supera el subtotal', async () => {
    const user = await makeUser();
    const owner = await makeUser();
    const business = await makeBusiness(owner._id);
    const coupon = await makeCoupon({ type: CouponType.FIXED, value: 999999 });

    const applied = couponService.computeDiscount(
      coupon,
      await context(user._id.toString(), business._id.toString())
    , await pricingConfig());

    expect(applied.productDiscount).toBe(20000);
  });

  it('envío gratis descuenta exactamente el costo de envío', async () => {
    const user = await makeUser();
    const owner = await makeUser();
    const business = await makeBusiness(owner._id);
    const coupon = await makeCoupon({ type: CouponType.FREE_DELIVERY, value: 0 });

    const applied = couponService.computeDiscount(
      coupon,
      await context(user._id.toString(), business._id.toString())
    , await pricingConfig());

    expect(applied.productDiscount).toBe(0);
    expect(applied.deliveryDiscount).toBe(5000);
  });
});

describe('CouponService.validate', () => {
  it('acepta un cupón vigente', async () => {
    const user = await makeUser();
    const owner = await makeUser();
    const business = await makeBusiness(owner._id);
    const coupon = await makeCoupon({ code: 'BIENVENIDO' });

    const applied = await couponService.validate(
      'bienvenido', // el código no distingue mayúsculas
      await context(user._id.toString(), business._id.toString())
    , await pricingConfig());

    expect(applied.code).toBe('BIENVENIDO');
    expect(applied.couponId).toBe(coupon._id.toString());
  });

  it('rechaza un código inexistente', async () => {
    const user = await makeUser();
    const owner = await makeUser();
    const business = await makeBusiness(owner._id);

    await expect(
      couponService.validate('NOEXISTE', await context(user._id.toString(), business._id.toString()), await pricingConfig())
    ).rejects.toThrow(/inválido/i);
  });

  it('rechaza un cupón expirado', async () => {
    const user = await makeUser();
    const owner = await makeUser();
    const business = await makeBusiness(owner._id);
    await makeCoupon({
      code: 'VENCIDO',
      validFrom: new Date(Date.now() - 10 * 24 * 3600_000),
      validUntil: new Date(Date.now() - 24 * 3600_000),
    });

    await expect(
      couponService.validate('VENCIDO', await context(user._id.toString(), business._id.toString()), await pricingConfig())
    ).rejects.toThrow(/expiró/i);
  });

  it('rechaza un cupón que aún no inicia', async () => {
    const user = await makeUser();
    const owner = await makeUser();
    const business = await makeBusiness(owner._id);
    await makeCoupon({
      code: 'FUTURO',
      validFrom: new Date(Date.now() + 24 * 3600_000),
      validUntil: new Date(Date.now() + 10 * 24 * 3600_000),
    });

    await expect(
      couponService.validate('FUTURO', await context(user._id.toString(), business._id.toString()), await pricingConfig())
    ).rejects.toThrow(/aún no está vigente/i);
  });

  it('rechaza un cupón desactivado', async () => {
    const user = await makeUser();
    const owner = await makeUser();
    const business = await makeBusiness(owner._id);
    await makeCoupon({ code: 'APAGADO', isActive: false });

    await expect(
      couponService.validate('APAGADO', await context(user._id.toString(), business._id.toString()), await pricingConfig())
    ).rejects.toThrow(/no está disponible/i);
  });

  it('exige el pedido mínimo', async () => {
    const user = await makeUser();
    const owner = await makeUser();
    const business = await makeBusiness(owner._id);
    await makeCoupon({ code: 'MIN50', minOrderAmount: 50000 });

    await expect(
      couponService.validate('MIN50', await context(user._id.toString(), business._id.toString()), await pricingConfig())
    ).rejects.toThrow(/pedido mínimo/i);
  });

  it('rechaza un cupón de otro negocio', async () => {
    const user = await makeUser();
    const owner = await makeUser();
    const businessA = await makeBusiness(owner._id);
    const businessB = await makeBusiness(owner._id);
    await makeCoupon({ code: 'SOLOB', businessId: businessB._id });

    await expect(
      couponService.validate('SOLOB', await context(user._id.toString(), businessA._id.toString()), await pricingConfig())
    ).rejects.toThrow(/no aplica para este negocio/i);
  });

  it('rechaza cuando se agotó el límite global de usos', async () => {
    const user = await makeUser();
    const owner = await makeUser();
    const business = await makeBusiness(owner._id);
    const coupon = await makeCoupon({ code: 'AGOTADO', usageLimit: 1 });
    coupon.usedCount = 1;
    await coupon.save();

    await expect(
      couponService.validate('AGOTADO', await context(user._id.toString(), business._id.toString()), await pricingConfig())
    ).rejects.toThrow(/límite de usos/i);
  });

  it('rechaza cuando el usuario ya alcanzó su límite personal', async () => {
    const user = await makeUser();
    const owner = await makeUser();
    const business = await makeBusiness(owner._id);
    const coupon = await makeCoupon({ code: 'UNAVEZ', perUserLimit: 1 });

    await CouponRedemption.create({
      couponId: coupon._id,
      userId: user._id,
      orderId: coupon._id, // cualquier ObjectId sirve como referencia aquí
      discountAmount: 1000,
    });

    await expect(
      couponService.validate('UNAVEZ', await context(user._id.toString(), business._id.toString()), await pricingConfig())
    ).rejects.toThrow(/ya usaste/i);
  });

  it('firstOrderOnly rechaza a quien ya tiene pedidos', async () => {
    const user = await makeUser();
    const owner = await makeUser();
    const business = await makeBusiness(owner._id);
    await makeCoupon({ code: 'PRIMERO', firstOrderOnly: true });

    await Order.create({
      clientId: user._id,
      businessId: business._id,
      items: [{ productId: business._id, productName: 'X', quantity: 1, unitPrice: 1000, totalPrice: 1000 }],
      paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
      paymentStatus: PaymentStatus.PENDING,
      deliveryAddress: 'Calle 1',
      deliveryLocation: { type: 'Point', coordinates: [GARZON.lng, GARZON.lat] },
      subtotal: 1000, deliveryFee: 0, platformCommission: 0,
      businessPayout: 1000, driverPayout: 0, total: 1000,
    });

    await expect(
      couponService.validate('PRIMERO', await context(user._id.toString(), business._id.toString()), await pricingConfig())
    ).rejects.toThrow(/primer pedido/i);
  });
});

describe('CouponService.redeem / release', () => {
  it('consume un uso y registra la redención', async () => {
    const user = await makeUser();
    const owner = await makeUser();
    const business = await makeBusiness(owner._id);
    const coupon = await makeCoupon({ code: 'CANJE', usageLimit: 5 });

    const ok = await couponService.redeem(coupon._id.toString(), user._id.toString(), business._id.toString(), 3000, 0);

    expect(ok).toBe(true);
    const refreshed = await Coupon.findById(coupon._id);
    expect(refreshed!.usedCount).toBe(1);
    expect(await CouponRedemption.countDocuments({ couponId: coupon._id })).toBe(1);
  });

  it('no permite superar el límite global', async () => {
    const user = await makeUser();
    const owner = await makeUser();
    const business = await makeBusiness(owner._id);
    const coupon = await makeCoupon({ code: 'UNICO', usageLimit: 1 });

    const first = await couponService.redeem(coupon._id.toString(), user._id.toString(), business._id.toString(), 1000, 0);
    const second = await couponService.redeem(coupon._id.toString(), user._id.toString(), owner._id.toString(), 1000, 0);

    expect(first).toBe(true);
    expect(second).toBe(false);
    const refreshed = await Coupon.findById(coupon._id);
    expect(refreshed!.usedCount).toBe(1);
  });

  it('release devuelve el uso al cancelar el pedido', async () => {
    const user = await makeUser();
    const owner = await makeUser();
    const business = await makeBusiness(owner._id);
    const coupon = await makeCoupon({ code: 'DEVUELTO', usageLimit: 5 });

    await couponService.redeem(coupon._id.toString(), user._id.toString(), business._id.toString(), 2000, 0);
    await couponService.release(business._id.toString());

    const refreshed = await Coupon.findById(coupon._id);
    expect(refreshed!.usedCount).toBe(0);
    expect(await CouponRedemption.countDocuments({ couponId: coupon._id })).toBe(0);
  });
});

describe('CouponService.getPublic', () => {
  it('sólo devuelve cupones públicos, activos y vigentes', async () => {
    await makeCoupon({ code: 'PUBLICO', isPublic: true });
    await makeCoupon({ code: 'PRIVADO', isPublic: false });
    await makeCoupon({ code: 'INACTIVO', isPublic: true, isActive: false });
    await makeCoupon({
      code: 'EXPIRADO',
      isPublic: true,
      validFrom: new Date(Date.now() - 10 * 24 * 3600_000),
      validUntil: new Date(Date.now() - 3600_000),
    });

    const codes = (await couponService.getPublic()).map((c) => c.code);

    expect(codes).toEqual(['PUBLICO']);
  });

  it('oculta los cupones que ya se agotaron', async () => {
    const coupon = await makeCoupon({ code: 'SINCUPOS', isPublic: true, usageLimit: 2 });
    coupon.usedCount = 2;
    await coupon.save();

    expect(await couponService.getPublic()).toHaveLength(0);
  });
});

/**
 * Regresión: el validador de `POST/PATCH /coupons` no declaraba `fundedBy`,
 * `scope`, `budgetLimit`, `maxDiscountAmount` ni `minimumContributionMargin`.
 * Zod descarta en silencio las claves que un esquema no declara, así que un
 * administrador que pedía "cupón financiado por el comercio, presupuesto de
 * $50.000" terminaba con un cupón financiado por la plataforma y sin tope de
 * gasto — sin ningún error que lo avisara. Estas pruebas fijan que la API
 * en verdad persiste lo que el administrador pidió.
 */
describe('POST /api/v1/coupons — financiación y presupuesto', () => {
  async function admin(overrides: Record<string, unknown> = {}) {
    return makeUser({ role: UserRole.ADMIN, ...overrides });
  }

  it('persiste fundedBy, scope, budgetLimit y maxDiscountAmount tal como se enviaron', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id);
    const adminUser = await admin();

    const res = await request(app)
      .post('/api/v1/coupons')
      .set(await authHeader(adminUser))
      .send({
        code: 'PRUEBAFONDO',
        title: 'Prueba de financiación',
        type: 'percentage',
        value: 20,
        fundedBy: 'business',
        scope: 'product',
        businessId: business._id.toString(),
        budgetLimit: 50000,
        maxDiscountAmount: 8000,
        minimumContributionMargin: 1500,
        validUntil: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      })
      .expect(201);

    expect(res.body.data.fundedBy).toBe('business');
    expect(res.body.data.scope).toBe('product');
    expect(res.body.data.budgetLimit).toBe(50000);
    expect(res.body.data.maxDiscountAmount).toBe(8000);
    expect(res.body.data.minimumContributionMargin).toBe(1500);

    // Y lo que quedó en la base de datos es lo mismo que respondió la API,
    // no el valor por defecto que se aplicaba antes del arreglo.
    const stored = await Coupon.findOne({ code: 'PRUEBAFONDO' });
    expect(stored!.fundedBy).toBe('business');
    expect(stored!.budgetLimit).toBe(50000);
  });

  it('rechaza campaignApproved sin permisos de administrador financiero', async () => {
    const adminSinFinanzas = await admin({ isFinanceAdmin: false });

    const res = await request(app)
      .post('/api/v1/coupons')
      .set(await authHeader(adminSinFinanzas))
      .send({
        code: 'BAJOMARGEN',
        title: 'Campaña bajo margen',
        type: 'fixed',
        value: 5000,
        campaignApproved: true,
        validUntil: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      })
      .expect(403);

    expect(res.body.message).toMatch(/administrador financiero/i);
    expect(await Coupon.findOne({ code: 'BAJOMARGEN' })).toBeNull();
  });

  it('permite campaignApproved a un administrador financiero', async () => {
    const adminFinanciero = await admin({ isFinanceAdmin: true });

    await request(app)
      .post('/api/v1/coupons')
      .set(await authHeader(adminFinanciero))
      .send({
        code: 'CAMPANAOK',
        title: 'Campaña aprobada',
        type: 'fixed',
        value: 5000,
        campaignApproved: true,
        validUntil: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      })
      .expect(201);

    const stored = await Coupon.findOne({ code: 'CAMPANAOK' });
    expect(stored!.campaignApproved).toBe(true);
  });
});

describe('GET /api/v1/coupons/:id/redemptions', () => {
  it('reporta quién usó el cupón, cuándo y cuánto se descontó', async () => {
    await makePricingConfig();
    const client = await makeUser({ role: UserRole.CLIENT });
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id);
    const product = await makeProduct(business._id, { price: 20000 });
    const adminUser = await makeUser({ role: UserRole.ADMIN });
    const coupon = await makeCoupon({ code: 'HISTORIAL', type: CouponType.FIXED, value: 5000 });

    const destination = offsetKm(GARZON, 2);
    await request(app)
      .post('/api/v1/orders')
      .set(await authHeader(client))
      .send({
        businessId: business._id.toString(),
        items: [{ productId: product._id.toString(), quantity: 1 }],
        paymentMethod: 'online',
        deliveryAddress: 'Calle 5 # 3-21, Garzón',
        deliveryLatitude: destination.lat,
        deliveryLongitude: destination.lng,
        couponCode: 'HISTORIAL',
      })
      .expect(201);

    const res = await request(app)
      .get(`/api/v1/coupons/${coupon._id}/redemptions`)
      .set(await authHeader(adminUser))
      .expect(200);

    expect(res.body.data.usedCount).toBe(1);
    expect(res.body.data.totalDiscounted).toBe(5000);
    expect(res.body.data.redemptions).toHaveLength(1);
    expect(res.body.data.redemptions[0].discountAmount).toBe(5000);
    expect(res.body.data.redemptions[0].userId?.name).toBe(client.name);
  });

  it('lo rechaza a cualquiera que no sea administrador', async () => {
    const client = await makeUser({ role: UserRole.CLIENT });
    const coupon = await makeCoupon({ code: 'PRIVADOHIST' });

    await request(app)
      .get(`/api/v1/coupons/${coupon._id}/redemptions`)
      .set(await authHeader(client))
      .expect(403);
  });
});

/**
 * El límite por usuario, cuando dos pedidos salen a la vez.
 *
 * `validate()` cuenta los canjes previos del usuario, pero eso pasa
 * mientras se cotiza; `redeem()` reclama el cupón con una escritura
 * condicional que solo mira el tope global y el presupuesto. En medio hay
 * un hueco, y no es teórico: la app reintenta sola cuando la red va mal, y
 * dos peticiones de creación de pedido con el mismo cupón pasan las dos
 * por la cotización antes de que ninguna haya canjeado nada.
 *
 * Con `usageLimit: 0` —promoción sin tope global, que es lo normal en una
 * campaña de bienvenida— nada más lo detenía: el descuento se concedía
 * tantas veces como peticiones simultáneas se lanzaran.
 */
describe('CouponService.redeem — concurrencia', () => {
  it('respeta el límite por usuario aunque dos canjes lleguen a la vez', async () => {
    await pricingConfig();
    const user = await makeUser();
    const coupon = await makeCoupon({
      code: 'UNOPORCABEZA',
      perUserLimit: 1,
      // Sin tope global: es el `perUserLimit` lo que se prueba, y con un
      // tope global el reclamo atómico lo taparía por accidente.
      usageLimit: 0,
    });

    const results = await Promise.all([
      couponService.redeem(coupon._id.toString(), user._id.toString(), 'aaaaaaaaaaaaaaaaaaaaaaa1', 5000, 5000),
      couponService.redeem(coupon._id.toString(), user._id.toString(), 'aaaaaaaaaaaaaaaaaaaaaaa2', 5000, 5000),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);

    const canjes = await CouponRedemption.countDocuments({
      couponId: coupon._id,
      userId: user._id,
    });
    expect(canjes).toBe(1);

    // Y los contadores del cupón no pueden quedarse contando el canje que
    // se deshizo: si `usedCount` sube de más, la campaña se cierra antes
    // de tiempo para todos los demás.
    const fresco = await Coupon.findById(coupon._id);
    expect(fresco!.usedCount).toBe(1);
    expect(fresco!.budgetSpent).toBe(5000);
  });

  it('deja pasar los dos canjes cuando el límite por usuario lo permite', async () => {
    await pricingConfig();
    const user = await makeUser();
    const coupon = await makeCoupon({ code: 'DOSPORCABEZA', perUserLimit: 2, usageLimit: 0 });

    const results = await Promise.all([
      couponService.redeem(coupon._id.toString(), user._id.toString(), 'bbbbbbbbbbbbbbbbbbbbbbb1', 5000, 0),
      couponService.redeem(coupon._id.toString(), user._id.toString(), 'bbbbbbbbbbbbbbbbbbbbbbb2', 5000, 0),
    ]);

    expect(results.filter(Boolean)).toHaveLength(2);
    expect(await CouponRedemption.countDocuments({ couponId: coupon._id })).toBe(2);
  });
});
