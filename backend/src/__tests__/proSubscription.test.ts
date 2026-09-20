import { describe, it, expect, beforeEach } from 'vitest';
import { ProSubscription, ProSubscriptionStatus, isProActive, Payment } from '../models';
import { UserRole, PaymentMethod, PaymentStatus, PaymentType } from '../types';
import { pricingService } from '../services/pricing.service';
import { proService } from '../services/pro.service';
import { PRO_PLAN, PRO_RENEWAL_MAX_ATTEMPTS } from '../config/pro';
import { makeUser, makeBusiness, makeProduct, makePricingConfig, GARZON } from './factories';

/**
 * Zipp Pro: la membresía.
 *
 * Lo que se fija aquí no es la pantalla, es el dinero y las fechas: quién
 * tiene beneficios y hasta cuándo, quién paga el envío que se regala, y qué
 * pasa cuando la renovación no entra. Todo lo demás —el precio, el mínimo
 * de compra— vive en `config/pro.ts` y puede cambiar sin que estas pruebas
 * dejen de valer, porque ninguna escribe un número del plan a mano.
 */

const DAY = 24 * 60 * 60_000;

/** Enciende la membresía sin pasar por la pasarela. */
async function makeMember(userId: string, overrides: Record<string, unknown> = {}) {
  return ProSubscription.create({
    userId,
    status: ProSubscriptionStatus.ACTIVE,
    planId: PRO_PLAN.id,
    price: PRO_PLAN.price,
    currency: PRO_PLAN.currency,
    startedAt: new Date(),
    currentPeriodStart: new Date(),
    currentPeriodEnd: new Date(Date.now() + 15 * DAY),
    autoRenew: true,
    ...overrides,
  });
}

describe('Ser Pro es una fecha, no un estado', () => {
  it('una membresía cancelada pero vigente sigue dando beneficios', () => {
    const sub = {
      status: ProSubscriptionStatus.CANCELLED,
      currentPeriodEnd: new Date(Date.now() + DAY),
    };
    // Lo pagó. Cancelar solo quiere decir "no me cobres el mes que viene".
    expect(isProActive(sub as never)).toBe(true);
  });

  it('una membresía activa pero vencida no da nada', () => {
    const sub = {
      status: ProSubscriptionStatus.ACTIVE,
      currentPeriodEnd: new Date(Date.now() - DAY),
    };
    expect(isProActive(sub as never)).toBe(false);
  });

  it('un cobro en curso todavía no es una membresía', () => {
    const sub = {
      status: ProSubscriptionStatus.PENDING,
      currentPeriodEnd: null,
    };
    expect(isProActive(sub as never)).toBe(false);
  });
});

describe('El trato de Zipp Pro en el precio', () => {
  let client: any;
  let business: any;
  let product: any;

  const quoteFor = (quantity: number) =>
    pricingService.quote({
      userId: client._id.toString(),
      businessId: business._id.toString(),
      items: [{ productId: product._id.toString(), quantity }],
      paymentMethod: PaymentMethod.ONLINE,
      deliveryLatitude: GARZON.lat,
      deliveryLongitude: GARZON.lng,
    } as never);

  beforeEach(async () => {
    await makePricingConfig();
    client = await makeUser({ role: UserRole.CLIENT });
    const owner = await makeUser({ role: UserRole.BUSINESS });
    business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
    // Precio por unidad tal que 5 unidades superen el mínimo del plan y 1 no.
    product = await makeProduct(business._id, {
      price: Math.max(1000, Math.ceil(PRO_PLAN.benefits.freeDelivery.minSubtotal / 4)),
    });
  });

  it('sin membresía, el cliente paga su domicilio', async () => {
    const quote = await quoteFor(5);
    expect(quote.proDeliveryDiscount).toBe(0);
    expect(quote.deliveryPayable).toBeGreaterThan(0);
  });

  it('siendo Pro y alcanzando el mínimo, el domicilio queda en cero', async () => {
    await makeMember(client._id.toString());

    const quote = await quoteFor(5);
    expect(quote.deliveryPayable).toBe(0);
    // El bruto se conserva para poder enseñar el ahorro.
    expect(quote.deliveryCustomerFee).toBeGreaterThan(0);
    expect(quote.proDeliveryDiscount).toBeGreaterThan(0);
  });

  it('por debajo del mínimo, la membresía no regala el envío', async () => {
    await makeMember(client._id.toString());

    const quote = await quoteFor(1);
    expect(quote.proDeliveryDiscount).toBe(0);
    expect(quote.deliveryPayable).toBeGreaterThan(0);
  });

  it('una membresía vencida no descuenta nada', async () => {
    await makeMember(client._id.toString(), {
      currentPeriodEnd: new Date(Date.now() - DAY),
    });

    const quote = await quoteFor(5);
    expect(quote.proDeliveryDiscount).toBe(0);
  });

  it('lo paga ZIPP, no el comercio ni el domiciliario', async () => {
    const sinPro = await quoteFor(5);
    await makeMember(client._id.toString());
    const conPro = await quoteFor(5);

    // Quien reparte cobra lo mismo y quien cocina liquida lo mismo: el
    // descuento sale entero del subsidio de plataforma.
    expect(conPro.driverPayout).toBe(sinPro.driverPayout);
    expect(conPro.businessPayout).toBe(sinPro.businessPayout);
    expect(conPro.platformFundedDiscount).toBeGreaterThan(sinPro.platformFundedDiscount);
  });

  it('el cliente paga menos', async () => {
    const sinPro = await quoteFor(5);
    await makeMember(client._id.toString());
    const conPro = await quoteFor(5);

    expect(conPro.customerTotal).toBeLessThan(sinPro.customerTotal);
  });

  it('el libro cuadra con la membresía puesta', async () => {
    await makeMember(client._id.toString());
    const quote = await quoteFor(5);

    // `assertBalanced` se niega a cotizar si no cuadra, así que llegar aquí
    // ya es la mitad de la prueba; la identidad se comprueba igualmente.
    const inflow = quote.customerTotal + quote.platformFundedDiscount;
    const outflow =
      quote.businessPayout + quote.driverPayout + quote.platformGrossRevenue + quote.taxPayable;
    expect(inflow).toBe(outflow);
  });
});

describe('Ciclo de vida de la membresía', () => {
  let client: any;

  beforeEach(async () => {
    client = await makeUser({ role: UserRole.CLIENT });
  });

  const fakePayment = (userId: string) =>
    new Payment({
      userId,
      type: PaymentType.PRO_SUBSCRIPTION,
      method: PaymentMethod.ONLINE,
      status: PaymentStatus.PAID,
      amount: PRO_PLAN.price,
      currency: PRO_PLAN.currency,
      reference: `ZIPP-PRO-${userId}-TEST-${Math.random().toString(36).slice(2, 8)}`,
    });

  it('un cobro aprobado enciende la membresía por el periodo del plan', async () => {
    await ProSubscription.create({
      userId: client._id,
      status: ProSubscriptionStatus.PENDING,
      planId: PRO_PLAN.id,
      price: PRO_PLAN.price,
    });

    await proService.settlePayment(fakePayment(client._id.toString()) as never, PaymentStatus.PAID);

    const sub = await ProSubscription.findOne({ userId: client._id });
    expect(sub!.status).toBe(ProSubscriptionStatus.ACTIVE);
    expect(isProActive(sub)).toBe(true);

    const days = Math.round((sub!.currentPeriodEnd!.getTime() - Date.now()) / DAY);
    expect(days).toBe(PRO_PLAN.periodDays);
  });

  it('renovar antes de tiempo encadena al final del periodo, no a hoy', async () => {
    const end = new Date(Date.now() + 5 * DAY);
    await makeMember(client._id.toString(), { currentPeriodEnd: end });

    await proService.settlePayment(fakePayment(client._id.toString()) as never, PaymentStatus.PAID);

    const sub = await ProSubscription.findOne({ userId: client._id });
    const expected = end.getTime() + PRO_PLAN.periodDays * DAY;
    // Los cinco días ya pagados no se pierden por renovar antes.
    expect(Math.abs(sub!.currentPeriodEnd!.getTime() - expected)).toBeLessThan(60_000);
  });

  it('cancelar no quita el acceso: apaga la renovación', async () => {
    await makeMember(client._id.toString());

    const status = await proService.cancel(client._id.toString());

    expect(status.member).toBe(true);
    expect(status.autoRenew).toBe(false);
    expect(status.status).toBe(ProSubscriptionStatus.CANCELLED);
  });

  it('reactivar vuelve a poner la renovación en marcha', async () => {
    await makeMember(client._id.toString(), {
      status: ProSubscriptionStatus.CANCELLED,
      autoRenew: false,
      cancelledAt: new Date(),
    });

    const status = await proService.resume(client._id.toString());

    expect(status.autoRenew).toBe(true);
    expect(status.status).toBe(ProSubscriptionStatus.ACTIVE);
  });

  it('no se puede cancelar lo que no está activo', async () => {
    await expect(proService.cancel(client._id.toString())).rejects.toThrow();
  });

  it('un rechazo con periodo vivo no toca el acceso: cuenta el intento', async () => {
    await makeMember(client._id.toString());

    const payment = fakePayment(client._id.toString());
    await proService.settlePayment(payment as never, PaymentStatus.FAILED);

    const sub = await ProSubscription.findOne({ userId: client._id });
    expect(isProActive(sub)).toBe(true);
    expect(sub!.renewalFailures).toBe(1);
  });

  it('un rechazo sin periodo vivo deja la membresía por vencida', async () => {
    await ProSubscription.create({
      userId: client._id,
      status: ProSubscriptionStatus.PENDING,
      planId: PRO_PLAN.id,
      price: PRO_PLAN.price,
    });

    await proService.settlePayment(fakePayment(client._id.toString()) as never, PaymentStatus.FAILED);

    const sub = await ProSubscription.findOne({ userId: client._id });
    expect(sub!.status).toBe(ProSubscriptionStatus.EXPIRED);
  });
});

describe('Barrido de renovaciones', () => {
  let client: any;

  beforeEach(async () => {
    client = await makeUser({ role: UserRole.CLIENT });
  });

  it('da por vencida la que no renueva y ya pasó su fecha', async () => {
    await makeMember(client._id.toString(), {
      status: ProSubscriptionStatus.CANCELLED,
      autoRenew: false,
      currentPeriodEnd: new Date(Date.now() - DAY),
    });

    const result = await proService.sweepRenewals();

    expect(result.expired).toBe(1);
    const sub = await ProSubscription.findOne({ userId: client._id });
    expect(sub!.status).toBe(ProSubscriptionStatus.EXPIRED);
  });

  it('da por vencida la que agotó sus reintentos', async () => {
    await makeMember(client._id.toString(), {
      currentPeriodEnd: new Date(Date.now() - DAY),
      renewalFailures: PRO_RENEWAL_MAX_ATTEMPTS,
    });

    await proService.sweepRenewals();

    const sub = await ProSubscription.findOne({ userId: client._id });
    expect(sub!.status).toBe(ProSubscriptionStatus.EXPIRED);
  });

  it('no toca la que todavía no vence', async () => {
    await makeMember(client._id.toString(), {
      currentPeriodEnd: new Date(Date.now() + 5 * DAY),
    });

    const result = await proService.sweepRenewals();

    expect(result.charged).toBe(0);
    expect(result.expired).toBe(0);
    const sub = await ProSubscription.findOne({ userId: client._id });
    expect(sub!.status).toBe(ProSubscriptionStatus.ACTIVE);
  });
});
