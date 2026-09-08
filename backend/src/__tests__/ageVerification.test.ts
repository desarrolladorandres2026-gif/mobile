import { describe, it, expect, beforeEach } from 'vitest';
import { Order, Product } from '../models';
import { UserRole, PaymentMethod } from '../types';
import { orderService } from '../services/order.service';
import { makeUser, makeBusiness, makeProduct, makePricingConfig, GARZON } from './factories';

/**
 * Productos que no se le pueden vender a un menor.
 *
 * En Colombia aplica a licor y cigarrillos, y la responsabilidad es del
 * comercio y de quien entrega, no de la plataforma que los conecta.
 *
 * Por eso la plataforma **no bloquea la compra**: comprobar la edad de
 * verdad exige ver un documento, y eso ocurre en la puerta. Lo que hace es
 * marcar el pedido para que el domiciliario sepa que tiene que pedir la
 * cédula, y que quede constancia de que se le avisó.
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

  it('la compra NO se bloquea: la cédula se pide en la puerta', async () => {
    const licor = await makeProduct(business._id, { name: 'Ron' });
    await Product.updateOne({ _id: licor._id }, { requiresAgeVerification: true });

    // Bloquear aquí daría una falsa sensación de control: la plataforma no
    // puede ver un documento, y quien sí puede es el domiciliario.
    await expect(orderWith([licor._id.toString()])).resolves.toBeDefined();
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
