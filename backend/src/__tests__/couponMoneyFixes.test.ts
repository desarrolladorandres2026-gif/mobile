import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { ProSubscription, ProSubscriptionStatus } from '../models';
import { CouponType, CouponFundedBy, CouponScope, PaymentMethod, UserRole } from '../types';
import { couponService } from '../services/coupon.service';
import { pricingConfigService } from '../services/pricingConfig.service';
import { pricingService, COUPON_FUNDING_TIE_BAND } from '../services/pricing.service';
import { PRO_PLAN } from '../config/pro';
import {
  GARZON, makeUser, makeBusiness, makeProduct, makeCoupon, makePricingConfig,
} from './factories';

/**
 * Tres arreglos de dinero de cupones:
 *  - el techo que la app anuncia es el mismo con el que se cobra (C2);
 *  - a igualdad práctica de ahorro gana el cupón que paga el comercio (C3);
 *  - el "ahorro" que se sugiere es el real del cliente, no el bruto del
 *    cupón: con Zipp Pro un cupón de envío no ahorra nada (C4).
 */

const DAY = 24 * 60 * 60_000;

describe('C2 — el techo de un cupón sale resuelto', () => {
  const ctx = (subtotal: number) => ({
    userId: '507f1f77bcf86cd799439011',
    businessId: '507f1f77bcf86cd799439012',
    subtotal,
    deliveryFee: 5000,
    serviceFee: 1000,
    zoneId: null,
    userRole: 'client',
  });

  it('un porcentaje de plataforma con maxDiscount 0 anuncia el límite de subsidio', async () => {
    await makePricingConfig({ couponSubsidyLimit: 10_000 });
    const cfg = await pricingConfigService.getCurrent();
    const coupon = await makeCoupon({
      type: CouponType.PERCENTAGE, value: 20, maxDiscount: 0, fundedBy: CouponFundedBy.PLATFORM,
    });

    const view = couponService.publicView(coupon, cfg);
    expect(view.maxDiscount).toBe(10_000);

    // Y es exactamente donde corta el cobro.
    const applied = couponService.computeDiscount(coupon, ctx(1_000_000), cfg);
    expect(applied.totalDiscount).toBe(view.maxDiscount);
  });

  it('un cupón del comercio no hereda el límite de subsidio de la plataforma', async () => {
    await makePricingConfig({ couponSubsidyLimit: 10_000 });
    const cfg = await pricingConfigService.getCurrent();
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id);
    const coupon = await makeCoupon({
      type: CouponType.PERCENTAGE, value: 20, maxDiscount: 0,
      fundedBy: CouponFundedBy.BUSINESS, businessId: business._id,
    });

    expect(couponService.publicView(coupon, cfg).maxDiscount).toBe(0);
  });

  it('sale el menor de los topes que aplican', async () => {
    await makePricingConfig({ couponSubsidyLimit: 10_000 });
    const cfg = await pricingConfigService.getCurrent();

    const a = await makeCoupon({
      type: CouponType.PERCENTAGE, value: 20, maxDiscount: 6000, maxDiscountAmount: 8000,
    });
    expect(couponService.publicView(a, cfg).maxDiscount).toBe(6000);

    const b = await makeCoupon({
      type: CouponType.PERCENTAGE, value: 20, maxDiscount: 9000, maxDiscountAmount: 4000,
    });
    const view = couponService.publicView(b, cfg);
    expect(view.maxDiscount).toBe(4000);
    expect(couponService.computeDiscount(b, ctx(1_000_000), cfg).totalDiscount).toBe(4000);
  });

  it('un cupón fijo también lleva el techo con el que corta el cobro', async () => {
    await makePricingConfig({ couponSubsidyLimit: 10_000 });
    const cfg = await pricingConfigService.getCurrent();
    const coupon = await makeCoupon({ type: CouponType.FIXED, value: 15_000 });

    const view = couponService.publicView(coupon, cfg);
    expect(view.maxDiscount).toBe(10_000);
    expect(couponService.computeDiscount(coupon, ctx(1_000_000), cfg).totalDiscount).toBe(10_000);
  });

  it('sin ningún tope el techo es 0, y GET /coupons/public no filtra fundedBy ni el límite', async () => {
    await makePricingConfig({ couponSubsidyLimit: 0 });
    await makeCoupon({ isPublic: true, type: CouponType.PERCENTAGE, value: 15 });

    const res = await request(app).get('/api/v1/coupons/public').expect(200);
    const [coupon] = res.body.data;
    expect(coupon.maxDiscount).toBe(0);
    expect(coupon).not.toHaveProperty('fundedBy');
    expect(coupon).not.toHaveProperty('couponSubsidyLimit');
  });

  it('GET /coupons/public anuncia el límite de subsidio como techo', async () => {
    await makePricingConfig({ couponSubsidyLimit: 10_000 });
    await makeCoupon({
      isPublic: true, type: CouponType.PERCENTAGE, value: 20, maxDiscount: 0,
      fundedBy: CouponFundedBy.PLATFORM,
    });

    const res = await request(app).get('/api/v1/coupons/public').expect(200);
    expect(res.body.data[0].maxDiscount).toBe(10_000);
  });
});

describe('C2 — /offers tampoco filtra la economía al resolver el techo', () => {
  it('anuncia el techo efectivo sin exponer fundedBy ni el límite de subsidio', async () => {
    await makePricingConfig({ couponSubsidyLimit: 10_000 });
    await makeCoupon({
      isPublic: true, type: CouponType.PERCENTAGE, value: 20, maxDiscount: 0,
      fundedBy: CouponFundedBy.PLATFORM,
    });

    const res = await request(app)
      .get('/api/v1/offers')
      .query({ lat: GARZON.lat, lng: GARZON.lng })
      .expect(200);

    const [coupon] = res.body.data.coupons;
    expect(coupon.maxDiscount).toBe(10_000);
    for (const leak of ['fundedBy', 'couponSubsidyLimit', 'maxDiscountAmount', 'budgetLimit', 'budgetSpent']) {
      expect(coupon).not.toHaveProperty(leak);
    }
  });

  it('GET /coupons/public con techo efectivo tampoco filtra fundedBy', async () => {
    await makePricingConfig({ couponSubsidyLimit: 10_000 });
    await makeCoupon({
      isPublic: true, type: CouponType.FIXED, value: 15_000, fundedBy: CouponFundedBy.PLATFORM,
    });

    const res = await request(app).get('/api/v1/coupons/public').expect(200);
    const [coupon] = res.body.data;
    expect(coupon.maxDiscount).toBe(10_000);
    for (const leak of ['fundedBy', 'couponSubsidyLimit', 'maxDiscountAmount', 'budgetLimit']) {
      expect(coupon).not.toHaveProperty(leak);
    }
  });
});

describe('C3 y C4 — qué cupón se sugiere', () => {
  let client: any;
  let business: any;
  let product: any;

  const suggest = async () => {
    const quote = await pricingService.quote({
      userId: client._id.toString(),
      businessId: business._id.toString(),
      // Cinco unidades: por encima del mínimo de envío gratis de Zipp Pro.
      items: [{ productId: product._id.toString(), quantity: 5 }],
      paymentMethod: PaymentMethod.ONLINE,
      deliveryLatitude: GARZON.lat,
      deliveryLongitude: GARZON.lng,
    } as never);
    return quote.suggestedCoupon;
  };

  beforeEach(async () => {
    await makePricingConfig({ couponSubsidyLimit: 0 });
    client = await makeUser({ role: UserRole.CLIENT });
    const owner = await makeUser({ role: UserRole.BUSINESS });
    business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
    product = await makeProduct(business._id, {
      price: Math.max(1000, Math.ceil(PRO_PLAN.benefits.freeDelivery.minSubtotal / 4)),
    });
  });

  const merchantCoupon = (code: string, value: number) =>
    makeCoupon({
      code, isPublic: true, type: CouponType.FIXED, value,
      fundedBy: CouponFundedBy.BUSINESS, businessId: business._id,
    });

  const platformCoupon = (code: string, value: number) =>
    makeCoupon({
      code, isPublic: true, type: CouponType.FIXED, value, fundedBy: CouponFundedBy.PLATFORM,
    });

  describe('C3 — desempate por financiador', () => {
    it('a ahorro casi igual, gana el que paga el comercio', async () => {
      await platformCoupon('PLAT', 9000);
      await merchantCoupon('COMERCIO', 9000 - COUPON_FUNDING_TIE_BAND);

      const suggested = await suggest();
      expect(suggested?.code).toBe('COMERCIO');
      expect(suggested?.discount).toBe(9000 - COUPON_FUNDING_TIE_BAND);
    });

    it('a ahorro exactamente igual, también gana el del comercio', async () => {
      await platformCoupon('PLAT', 5000);
      await merchantCoupon('COMERCIO', 5000);

      expect((await suggest())?.code).toBe('COMERCIO');
    });

    it('si el del comercio ahorra bastante menos, gana el de plataforma', async () => {
      await platformCoupon('PLAT', 9000);
      await merchantCoupon('COMERCIO', 9000 - COUPON_FUNDING_TIE_BAND - 1);

      expect((await suggest())?.code).toBe('PLAT');
    });

    it('si el mejor ya es del comercio, no se busca más', async () => {
      await merchantCoupon('COMERCIO', 9000);
      await platformCoupon('PLAT', 8000);

      expect((await suggest())?.code).toBe('COMERCIO');
    });

    it('con tres candidatos gana el cupón del comercio que más ahorra dentro de la banda', async () => {
      await platformCoupon('PLAT_A', 10_000);
      await merchantCoupon('COM_B', 8500);
      await merchantCoupon('COM_C', 9000);

      const suggested = await suggest();
      expect(suggested).toMatchObject({ code: 'COM_C', discount: 9000 });
    });

    it('la banda se ancla al mejor ahorro, no se encadena: es un escalón, no una cadena', async () => {
      // P1 12000 y P2 10500 son de plataforma; M (8600) queda a 3400 de P1,
      // fuera de la banda, aunque solo a 1900 de P2. Gana P1.
      await platformCoupon('PLAT_1', 12_000);
      await platformCoupon('PLAT_2', 10_500);
      await merchantCoupon('COM_M', 8600);

      expect((await suggest())?.code).toBe('PLAT_1');
    });

    it('el borde de la banda es inclusivo (el otro lado ya está cubierto arriba con -1)', async () => {
      // Documenta el escalón actual, no lo aplaude: con la banda en 2000, un
      // comercio a 2000 gana y a 2001 pierde.
      await platformCoupon('PLAT', 10_000);
      await merchantCoupon('EN_BORDE', 10_000 - COUPON_FUNDING_TIE_BAND);
      expect((await suggest())?.code).toBe('EN_BORDE');
    });
  });

  describe('C4 — ahorro incremental con Zipp Pro', () => {
    const makeMember = () =>
      ProSubscription.create({
        userId: client._id,
        status: ProSubscriptionStatus.ACTIVE,
        planId: PRO_PLAN.id,
        price: PRO_PLAN.price,
        currency: PRO_PLAN.currency,
        startedAt: new Date(),
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 15 * DAY),
        autoRenew: true,
      });

    const freeDelivery = () =>
      makeCoupon({
        code: 'ENVIO', isPublic: true, type: CouponType.FREE_DELIVERY,
        scope: CouponScope.DELIVERY, fundedBy: CouponFundedBy.PLATFORM,
      });

    it('sin membresía, el envío gratis sí ahorra y se sugiere', async () => {
      await freeDelivery();

      const suggested = await suggest();
      expect(suggested?.code).toBe('ENVIO');
      expect(suggested?.discount).toBeGreaterThan(0);
    });

    it('siendo Pro, un cupón que solo descuenta el envío ahorra 0 y no se sugiere', async () => {
      await makeMember();
      await freeDelivery();

      expect(await suggest()).toBeNull();
    });

    it('siendo Pro, se sugiere el que sí baja el total, con su ahorro real', async () => {
      await makeMember();
      await freeDelivery();
      await platformCoupon('PRODUCTO', 1000);

      const suggested = await suggest();
      expect(suggested).toMatchObject({ code: 'PRODUCTO', discount: 1000 });
    });

    describe('cupón de alcance SERVICE_FEE y tarifa perdonada por Pro', () => {
      const FEE = 3000;
      const feeCoupon = () =>
        makeCoupon({
          code: 'TARIFA', isPublic: true, type: CouponType.FIXED, value: 1000,
          scope: CouponScope.SERVICE_FEE, fundedBy: CouponFundedBy.PLATFORM,
        });

      const input = (couponCode?: string) => ({
        userId: client._id.toString(),
        businessId: business._id.toString(),
        items: [{ productId: product._id.toString(), quantity: 5 }],
        paymentMethod: PaymentMethod.ONLINE,
        deliveryLatitude: GARZON.lat,
        deliveryLongitude: GARZON.lng,
        suggest: false,
        couponCode,
      } as never);

      beforeEach(async () => {
        await makePricingConfig({ couponSubsidyLimit: 0, serviceFeeFixed: FEE });
      });

      it('sin membresía, el cupón de tarifa ahorra lo que descuenta y se sugiere', async () => {
        await feeCoupon();

        expect(await suggest()).toMatchObject({ code: 'TARIFA', discount: 1000 });
      });

      it('siendo Pro, ese cupón ahorra 0 (la tarifa ya iba a $0) y no se sugiere', async () => {
        await makeMember();
        await feeCoupon();

        expect(await suggest()).toBeNull();
      });

      it('siendo Pro, aplicarlo a mano no perdona la tarifa dos veces ni cambia el total', async () => {
        await makeMember();
        await feeCoupon();

        const without = await pricingService.quote(input());
        const withCoupon = await pricingService.quote(input('TARIFA'));

        expect(without.customerServiceFee).toBe(FEE);
        expect(without.proServiceFeeDiscount).toBe(FEE);

        // La membresía perdona solo lo que el cupón no cubrió: entre los dos
        // suman exactamente la tarifa, nunca más (tarifa a pagar negativa).
        expect(withCoupon.proServiceFeeDiscount).toBe(FEE - 1000);
        expect(withCoupon.customerTotal).toBe(without.customerTotal);
        // Y el cupón le costó a ZIPP lo mismo que sin él: no hay gasto doble.
        expect(withCoupon.platformPromotionExpense).toBe(without.platformPromotionExpense);
      });
    });
  });
});
