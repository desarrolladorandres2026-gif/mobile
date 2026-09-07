import mongoose, { Types } from 'mongoose';
import { Order, IOrder, Business, Driver } from '../models';
import { AppError } from '../middlewares';
import { UserRole } from '../types';

/**
 * Quién es alguien *respecto a un pedido concreto*.
 *
 * No es lo mismo que su rol en la plataforma: un domiciliario es
 * `driver` en el pedido que tiene asignado y absolutamente nadie en el
 * resto. Todo el flujo de entrega —chat, llamadas, evidencias, códigos—
 * pregunta por esto y nunca por `req.user.role` a secas.
 */
export type OrderParticipant = 'client' | 'driver' | 'business' | 'admin';

export interface OrderAccess {
  order: IOrder;
  participant: OrderParticipant;
  userId: string;
  /** `Driver._id` (no el del usuario) cuando quien consulta es el repartidor. */
  driverId: string | null;
  /** El repartidor asignado, si lo hay, aunque quien consulte sea otro. */
  assignedDriverId: string | null;
}

interface Requester {
  _id: Types.ObjectId | string;
  role: string;
}

/**
 * Resuelve —y exige— la relación entre un usuario y un pedido.
 *
 * Este es el único sitio del backend donde se decide si alguien puede
 * tocar un pedido. Está aquí y no repartido por los controladores porque
 * un IDOR no aparece cuando alguien escribe mal la comprobación, sino
 * cuando un endpoint nuevo se olvida de escribirla: teniendo una sola
 * función, olvidarla significa no poder ni cargar el pedido.
 *
 * Un pedido ajeno y un pedido inexistente responden **exactamente lo
 * mismo**. Distinguirlos convertiría el endpoint en un oráculo para
 * enumerar identificadores: "403" diría "este pedido existe".
 */
export async function resolveOrderAccess(
  orderId: string,
  user: Requester
): Promise<OrderAccess> {
  const notFound = new AppError('Pedido no encontrado', 404);

  // Un id con forma inválida es un 404, no un 500 por CastError: quien
  // sondea la API no debe distinguir "no existe" de "no es un id".
  if (!mongoose.isValidObjectId(orderId)) throw notFound;

  const order = await Order.findById(orderId);
  if (!order) throw notFound;

  const userId = user._id.toString();
  const assignedDriverId = order.driverId ? order.driverId.toString() : null;

  if (user.role === UserRole.ADMIN) {
    return { order, participant: 'admin', userId, driverId: null, assignedDriverId };
  }

  if (order.clientId.toString() === userId) {
    return { order, participant: 'client', userId, driverId: null, assignedDriverId };
  }

  if (order.driverId) {
    // La comprobación va del pedido hacia el usuario, no al revés: se
    // busca el repartidor *de este pedido* y se mira si es quien pregunta.
    // Con `Driver.findOne({ userId })` bastaría con tener un perfil de
    // repartidor para pasar por asignado.
    const driver = await Driver.findOne({ _id: order.driverId, userId }).select('_id');
    if (driver) {
      return {
        order,
        participant: 'driver',
        userId,
        driverId: driver._id.toString(),
        assignedDriverId,
      };
    }
  }

  if (user.role === UserRole.BUSINESS) {
    const owned = await Business.exists({ _id: order.businessId, ownerId: userId });
    if (owned) {
      return { order, participant: 'business', userId, driverId: null, assignedDriverId };
    }
  }

  throw notFound;
}

/**
 * Restringe una operación a ciertos participantes.
 *
 * Separado de `resolveOrderAccess` porque "puedo ver este pedido" y
 * "puedo subir una evidencia de entrega" son preguntas distintas: el
 * cliente pasa la primera y no la segunda.
 */
export function assertParticipant(
  access: OrderAccess,
  allowed: OrderParticipant[],
  action = 'esta acción'
): void {
  if (!allowed.includes(access.participant)) {
    throw new AppError(`No tienes permiso para ${action} en este pedido`, 403);
  }
}

export interface OrderParticipants {
  clientUserId: string;
  /** Usuario del repartidor asignado, si hay. */
  driverUserId: string | null;
  businessOwnerId: string | null;
  businessId: string;
}

/**
 * Los usuarios que hay detrás de un pedido, listos para notificar o para
 * abrir salas de socket. `driverId` apunta a `Driver`, no a `User`, así
 * que sin este paso los avisos se mandarían a un id que no existe como
 * usuario — un fallo silencioso clásico en este esquema.
 */
export async function getOrderParticipants(order: IOrder): Promise<OrderParticipants> {
  const [driver, business] = await Promise.all([
    order.driverId ? Driver.findById(order.driverId).select('userId') : null,
    Business.findById(order.businessId).select('ownerId'),
  ]);

  return {
    clientUserId: order.clientId.toString(),
    driverUserId: driver ? driver.userId.toString() : null,
    businessOwnerId: business ? business.ownerId.toString() : null,
    businessId: order.businessId.toString(),
  };
}
