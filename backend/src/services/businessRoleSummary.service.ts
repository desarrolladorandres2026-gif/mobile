import { Types } from 'mongoose';
import { Order, Product, BusinessPermission, ShiftClosing } from '../models';
import { OrderStatus, PaymentMethod } from '../types';
import { UNPAID_ONLINE_MATCH } from '../utils/merchantVisibility';
import { bogotaDateString, bogotaDayRange } from '../utils/period';
import { businessDailySummaryService, type BusinessDaySnapshot } from './businessDailySummary.service';
import type { BusinessAccess } from './businessStaff.service';
import { cashHandover } from './cashHandover.service';

// Vive en su propio archivo porque `businessDailySummary` también la usa y este
// importa a aquel; así no hay ciclo. Se reexporta para tenerla junto a `closedToday`.
export { cashHandover, type CashHandover } from './cashHandover.service';

/**
 * La portada del panel para quien no es el dueño.
 *
 * El cierre del día (`businessDailySummary.service`) enseña el neto, la
 * comisión de ZIPP y los descuentos que pagó el comercio: es la capa
 * financiera, y solo la ve quien tiene `financial:view`. El resto del
 * equipo necesitaba algo en "/" y se quedaba en Pedidos.
 *
 * Cada papel recibe una forma distinta, decidida por sus permisos y nunca
 * por el nombre del papel:
 *   - `operations` (con `analytics:view`, el administrador): el día del
 *     negocio sin neto, comisión ni descuentos asumidos.
 *   - `shift` (con `shift:view`: el empleado y el administrador): lo vendido hoy por medio de
 *     pago y lo que sigue abierto.
 *   - `kitchen` (solo `orders:view`, el operador): cuántos pedidos hay en
 *     cada estado. Sin dinero.
 *
 * Los campos se copian por lista blanca: si mañana el snapshot gana un
 * campo financiero, no se cuela aquí por accidente.
 */

/** Lo que el administrador ve del día: todo menos la capa financiera. */
const OPERATIONAL_FIELDS = [
  'date',
  'ordersCreated',
  'ordersDelivered',
  'ordersCancelled',
  'sales',
  'avgTicket',
  'avgPrepMinutes',
  'reviewsCount',
  'avgRating',
  'lowRatingsCount',
] as const satisfies ReadonlyArray<keyof BusinessDaySnapshot>;

type OperationalSnapshot = Pick<BusinessDaySnapshot, (typeof OPERATIONAL_FIELDS)[number]>;

function operational(snapshot: BusinessDaySnapshot): OperationalSnapshot {
  const out = {} as Record<string, unknown>;
  for (const field of OPERATIONAL_FIELDS) out[field] = snapshot[field];
  return out as OperationalSnapshot;
}

/** Pedidos abiertos ahora mismo, por estado. Lo mismo que ve la cocina. */
export interface OrderQueue {
  pending: number;
  preparing: number;
  ready: number;
  onTheWay: number;
}

export interface OperationsSummary {
  kind: 'operations';
  date: string;
  generatedAt: string;
  today: OperationalSnapshot;
  baseline: OperationalSnapshot;
  queue: OrderQueue;
  topProducts: Array<{ productId: string; name: string; quantity: number; sales: number }>;
  cancelReasons: Array<{ reason: string; count: number }>;
  byHour: Array<{ hour: number; orders: number }>;
}

/**
 * Lo que quien está en el mostrador tiene que tener presente además de la cola.
 * Todo es operativo (conteos, minutos, nombres de producto): ningún dato de dinero.
 */
export interface Attention {
  /** Minutos que lleva esperando el pedido nuevo más antiguo; `null` si no hay ninguno. */
  oldestPendingMinutes: number | null;
  /** Programados que aún no le tocan a la cocina: cuántos caen hoy y la hora del próximo (de cualquier día). */
  scheduled: { today: number; next: string | null };
  /** Productos apagados o sin stock: lo que hay que avisar al cliente que no hay. */
  unavailable: { count: number; names: string[] };
}

export interface ShiftSummary {
  kind: 'shift';
  date: string;
  generatedAt: string;
  attention: Attention;
  queue: OrderQueue;
  ordersDelivered: number;
  ordersCancelled: number;
  /** Ventas de producto de lo entregado hoy (sin domicilio ni propina). */
  sales: number;
  byPaymentMethod: Array<{ method: PaymentMethod; orders: number; sales: number }>;
  /** Pedidos abiertos: todavía no son venta. */
  pendingOrders: number;
  pendingSales: number;
  /**
   * Efectivo que debe haber en caja en el corte actual. Solo para quien tiene
   * `financial:view`: el empleado lo conoce hasta que declara lo que contó
   * (ver `shiftClosing.service`), para que no cuadre el conteo contra la cifra.
   */
  expectedCash?: number;
}

export interface KitchenSummary {
  kind: 'kitchen';
  date: string;
  generatedAt: string;
  attention: Attention;
  queue: OrderQueue;
  ordersDelivered: number;
  ordersCancelled: number;
}

export type RoleSummary = OperationsSummary | ShiftSummary | KitchenSummary;

const OPEN_STATUSES = [
  OrderStatus.PENDING, OrderStatus.ACCEPTED, OrderStatus.PREPARING, OrderStatus.READY,
  OrderStatus.PICKED_UP, OrderStatus.ON_WAY,
];

/**
 * Lo que está "en curso" para el comercio. Un programado que aún no se
 * activó no está en la cocina todavía; uno online sin pagar no existe para
 * el comercio (mismos filtros que `ordersInProgressNow` del cierre).
 */
function openMatch(businessId: Types.ObjectId) {
  return {
    businessId,
    status: { $in: OPEN_STATUSES },
    $nor: [UNPAID_ONLINE_MATCH],
    $or: [{ scheduledFor: null }, { scheduledFor: { $exists: false } }, { scheduledActivatedAt: { $ne: null } }],
  };
}

const productSales = { $ifNull: ['$finance.productSubtotal', '$subtotal'] };

/** Desde cuándo espera un pedido: un programado cuenta desde que se activó, no desde que se creó. */
const waitingSince = { $ifNull: ['$scheduledActivatedAt', '$createdAt'] };

async function queueFor(
  businessId: Types.ObjectId
): Promise<OrderQueue & { openSales: number; open: number; oldestPendingMinutes: number | null }> {
  const rows: Array<{ _id: OrderStatus; count: number; sales: number; oldest: Date }> = await Order.aggregate([
    { $match: openMatch(businessId) },
    { $group: { _id: '$status', count: { $sum: 1 }, sales: { $sum: productSales }, oldest: { $min: waitingSince } } },
  ]);
  const oldestPending = rows.find((r) => r._id === OrderStatus.PENDING)?.oldest;
  const count = (...statuses: OrderStatus[]) =>
    rows.filter((r) => statuses.includes(r._id)).reduce((n, r) => n + r.count, 0);
  return {
    pending: count(OrderStatus.PENDING),
    preparing: count(OrderStatus.ACCEPTED, OrderStatus.PREPARING),
    ready: count(OrderStatus.READY),
    onTheWay: count(OrderStatus.PICKED_UP, OrderStatus.ON_WAY),
    open: rows.reduce((n, r) => n + r.count, 0),
    openSales: Math.round(rows.reduce((n, r) => n + (r.sales ?? 0), 0)),
    oldestPendingMinutes: oldestPending ? Math.max(0, Math.floor((Date.now() - oldestPending.getTime()) / 60_000)) : null,
  };
}

const UNAVAILABLE_NAMES_SHOWN = 5;

async function attentionFor(
  businessId: Types.ObjectId,
  date: string,
  oldestPendingMinutes: number | null
): Promise<Attention> {
  const { to } = bogotaDayRange(date);
  const outOfStock = { businessId, $or: [{ isAvailable: false }, { stock: 0 }] };

  const [scheduled, unavailableCount, unavailable] = await Promise.all([
    Order.find({
      businessId,
      status: OrderStatus.PENDING,
      scheduledFor: { $ne: null },
      scheduledActivatedAt: null,
      $nor: [UNPAID_ONLINE_MATCH],
    })
      .select('scheduledFor')
      .sort({ scheduledFor: 1 })
      .limit(500)
      .lean(),
    Product.countDocuments(outOfStock),
    Product.find(outOfStock).select('name').sort({ name: 1 }).limit(UNAVAILABLE_NAMES_SHOWN).lean(),
  ]);

  return {
    oldestPendingMinutes,
    scheduled: {
      today: scheduled.filter((o) => o.scheduledFor && o.scheduledFor <= to).length,
      next: scheduled[0]?.scheduledFor ? new Date(scheduled[0].scheduledFor).toISOString() : null,
    },
    unavailable: { count: unavailableCount, names: unavailable.map((p) => p.name) },
  };
}

export async function closedToday(businessId: Types.ObjectId, date: string) {
  const { from, to } = bogotaDayRange(date);
  const rows: Array<{ _id: { status: OrderStatus; method: PaymentMethod | null }; count: number; sales: number }> =
    await Order.aggregate([
      {
        $match: {
          businessId,
          $nor: [UNPAID_ONLINE_MATCH],
          createdAt: { $gte: from, $lte: to },
          status: { $in: [OrderStatus.DELIVERED, OrderStatus.CANCELLED] },
        },
      },
      {
        $group: {
          _id: { status: '$status', method: '$paymentMethod' },
          count: { $sum: 1 },
          sales: { $sum: productSales },
        },
      },
    ]);
  const delivered = rows.filter((r) => r._id.status === OrderStatus.DELIVERED);
  const methods = [PaymentMethod.CASH_ON_DELIVERY, PaymentMethod.ONLINE];
  return {
    ordersDelivered: delivered.reduce((n, r) => n + r.count, 0),
    ordersCancelled: rows.filter((r) => r._id.status === OrderStatus.CANCELLED).reduce((n, r) => n + r.count, 0),
    sales: Math.round(delivered.reduce((n, r) => n + (r.sales ?? 0), 0)),
    byPaymentMethod: methods.map((method) => {
      // Pedidos viejos sin `paymentMethod` eran contra entrega.
      const mine = delivered.filter((r) => (r._id.method ?? PaymentMethod.CASH_ON_DELIVERY) === method);
      return {
        method,
        orders: mine.reduce((n, r) => n + r.count, 0),
        sales: Math.round(mine.reduce((n, r) => n + (r.sales ?? 0), 0)),
      };
    }),
  };
}

/**
 * Desde cuándo cuenta el cierre de caja que se hace ahora: desde el último
 * cierre del mismo día, o desde que empezó el día si no hay ninguno. Así dos
 * cierres el mismo día no cuentan dos veces el mismo efectivo.
 *
 * El instante del cierre ES `createdAt` (el servicio lo fija igual a `to`),
 * y el siguiente corte arranca un milisegundo después: el borde no se pierde
 * ni se cuenta dos veces. Lo que pase entre el último cierre y la medianoche
 * sin otro cierre no entra en ningún corte; sigue en el resumen del día.
 */
export async function currentShiftWindow(businessId: Types.ObjectId, now: Date = new Date()) {
  const { from: dayStart, to: dayEnd } = bogotaDayRange(bogotaDateString(now));
  const last = await ShiftClosing.findOne({ businessId, createdAt: { $gte: dayStart, $lte: dayEnd } })
    .sort({ createdAt: -1 })
    .select('createdAt')
    .lean();
  const from = last ? new Date(last.createdAt.getTime() + 1) : dayStart;
  return { from, to: now };
}

/**
 * La portada que le toca a esta persona. `null` si no tiene ni
 * `orders:view`: no hay nada del día que pueda ver.
 */
export async function roleSummaryFor(access: BusinessAccess, businessIdRaw: string): Promise<RoleSummary | null> {
  const businessId = new Types.ObjectId(businessIdRaw);
  const date = bogotaDateString();
  const generatedAt = new Date().toISOString();
  const has = (p: BusinessPermission) => access.permissions.includes(p);

  if (has(BusinessPermission.ANALYTICS_VIEW)) {
    const [full, queue] = await Promise.all([
      businessDailySummaryService.summaryFor(businessIdRaw, date),
      queueFor(businessId),
    ]);
    return {
      kind: 'operations',
      date,
      generatedAt,
      today: operational(full.today),
      baseline: operational(full.baseline),
      queue: { pending: queue.pending, preparing: queue.preparing, ready: queue.ready, onTheWay: queue.onTheWay },
      topProducts: full.topProducts,
      cancelReasons: full.cancelReasons,
      byHour: full.byHour,
    };
  }

  if (!has(BusinessPermission.ORDERS_VIEW)) return null;

  const [queue, closed] = await Promise.all([queueFor(businessId), closedToday(businessId, date)]);
  const attention = await attentionFor(businessId, date, queue.oldestPendingMinutes);
  const queueOnly = { pending: queue.pending, preparing: queue.preparing, ready: queue.ready, onTheWay: queue.onTheWay };

  if (has(BusinessPermission.SHIFT_VIEW)) {
    const shift: ShiftSummary = {
      kind: 'shift',
      date,
      generatedAt,
      attention,
      queue: queueOnly,
      ordersDelivered: closed.ordersDelivered,
      ordersCancelled: closed.ordersCancelled,
      sales: closed.sales,
      byPaymentMethod: closed.byPaymentMethod,
      pendingOrders: queue.open,
      pendingSales: queue.openSales,
    };
    // Decidido en el servidor: sin `financial:view` la clave ni existe.
    if (has(BusinessPermission.FINANCIAL_VIEW)) {
      const { from, to } = await currentShiftWindow(businessId);
      shift.expectedCash = (await cashHandover(businessId, from, to)).expectedCash;
    }
    return shift;
  }

  return {
    kind: 'kitchen',
    date,
    generatedAt,
    attention,
    queue: queueOnly,
    ordersDelivered: closed.ordersDelivered,
    ordersCancelled: closed.ordersCancelled,
  };
}

export const businessRoleSummaryService = { roleSummaryFor };
