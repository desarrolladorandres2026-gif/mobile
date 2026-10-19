import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { Order, ProSubscription, ProSubscriptionStatus } from '../models';
import { CouponType, CouponFundedBy, PaymentMethod, UserRole } from '../types';
import { pricingService, PRO_MIN_ORDER_MARGIN } from '../services/pricing.service';
import { orderService } from '../services/order.service';
import { estimateGatewayFee } from '../utils/gatewayFee';
import { pricingConfigService } from '../services/pricingConfig.service';
import { PRO_PLAN } from '../config/pro';
import { Business } from '../models';
import {
  GARZON, makeUser, makeBusiness, makeProduct, makeCoupon, makePricingConfig, authHeader,
} from './factories';

/**
 * M-012 — la guarda de margen de Zipp Pro.
 *
 * Zipp Pro regala el envío (y la tarifa de servicio) y lo paga ZIPP. Sin
 * guarda, un pedido pequeño con comisión baja dejaba el neto de ZIPP en
 * negativo. Ahora el motor, con los valores definitivos del pedido, comprueba el
 * margen REAL (comisión + tarifa de servicio + margen de domicilio − lo que
 * regala ZIPP − la comisión estimada de la pasarela) y, si queda por debajo
 * de cero, busca una versión más chica del mismo trato; si ninguna cabe, no
 * aplica el beneficio y lo explica.
 *
 * Con el domicilio en el propio local: $4.000 al cliente y $4.000 al domiciliario
 * (margen de domicilio 0), comisión 10 %, tarifa de servicio $1.500. Las tarifas
 * de pasarela de estas pruebas son de ejemplo, no el contrato de Wompi.
 */

const DELIVERY = 4000;
const SERVICE_FEE = 1500;
const GATEWAY = { gatewayCardBps: 299, gatewayCardFixed: 300, gatewayPseBps: 299, gatewayPseFixed: 300, gatewayNequiBps: 299, gatewayNequiFixed: 300, gatewayOtherBps: 299, gatewayOtherFixed: 300, gatewayFeeVatBps: 1900 };
const BASE_CONFIG = { serviceFeeFixed: SERVICE_FEE, serviceFeeMax: 10_000, ...GATEWAY };

let client: any;
let business: any;

async function member(userId: string) {
  await ProSubscription.create({
    userId,
    status: ProSubscriptionStatus.ACTIVE,
    planId: PRO_PLAN.id,
    price: PRO_PLAN.price,
    currency: PRO_PLAN.currency,
    startedAt: new Date(),
    currentPeriodStart: new Date(),
    currentPeriodEnd: new Date(Date.now() + 15 * 24 * 3600_000),
    autoRenew: true,
  });
}

/** Un producto de `price` pesos y una cotización de una unidad, siendo Pro. */
async function quoteSubtotal(price: number, extra: Record<string, unknown> = {}, method = PaymentMethod.ONLINE) {
  const product = await makeProduct(business._id, { price });
  return pricingService.quote({
    userId: client._id.toString(),
    businessId: business._id.toString(),
    items: [{ productId: product._id.toString(), quantity: 1 }],
    paymentMethod: method,
    deliveryLatitude: GARZON.lat,
    deliveryLongitude: GARZON.lng,
    suggest: false,
    ...extra,
  } as never);
}

/** El margen del pedido tal como lo mide la guarda. */
const marginOf = async (quote: { platformNetRevenueBeforeOperatingCosts: number; customerTotal: number }) => {
  const cfg = await pricingConfigService.getCurrent();
  const gateway = Math.max(...(['CARD', 'PSE', 'NEQUI', 'OTHER'] as const).map((m) => estimateGatewayFee(cfg, m, quote.customerTotal)));
  return quote.platformNetRevenueBeforeOperatingCosts - gateway;
};

beforeEach(async () => {
  await makePricingConfig(BASE_CONFIG);
  client = await makeUser({ role: UserRole.CLIENT });
  const owner = await makeUser({ role: UserRole.BUSINESS });
  business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
  await member(client._id.toString());
});

describe('Un pedido que da margen: el trato de Pro se aplica completo', () => {
  it('un pedido grande conserva envío gratis y tarifa de servicio sin costo, sin aviso', async () => {
    const quote = await quoteSubtotal(80_000);
    expect(quote.proDeliveryDiscount).toBe(DELIVERY);
    expect(quote.proServiceFeeDiscount).toBe(SERVICE_FEE);
    expect(quote.proBenefitNotice).toBeNull();
    expect(await marginOf(quote)).toBeGreaterThanOrEqual(PRO_MIN_ORDER_MARGIN);
  });

  it('justo en el límite del margen sigue aplicando (≥ 0, no > 0)', async () => {
    // Con el trato completo: margen = comisión − domicilio − pasarela. Se busca el
    // subtotal más chico que lo deja en cero o más.
    let price = PRO_PLAN.benefits.freeDelivery.minSubtotal;
    let quote = await quoteSubtotal(price);
    while (quote.proBenefitNotice) {
      price += 100;
      quote = await quoteSubtotal(price);
    }
    expect(await marginOf(quote)).toBeGreaterThanOrEqual(0);
    // Cien pesos menos de producto ya no cabe.
    const below = await quoteSubtotal(price - 100);
    expect(below.proBenefitNotice).not.toBeNull();
  });
});

describe('Un pedido que no da margen con el trato completo', () => {
  it('quita solo lo necesario y se queda con la alternativa que más ahorra al cliente', async () => {
    // $31.000 (sobre el mínimo de Pro): comisión 3.100 < domicilio 4.000.
    const quote = await quoteSubtotal(31_000);

    expect(quote.proBenefitNotice).not.toBeNull();
    const kept = quote.proDeliveryDiscount + quote.proServiceFeeDiscount;
    const skipped = quote.proBenefitNotice!.skipped;
    // Una versión parcial del mismo trato, nunca un descuento inventado.
    expect(skipped).toHaveLength(1);
    expect(kept).toBe(skipped[0] === 'freeDelivery' ? SERVICE_FEE : DELIVERY);
    // Y el pedido que se cobra queda con margen en regla.
    expect(await marginOf(quote)).toBeGreaterThanOrEqual(PRO_MIN_ORDER_MARGIN);
    expect(quote.proBenefitNotice!.marginWithFullBenefit).toBeLessThan(0);
    expect(quote.proBenefitNotice!.marginApplied).toBe(await marginOf(quote));
    expect(quote.proBenefitNotice!.message).toMatch(/Zipp Pro/);
    expect(quote.proBenefitNotice!.message).toMatch(/pérdida/);
  });

  it('si ninguna versión parcial cabe, no hay beneficio de Pro y se explica', async () => {
    // Comisión del 2 %: ni el envío ni la tarifa de servicio alcanzan a pagarse.
    await Business.updateOne({ _id: business._id }, { commissionRateBps: 200 });
    const quote = await quoteSubtotal(35_000);

    expect(quote.proDeliveryDiscount).toBe(0);
    expect(quote.proServiceFeeDiscount).toBe(0);
    expect(quote.proBenefitNotice!.skipped.sort()).toEqual(['freeDelivery', 'serviceFeeWaived']);
    // El cliente paga domicilio y tarifa de servicio completos; el resto del pedido no cambia.
    expect(quote.deliveryPayable).toBe(DELIVERY);
    expect(quote.customerTotal).toBe(35_000 + DELIVERY + SERVICE_FEE);
  });

  it('el libro cuadra con el beneficio ajustado', async () => {
    const quote = await quoteSubtotal(31_000);
    const inflow = quote.customerTotal + quote.platformFundedDiscount;
    const outflow = quote.businessPayout + quote.driverPayout + quote.platformGrossRevenue + quote.taxPayable;
    expect(inflow).toBe(outflow);
    expect(quote.businessPayout).toBeGreaterThanOrEqual(0);
  });

  it('el domiciliario y el comercio cobran lo mismo con o sin el ajuste', async () => {
    const adjusted = await quoteSubtotal(31_000);
    await ProSubscription.deleteMany({});
    const plain = await quoteSubtotal(31_000);
    expect(adjusted.driverPayout).toBe(plain.driverPayout);
    expect(adjusted.businessPayout).toBe(plain.businessPayout);
  });
});

describe('El costo de la pasarela entra en la cuenta', () => {
  it('lo que da margen en efectivo no lo da en línea', async () => {
    // Efectivo: sin pasarela. Se busca un subtotal que cabe en efectivo.
    await makePricingConfig({ ...BASE_CONFIG, cashOnDeliveryEnabled: true, cashOnDeliveryMaxAmount: 1_000_000 });
    let price = 34_000;
    let cash = await quoteSubtotal(price, {}, PaymentMethod.CASH_ON_DELIVERY);
    while (cash.proBenefitNotice && price < 80_000) {
      price += 500;
      cash = await quoteSubtotal(price, {}, PaymentMethod.CASH_ON_DELIVERY);
    }
    expect(cash.proBenefitNotice).toBeNull();

    const online = await quoteSubtotal(price, {}, PaymentMethod.ONLINE);
    // Es el subtotal más chico que cabe en efectivo: en línea la pasarela se come
    // ese margen, así que el trato se ajusta, y aun así el pedido sale en regla.
    expect(online.proBenefitNotice).not.toBeNull();
    expect(await marginOf(online)).toBeGreaterThanOrEqual(PRO_MIN_ORDER_MARGIN);
  });

  it('sin tarifas de pasarela configuradas no se inventa ningún costo', async () => {
    await makePricingConfig({ serviceFeeFixed: SERVICE_FEE, serviceFeeMax: 10_000 });
    const withoutGateway = await quoteSubtotal(41_000);
    expect(withoutGateway.proBenefitNotice).toBeNull(); // comisión 4.100 ≥ domicilio 4.000
  });
});

describe('Combinaciones con umbrales y promociones', () => {
  it('por debajo del mínimo de Pro no hay beneficio ni aviso: no es la guarda', async () => {
    const quote = await quoteSubtotal(PRO_PLAN.benefits.freeDelivery.minSubtotal - 1000);
    expect(quote.proDeliveryDiscount).toBe(0);
    expect(quote.proBenefitNotice?.skipped ?? []).not.toContain('freeDelivery');
  });

  it('el envío gratis del comercio ya cubre el domicilio: Pro solo pone la tarifa de servicio', async () => {
    await Business.updateOne({ _id: business._id }, { freeDeliveryThreshold: 30_000 });
    const quote = await quoteSubtotal(40_000);
    expect(quote.freeDeliveryApplied).toBe(true);
    expect(quote.proDeliveryDiscount).toBe(0);
    expect(quote.proServiceFeeDiscount).toBe(SERVICE_FEE);
    expect(quote.proBenefitNotice).toBeNull(); // la tarifa de servicio perdonada no deja pérdida
  });

  it('un cupón de la plataforma suma a lo que ZIPP regala: la guarda lo cuenta', async () => {
    await makeCoupon({ code: 'ZIPP5000', type: CouponType.FIXED, value: 5000, fundedBy: CouponFundedBy.PLATFORM, minimumContributionMargin: -100_000, campaignApproved: true });
    const sinCupon = await quoteSubtotal(80_000);
    expect(sinCupon.proBenefitNotice).toBeNull();

    const conCupon = await quoteSubtotal(80_000, { couponCode: 'ZIPP5000' });
    expect(conCupon.coupon!.platformFunded).toBe(5000);
    // El margen ya no sale de lo mismo: o se ajustó Pro, o el pedido sigue con margen en regla.
    expect(conCupon.proBenefitNotice !== null || (await marginOf(conCupon)) >= 0).toBe(true);
    expect(await marginOf(conCupon)).toBeGreaterThanOrEqual(
      conCupon.proBenefitNotice?.skipped.length === 2 ? Number.NEGATIVE_INFINITY : PRO_MIN_ORDER_MARGIN
    );
  });

  it('descuentos acumulados: cupón del comercio + promoción automática bajan la base de la comisión y la guarda lo ve', async () => {
    await makeCoupon({ code: 'COM20', type: CouponType.PERCENTAGE, value: 20, fundedBy: CouponFundedBy.BUSINESS, businessId: business._id });
    const sinCupon = await quoteSubtotal(60_000);
    const conCupon = await quoteSubtotal(60_000, { couponCode: 'COM20' });

    // El descuento del comercio rebaja lo que paga el cliente por productos y también la comisión de ZIPP.
    expect(conCupon.merchantCommission).toBeLessThan(sinCupon.merchantCommission);
    expect(conCupon.coupon!.merchantFunded).toBe(12_000);
    // Sigue por encima del mínimo de Pro (48.000 ≥ 30.000), pero con menos comisión el trato ya no cabe igual.
    expect(await marginOf(conCupon)).toBeGreaterThanOrEqual(PRO_MIN_ORDER_MARGIN);
    expect(conCupon.proDeliveryDiscount + conCupon.proServiceFeeDiscount).toBeLessThanOrEqual(sinCupon.proDeliveryDiscount + sinCupon.proServiceFeeDiscount);
    // El comercio nunca queda con pago negativo por culpa del ajuste.
    expect(conCupon.businessPayout).toBeGreaterThanOrEqual(0);
  });

  it('umbral de compra: justo en el mínimo de Pro aplica la regla del umbral y después la del margen', async () => {
    const min = PRO_PLAN.benefits.freeDelivery.minSubtotal;
    const enElMinimo = await quoteSubtotal(min);
    const bajoElMinimo = await quoteSubtotal(min - 1);
    // Bajo el mínimo no hay beneficio ni aviso (no es la guarda); en el mínimo sí se evalúa, y con 10 % de comisión no cabe.
    expect(bajoElMinimo.proDeliveryDiscount).toBe(0);
    expect(enElMinimo.proBenefitNotice).not.toBeNull();
  });

  it('la misma función decide en el checkout y en la simulación de Pro', async () => {
    const quote = await quoteSubtotal(31_000);
    const settled = pricingService.settleDiscounts({
      productSubtotal: 31_000,
      deliveryCustomerFee: quote.deliveryCustomerFee,
      deliveryMargin: quote.deliveryMargin,
      customerServiceFee: quote.customerServiceFee,
      appliedCommissionBps: quote.appliedCommissionBps,
      cfg: await pricingConfigService.getCurrent(),
      pro: { freeDelivery: true, freeDeliveryMinSubtotal: PRO_PLAN.benefits.freeDelivery.minSubtotal, serviceFeeWaived: true },
      tip: 0,
      isCash: false,
      coupon: null,
      autoPromotionMerchantFunded: 0,
      freeDeliveryThreshold: 0,
    });
    expect(settled.proDeliveryDiscount).toBe(quote.proDeliveryDiscount);
    expect(settled.proServiceFeeDiscount).toBe(quote.proServiceFeeDiscount);
    expect(settled.customerTotal).toBe(quote.customerTotal);
    expect(settled.proGuard?.skipped).toEqual(quote.proBenefitNotice?.skipped);
  });
});

describe('Pedidos y condiciones ya aceptadas', () => {
  const create = async (price: number, extra: Record<string, unknown> = {}) => {
    const product = await makeProduct(business._id, { price });
    return orderService.create({
      clientId: client._id.toString(),
      businessId: business._id.toString(),
      items: [{ productId: product._id.toString(), quantity: 1 }],
      paymentMethod: PaymentMethod.ONLINE,
      deliveryAddress: 'Calle 5 # 3-21',
      deliveryLatitude: GARZON.lat,
      deliveryLongitude: GARZON.lng,
      ...extra,
    } as never);
  };

  it('el pedido guarda qué beneficio se quitó, para explicarlo meses después', async () => {
    const order = await create(31_000);
    expect(order.finance.proBenefitSkipped).toHaveLength(1);
    const full = await create(80_000);
    expect(full.finance.proBenefitSkipped ?? []).toEqual([]);
  });

  it('un pedido ya creado no se recalcula cuando cambia la configuración', async () => {
    const order = await create(31_000);
    const before = JSON.stringify(order.finance);
    await Business.updateOne({ _id: business._id }, { commissionRateBps: 3000 });
    const stored = await Order.findById(order._id).lean();
    expect(JSON.stringify((await Order.findById(order._id))!.finance)).toBe(before);
    expect(stored!.finance.pricingConfigVersion).toBe(order.finance.pricingConfigVersion);
  });

  it('si el total aceptado ya no es el que sale, no se cobra en silencio: 409 PRICE_CHANGED con el total nuevo', async () => {
    const quote = await quoteSubtotal(80_000); // el cliente vio el trato completo
    const product = await makeProduct(business._id, { price: 80_000 });
    // Entre el checkout y la confirmación la comisión bajó y Pro ya no cabe.
    await Business.updateOne({ _id: business._id }, { commissionRateBps: 100 });

    await expect(
      orderService.create({
        clientId: client._id.toString(),
        businessId: business._id.toString(),
        items: [{ productId: product._id.toString(), quantity: 1 }],
        paymentMethod: PaymentMethod.ONLINE,
        deliveryAddress: 'Calle 5 # 3-21',
        deliveryLatitude: GARZON.lat,
        deliveryLongitude: GARZON.lng,
        expectedTotal: quote.customerTotal,
      } as never)
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'PRICE_CHANGED',
      details: { expectedTotal: quote.customerTotal, proBenefitNotice: expect.objectContaining({ code: 'PRO_NEGATIVE_MARGIN' }) },
    });
    expect(await Order.countDocuments({ clientId: client._id })).toBe(0);
  });

  it('con el total correcto el pedido se crea y por HTTP el aviso del checkout llega en la cotización', async () => {
    const quote = await quoteSubtotal(31_000);
    const order = await create(31_000, { expectedTotal: quote.customerTotal });
    expect(order.finance.customerTotal).toBe(quote.customerTotal);

    const product = await makeProduct(business._id, { price: 31_000 });
    const res = await request(app).post('/api/v1/orders/quote').set(await authHeader(client)).send({
      businessId: business._id.toString(),
      items: [{ productId: product._id.toString(), quantity: 1 }],
      paymentMethod: PaymentMethod.ONLINE,
      deliveryLatitude: GARZON.lat,
      deliveryLongitude: GARZON.lng,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.proBenefitNotice.code).toBe('PRO_NEGATIVE_MARGIN');
  });
});
