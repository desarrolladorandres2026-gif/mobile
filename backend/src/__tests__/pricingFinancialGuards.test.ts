import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import {
  Order, Coupon, CouponRedemption, Payout, Payment, LedgerEntry, Product, ProSubscription,
  ProSubscriptionStatus,
} from '../models';
import { CouponType, CouponFundedBy, CouponScope, PaymentMethod, UserRole } from '../types';
import { pricingService } from '../services/pricing.service';
import { pricingConfigService } from '../services/pricingConfig.service';
import { orderService } from '../services/order.service';
import { ledgerService } from '../services/ledger.service';
import { payoutService } from '../services/payout.service';
import { couponService } from '../services/coupon.service';
import { estimateGatewayFee } from '../utils/gatewayFee';
import { PRO_PLAN } from '../config/pro';
import { Business, PlatformPricingConfig } from '../models';
import {
  GARZON, makeUser, makeBusiness, makeProduct, makeCoupon, makePricingConfig, authHeader,
} from './factories';

/**
 * Guardas financieras del motor de precios.
 *
 * Lo que se fija aquí no es la aritmética de siempre sino sus bordes: qué
 * pasa cuando la combinación de descuentos que un comercio configuró —cada
 * uno razonable por separado— deja un pedido que nadie puede pagar.
 *
 * Con el domicilio en el propio local (distancia cero) la tarifa es la base
 * de la configuración de prueba: $4.000 al cliente, $4.000 al domiciliario.
 * Comisión del 10 %. Esas dos cifras hacen que cada caso se pueda calcular a
 * mano en el comentario.
 */

const DELIVERY = 4000;

async function setup(opts: { price?: number; threshold?: number; config?: Record<string, unknown> } = {}) {
  await makePricingConfig(opts.config ?? {});
  const client = await makeUser({ role: UserRole.CLIENT });
  const owner = await makeUser({ role: UserRole.BUSINESS });
  const business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
  const product = await makeProduct(business._id, { price: opts.price ?? 10000 });
  if (opts.threshold !== undefined) {
    await Business.updateOne({ _id: business._id }, { freeDeliveryThreshold: opts.threshold });
  }
  return { client, owner, business, product };
}

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

/** Un cupón de código que paga el comercio. */
const businessCoupon = (business: any, overrides: Record<string, unknown> = {}) =>
  makeCoupon({
    fundedBy: CouponFundedBy.BUSINESS,
    businessId: business._id,
    campaignApproved: false,
    ...overrides,
  } as never);

/** Una promoción automática del comercio sobre un producto. */
const autoPromotion = (business: any, product: any, overrides: Record<string, unknown> = {}) =>
  makeCoupon({
    fundedBy: CouponFundedBy.BUSINESS,
    businessId: business._id,
    campaignApproved: false,
    autoApply: true,
    productIds: [product._id],
    ...overrides,
  } as never);

describe('Pago negativo al comercio', () => {
  it('un cupón fijo + envío gratis que dejarían su pago en negativo se rechaza con 422 de negocio', async () => {
    // Umbral mal puesto (2.000 < domicilio de 4.000). Pedido de 10.000:
    //   cupón fijo de 8.000 → el cliente paga 2.000 en productos → alcanza el
    //   umbral → el comercio regala el domicilio (4.000).
    //   pago = 10.000 − (8.000 + 4.000) − comisión(2.000 × 10 %) = −2.200
    const ctx = await setup({ threshold: 2000 });
    await businessCoupon(ctx.business, { code: 'FIJO8000', type: CouponType.FIXED, value: 8000 });

    await expect(quoteFor(ctx, 1, { couponCode: 'FIJO8000' })).rejects.toMatchObject({
      statusCode: 422,
      code: 'COUPON_EXCEEDS_MERCHANT_PAYOUT',
    });

    // Sin el cupón, el mismo pedido sí se puede cobrar: el problema es la
    // combinación, no el envío gratis.
    const sin = await quoteFor(ctx, 1);
    expect(sin.freeDeliveryApplied).toBe(true);
    expect(sin.businessPayout).toBe(10000 - DELIVERY - 1000);
  });

  it('por HTTP responde 422 con un mensaje entendible, no un 500', async () => {
    const ctx = await setup({ threshold: 2000 });
    await businessCoupon(ctx.business, { code: 'FIJO8000', type: CouponType.FIXED, value: 8000 });

    const res = await request(app)
      .post('/api/v1/orders/quote')
      .set(await authHeader(ctx.client))
      .send({
        businessId: ctx.business._id.toString(),
        items: [{ productId: ctx.product._id.toString(), quantity: 1 }],
        paymentMethod: 'online',
        deliveryAddress: 'Calle 5 # 3-21, Garzón',
        deliveryLatitude: GARZON.lat,
        deliveryLongitude: GARZON.lng,
        couponCode: 'FIJO8000',
      });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('COUPON_EXCEEDS_MERCHANT_PAYOUT');
    expect(res.body.message).toMatch(/no se puede aplicar/i);
    expect(await Order.countDocuments()).toBe(0);
  });

  it('el envío gratis automático no se regala si dejaría el pago en negativo, y la cotización sigue siendo válida', async () => {
    // 1.000 en productos y 4.000 de domicilio: regalarlo costaría más que
    // lo vendido. No se apaga el envío gratis del comercio; solo cae en este
    // pedido, y el cliente paga su domicilio.
    const ctx = await setup({ price: 1000, threshold: 1000 });

    const quote = await quoteFor(ctx, 1);

    expect(quote.freeDeliveryApplied).toBe(false);
    expect(quote.deliveryPayable).toBe(DELIVERY);
    expect(quote.businessPayout).toBe(1000 - 100);
  });

  it('el mismo comercio sí regala el domicilio en el pedido que puede pagar', async () => {
    const ctx = await setup({ price: 1000, threshold: 1000 });

    const quote = await quoteFor(ctx, 20); // 20.000
    expect(quote.freeDeliveryApplied).toBe(true);
    expect(quote.deliveryPayable).toBe(0);
  });

  it('una promoción automática inviable no se aplica ni se ofrece', async () => {
    // Con la comisión sobre el bruto, una promoción que regala todo el pedido
    // dejaría al comercio pagando la comisión de su bolsillo.
    const ctx = await setup({ config: { commissionAfterMerchantDiscount: false } });
    await autoPromotion(ctx.business, ctx.product, { type: CouponType.FIXED, value: 10000 });

    const quote = await quoteFor(ctx, 1);

    expect(quote.appliedAutoPromotions).toHaveLength(0);
    expect(quote.promotionDiscount).toBe(0);
    expect(quote.businessPayout).toBe(10000 - 1000);
  });

  it('cupón porcentual + promoción automática + envío gratis, cuando caben, cuadran al peso', async () => {
    // 2 × 20.000 = 40.000.
    //   promoción automática 20 %      → −8.000  (32.000)
    //   cupón del comercio 10 % de 32k → −3.200  (28.800)  ← lo que paga en productos
    //   umbral 25.000 ≤ 28.800         → domicilio gratis (4.000, lo paga el comercio)
    //   comisión: 10 % de (40.000 − 8.000 − 3.200) = 2.880
    //   el comercio financia 8.000 + 3.200 + 4.000 = 15.200
    //   pago = 40.000 − 15.200 − 2.880 = 21.920
    const ctx = await setup({ price: 20000, threshold: 25000 });
    await autoPromotion(ctx.business, ctx.product, { type: CouponType.PERCENTAGE, value: 20 });
    await businessCoupon(ctx.business, { code: 'DIEZ', type: CouponType.PERCENTAGE, value: 10 });

    const quote = await quoteFor(ctx, 2, { couponCode: 'DIEZ' });

    expect(quote.promotionDiscount).toBe(8000);
    expect(quote.coupon!.productDiscount).toBe(3200);
    expect(quote.freeDeliveryApplied).toBe(true);
    expect(quote.merchantFundedDiscount).toBe(15200);
    expect(quote.merchantCommission).toBe(2880);
    expect(quote.businessPayout).toBe(21920);
    expect(quote.customerTotal).toBe(28800);
    // La identidad de siempre, sin ajustes artificiales.
    expect(quote.customerTotal + quote.platformFundedDiscount).toBe(
      quote.businessPayout + quote.driverPayout + quote.platformGrossRevenue + quote.taxPayable
    );
  });

  it('el sugeridor descarta el cupón que el checkout rechazaría y ofrece el siguiente válido', async () => {
    const ctx = await setup({ threshold: 2000 });
    // El que más "ahorra" sobre el papel es justo el imposible.
    await businessCoupon(ctx.business, {
      code: 'IMPOSIBLE', type: CouponType.FIXED, value: 8000, isPublic: true,
    });
    await makeCoupon({ code: 'PLAT500', type: CouponType.FIXED, value: 500, isPublic: true });

    const quote = await quoteFor(ctx, 1);

    expect(quote.suggestedCoupon?.code).toBe('PLAT500');
  });

  it('un pedido rechazado no crea pedido ni consume el cupón', async () => {
    const ctx = await setup({ threshold: 2000 });
    const coupon = await businessCoupon(ctx.business, {
      code: 'FIJO8000', type: CouponType.FIXED, value: 8000, usageLimit: 5, budgetLimit: 50000,
    });

    await expect(
      orderService.create({
        clientId: ctx.client._id.toString(),
        businessId: ctx.business._id.toString(),
        items: [{ productId: ctx.product._id.toString(), quantity: 1 }],
        paymentMethod: PaymentMethod.ONLINE,
        deliveryAddress: 'Calle 5 # 3-21',
        deliveryLatitude: GARZON.lat,
        deliveryLongitude: GARZON.lng,
        couponCode: 'FIJO8000',
      } as never)
    ).rejects.toMatchObject({ statusCode: 422 });

    expect(await Order.countDocuments()).toBe(0);
    expect(await CouponRedemption.countDocuments()).toBe(0);
    const fresh = await Coupon.findById(coupon._id);
    expect(fresh!.usedCount).toBe(0);
    expect(fresh!.budgetSpent).toBe(0);
  });
});

describe('El umbral se mide sobre lo que el cliente paga en productos', () => {
  it('alcanza el umbral con la carta, pero no después de una promoción automática', async () => {
    // 3 × 10.000 = 30.000 = umbral. Una promoción de 10.000 deja 20.000.
    const ctx = await setup({ threshold: 30000 });

    const antes = await quoteFor(ctx, 3);
    expect(antes.freeDeliveryApplied).toBe(true);

    await autoPromotion(ctx.business, ctx.product, { type: CouponType.FIXED, value: 10000 });
    const despues = await quoteFor(ctx, 3);

    expect(despues.promotionDiscount).toBe(10000);
    expect(despues.freeDeliveryApplied).toBe(false);
    expect(despues.deliveryPayable).toBe(DELIVERY);
  });

  it('un cupón de producto de ZIPP también baja la base', async () => {
    const ctx = await setup({ threshold: 30000 });
    await makeCoupon({ code: 'MENOS5K', type: CouponType.FIXED, value: 5000 });

    const quote = await quoteFor(ctx, 3, { couponCode: 'MENOS5K' });

    // 25.000 pagados < 30.000.
    expect(quote.freeDeliveryApplied).toBe(false);
    expect(quote.deliveryPayable).toBe(DELIVERY);
  });

  it('ni el domicilio ni la tarifa de servicio cuentan para alcanzarlo', async () => {
    // 29.000 en productos + 4.000 de domicilio + 2.000 de servicio superan
    // 30.000 en el total, pero no en productos.
    const ctx = await setup({
      price: 29000,
      threshold: 30000,
      config: { serviceFeeFixed: 2000 },
    });

    const quote = await quoteFor(ctx, 1);

    expect(quote.freeDeliveryApplied).toBe(false);
  });

  it('justo en el umbral, aplica', async () => {
    const ctx = await setup({ price: 30000, threshold: 30000 });
    expect((await quoteFor(ctx, 1)).freeDeliveryApplied).toBe(true);
  });

  it('el mínimo de Zipp Pro usa la misma definición', async () => {
    await makePricingConfig();
    const client = await makeUser({ role: UserRole.CLIENT });
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
    // El doble de lo justo para pasar el mínimo: la comisión de 5 unidades tiene
    // que cubrir el domicilio que regala Pro, o la guarda de margen (M-012) lo quita.
    const unit = 2 * Math.ceil(PRO_PLAN.benefits.freeDelivery.minSubtotal / 4);
    const product = await makeProduct(business._id, { price: unit });
    await ProSubscription.create({
      userId: client._id,
      status: ProSubscriptionStatus.ACTIVE,
      planId: PRO_PLAN.id,
      price: PRO_PLAN.price,
      currency: PRO_PLAN.currency,
      startedAt: new Date(),
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 15 * 24 * 3600_000),
      autoRenew: true,
    });
    const ctx = { client, business, product };

    // 5 unidades pasan el mínimo con la carta...
    const sinCupon = await quoteFor(ctx, 5);
    expect(sinCupon.proDeliveryDiscount).toBeGreaterThan(0);

    // ...pero un cupón que las deja por debajo del mínimo se lo quita.
    const rebaja = 5 * unit - PRO_PLAN.benefits.freeDelivery.minSubtotal + 1000;
    await makeCoupon({ code: 'BAJAMIN', type: CouponType.FIXED, value: rebaja });
    const conCupon = await quoteFor(ctx, 5, { couponCode: 'BAJAMIN' });
    expect(conCupon.proDeliveryDiscount).toBe(0);
  });
});

describe('Un cupón de envío gratis sobre un pedido que ya lo tiene', () => {
  it('se rechaza con 422 cuando el comercio ya regala el domicilio', async () => {
    const ctx = await setup({ price: 20000, threshold: 30000 });
    await makeCoupon({ code: 'ENVIOZIPP', type: CouponType.FREE_DELIVERY });

    await expect(quoteFor(ctx, 2, { couponCode: 'ENVIOZIPP' })).rejects.toMatchObject({
      statusCode: 422,
      code: 'DELIVERY_ALREADY_FREE',
    });

    // Por debajo del umbral el mismo cupón sí aporta.
    const bajo = await quoteFor(ctx, 1, { couponCode: 'ENVIOZIPP' });
    expect(bajo.deliveryPayable).toBe(0);
    expect(bajo.coupon!.deliveryDiscount).toBe(DELIVERY);
  });

  it('también cuando el envío gratis lo da Zipp Pro', async () => {
    await makePricingConfig();
    const client = await makeUser({ role: UserRole.CLIENT });
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
    const product = await makeProduct(business._id, {
      price: PRO_PLAN.benefits.freeDelivery.minSubtotal + 1000,
    });
    await ProSubscription.create({
      userId: client._id,
      status: ProSubscriptionStatus.ACTIVE,
      planId: PRO_PLAN.id,
      price: PRO_PLAN.price,
      currency: PRO_PLAN.currency,
      startedAt: new Date(),
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 15 * 24 * 3600_000),
      autoRenew: true,
    });
    await makeCoupon({ code: 'ENVIOZIPP', type: CouponType.FREE_DELIVERY });

    await expect(
      quoteFor({ client, business, product }, 1, { couponCode: 'ENVIOZIPP' })
    ).rejects.toMatchObject({ statusCode: 422, code: 'DELIVERY_ALREADY_FREE' });
  });

  it('el sugeridor no recomienda un cupón que no ahorra nada más', async () => {
    const ctx = await setup({ price: 20000, threshold: 30000 });
    await makeCoupon({ code: 'ENVIOZIPP', type: CouponType.FREE_DELIVERY, isPublic: true });

    const quote = await quoteFor(ctx, 2);

    expect(quote.freeDeliveryApplied).toBe(true);
    expect(quote.suggestedCoupon).toBeNull();
  });

  it('no consume el cupón ni crea el pedido', async () => {
    const ctx = await setup({ price: 20000, threshold: 30000 });
    const coupon = await makeCoupon({ code: 'ENVIOZIPP', type: CouponType.FREE_DELIVERY, usageLimit: 5 });

    await expect(
      orderService.create({
        clientId: ctx.client._id.toString(),
        businessId: ctx.business._id.toString(),
        items: [{ productId: ctx.product._id.toString(), quantity: 2 }],
        paymentMethod: PaymentMethod.ONLINE,
        deliveryAddress: 'Calle 5 # 3-21',
        deliveryLatitude: GARZON.lat,
        deliveryLongitude: GARZON.lng,
        couponCode: 'ENVIOZIPP',
      } as never)
    ).rejects.toMatchObject({ statusCode: 422 });

    expect(await Order.countDocuments()).toBe(0);
    expect(await CouponRedemption.countDocuments()).toBe(0);
    expect((await Coupon.findById(coupon._id))!.usedCount).toBe(0);
  });

  it('el domiciliario cobra lo mismo con o sin el envío gratis del comercio', async () => {
    const ctx = await setup({ price: 20000 });
    const sin = await quoteFor(ctx, 2);
    await Business.updateOne({ _id: ctx.business._id }, { freeDeliveryThreshold: 30000 });
    const con = await quoteFor(ctx, 2);

    expect(con.driverPayout).toBe(sin.driverPayout);
    expect(con.driverDeliveryPayout).toBe(sin.driverDeliveryPayout);
  });
});

describe('El coste de Wompi en el piso de margen', () => {
  const GATEWAY = {
    gatewayCardBps: 300,
    gatewayCardFixed: 700,
    gatewayFeeVatBps: 1900,
    cashOnDeliveryEnabled: true,
  };

  /**
   * 20.000 en productos, comisión 10 % = 2.000 de ingreso, domicilio al costo.
   * Un cupón de ZIPP de 1.500 deja 500 de margen antes de la pasarela, y la
   * pasarela se lleva más que eso sobre un cobro de ~22.500.
   */
  async function platformScenario(config: Record<string, unknown>, couponValue: number) {
    const ctx = await setup({ price: 20000, config });
    await makeCoupon({
      code: 'ZIPPCAMP',
      type: CouponType.FIXED,
      value: couponValue,
      campaignApproved: false,
      minimumContributionMargin: -1,
    });
    return ctx;
  }

  it('pago en línea: una campaña que sin pasarela deja margen, con pasarela no pasa el piso', async () => {
    const ctx = await platformScenario(GATEWAY, 1500);

    await expect(quoteFor(ctx, 1, { couponCode: 'ZIPPCAMP' })).rejects.toMatchObject({
      statusCode: 422,
      message: expect.stringMatching(/margen/i),
    });
  });

  it('pago en efectivo: no genera comisión de pasarela, así que la misma campaña pasa', async () => {
    const ctx = await platformScenario(GATEWAY, 1500);

    const quote = await quoteFor(ctx, 1, {
      couponCode: 'ZIPPCAMP',
      paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
    });

    expect(quote.platformNetRevenueBeforeOperatingCosts).toBe(500);
  });

  it('sin tarifas configuradas, el comportamiento no cambia (no se inventa ninguna)', async () => {
    const ctx = await platformScenario({ cashOnDeliveryEnabled: true }, 1500);

    await expect(quoteFor(ctx, 1, { couponCode: 'ZIPPCAMP' })).resolves.toBeDefined();
  });

  it('una campaña con margen suficiente tras la pasarela sí pasa en línea', async () => {
    const ctx = await platformScenario(GATEWAY, 100);

    await expect(quoteFor(ctx, 1, { couponCode: 'ZIPPCAMP' })).resolves.toBeDefined();
  });

  it('el snapshot del pedido no incluye la pasarela: el libro la asienta al capturar, y sumarla aquí la contaría dos veces', async () => {
    const ctx = await platformScenario(GATEWAY, 100);

    const online = await quoteFor(ctx, 1, { couponCode: 'ZIPPCAMP' });
    const cash = await quoteFor(ctx, 1, {
      couponCode: 'ZIPPCAMP',
      paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
    });

    expect(online.platformNetRevenueBeforeOperatingCosts).toBe(cash.platformNetRevenueBeforeOperatingCosts);
  });

  it('con el método desconocido se toma la tarifa más alta configurada, con la función de siempre', async () => {
    await makePricingConfig({ ...GATEWAY, gatewayPseBps: 500, gatewayPseFixed: 900 });
    const cfg = await pricingConfigService.getCurrent();

    const outcome = pricingService.settleDiscounts({
      productSubtotal: 20000,
      deliveryCustomerFee: DELIVERY,
      deliveryMargin: 0,
      customerServiceFee: 0,
      appliedCommissionBps: 1000,
      cfg,
      pro: null,
      tip: 0,
      isCash: false,
      coupon: null,
      autoPromotionMerchantFunded: 0,
      freeDeliveryThreshold: 0,
    });

    expect(outcome.estimatedGatewayFee).toBe(estimateGatewayFee(cfg, 'PSE', outcome.customerTotal));
    expect(outcome.estimatedGatewayFee).toBeGreaterThan(estimateGatewayFee(cfg, 'CARD', outcome.customerTotal));
  });
});

describe('Un fallo al crear el pedido no deja nada a medias', () => {
  afterEach(() => vi.restoreAllMocks());

  async function createWithCoupon() {
    const ctx = await setup({ price: 10000 });
    await Product.updateOne({ _id: ctx.product._id }, { stock: 5 });
    const coupon = await makeCoupon({
      code: 'FALLA', type: CouponType.FIXED, value: 1000, usageLimit: 5, budgetLimit: 100000,
    });
    const input = {
      clientId: ctx.client._id.toString(),
      businessId: ctx.business._id.toString(),
      items: [{ productId: ctx.product._id.toString(), quantity: 2 }],
      paymentMethod: PaymentMethod.ONLINE,
      deliveryAddress: 'Calle 5 # 3-21',
      deliveryLatitude: GARZON.lat,
      deliveryLongitude: GARZON.lng,
      couponCode: 'FALLA',
    };
    return { ctx, coupon, input };
  }

  async function expectNothingLeft(ctx: any, couponId: any) {
    expect(await Order.countDocuments()).toBe(0);
    expect(await Payout.countDocuments()).toBe(0);
    expect(await Payment.countDocuments()).toBe(0);
    expect(await CouponRedemption.countDocuments()).toBe(0);
    const coupon = await Coupon.findById(couponId);
    expect(coupon!.usedCount).toBe(0);
    expect(coupon!.budgetSpent).toBe(0);
    expect((await Product.findById(ctx.product._id))!.stock).toBe(5);
  }

  it('si el libro falla antes de asentar, se devuelve el cupón, el presupuesto y el stock', async () => {
    const { ctx, coupon, input } = await createWithCoupon();
    vi.spyOn(ledgerService, 'recordOrderPlaced').mockRejectedValueOnce(new Error('libro caído'));

    await expect(orderService.create(input as never)).rejects.toThrow('libro caído');

    await expectNothingLeft(ctx, coupon._id);
    expect(await LedgerEntry.countDocuments()).toBe(0);
  });

  it('si falla después de asentar, el libro queda en cero: se asienta la reversión, no se borra', async () => {
    const { ctx, coupon, input } = await createWithCoupon();
    vi.spyOn(payoutService, 'accrueForOrder').mockRejectedValueOnce(new Error('payouts caídos'));

    await expect(orderService.create(input as never)).rejects.toThrow('payouts caídos');

    await expectNothingLeft(ctx, coupon._id);
    expect(await ledgerService.isBalanced()).toBe(true);
    // Cada cuenta termina neta en cero: lo asentado y su reversión se anulan.
    const accounts = await LedgerEntry.aggregate([
      { $group: { _id: '$account', net: { $sum: { $cond: [{ $eq: ['$direction', 'debit'] }, '$amount', { $multiply: ['$amount', -1] }] } } } },
    ]);
    expect(accounts.length).toBeGreaterThan(0);
    for (const row of accounts) expect(row.net, String(row._id)).toBe(0);
  });

  it('si una promoción automática se agota entre cotizar y crear, se devuelve también el cupón de código', async () => {
    const { ctx, coupon, input } = await createWithCoupon();
    await makeCoupon({
      code: 'AUTOAGOTA',
      autoApply: true,
      productIds: [ctx.product._id],
      fundedBy: CouponFundedBy.BUSINESS,
      businessId: ctx.business._id,
      campaignApproved: false,
      type: CouponType.PERCENTAGE,
      value: 10,
      usageLimit: 5,
    });

    const real = couponService.redeem.bind(couponService);
    let calls = 0;
    vi.spyOn(couponService, 'redeem').mockImplementation(async (...args) => {
      calls += 1;
      // El del código entra; el de la promoción automática "se agotó".
      return calls === 1 ? real(...args) : false;
    });

    await expect(orderService.create(input as never)).rejects.toMatchObject({ statusCode: 409 });

    await expectNothingLeft(ctx, coupon._id);
  });
});

describe('El pedido guarda cuánto costó cada beneficio del comercio', () => {
  it('el envío gratis y la promoción automática quedan en el snapshot, dentro de lo que financia el comercio', async () => {
    const ctx = await setup({ price: 20000, threshold: 25000 });
    await autoPromotion(ctx.business, ctx.product, { type: CouponType.PERCENTAGE, value: 10 });

    const order = await orderService.create({
      clientId: ctx.client._id.toString(),
      businessId: ctx.business._id.toString(),
      items: [{ productId: ctx.product._id.toString(), quantity: 2 }],
      paymentMethod: PaymentMethod.ONLINE,
      deliveryAddress: 'Calle 5 # 3-21',
      deliveryLatitude: GARZON.lat,
      deliveryLongitude: GARZON.lng,
    } as never);

    // 40.000 − 4.000 (10 %) = 36.000 pagados ≥ 25.000.
    expect(order.finance.autoPromotionDiscount).toBe(4000);
    expect(order.finance.freeDeliveryDiscount).toBe(DELIVERY);
    expect(order.finance.merchantFundedDiscount).toBe(4000 + DELIVERY);
  });
});

describe('La configuración de precios es segura ante lecturas simultáneas', () => {
  it('con la base vacía, varias lecturas a la vez crean una sola versión 1', async () => {
    await PlatformPricingConfig.deleteMany({});
    pricingConfigService.invalidate();

    const results = await Promise.all(Array.from({ length: 6 }, () => pricingConfigService.getCurrent()));

    expect(new Set(results.map((r) => r.version))).toEqual(new Set([1]));
    expect(await PlatformPricingConfig.countDocuments()).toBe(1);
  });

  it('una carga que empezó antes de un cambio no deja la versión vieja en la caché', async () => {
    await makePricingConfig();
    pricingConfigService.invalidate();

    const inFlight = pricingConfigService.getCurrent();
    pricingConfigService.invalidate(); // un administrador publicó otra versión
    await inFlight;

    expect((pricingConfigService as unknown as { cached: unknown }).cached).toBeNull();
  });
});
