import { describe, it, expect, beforeEach } from 'vitest';
import { Order, Product, User } from '../models';
import { UserRole, PaymentMethod } from '../types';
import { orderService } from '../services/order.service';
import { makeUser, makeBusiness, makeProduct, makePricingConfig, GARZON } from './factories';

/**
 * Productos que no se le pueden vender a un menor.
 *
 * En Colombia aplica a licor y cigarrillos. Hay dos barreras:
 * - La plataforma exige la fecha de nacimiento declarada (se guarda una
 *   sola vez) y rechaza el pedido si es de un menor de 18. Antes no se
 *   bloqueaba nada; se cambió a pedido del dueño del producto (2026-09-19).
 * - En la puerta, la cédula: lo declarado no prueba nada, así que el pedido
 *   sigue quedando marcado para que el domiciliario la pida.
 */
describe('Productos con restricción de edad', () => {
  let client: any;
  let business: any;

  const orderWith = async (productIds: string[]) =>
    orderService.create({
      clientId: client._id.toString(),
      businessId: business._id.toString(),
      items: productIds.map((productId) => ({ productId, quantity: 1 })),
      paymentMethod: PaymentMethod.ONLINE,
      deliveryAddress: 'Cra 1 #2-3',
      deliveryLongitude: GARZON.lng,
      deliveryLatitude: GARZON.lat,
    });

  beforeEach(async () => {
    await makePricingConfig();
    client = await makeUser({ role: UserRole.CLIENT });
    // Adulto por defecto: los casos de fecha ausente o de menor lo cambian.
    await User.updateOne({ _id: client._id }, { birthDate: new Date(Date.UTC(1990, 4, 10)) });
    const owner = await makeUser({ role: UserRole.BUSINESS });
    business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
  });

  it('un producto normal nace sin restricción', async () => {
    const product = await makeProduct(business._id);
    expect((await Product.findById(product._id))!.requiresAgeVerification).toBe(false);
  });

  it('un pedido con licor queda marcado', async () => {
    const licor = await makeProduct(business._id, { name: 'Aguardiente' });
    await Product.updateOne({ _id: licor._id }, { requiresAgeVerification: true });

    const order = await orderWith([licor._id.toString()]);

    expect((await Order.findById(order._id))!.requiresAgeVerification).toBe(true);
  });

  it('un pedido sin nada restringido no se marca', async () => {
    const product = await makeProduct(business._id);
    const order = await orderWith([product._id.toString()]);

    expect((await Order.findById(order._id))!.requiresAgeVerification).toBe(false);
  });

  it('basta un producto restringido entre varios', async () => {
    const normal = await makeProduct(business._id, { name: 'Papas' });
    const licor = await makeProduct(business._id, { name: 'Cerveza' });
    await Product.updateOne({ _id: licor._id }, { requiresAgeVerification: true });

    const order = await orderWith([normal._id.toString(), licor._id.toString()]);

    expect((await Order.findById(order._id))!.requiresAgeVerification).toBe(true);
  });

  it('sin fecha de nacimiento no se puede pedir licor', async () => {
    const licor = await makeProduct(business._id, { name: 'Ron' });
    await Product.updateOne({ _id: licor._id }, { requiresAgeVerification: true });
    await User.updateOne({ _id: client._id }, { $unset: { birthDate: 1 } });

    await expect(orderWith([licor._id.toString()])).rejects.toMatchObject({
      statusCode: 400,
      code: 'BIRTHDATE_REQUIRED',
    });
  });

  it('un menor de 18 no puede pedir licor', async () => {
    const licor = await makeProduct(business._id, { name: 'Cerveza' });
    await Product.updateOne({ _id: licor._id }, { requiresAgeVerification: true });
    const now = new Date();
    await User.updateOne(
      { _id: client._id },
      { birthDate: new Date(Date.UTC(now.getUTCFullYear() - 16, 0, 1)) }
    );

    await expect(orderWith([licor._id.toString()])).rejects.toMatchObject({
      statusCode: 403,
      code: 'AGE_RESTRICTED',
    });
    // Nada quedó a medias: ni pedido ni stock apartado.
    expect(await Order.countDocuments({ clientId: client._id })).toBe(0);
  });

  it('un adulto pide licor y el pedido sigue marcado para la cédula', async () => {
    const licor = await makeProduct(business._id, { name: 'Ron' });
    await Product.updateOne({ _id: licor._id }, { requiresAgeVerification: true });

    const order = await orderWith([licor._id.toString()]);

    expect((await Order.findById(order._id))!.requiresAgeVerification).toBe(true);
  });

  it('sin productos +18 la fecha de nacimiento no hace falta', async () => {
    const product = await makeProduct(business._id);
    await User.updateOne({ _id: client._id }, { $unset: { birthDate: 1 } });

    await expect(orderWith([product._id.toString()])).resolves.toBeDefined();
  });

  it('la cotización avisa que hay productos +18', async () => {
    const normal = await makeProduct(business._id, { name: 'Papas' });
    const licor = await makeProduct(business._id, { name: 'Vino' });
    await Product.updateOne({ _id: licor._id }, { requiresAgeVerification: true });

    const quoteFor = (ids: string[]) =>
      orderService.quote({
        clientId: client._id.toString(),
        businessId: business._id.toString(),
        items: ids.map((productId) => ({ productId, quantity: 1 })),
        paymentMethod: PaymentMethod.ONLINE,
        deliveryLongitude: GARZON.lng,
        deliveryLatitude: GARZON.lat,
      });

    expect((await quoteFor([normal._id.toString()])).requiresAgeVerification).toBe(false);
    expect((await quoteFor([normal._id.toString(), licor._id.toString()])).requiresAgeVerification).toBe(true);
  });

  it('la marca se congela: quitarla del producto no cambia pedidos viejos', async () => {
    const licor = await makeProduct(business._id, { name: 'Vino' });
    await Product.updateOne({ _id: licor._id }, { requiresAgeVerification: true });

    const order = await orderWith([licor._id.toString()]);
    await Product.updateOne({ _id: licor._id }, { requiresAgeVerification: false });

    // Si el comercio quita la marca mañana, este pedido siguió necesitando
    // la cédula hoy.
    expect((await Order.findById(order._id))!.requiresAgeVerification).toBe(true);
  });

  it('el comercio puede marcar y desmarcar sus productos', async () => {
    const { productService } = await import('../services/product.service');
    const product = await makeProduct(business._id);

    await productService.update(product._id.toString(), business._id.toString(), {
      requiresAgeVerification: true,
    });
    expect((await Product.findById(product._id))!.requiresAgeVerification).toBe(true);

    await productService.update(product._id.toString(), business._id.toString(), {
      requiresAgeVerification: false,
    });
    expect((await Product.findById(product._id))!.requiresAgeVerification).toBe(false);
  });
});
