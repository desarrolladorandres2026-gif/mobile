import { describe, it, expect, beforeEach } from 'vitest';
import { Types } from 'mongoose';
import { Order, Coupon, CouponRedemption, Business } from '../models';
import { CouponType, CouponFundedBy, OrderStatus, PaymentMethod, UserRole } from '../types';
import { couponService } from '../services/coupon.service';
import { orderService, ABANDONED_ONLINE_ORDER_MS } from '../services/order.service';
import { pricingService } from '../services/pricing.service';
import {
  GARZON, makeUser, makeBusiness, makeProduct, makeCoupon, makePricingConfig,
} from './factories';

/**
 * Presupuesto de las promociones y quién puede recibirlas.
 *
 * `budgetLimit` es «lo que la campaña puede costarle a quien la financia»: el
 * subsidio de plataforma si la paga ZIPP, lo que sale de la liquidación del
 * comercio si la paga él. Un solo descuento pertenece a uno de los dos, así
 * que nunca se cuenta dos veces.
 */

async function setup(price = 10000) {
  await makePricingConfig();
  const client = await makeUser({ role: UserRole.CLIENT });
  const owner = await makeUser({ role: UserRole.BUSINESS });
  const business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
  const product = await makeProduct(business._id, { price });
  return { client, owner, business, product };
}

const createOrder = (
  ctx: { client: any; business: any; product: any },
  quantity: number,
  extra: Record<string, unknown> = {}
) =>
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

const quoteFor = (
  ctx: { client: any; business: any; product: any },
  quantity: number,
  extra: Record<string, unknown> = {}
) =>
  pricingService.quote({
    userId: ctx.client._id.toString(),
    businessId: ctx.business._id.toString(),
    items: [{ productId: ctx.product._id.toString(), quantity }],
    paymentMethod: PaymentMethod.ONLINE,
    deliveryLatitude: GARZON.lat,
    deliveryLongitude: GARZON.lng,
    ...extra,
  } as never);

const autoPromo = (ctx: { business: any; product: any }, overrides: Record<string, unknown> = {}) =>
  makeCoupon({
    fundedBy: CouponFundedBy.BUSINESS,
    businessId: ctx.business._id,
    campaignApproved: false,
    autoApply: true,
    productIds: [ctx.product._id],
    type: CouponType.PERCENTAGE,
    value: 20,
    perUserLimit: 0,
    ...overrides,
  } as never);

describe('El presupuesto de una promoción del comercio sube con lo que él financia', () => {
  it('una promoción automática gasta su presupuesto con el descuento del pedido', async () => {
    const ctx = await setup();
    const promo = await autoPromo(ctx, { budgetLimit: 50000 });

    await createOrder(ctx, 2); // 20 % de 20.000 = 4.000

    const fresh = await Coupon.findById(promo._id);
    expect(fresh!.budgetSpent).toBe(4000);
    const redemption = await CouponRedemption.findOne({ couponId: promo._id });
    expect(redemption!.discountAmount).toBe(4000);
    expect(redemption!.budgetConsumed).toBe(4000);
  });

  it('un cupón de código del comercio también', async () => {
    const ctx = await setup();
    const coupon = await makeCoupon({
      code: 'MIOCUPON',
      fundedBy: CouponFundedBy.BUSINESS,
      businessId: ctx.business._id,
      campaignApproved: false,
      type: CouponType.FIXED,
      value: 3000,
      budgetLimit: 10000,
    });

    await createOrder(ctx, 2, { couponCode: 'MIOCUPON' });

    expect((await Coupon.findById(coupon._id))!.budgetSpent).toBe(3000);
  });

  it('el de ZIPP gasta el subsidio de plataforma, y solo el del cupón (no el de Zipp Pro ni otro)', async () => {
    const ctx = await setup();
    const coupon = await makeCoupon({ code: 'ZIPP2K', type: CouponType.FIXED, value: 2000, budgetLimit: 20000 });

    await createOrder(ctx, 2, { couponCode: 'ZIPP2K' });

    expect((await Coupon.findById(coupon._id))!.budgetSpent).toBe(2000);
  });

  it('cuando el presupuesto ya no alcanza, la promoción deja de aplicarse en la cotización', async () => {
    const ctx = await setup();
    // 20 % de 20.000 = 4.000 por pedido; el presupuesto alcanza para uno.
    const promo = await autoPromo(ctx, { budgetLimit: 5000 });

    const primero = await quoteFor(ctx, 2);
    expect(primero.promotionDiscount).toBe(4000);
    await createOrder(ctx, 2);

    const segundo = await quoteFor(ctx, 2);
    expect(segundo.promotionDiscount).toBe(0);
    expect((await Coupon.findById(promo._id))!.budgetSpent).toBe(4000);
  });

  it('un cupón de código que no cabe en lo que queda se rechaza al validar', async () => {
    const ctx = await setup();
    await makeCoupon({
      code: 'SINSALDO',
      fundedBy: CouponFundedBy.BUSINESS,
      businessId: ctx.business._id,
      campaignApproved: false,
      type: CouponType.FIXED,
      value: 3000,
      budgetLimit: 4000,
      budgetSpent: 2000,
    });

    await expect(quoteFor(ctx, 2, { couponCode: 'SINSALDO' })).rejects.toThrow(/presupuesto/i);
  });
});

describe('Liberar un canje devuelve exactamente lo que gastó', () => {
  async function redeemed(spend: number, overrides: Record<string, unknown> = {}) {
    const coupon = await makeCoupon({ code: `C${Math.random().toString(36).slice(2, 8)}`.toUpperCase(), budgetLimit: 100000, ...overrides });
    const orderId = new Types.ObjectId().toString();
    const user = await makeUser();
    const ok = await couponService.redeem(coupon._id.toString(), user._id.toString(), orderId, 5000, spend);
    expect(ok).toBe(true);
    return { coupon, orderId };
  }

  it('revierte el consumo del canje, no el descuento ni el subsidio total del pedido', async () => {
    const { coupon, orderId } = await redeemed(3000);
    expect((await Coupon.findById(coupon._id))!.budgetSpent).toBe(3000);

    await couponService.release(orderId);

    const fresh = await Coupon.findById(coupon._id);
    expect(fresh!.budgetSpent).toBe(0);
    expect(fresh!.usedCount).toBe(0);
  });

  it('es idempotente: liberar dos veces no devuelve dos veces', async () => {
    const { coupon, orderId } = await redeemed(3000);
    // Otro canje del mismo cupón que debe seguir contando.
    const other = new Types.ObjectId().toString();
    const user = await makeUser();
    await couponService.redeem(coupon._id.toString(), user._id.toString(), other, 2000, 2000);

    await couponService.release(orderId);
    await couponService.release(orderId);

    const fresh = await Coupon.findById(coupon._id);
    expect(fresh!.budgetSpent).toBe(2000);
    expect(fresh!.usedCount).toBe(1);
  });

  it('un canje que no gastó presupuesto no devuelve nada', async () => {
    const { coupon, orderId } = await redeemed(0, { budgetSpent: 7000 });

    await couponService.release(orderId);

    expect((await Coupon.findById(coupon._id))!.budgetSpent).toBe(7000);
  });

  it('un canje anterior a este campo se lee con la regla con la que se gastó', async () => {
    const platform = await makeCoupon({ code: 'VIEJOPLAT', budgetLimit: 100000, budgetSpent: 4000, usedCount: 1 });
    const orderA = new Types.ObjectId();
    await CouponRedemption.collection.insertOne({
      couponId: platform._id, userId: new Types.ObjectId(), orderId: orderA, discountAmount: 4000, createdAt: new Date(),
    });
    const business = await makeBusiness((await makeUser({ role: UserRole.BUSINESS }))._id);
    const merchant = await makeCoupon({
      code: 'VIEJOCOM',
      fundedBy: CouponFundedBy.BUSINESS,
      businessId: business._id,
      campaignApproved: false,
      budgetLimit: 100000,
      budgetSpent: 0,
      usedCount: 1,
    });
    const orderB = new Types.ObjectId();
    await CouponRedemption.collection.insertOne({
      couponId: merchant._id, userId: new Types.ObjectId(), orderId: orderB, discountAmount: 3000, createdAt: new Date(),
    });

    await couponService.release(orderA.toString());
    await couponService.release(orderB.toString());

    // ZIPP gastó el descuento; el comercio nunca tocó el presupuesto.
    expect((await Coupon.findById(platform._id))!.budgetSpent).toBe(0);
    expect((await Coupon.findById(merchant._id))!.budgetSpent).toBe(0);
  });

  it('cancelar el pedido (por la ruta real de cancelación) libera el presupuesto del comercio', async () => {
    const ctx = await setup();
    const promo = await autoPromo(ctx, { budgetLimit: 50000, usageLimit: 3 });
    await createOrder(ctx, 2);
    expect((await Coupon.findById(promo._id))!.budgetSpent).toBe(4000);

    // Un checkout en línea que nadie paga se cancela solo, por el mismo camino
    // que cualquier cancelación.
    const later = new Date(Date.now() + ABANDONED_ONLINE_ORDER_MS + 60_000);
    expect(await orderService.cancelAbandonedOnlineOrders(later)).toBe(1);

    const fresh = await Coupon.findById(promo._id);
    expect(fresh!.budgetSpent).toBe(0);
    expect(fresh!.usedCount).toBe(0);
    expect(await CouponRedemption.countDocuments({ couponId: promo._id })).toBe(0);
  });
});

describe('Dos canjes simultáneos no pueden pasarse del presupuesto', () => {
  it('con saldo para uno, entra uno', async () => {
    const coupon = await makeCoupon({ code: 'UNSALDO', budgetLimit: 6000 });
    const [a, b] = [await makeUser(), await makeUser()];

    const results = await Promise.all([
      couponService.redeem(coupon._id.toString(), a._id.toString(), new Types.ObjectId().toString(), 4000, 4000),
      couponService.redeem(coupon._id.toString(), b._id.toString(), new Types.ObjectId().toString(), 4000, 4000),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    const fresh = await Coupon.findById(coupon._id);
    expect(fresh!.budgetSpent).toBe(4000);
    expect(fresh!.usedCount).toBe(1);
  });

  it('lo mismo con el presupuesto de un comercio', async () => {
    const business = await makeBusiness((await makeUser({ role: UserRole.BUSINESS }))._id);
    const coupon = await makeCoupon({
      code: 'COMSALDO',
      fundedBy: CouponFundedBy.BUSINESS,
      businessId: business._id,
      campaignApproved: false,
      budgetLimit: 6000,
    });
    const users = await Promise.all([makeUser(), makeUser(), makeUser()]);

    const results = await Promise.all(
      users.map((u) =>
        couponService.redeem(coupon._id.toString(), u._id.toString(), new Types.ObjectId().toString(), 4000, 4000)
      )
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await Coupon.findById(coupon._id))!.budgetSpent).toBe(4000);
  });

  it('un tope de usos que se baja durante el canje se obedece: la escritura mira el valor de ese instante', async () => {
    const coupon = await makeCoupon({ code: 'BAJAUSOS', usageLimit: 5, usedCount: 2 });
    // El administrador baja el tope a lo ya usado.
    await Coupon.updateOne({ _id: coupon._id }, { usageLimit: 2 });
    const user = await makeUser();

    const ok = await couponService.redeem(coupon._id.toString(), user._id.toString(), new Types.ObjectId().toString(), 1000, 0);

    expect(ok).toBe(false);
  });

  it('una promoción apagada entre cotizar y crear no se canjea', async () => {
    const coupon = await makeCoupon({ code: 'APAGADA' });
    await Coupon.updateOne({ _id: coupon._id }, { isActive: false });
    const user = await makeUser();

    expect(
      await couponService.redeem(coupon._id.toString(), user._id.toString(), new Types.ObjectId().toString(), 1000, 0)
    ).toBe(false);
  });

  it('el techo global de campañas de ZIPP tampoco se supera con dos cupones distintos a la vez', async () => {
    await makePricingConfig({ campaignBudgetTotal: 10000 });
    const [one, two] = [
      await makeCoupon({ code: 'CAMPUNO', budgetLimit: 50000 }),
      await makeCoupon({ code: 'CAMPDOS', budgetLimit: 50000 }),
    ];
    const [a, b] = [await makeUser(), await makeUser()];

    const results = await Promise.all([
      couponService.redeem(one._id.toString(), a._id.toString(), new Types.ObjectId().toString(), 6000, 6000),
      couponService.redeem(two._id.toString(), b._id.toString(), new Types.ObjectId().toString(), 6000, 6000),
    ]);

    // Puede entrar uno o ninguno (si se pisan se deshacen los dos), nunca los dos.
    expect(results.filter(Boolean).length).toBeLessThanOrEqual(1);
    const spent = (await Coupon.find({ _id: { $in: [one._id, two._id] } })).reduce((s, c) => s + c.budgetSpent, 0);
    expect(spent).toBeLessThanOrEqual(10000);
  });
});

describe('Promociones automáticas de primer pedido', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let promo: any;

  beforeEach(async () => {
    ctx = await setup();
    promo = await autoPromo(ctx, { firstOrderOnly: true, perUserLimit: 1 });
  });

  it('el cliente que estrena recibe el descuento', async () => {
    const quote = await quoteFor(ctx, 2);
    expect(quote.promotionDiscount).toBe(4000);
    expect(quote.appliedAutoPromotions).toHaveLength(1);
  });

  it('quien ya pidió no lo recibe', async () => {
    const veteran = await makeUser({ role: UserRole.CLIENT });
    await Order.create({
      clientId: veteran._id,
      businessId: ctx.business._id,
      items: [],
      status: OrderStatus.DELIVERED,
      paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
      paymentStatus: 'paid',
      deliveryAddress: 'Calle 1',
      deliveryLocation: { type: 'Point', coordinates: [GARZON.lng, GARZON.lat] },
      subtotal: 1000, deliveryFee: 0, platformCommission: 0,
      businessPayout: 1000, driverPayout: 0, total: 1000,
    });

    const quote = await quoteFor({ ...ctx, client: veteran }, 2);

    expect(quote.promotionDiscount).toBe(0);
    expect(quote.appliedAutoPromotions).toHaveLength(0);
  });

  it('un pedido cancelado no cuenta como primer pedido (la misma definición que el cupón de código)', async () => {
    const cancelled = await makeUser({ role: UserRole.CLIENT });
    await Order.create({
      clientId: cancelled._id,
      businessId: ctx.business._id,
      items: [],
      status: OrderStatus.CANCELLED,
      paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
      paymentStatus: 'pending_cash',
      deliveryAddress: 'Calle 1',
      deliveryLocation: { type: 'Point', coordinates: [GARZON.lng, GARZON.lat] },
      subtotal: 1000, deliveryFee: 0, platformCommission: 0,
      businessPayout: 1000, driverPayout: 0, total: 1000,
    });

    const quote = await quoteFor({ ...ctx, client: cancelled }, 2);

    expect(quote.promotionDiscount).toBe(4000);
  });

  it('la lista pública (carta, inicio, ofertas) no la pinta: depende de quién mira', async () => {
    const shared = await couponService.autoPromotionsFor(ctx.business._id.toString());
    expect(shared.size).toBe(0);

    const personal = await couponService.autoPromotionsFor(ctx.business._id.toString(), new Date(), {
      includePersonal: true,
    });
    expect(personal.get(ctx.product._id.toString())!._id.toString()).toBe(promo._id.toString());

    const across = await couponService.activeAutoPromotionsAcrossBusinesses();
    expect(across.size).toBe(0);
  });

  it('el comercio no puede crearla con más de un uso por persona', async () => {
    const another = await makeProduct(ctx.business._id, { price: 8000 });
    const created = await couponService.createForBusiness(
      ctx.owner._id.toString(),
      ctx.business._id.toString(),
      {
        autoApply: true,
        title: 'Primer pedido',
        type: 'percentage',
        value: 10,
        productIds: [another._id.toString()],
        validUntil: new Date(Date.now() + 7 * 24 * 3600_000),
        firstOrderOnly: true,
        perUserLimit: 0,
      }
    );

    expect(created.firstOrderOnly).toBe(true);
    expect(created.perUserLimit).toBe(1);
  });
});

describe('La lista blanca de lo que un comercio puede fijar', () => {
  it('ignora los campos de ZIPP aunque lleguen en el cuerpo', async () => {
    const ctx = await setup();
    const hostile = await couponService.createForBusiness(
      ctx.owner._id.toString(),
      ctx.business._id.toString(),
      {
        code: 'HOSTIL',
        title: 'Intento',
        type: 'percentage',
        value: 10,
        validUntil: new Date(Date.now() + 7 * 24 * 3600_000),
        fundedBy: CouponFundedBy.PLATFORM,
        campaignApproved: true,
        restrictedToUserId: new Types.ObjectId().toString(),
        eligibleRoles: ['driver'],
        zoneIds: [new Types.ObjectId().toString()],
        usedCount: -5,
        budgetSpent: -9999,
        minimumContributionMargin: -100000,
        scope: 'delivery',
      }
    );

    expect(hostile.fundedBy).toBe(CouponFundedBy.BUSINESS);
    expect(hostile.campaignApproved).toBe(false);
    expect(hostile.restrictedToUserId ?? null).toBeNull();
    expect(hostile.eligibleRoles).toEqual(['client']);
    expect(hostile.zoneIds).toHaveLength(0);
    expect(hostile.usedCount).toBe(0);
    expect(hostile.budgetSpent).toBe(0);
    expect(hostile.minimumContributionMargin).toBe(-1);
    expect(hostile.scope).toBe('product');
  });
});
