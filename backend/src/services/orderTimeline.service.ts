import { Types } from 'mongoose';
import { User } from '../models';
import { OrderEvent, IOrderEvent, logOrderEvent } from '../security/orderSecurity';
import type { IOrder } from '../models';
import { OrderStatus, OrderTimelineAction } from '../types';
import { OrderAccess } from './orderAccess.service';

/**
 * La historia de un pedido, contada una sola vez.
 *
 * Hasta ahora la bitácora solo recogía lo que pasaba durante el traspaso
 * físico —llegadas, fotos, códigos— porque era lo único que escribía
 * `OrderEvent`. Los hitos anteriores (aceptado, en preparación, listo) y
 * la asignación del domiciliario solo existían como marcas de tiempo
 * sueltas en el documento del pedido, sin actor: se sabía *cuándo* se
 * aceptó y nunca *quién* lo aceptó.
 *
 * Este servicio es el único sitio que escribe y lee esa línea de tiempo,
 * y hace dos cosas que no se pueden separar:
 *
 *  · **Registra** cada hito con su actor, desde donde ocurra.
 *  · **Reconstruye** los hitos de los pedidos anteriores a este cambio a
 *    partir de las marcas de tiempo del propio pedido, marcándolos como
 *    derivados. Una línea de tiempo que empieza a mitad de la historia es
 *    peor que ninguna: parece que el pedido nació ya recogido.
 */

/** Cómo se cuenta cada hito. El texto vive aquí, no en tres aplicaciones. */
const LABELS: Record<string, string> = {
  [OrderTimelineAction.CREATED]: 'Pedido creado',
  [OrderTimelineAction.ACCEPTED]: 'Aceptado por el comercio',
  [OrderTimelineAction.PREPARING]: 'En preparación',
  [OrderTimelineAction.READY]: 'Listo para recoger',
  [OrderTimelineAction.DRIVER_ASSIGNED]: 'Domiciliario asignado',
  [OrderTimelineAction.ARRIVED_PICKUP]: 'El domiciliario llegó al comercio',
  [OrderTimelineAction.EVIDENCE_PICKUP]: 'Evidencia de recogida registrada',
  [OrderTimelineAction.CODE_VERIFIED_PICKUP]: 'Código de recogida validado',
  [OrderTimelineAction.CODE_FAILED_PICKUP]: 'Intento fallido del código de recogida',
  [OrderTimelineAction.PICKED_UP]: 'Producto recibido por el domiciliario',
  [OrderTimelineAction.ON_WAY]: 'En camino al cliente',
  [OrderTimelineAction.ARRIVED_DELIVERY]: 'El domiciliario llegó al cliente',
  [OrderTimelineAction.EVIDENCE_DELIVERY]: 'Evidencia de entrega registrada',
  [OrderTimelineAction.CODE_VERIFIED_DELIVERY]: 'Código de entrega validado',
  [OrderTimelineAction.CODE_FAILED_DELIVERY]: 'Intento fallido del código de entrega',
  [OrderTimelineAction.DELIVERED]: 'Pedido entregado',
  [OrderTimelineAction.CANCELLED]: 'Pedido cancelado',
  [OrderTimelineAction.CASH_CONFIRMED]: 'Efectivo recibido por el domiciliario',
  [OrderTimelineAction.CASH_NOT_RECEIVED]: 'El domiciliario no recibió el efectivo',
};

/** Estado del pedido → hito que lo anuncia. */
const ACTION_FOR_STATUS: Record<OrderStatus, OrderTimelineAction | null> = {
  [OrderStatus.PENDING]: null,
  [OrderStatus.ACCEPTED]: OrderTimelineAction.ACCEPTED,
  [OrderStatus.PREPARING]: OrderTimelineAction.PREPARING,
  [OrderStatus.READY]: OrderTimelineAction.READY,
  [OrderStatus.PICKED_UP]: OrderTimelineAction.PICKED_UP,
  [OrderStatus.ON_WAY]: OrderTimelineAction.ON_WAY,
  [OrderStatus.DELIVERED]: OrderTimelineAction.DELIVERED,
  [OrderStatus.CANCELLED]: OrderTimelineAction.CANCELLED,
};

/** Un hito fallido no es un paso del recorrido: es una incidencia. */
const INCIDENTS: string[] = [
  OrderTimelineAction.CODE_FAILED_PICKUP,
  OrderTimelineAction.CODE_FAILED_DELIVERY,
  OrderTimelineAction.CANCELLED,
  // Un faltante de efectivo no es un paso del recorrido: es la única
  // pista que va a tener finanzas de que ese dinero no llegó.
  OrderTimelineAction.CASH_NOT_RECEIVED,
];

export interface TimelineEntry {
  action: string;
  label: string;
  at: Date;
  actor: { id: string | null; name: string | null; role: string } | null;
  /** True si se dedujo de una marca de tiempo del pedido, sin bitácora. */
  derived: boolean;
  /** True si describe algo que salió mal. */
  incident: boolean;
  /** Solo para administración: dónde y desde qué dispositivo. */
  forensics?: {
    ip: string;
    userAgent: string;
    location: { lat: number; lng: number } | null;
  };
}

export interface TimelineContext {
  ip?: string;
  userAgent?: string;
  location?: { lat: number; lng: number };
  previousValue?: Record<string, unknown>;
  newValue?: Record<string, unknown>;
}

export class OrderTimelineService {
  /**
   * Deja constancia de un hito.
   *
   * Nunca lanza: una bitácora que rompe la operación que está narrando es
   * peor que una bitácora incompleta. `logOrderEvent` ya traga sus propios
   * errores; aquí solo se normaliza la forma.
   */
  async record(
    orderId: string,
    action: OrderTimelineAction,
    actor: { userId: string; role: string },
    context: TimelineContext = {}
  ): Promise<void> {
    await logOrderEvent(
      orderId,
      action,
      actor.userId,
      actor.role,
      LABELS[action] ?? action,
      // Los hitos que nacen en la capa de servicios no tienen petición
      // detrás (una cancelación automática, un cambio disparado por un
      // webhook). Marcarlos "server" es más honesto que inventarles una IP.
      context.ip ?? 'server',
      context.userAgent ?? 'system',
      {
        previousValue: context.previousValue as Record<string, any> | undefined,
        newValue: context.newValue as Record<string, any> | undefined,
        location: context.location,
      }
    );
  }

  /** Registra el cambio de estado que corresponda, si es un hito narrable. */
  async recordStatusChange(
    orderId: string,
    from: OrderStatus,
    to: OrderStatus,
    actor: { userId: string; role: string },
    context: TimelineContext = {}
  ): Promise<void> {
    const action = ACTION_FOR_STATUS[to];
    if (!action) return;
    await this.record(orderId, action, actor, {
      ...context,
      previousValue: { status: from, ...(context.previousValue ?? {}) },
      newValue: { status: to, ...(context.newValue ?? {}) },
    });
  }

  /**
   * La línea de tiempo tal como la ve un participante.
   *
   * Todos los participantes ven los mismos hitos: no hay secretos en un
   * hito —los códigos nunca se escriben aquí— y ocultarle al cliente que
   * hubo tres intentos fallidos en su puerta solo sirve para que la
   * discusión posterior sea a ciegas. Lo que sí se reserva a
   * administración es la telemetría: IP, dispositivo y coordenadas del
   * actor, que son datos personales de quien ejecutó la acción y no del
   * pedido.
   */
  async forOrder(access: OrderAccess): Promise<TimelineEntry[]> {
    const order = access.order;
    const orderId = order._id.toString();

    const events = await OrderEvent.find({ orderId }).sort({ timestamp: 1 }).limit(200);

    const names = await this.resolveActorNames(events);
    const isAdmin = access.participant === 'admin';

    const recorded: TimelineEntry[] = events.map((event) => ({
      action: event.action,
      label: LABELS[event.action] ?? event.description ?? event.action,
      at: event.timestamp,
      actor: {
        id: event.userId,
        name: names.get(event.userId) ?? null,
        role: event.userRole,
      },
      derived: false,
      incident: INCIDENTS.includes(event.action),
      ...(isAdmin
        ? {
            forensics: {
              ip: event.ip,
              userAgent: event.userAgent,
              location:
                event.location && typeof event.location.lat === 'number'
                  ? { lat: event.location.lat, lng: event.location.lng }
                  : null,
            },
          }
        : {}),
    }));

    const merged = [...recorded, ...this.derivedMilestones(order, recorded)];

    // Empate de milisegundos: el hito derivado va detrás del registrado,
    // que es el que trae actor y por tanto el que cuenta la historia.
    return merged.sort((a, b) => {
      const diff = a.at.getTime() - b.at.getTime();
      if (diff !== 0) return diff;
      return Number(a.derived) - Number(b.derived);
    });
  }

  /**
   * Hitos que el pedido demuestra por sí mismo.
   *
   * Un pedido creado antes de que existiera esta bitácora tiene
   * `acceptedAt` pero ningún `OrderEvent` que lo cuente. La marca de
   * tiempo es un hecho igual de firme; lo único que falta es el actor, y
   * eso se dice en vez de inventarse.
   */
  private derivedMilestones(order: IOrder, recorded: TimelineEntry[]): TimelineEntry[] {
    const seen = new Set(recorded.map((entry) => entry.action));

    const candidates: Array<[OrderTimelineAction, Date | undefined]> = [
      [OrderTimelineAction.CREATED, order.createdAt],
      [OrderTimelineAction.ACCEPTED, order.acceptedAt],
      [OrderTimelineAction.PREPARING, order.preparedAt],
      [OrderTimelineAction.PICKED_UP, order.pickedUpAt],
      [OrderTimelineAction.DELIVERED, order.deliveredAt],
      [OrderTimelineAction.CANCELLED, order.cancelledAt],
    ];

    return candidates
      .filter(([action, at]) => at instanceof Date && !seen.has(action))
      .map(([action, at]) => ({
        action,
        label: LABELS[action],
        at: at as Date,
        actor: null,
        derived: true,
        incident: INCIDENTS.includes(action),
      }));
  }

  /** Un solo viaje a `users` para todos los actores de la línea. */
  private async resolveActorNames(events: IOrderEvent[]): Promise<Map<string, string>> {
    const ids = [...new Set(events.map((event) => event.userId))].filter((id) =>
      Types.ObjectId.isValid(id)
    );
    if (ids.length === 0) return new Map();

    const users = await User.find({ _id: { $in: ids } }).select('name');
    return new Map(users.map((user) => [user._id.toString(), user.name]));
  }
}

export const orderTimelineService = new OrderTimelineService();

/** Reexportado para que los clientes compartan el mismo diccionario. */
export const TIMELINE_LABELS = LABELS;
