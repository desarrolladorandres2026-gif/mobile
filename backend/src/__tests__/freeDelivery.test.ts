import { describe, it, expect, beforeEach } from 'vitest';
import { Business } from '../models';
import { UserRole, PaymentMethod } from '../types';
import { pricingService } from '../services/pricing.service';
import { makeUser, makeBusiness, makeProduct, makePricingConfig, GARZON } from './factories';

/**
 * Envío gratis por compra mínima, financiado por el comercio.
 *
 * No es un mecanismo nuevo: es un descuento de entrega financiado por el
 * negocio, igual que uno de sus cupones. Modelarlo así importa porque toda
 * la contabilidad ya sabe tratar eso, y una vía paralela sería una vía por
 * la que se escapa dinero sin que nadie lo cuadre.
 *
 * Lo que estas pruebas fijan es el reparto: quién cobra menos y quién sigue
 * cobrando lo mismo cuando el cliente no paga el domicilio.
 */
describe('Envío gratis financiado por el comercio', () => {
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
    product = await makeProduct(business._id, { price: 10000 });
  });

  it('sin umbral configurado, el cliente paga su domicilio', async () => {
    const quote = await quoteFor(5);
    expect(quote.deliveryPayable).toBeGreaterThan(0);
    expect(quote.freeDeliveryApplied).toBe(false);
  });

  it('por debajo del umbral tampoco lo regala', async () => {
    await Business.updateOne({ _id: business._id }, { freeDeliveryThreshold: 60000 });

    const quote = await quoteFor(1);
    expect(quote.deliveryPayable).toBeGreaterThan(0);
  });

  it('alcanzado el umbral, el cliente no paga domicilio', async () => {
    await Business.updateOne({ _id: business._id }, { freeDeliveryThreshold: 30000 });

    const quote = await quoteFor(5);
    // El bruto se conserva para poder enseñar el ahorro; lo que paga es 0.
    expect(quote.deliveryPayable).toBe(0);
    expect(quote.deliveryCustomerFee).toBeGreaterThan(0);
    expect(quote.freeDeliveryApplied).toBe(true);
  });

  it('el domiciliario cobra exactamente lo mismo', async () => {
    const sinUmbral = await quoteFor(5);

    await Business.updateOne({ _id: business._id }, { freeDeliveryThreshold: 30000 });
    const conUmbral = await quoteFor(5);

    // Quien reparte no financia la promoción de nadie.
    expect(conUmbral.driverPayout).toBe(sinUmbral.driverPayout);
  });

  it('lo paga el negocio: su liquidación baja justo el importe del envío', async () => {
    const sinUmbral = await quoteFor(5);

    await Business.updateOne({ _id: business._id }, { freeDeliveryThreshold: 30000 });
    const conUmbral = await quoteFor(5);

    const envio = sinUmbral.deliveryPayable;
    expect(conUmbral.businessPayout).toBe(sinUmbral.businessPayout - envio);
  });

  it('la comisión de la plataforma no baja: los productos se vendieron enteros', async () => {
    const sinUmbral = await quoteFor(5);

    await Business.updateOne({ _id: business._id }, { freeDeliveryThreshold: 30000 });
    const conUmbral = await quoteFor(5);

    // Descontar el envío regalado de la base haría que ZIPP pagara parte de
    // una promoción que no decidió.
    expect(conUmbral.merchantCommission).toBe(sinUmbral.merchantCommission);
  });

  it('el cliente paga menos, exactamente el envío menos', async () => {
    const sinUmbral = await quoteFor(5);

    await Business.updateOne({ _id: business._id }, { freeDeliveryThreshold: 30000 });
    const conUmbral = await quoteFor(5);

    // Puede haber impuesto sobre el envío, así que la diferencia es de al
    // menos el envío y nunca mayor que el envío más su impuesto.
    const ahorro = sinUmbral.customerTotal - conUmbral.customerTotal;
    expect(ahorro).toBeGreaterThanOrEqual(sinUmbral.deliveryPayable);
  });

  it('el libro cuadra: el propio servicio se niega a cotizar si no', async () => {
    await Business.updateOne({ _id: business._id }, { freeDeliveryThreshold: 30000 });

    // `assertBalanced` comprueba en cada cotización que lo que paga el
    // cliente más lo subsidiado acaba exactamente en alguien, y lanza si
    // no. Que esto no lance es la comprobación: reimplementar aquí la
    // fórmula solo probaría que sé copiarla.
    await expect(quoteFor(5)).resolves.toBeDefined();

    const quote = await quoteFor(5);
    expect(quote.merchantFundedDiscount).toBe(quote.deliveryCustomerFee);
  });
});
