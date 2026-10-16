import type { IOrder } from '../models';
import { getIO } from '../sockets/emitter';

/**
 * Avisa por socket que la consulta por un producto que falta cambió de estado
 * (pedida, aceptada, rechazada, vencida o `superseded`).
 *
 * Vive aparte de `order.service` y de `itemShortage.service` para que los dos
 * puedan usarla sin cerrar un ciclo de importaciones. El payload es el mismo
 * para las dos puntas —el panel del comercio y la app del cliente—: ninguno
 * necesita más que saber que cambió, y cada uno relee el pedido por REST, donde
 * ya se aplican permisos y enmascarado.
 */
export function announceShortage(order: IOrder): void {
  const io = getIO();
  const shortage = order.itemShortage;
  if (!io || !shortage) return;

  const businessId = order.businessId ? String(order.businessId) : '';
  const payload = {
    orderId: String(order._id),
    orderNumber: order.orderNumber,
    businessId,
    status: shortage.status,
  };

  io.to(`user:${String(order.clientId)}`).emit('order:shortage', payload);
  if (businessId) io.to(`business:${businessId}`).emit('order:shortage', payload);
}
