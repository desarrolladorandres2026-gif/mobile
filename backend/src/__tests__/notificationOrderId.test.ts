import { describe, it, expect } from 'vitest';
import { orderService } from '../services/order.service';
import { Notification } from '../models';
import { UserRole } from '../types';
import {
  GARZON, offsetKm, makeUser, makeBusiness, makeProduct, makePricingConfig,
} from './factories';

const DESTINATION = offsetKm(GARZON, 2);

/**
 * Las notificaciones de pedido llevan el id de Mongo, no solo el número.
 *
 * Los 13 métodos de `notification.service.ts` solo recibían `orderNumber`
 * (el texto legible, `ZIPP-1234`), nunca el `_id` del pedido. La app decide
 * a qué pantalla abrir por ese id cuando alguien toca la push
 * (`usePushNotifications.ts`): sin él, la condición que abre el pedido no
 * se cumplía jamás — tocar cualquier aviso de pedido no hacía nada, tanto
 * para el cliente como para el domiciliario.
 */
describe('Notificaciones de pedido llevan orderId', () => {
  it('notifyOrderCreated guarda el id del pedido en data', async () => {
    await makePricingConfig({});
    const client = await makeUser({ role: UserRole.CLIENT });
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id);
    const product = await makeProduct(business._id, { price: 20000 });

    const order = await orderService.create({
      clientId: client._id.toString(),
      businessId: business._id.toString(),
      items: [{ productId: product._id.toString(), quantity: 1 }],
      paymentMethod: 'online',
      deliveryAddress: 'Calle 5 # 3-21',
      deliveryLatitude: DESTINATION.lat,
      deliveryLongitude: DESTINATION.lng,
    });

    // Las notificaciones se disparan en background (no bloquean la
    // creación del pedido), así que hay que darles el instante que
    // necesitan para escribirse.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const clientNotice = await Notification.findOne({
      userId: client._id,
    }).sort({ createdAt: -1 });

    expect(clientNotice).not.toBeNull();
    expect(clientNotice!.data?.orderId).toBe(order._id.toString());
    expect(clientNotice!.data?.orderNumber).toBe(order.orderNumber);

    const businessNotice = await Notification.findOne({ userId: owner._id });
    expect(businessNotice!.data?.orderId).toBe(order._id.toString());
  });
});
