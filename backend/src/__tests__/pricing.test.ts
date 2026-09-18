import { describe, it, expect } from 'vitest';
import { pricingService } from '../services/pricing.service';
import { PaymentMethod } from '../types';
import { config } from '../config';
import { haversineKm, roundToStep, isValidCoordinate } from '../utils';
import {
  GARZON, offsetKm, makeUser, makeBusiness, makeProduct, makeZone, makePricingConfig,
} from './factories';

/**
 * Delivery pricing now reads an admin-editable configuration rather than
 * environment variables, so each case installs one. The defaults reproduce
 * the platform's pre-migration economics: no service fee and no delivery
 * margin, which keeps these long-standing assertions meaningful.
 */
const RULES = {
  baseFee: 4000,
  perKm: 900,
  minFee: 3000,
  maxFee: 20000,
  rounding: 100,
  maxRadiusKm: 12,
};

async function deliveryConfig(overrides: Record<string, unknown> = {}) {
  return makePricingConfig({
    driverBaseFee: RULES.baseFee,
    driverPerKm: RULES.perKm,
    driverMinFee: RULES.minFee,
    deliveryMinFee: RULES.minFee,
    deliveryMaxFee: RULES.maxFee,
    deliveryRoundingStep: RULES.rounding,
    freeRadiusMeters: 1000,
    maxRadiusMeters: RULES.maxRadiusKm * 1000,
    ...overrides,
  });
}

describe('geo helpers', () => {
  it('mide una distancia conocida con precisión razonable', () => {
    // 0.009° de latitud ≈ 1 km
    const km = haversineKm(GARZON, offsetKm(GARZON, 1));
    expect(km).toBeGreaterThan(0.95);
    expect(km).toBeLessThan(1.05);
  });

  it('es simétrica y cero para el mismo punto', () => {
    const a = GARZON;
    const b = offsetKm(GARZON, 3);
    expect(haversineKm(a, b)).toBeCloseTo(haversineKm(b, a), 6);
    expect(haversineKm(a, a)).toBe(0);
  });

  it('rechaza coordenadas inválidas, incluida Null Island', () => {
    expect(isValidCoordinate(0, 0)).toBe(false);
    expect(isValidCoordinate(undefined, undefined)).toBe(false);
    expect(isValidCoordinate(91, 0)).toBe(false);
    expect(isValidCoordinate(NaN, 10)).toBe(false);
    expect(isValidCoordinate(GARZON.lat, GARZON.lng)).toBe(true);
  });

  it('redondea al múltiplo indicado', () => {
    expect(roundToStep(4321, 100)).toBe(4300);
    expect(roundToStep(4361, 100)).toBe(4400);
    expect(roundToStep(4361, 1)).toBe(4361);
  });
});

describe('PricingService.priceItems', () => {
  it('usa el precio del producto y no el que envía el cliente', async () => {
    const owner = await makeUser();
    const business = await makeBusiness(owner._id);
    const product = await makeProduct(business._id, { price: 18000 });

    const { subtotal, pricedItems } = await pricingService.priceItems(
      business._id.toString(),
      [{ productId: product._id.toString(), quantity: 2 }]
    );

    expect(subtotal).toBe(36000);
    expect(pricedItems[0].unitPrice).toBe(18000);
  });

  it('prefiere discountPrice cuando existe', async () => {
    const owner = await makeUser();
    const business = await makeBusiness(owner._id);
    const product = await makeProduct(business._id, { price: 22000, discountPrice: 19000 });

    const { subtotal } = await pricingService.priceItems(business._id.toString(), [
      { productId: product._id.toString(), quantity: 1 },
    ]);

    expect(subtotal).toBe(19000);
  });

  it('cobra los extras al precio del catálogo y multiplica por su cantidad', async () => {
    const owner = await makeUser();
    const business = await makeBusiness(owner._id);
    const product = await makeProduct(business._id, {
      price: 18000,
      extras: [{ name: 'Queso extra', price: 3000 }],
    });

    const { subtotal } = await pricingService.priceItems(business._id.toString(), [
      {
        productId: product._id.toString(),
        quantity: 2,
        selectedExtras: [{ name: 'Queso extra', quantity: 2 }],
      },
    ]);

    // (18000 + 3000×2) × 2
    expect(subtotal).toBe(48000);
  });

  // Regression: the previous implementation trusted the client's extra
  // prices, so a crafted request could drive the total to zero or below.
  it('ignora un precio de extra manipulado por el cliente', async () => {
    const owner = await makeUser();
    const business = await makeBusiness(owner._id);
    const product = await makeProduct(business._id, {
      price: 18000,
      extras: [{ name: 'Queso extra', price: 3000 }],
    });

    const { subtotal } = await pricingService.priceItems(business._id.toString(), [
      {
        productId: product._id.toString(),
        quantity: 1,
        // A malicious client sends a negative price; it must have no effect.
        selectedExtras: [{ name: 'Queso extra', price: -999999, quantity: 1 } as any],
      },
    ]);

    expect(subtotal).toBe(21000);
  });

  it('rechaza un extra que no existe en el producto', async () => {
    const owner = await makeUser();
    const business = await makeBusiness(owner._id);
    const product = await makeProduct(business._id, { price: 18000, extras: [] });

    await expect(
      pricingService.priceItems(business._id.toString(), [
        {
          productId: product._id.toString(),
          quantity: 1,
          selectedExtras: [{ name: 'Trufa negra gratis', quantity: 1 }],
        },
      ])
    ).rejects.toThrow(/no existe/i);
  });

  it('rechaza productos de otro negocio', async () => {
    const owner = await makeUser();
    const businessA = await makeBusiness(owner._id);
    const businessB = await makeBusiness(owner._id);
    const product = await makeProduct(businessB._id, { price: 5000 });

    await expect(
      pricingService.priceItems(businessA._id.toString(), [
        { productId: product._id.toString(), quantity: 1 },
      ])
    ).rejects.toThrow(/no pertenece/i);
  });

  it('rechaza productos no disponibles', async () => {
    const owner = await makeUser();
    const business = await makeBusiness(owner._id);
    const product = await makeProduct(business._id, { isAvailable: false });

    await expect(
      pricingService.priceItems(business._id.toString(), [
        { productId: product._id.toString(), quantity: 1 },
      ])
    ).rejects.toThrow(/no está disponible/i);
  });

  it('rechaza cantidades inválidas', async () => {
    const owner = await makeUser();
    const business = await makeBusiness(owner._id);
    const product = await makeProduct(business._id);

    await expect(
      pricingService.priceItems(business._id.toString(), [
        { productId: product._id.toString(), quantity: 0 },
      ])
    ).rejects.toThrow(/cantidad inválida/i);
  });
});

describe('PricingService.priceDelivery', () => {
  it('cobra la tarifa mínima dentro del radio incluido', async () => {
    const owner = await makeUser();
    const business = await makeBusiness(owner._id);

    // 0.5 km: por debajo del radio incluido, así que sólo la tarifa base,
    // acotada al mínimo configurado.
    const cfg = await deliveryConfig();
    const quote = await pricingService.priceDelivery(business, offsetKm(GARZON, 0.5), cfg);

    expect(quote.customerFee).toBe(
      roundToStep(Math.max(RULES.baseFee, RULES.minFee), RULES.rounding)
    );
    // Sin margen configurado, cliente y repartidor ven el mismo número.
    expect(quote.driverPayout).toBe(quote.customerFee);
    expect(quote.distanceKm).toBeGreaterThan(0.4);
  });

  it('cobra más a mayor distancia', async () => {
    const owner = await makeUser();
    const business = await makeBusiness(owner._id);

    const cfg = await deliveryConfig();
    const near = await pricingService.priceDelivery(business, offsetKm(GARZON, 1), cfg);
    const far = await pricingService.priceDelivery(business, offsetKm(GARZON, 5), cfg);

    expect(far.customerFee).toBeGreaterThan(near.customerFee);
  });

  it('nunca supera la tarifa máxima', async () => {
    const owner = await makeUser();
    const business = await makeBusiness(owner._id);

    const cfg = await deliveryConfig();
    const quote = await pricingService.priceDelivery(
      business,
      offsetKm(GARZON, RULES.maxRadiusKm - 0.1),
      cfg
    );

    expect(quote.customerFee).toBeLessThanOrEqual(RULES.maxFee);
  });

  it('rechaza direcciones fuera del radio de cobertura', async () => {
    const owner = await makeUser();
    const business = await makeBusiness(owner._id);

    const cfg = await deliveryConfig();
    await expect(
      pricingService.priceDelivery(business, offsetKm(GARZON, RULES.maxRadiusKm + 5), cfg)
    ).rejects.toThrow(/cobertura/i);
  });

  it('una zona sobreescribe la tarifa de la plataforma', async () => {
    const owner = await makeUser();
    const business = await makeBusiness(owner._id);
    await makeZone(GARZON, 5, { baseFee: 9000, perKm: 0, surcharge: 0 });

    const cfg = await deliveryConfig();
    const quote = await pricingService.priceDelivery(business, offsetKm(GARZON, 2), cfg);

    expect(quote.zoneId).not.toBeNull();
    // Una zona describe el costo de servirla, así que sube el pago garantizado.
    expect(quote.driverPayout).toBe(9000);
    expect(quote.customerFee).toBe(9000);
  });

  it('con zonas superpuestas gana la de mayor prioridad', async () => {
    const owner = await makeUser();
    const business = await makeBusiness(owner._id);
    await makeZone(GARZON, 5, { name: 'General', baseFee: 9000, perKm: 0, priority: 0 });
    await makeZone(GARZON, 5, { name: 'Preferente', baseFee: 5000, perKm: 0, priority: 10 });

    const cfg = await deliveryConfig();
    const quote = await pricingService.priceDelivery(business, offsetKm(GARZON, 1), cfg);

    expect(quote.zoneName).toBe('Preferente');
    expect(quote.customerFee).toBe(5000);
  });
});

/**
 * El "Desde $X" que enseña la ficha del negocio.
 *
 * Lo que hay que proteger no es el número concreto —ese lo mueve la
 * configuración— sino la promesa: que sea un piso de verdad. Si algún día
 * supera el precio de una entrega real, la ficha estaría prometiendo menos
 * de lo que cobra el carrito, que es justo la queja que este dato existe
 * para evitar.
 */
describe('PricingService.minimumDeliveryFee', () => {
  it('nunca supera lo que cuesta una entrega real', async () => {
    const owner = await makeUser();
    const business = await makeBusiness(owner._id);

    const floor = await pricingService.minimumDeliveryFee(business);
    const cfg = await deliveryConfig();
    const cerca = await pricingService.priceDelivery(business, offsetKm(GARZON, 0.5), cfg);
    const lejos = await pricingService.priceDelivery(business, offsetKm(GARZON, 4), cfg);

    expect(floor).not.toBeNull();
    expect(floor!).toBeLessThanOrEqual(cerca.customerFee);
    expect(floor!).toBeLessThanOrEqual(lejos.customerFee);
  });

  it('respeta la tarifa base de la zona del negocio', async () => {
    const owner = await makeUser();
    const business = await makeBusiness(owner._id);
    await makeZone(GARZON, 5, { baseFee: 9000, perKm: 0, surcharge: 0 });

    expect(await pricingService.minimumDeliveryFee(business)).toBe(9000);
  });

  it('devuelve null en vez de romper la ficha cuando el negocio no tiene ubicación', async () => {
    const owner = await makeUser();
    const business = await makeBusiness(owner._id);
    // Un negocio mal dado de alta no puede tumbar la pantalla del cliente:
    // el encabezado tiene que saber pintarse sin este dato.
    business.set('location', undefined);

    expect(await pricingService.minimumDeliveryFee(business)).toBeNull();
  });
});

describe('PricingService.quote', () => {
  // Online by default: cash on delivery is disabled until reconciliation is
  // operating, so a cash quote is now a deliberate opt-in per test.
  const baseInput = (userId: string, businessId: string, productId: string) => ({
    userId,
    businessId,
    items: [{ productId, quantity: 1 }],
    deliveryLatitude: offsetKm(GARZON, 1).lat,
    deliveryLongitude: offsetKm(GARZON, 1).lng,
    paymentMethod: PaymentMethod.ONLINE,
  });

  it('el total es subtotal + envío + fee + impuestos + propina − descuento', async () => {
    await deliveryConfig();
    const client = await makeUser();
    const owner = await makeUser();
    const business = await makeBusiness(owner._id);
    const product = await makeProduct(business._id, { price: 20000 });

    const quote = await pricingService.quote(
      baseInput(client._id.toString(), business._id.toString(), product._id.toString())
    );

    expect(quote.total).toBe(
      quote.subtotal +
        quote.deliveryFee +
        quote.customerServiceFee +
        quote.tax +
        quote.tip -
        quote.discount
    );
    expect(quote.subtotal).toBe(20000);
  });

  it('rechaza coordenadas de entrega inválidas', async () => {
    await deliveryConfig();
    const client = await makeUser();
    const owner = await makeUser();
    const business = await makeBusiness(owner._id);
    const product = await makeProduct(business._id);

    await expect(
      pricingService.quote({
        ...baseInput(client._id.toString(), business._id.toString(), product._id.toString()),
        deliveryLatitude: 0,
        deliveryLongitude: 0,
      })
    ).rejects.toThrow(/ubicación válida/i);
  });

  it('respeta el pedido mínimo del negocio', async () => {
    await deliveryConfig();
    const client = await makeUser();
    const owner = await makeUser();
    const business = await makeBusiness(owner._id, { minOrder: 30000 });
    const product = await makeProduct(business._id, { price: 10000 });

    await expect(
      pricingService.quote(
        baseInput(client._id.toString(), business._id.toString(), product._id.toString())
      )
    ).rejects.toThrow(/pedido mínimo/i);
  });

  it('la propina se suma al total y va completa al domiciliario', async () => {
    await deliveryConfig();
    const client = await makeUser();
    const owner = await makeUser();
    const business = await makeBusiness(owner._id);
    const product = await makeProduct(business._id, { price: 20000 });

    const withoutTip = await pricingService.quote(
      baseInput(client._id.toString(), business._id.toString(), product._id.toString())
    );
    const withTip = await pricingService.quote({
      ...baseInput(client._id.toString(), business._id.toString(), product._id.toString()),
      tip: 3000,
    });

    expect(withTip.total - withoutTip.total).toBe(3000);
    expect(withTip.driverPayout - withoutTip.driverPayout).toBe(3000);
  });

  it('rechaza propinas negativas o desproporcionadas', async () => {
    await deliveryConfig();
    const client = await makeUser();
    const owner = await makeUser();
    const business = await makeBusiness(owner._id);
    const product = await makeProduct(business._id, { price: 20000 });

    const input = baseInput(client._id.toString(), business._id.toString(), product._id.toString());

    await expect(pricingService.quote({ ...input, tip: -1000 })).rejects.toThrow(/negativa/i);
    await expect(pricingService.quote({ ...input, tip: 99_999_999 })).rejects.toThrow(/propina/i);
  });

  it('en pago digital la plataforma retiene su comisión del pago al negocio', async () => {
    await deliveryConfig();
    const client = await makeUser();
    const owner = await makeUser();
    const business = await makeBusiness(owner._id, { commissionRateBps: 1000 });
    const product = await makeProduct(business._id, { price: 20000 });

    const quote = await pricingService.quote({
      ...baseInput(client._id.toString(), business._id.toString(), product._id.toString()),
      paymentMethod: PaymentMethod.ONLINE,
    });

    expect(quote.platformCommission).toBe(2000);
    expect(quote.businessPayout).toBe(18000);
    expect(quote.driverPayout).toBe(quote.driverDeliveryPayout);
  });

  /**
   * Under the old model a cash order charged the merchant's commission to
   * the courier: `driverPayout = deliveryFee − commission`. Above roughly
   * ten times the delivery fee that went to zero and the courier still owed
   * the difference. The commission is now the merchant's, whatever the
   * payment method, and the courier's fee is untouchable.
   */
  it('contra entrega el repartidor conserva íntegra su tarifa', async () => {
    await deliveryConfig({ cashOnDeliveryEnabled: true });
    const client = await makeUser();
    const owner = await makeUser();
    const business = await makeBusiness(owner._id, { commissionRateBps: 1000 });
    const product = await makeProduct(business._id, { price: 20000 });

    const quote = await pricingService.quote({
      ...baseInput(client._id.toString(), business._id.toString(), product._id.toString()),
      paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
    });

    expect(quote.platformCommission).toBe(2000);
    expect(quote.businessPayout).toBe(18000);
    expect(quote.driverPayout).toBe(quote.driverDeliveryPayout);
    // Lo que el repartidor debe rendir es sólo la parte de ZIPP.
    expect(quote.cashToRemit).toBe(2000);
  });

  it('el pago contra entrega se rechaza si el admin lo tiene desactivado', async () => {
    await deliveryConfig({ cashOnDeliveryEnabled: false });
    const client = await makeUser();
    const owner = await makeUser();
    const business = await makeBusiness(owner._id);
    const product = await makeProduct(business._id, { price: 20000 });

    await expect(
      pricingService.quote({
        ...baseInput(client._id.toString(), business._id.toString(), product._id.toString()),
        paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
      })
    ).rejects.toThrow(/contra entrega no está disponible/i);
  });

  it('rechaza negocios inactivos', async () => {
    await deliveryConfig();
    const client = await makeUser();
    const owner = await makeUser();
    const business = await makeBusiness(owner._id, { isActive: false });
    const product = await makeProduct(business._id);

    await expect(
      pricingService.quote(
        baseInput(client._id.toString(), business._id.toString(), product._id.toString())
      )
    ).rejects.toThrow(/no encontrado o inactivo/i);
  });
});
