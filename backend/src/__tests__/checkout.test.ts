import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../app';
import { Order, Coupon, CouponRedemption } from '../models';
import { CouponType, OrderStatus, UserRole } from '../types';
import {
  GARZON, offsetKm, makeUser, makeBusiness, makeProduct, makeCoupon, authHeader,
  makePricingConfig,
} from './factories';

const DESTINATION = offsetKm(GARZON, 2);

async function scenario(productOverrides = {}) {
  await makePricingConfig();
  const client = await makeUser({ role: UserRole.CLIENT });
  const owner = await makeUser({ role: UserRole.BUSINESS });
  const business = await makeBusiness(owner._id);
  const product = await makeProduct(business._id, { price: 20000, ...productOverrides });
  return { client, owner, business, product };
}

const orderBody = (business: any, product: any, extra: Record<string, unknown> = {}) => ({
  businessId: business._id.toString(),
  items: [{ productId: product._id.toString(), quantity: 2 }],
  paymentMethod: 'online',
  deliveryAddress: 'Calle 5 # 3-21, Garzón',
  deliveryDetails: 'Portón negro',
  deliveryLatitude: DESTINATION.lat,
  deliveryLongitude: DESTINATION.lng,
  ...extra,
});

describe('POST /api/v1/orders/quote', () => {
  it('requiere autenticación', async () => {
    const { business, product } = await scenario();

    await request(app)
      .post('/api/v1/orders/quote')
      .send(orderBody(business, product))
      .expect(401);
  });

  it('devuelve un desglose completo y coherente', async () => {
    const { client, business, product } = await scenario();

    const res = await request(app)
      .post('/api/v1/orders/quote')
      .set(authHeader(client))
      .send(orderBody(business, product))
      .expect(200);

    const quote = res.body.data;
    expect(quote.subtotal).toBe(40000);
    expect(quote.deliveryFee).toBeGreaterThan(0);
    expect(quote.total).toBe(
      quote.subtotal +
        quote.deliveryFee +
        quote.customerServiceFee +
        quote.tax +
        quote.tip -
        quote.discount
    );
  });

  it('no crea ningún pedido', async () => {
    const { client, business, product } = await scenario();

    await request(app)
      .post('/api/v1/orders/quote')
      .set(authHeader(client))
      .send(orderBody(business, product))
      .expect(200);

    expect(await Order.countDocuments()).toBe(0);
  });

  it('no consume el cupón al previsualizarlo', async () => {
    const { client, business, product } = await scenario();
    const coupon = await makeCoupon({ code: 'PREVIEW', type: CouponType.PERCENTAGE, value: 10 });

    await request(app)
      .post('/api/v1/orders/quote')
      .set(authHeader(client))
      .send(orderBody(business, product, { couponCode: 'PREVIEW' }))
      .expect(200);

    expect((await Coupon.findById(coupon._id))!.usedCount).toBe(0);
  });

  it('rechaza un cupón inválido con un mensaje legible', async () => {
    const { client, business, product } = await scenario();

    const res = await request(app)
      .post('/api/v1/orders/quote')
      .set(authHeader(client))
      .send(orderBody(business, product, { couponCode: 'NOEXISTE' }))
      .expect(404);

    expect(res.body.message).toMatch(/inválido/i);
  });

  it('rechaza direcciones fuera de cobertura', async () => {
    const { client, business, product } = await scenario();
    const faraway = offsetKm(GARZON, 100);

    const res = await request(app)
      .post('/api/v1/orders/quote')
      .set(authHeader(client))
      .send(orderBody(business, product, {
        deliveryLatitude: faraway.lat,
        deliveryLongitude: faraway.lng,
      }))
      .expect(422);

    expect(res.body.message).toMatch(/cobertura/i);
  });
});

describe('POST /api/v1/orders', () => {
  it('cobra exactamente el total cotizado', async () => {
    const { client, business, product } = await scenario();
    const body = orderBody(business, product);

    const quoted = await request(app)
      .post('/api/v1/orders/quote')
      .set(authHeader(client))
      .send(body)
      .expect(200);

    const created = await request(app)
      .post('/api/v1/orders')
      .set(authHeader(client))
      .send(body)
      .expect(201);

    expect(created.body.data.total).toBe(quoted.body.data.total);
    expect(created.body.data.subtotal).toBe(quoted.body.data.subtotal);
    expect(created.body.data.deliveryFee).toBe(quoted.body.data.deliveryFee);
  });

  // This is the regression that motivated the pricing rework: checkout used
  // to show a discounted total while the order was stored at full price.
  it('con cupón, el total guardado coincide con el cotizado y refleja el descuento', async () => {
    const { client, business, product } = await scenario();
    await makeCoupon({ code: 'MITAD', type: CouponType.PERCENTAGE, value: 50 });

    const body = orderBody(business, product, { couponCode: 'MITAD' });

    const quoted = await request(app)
      .post('/api/v1/orders/quote')
      .set(authHeader(client))
      .send(body)
      .expect(200);

    const created = await request(app)
      .post('/api/v1/orders')
      .set(authHeader(client))
      .send(body)
      .expect(201);

    const order = created.body.data;

    expect(order.discount).toBe(20000);          // 50% de 40000
    expect(order.total).toBe(quoted.body.data.total);
    expect(order.total).toBe(order.subtotal + order.deliveryFee + order.tip + order.tax - order.discount);
    expect(order.couponCode).toBe('MITAD');
  });

  it('el cupón de envío gratis deja el envío en cero', async () => {
    const { client, business, product } = await scenario();
    await makeCoupon({ code: 'ENVIOGRATIS', type: CouponType.FREE_DELIVERY, value: 0 });

    const created = await request(app)
      .post('/api/v1/orders')
      .set(authHeader(client))
      .send(orderBody(business, product, { couponCode: 'ENVIOGRATIS' }))
      .expect(201);

    const order = created.body.data;
    expect(order.discount).toBe(order.deliveryFee);
    expect(order.total).toBe(order.subtotal + order.tip + order.tax);
  });

  it('consume el cupón al crear el pedido', async () => {
    const { client, business, product } = await scenario();
    const coupon = await makeCoupon({ code: 'CONSUMO', type: CouponType.FIXED, value: 5000 });

    await request(app)
      .post('/api/v1/orders')
      .set(authHeader(client))
      .send(orderBody(business, product, { couponCode: 'CONSUMO' }))
      .expect(201);

    expect((await Coupon.findById(coupon._id))!.usedCount).toBe(1);
    expect(await CouponRedemption.countDocuments({ couponId: coupon._id })).toBe(1);
  });

  it('guarda la propina y la suma al total', async () => {
    const { client, business, product } = await scenario();

    const created = await request(app)
      .post('/api/v1/orders')
      .set(authHeader(client))
      .send(orderBody(business, product, { tip: 4000 }))
      .expect(201);

    const order = created.body.data;
    expect(order.tip).toBe(4000);
    expect(order.total).toBe(order.subtotal + order.deliveryFee + order.tax - order.discount + 4000);
  });

  it('ignora precios de extras enviados por el cliente', async () => {
    await makePricingConfig();
    const client = await makeUser({ role: UserRole.CLIENT });
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id);
    const product = await makeProduct(business._id, {
      price: 20000,
      extras: [{ name: 'Queso extra', price: 3000 }],
    });

    const created = await request(app)
      .post('/api/v1/orders')
      .set(authHeader(client))
      .send({
        ...orderBody(business, product),
        items: [{
          productId: product._id.toString(),
          quantity: 1,
          selectedExtras: [{ name: 'Queso extra', price: -1000000, quantity: 1 }],
        }],
      })
      .expect(201);

    expect(created.body.data.subtotal).toBe(23000);
    expect(created.body.data.items[0].selectedExtras[0].price).toBe(3000);
  });

  it('es idempotente: la misma clave no duplica el pedido', async () => {
    const { client, business, product } = await scenario();
    const body = orderBody(business, product, { idempotencyKey: 'clave-fija-123' });

    const first = await request(app).post('/api/v1/orders').set(authHeader(client)).send(body).expect(201);
    const second = await request(app).post('/api/v1/orders').set(authHeader(client)).send(body).expect(201);

    expect(second.body.data._id).toBe(first.body.data._id);
    expect(await Order.countDocuments()).toBe(1);
  });

  it('rechaza a un usuario que no es cliente', async () => {
    const { business, product } = await scenario();
    const driver = await makeUser({ role: UserRole.DRIVER });

    await request(app)
      .post('/api/v1/orders')
      .set(authHeader(driver))
      .send(orderBody(business, product))
      .expect(403);
  });

  it('rechaza un carrito vacío', async () => {
    const { client, business, product } = await scenario();

    await request(app)
      .post('/api/v1/orders')
      .set(authHeader(client))
      .send({ ...orderBody(business, product), items: [] })
      .expect(400);
  });

  it('nace en estado pendiente y sin domiciliario', async () => {
    const { client, business, product } = await scenario();

    const created = await request(app)
      .post('/api/v1/orders')
      .set(authHeader(client))
      .send(orderBody(business, product))
      .expect(201);

    expect(created.body.data.status).toBe(OrderStatus.PENDING);
    expect(created.body.data.driverId).toBeNull();
    expect(created.body.data.orderNumber).toMatch(/^ZP\d{4}-\d{5}$/);
  });
});
