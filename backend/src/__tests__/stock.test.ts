import { describe, it, expect, beforeEach } from 'vitest';
import { Product, Order } from '../models';
import { OrderStatus, UserRole, PaymentMethod } from '../types';
import { orderService } from '../services/order.service';
import { makeUser, makeBusiness, makeProduct, makePricingConfig, GARZON } from './factories';

/**
 * Control de inventario.
 *
 * Hasta ahora solo existía un booleano de "disponible" que alguien tenía
 * que apagar a mano. Un negocio con unidades contadas —una panadería, una
 * droguería— no puede estar pendiente del panel mientras atiende.
 *
 * `null` y `0` significan cosas opuestas: null es "no lo cuento" y cero es
 * "se acabó". Buena parte de estas pruebas existe para que esa distinción
 * no se pierda en una refactorización.
 */
describe('Inventario', () => {
  let client: any;
  let business: any;

  const orderOf = (product: any, quantity: number) =>
    orderService.create({
      clientId: client._id.toString(),
      businessId: business._id.toString(),
      items: [{ productId: product._id.toString(), quantity }],
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

  it('un producto sin control de inventario se pide sin límite', async () => {
    // Una cocina no cuenta bandejas. Obligarla a hacerlo apagaría su carta.
    const product = await makeProduct(business._id);
    expect((await Product.findById(product._id))!.stock).toBeNull();

    await orderOf(product, 50);
    await orderOf(product, 50);

    expect((await Product.findById(product._id))!.isAvailable).toBe(true);
  });

  it('descuenta las unidades pedidas', async () => {
    const product = await makeProduct(business._id);
    await Product.updateOne({ _id: product._id }, { stock: 10 });

    await orderOf(product, 3);

    expect((await Product.findById(product._id))!.stock).toBe(7);
  });

  it('al llegar a cero deja de ofrecerse solo', async () => {
    const product = await makeProduct(business._id);
    await Product.updateOne({ _id: product._id }, { stock: 2 });

    await orderOf(product, 2);

    const saved = await Product.findById(product._id);
    expect(saved!.stock).toBe(0);
    // Sin esto seguiría en la carta y el siguiente cliente pediría algo
    // que ya no existe.
    expect(saved!.isAvailable).toBe(false);
  });

  it('no deja pedir más de lo que queda', async () => {
    const product = await makeProduct(business._id);
    await Product.updateOne({ _id: product._id }, { stock: 2 });

    await expect(orderOf(product, 3)).rejects.toMatchObject({ statusCode: 409 });

    // Y no se queda a medias: el inventario sigue intacto.
    expect((await Product.findById(product._id))!.stock).toBe(2);
  });

  it('dos clientes por la última unidad: solo uno se la lleva', async () => {
    const product = await makeProduct(business._id);
    await Product.updateOne({ _id: product._id }, { stock: 1 });

    const otro = await makeUser({ role: UserRole.CLIENT });
    const results = await Promise.allSettled([
      orderOf(product, 1),
      orderService.create({
        clientId: otro._id.toString(),
        businessId: business._id.toString(),
        items: [{ productId: product._id.toString(), quantity: 1 }],
        paymentMethod: PaymentMethod.ONLINE,
        deliveryAddress: 'Cra 1 #2-3',
        deliveryLongitude: GARZON.lng,
        deliveryLatitude: GARZON.lat,
      }),
    ]);

    // Leer, decidir y guardar son tres pasos, y entre ellos cabe el otro
    // pedido: la condición tiene que viajar dentro de la escritura.
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await Product.findById(product._id))!.stock).toBe(0);
  });

  it('cancelar devuelve las unidades a la carta', async () => {
    const product = await makeProduct(business._id);
    await Product.updateOne({ _id: product._id }, { stock: 5 });

    const order = await orderOf(product, 5);
    expect((await Product.findById(product._id))!.stock).toBe(0);

    await orderService.updateStatus(
      order._id.toString(),
      OrderStatus.CANCELLED,
      client._id.toString(),
      UserRole.CLIENT,
      'Me arrepentí'
    );

    const saved = await Product.findById(product._id);
    expect(saved!.stock).toBe(5);
    // Y vuelve a ofrecerse, porque ya hay de nuevo.
    expect(saved!.isAvailable).toBe(true);
  });

  it('cancelar un pedido de algo sin inventario no inventa unidades', async () => {
    const product = await makeProduct(business._id);
    const order = await orderOf(product, 3);

    await orderService.updateStatus(
      order._id.toString(),
      OrderStatus.CANCELLED,
      client._id.toString(),
      UserRole.CLIENT,
      'Me arrepentí'
    );

    expect((await Product.findById(product._id))!.stock).toBeNull();
  });

  it('reponer devuelve el producto a la carta sin un segundo paso', async () => {
    const { productService } = await import('../services/product.service');
    const product = await makeProduct(business._id);
    await Product.updateOne({ _id: product._id }, { stock: 0, isAvailable: false });

    // Un negocio que acaba de escribir "quedan 12" no espera tener que
    // acordarse además de reactivarlo.
    await productService.update(product._id.toString(), business._id.toString(), { stock: 12 });

    const saved = await Product.findById(product._id);
    expect(saved!.stock).toBe(12);
    expect(saved!.isAvailable).toBe(true);
  });

  it('poner el inventario en null desactiva el control, no lo agota', async () => {
    const { productService } = await import('../services/product.service');
    const product = await makeProduct(business._id);
    await Product.updateOne({ _id: product._id }, { stock: 3 });

    await productService.update(product._id.toString(), business._id.toString(), { stock: null });

    const saved = await Product.findById(product._id);
    expect(saved!.stock).toBeNull();
    expect(saved!.isAvailable).toBe(true);
  });

  it('un pedido con varios productos no deja medio inventario apartado si uno falla', async () => {
    const hay = await makeProduct(business._id, { name: 'Con stock' });
    const noHay = await makeProduct(business._id, { name: 'Agotado' });
    await Product.updateOne({ _id: hay._id }, { stock: 10 });
    await Product.updateOne({ _id: noHay._id }, { stock: 0 });

    await expect(
      orderService.create({
        clientId: client._id.toString(),
        businessId: business._id.toString(),
        items: [
          { productId: hay._id.toString(), quantity: 2 },
          { productId: noHay._id.toString(), quantity: 1 },
        ],
        paymentMethod: PaymentMethod.ONLINE,
        deliveryAddress: 'Cra 1 #2-3',
        deliveryLongitude: GARZON.lng,
        deliveryLatitude: GARZON.lat,
      })
    ).rejects.toBeDefined();

    // Lo apartado del primero se devuelve: si no, cada intento fallido se
    // comería unidades que nadie compró.
    expect((await Product.findById(hay._id))!.stock).toBe(10);
    expect(await Order.countDocuments({ clientId: client._id })).toBe(0);
  });
});
