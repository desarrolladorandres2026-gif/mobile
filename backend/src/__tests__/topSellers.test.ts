import { describe, it, expect, beforeEach } from 'vitest';
import { Order, Product } from '../models';
import { OrderStatus, UserRole, PaymentMethod } from '../types';
import { productService } from '../services/product.service';
import { orderService } from '../services/order.service';
import {
  makeUser, makeBusiness, makeProduct, makePricingConfig, GARZON,
} from './factories';

/**
 * Los más pedidos de un negocio.
 *
 * "Destacado" dice lo que el negocio quiere vender; esto dice lo que la
 * gente compra. Rara vez es lo mismo, y para quien entra por primera vez a
 * una carta larga lo segundo ayuda mucho más.
 */
describe('Productos más vendidos', () => {
  let client: any;
  let business: any;
  let popular: any;
  let rare: any;

  const orderOf = async (product: any, quantity: number, deliver = true) => {
    const order = await orderService.create({
      clientId: client._id.toString(),
      businessId: business._id.toString(),
      items: [{ productId: product._id.toString(), quantity }],
      paymentMethod: PaymentMethod.ONLINE,
      deliveryAddress: 'Cra 1 #2-3',
      deliveryLongitude: GARZON.lng,
      deliveryLatitude: GARZON.lat,
    });

    if (deliver) {
      await Order.updateOne(
        { _id: order._id },
        { status: OrderStatus.DELIVERED, deliveredAt: new Date() }
      );
    }
    return order;
  };

  beforeEach(async () => {
    await makePricingConfig();
    client = await makeUser({ role: UserRole.CLIENT });
    const owner = await makeUser({ role: UserRole.BUSINESS });
    business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
    popular = await makeProduct(business._id, { name: 'Bandeja paisa' });
    rare = await makeProduct(business._id, { name: 'Ensalada triste' });
  });

  it('ordena por unidades vendidas, no por número de pedidos', async () => {
    await orderOf(popular, 5);
    await orderOf(rare, 1);
    await orderOf(rare, 1);

    const top = await productService.topSellers(business._id.toString());

    expect(top[0].name).toBe('Bandeja paisa');
    expect(top[0].soldCount).toBe(5);
  });

  it('no cuenta pedidos que no se entregaron', async () => {
    // Incluir cancelados premiaría justamente los platos que fallan.
    await orderOf(popular, 10, false);
    await orderOf(rare, 1);

    const top = await productService.topSellers(business._id.toString());

    expect(top).toHaveLength(1);
    expect(top[0].name).toBe('Ensalada triste');
  });

  it('deja fuera lo que ya no está en la carta', async () => {
    await orderOf(popular, 5);
    await Product.updateOne({ _id: popular._id }, { isAvailable: false });

    const top = await productService.topSellers(business._id.toString());
    expect(top.find((p: any) => p.name === 'Bandeja paisa')).toBeUndefined();
  });

  it('respeta el límite pedido', async () => {
    await orderOf(popular, 5);
    await orderOf(rare, 3);

    const top = await productService.topSellers(business._id.toString(), 1);
    expect(top).toHaveLength(1);
  });

  it('no mezcla las ventas de otro negocio', async () => {
    const otherOwner = await makeUser({ role: UserRole.BUSINESS });
    const other = await makeBusiness(otherOwner._id, { lat: GARZON.lat, lng: GARZON.lng });

    await orderOf(popular, 5);

    const top = await productService.topSellers(other._id.toString());
    expect(top).toHaveLength(0);
  });

  it('un negocio sin ventas devuelve lista vacía, no un error', async () => {
    const top = await productService.topSellers(business._id.toString());
    expect(top).toEqual([]);
  });
});
