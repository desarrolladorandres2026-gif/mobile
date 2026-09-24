import {
  Order,
  User,
  Business,
  Driver,
  Review,
  Pqrs,
  Refund,
  CashReconciliation,
} from '../models';
import { OrderStatus, PaymentMethod, UserRole } from '../types';
import { platformResultService, PlatformResult } from './platformResult.service';
import { bogotaDayRange, bogotaDateString, shiftDateString } from '../utils/period';

/**
 * Cierre operativo de un día.
 *
 * A diferencia de `adminService.getDashboardStats` —una foto "en vivo"— esto
 * reconstruye un día concreto: se le pasa una fecha `YYYY-MM-DD` y devuelve
 * los mismos números que vería un gerente al cerrar caja. Todo el dinero
 * sale del sub-documento `order.finance`, que es el desglose contable real
 * (GMV, ingreso bruto, gasto promocional, margen neto), con respaldo a los
 * campos planos legados cuando un pedido viejo no lo tiene.
 *
 * El día se delimita en hora de Colombia (America/Bogota, UTC-5 fijo), vía
 * `utils/period.ts`, sin depender de la zona del servidor.
 *
 * El ingreso de ZIPP (`platformGrossRevenue`, `promotionExpense`,
 * `netRevenue`) sale del libro mayor con `platformResultService`, la misma
 * función que usan el Dashboard y Finanzas. `netRevenue` es el neto ANTES de
 * costos de pasarela (`platformResult.incomplete`), no rentabilidad.
 */

// ── Tipos ────────────────────────────────────────────────────────────

/** Métricas escalares de un día, comparables entre sí de un día a otro. */
export interface DaySnapshot {
  date: string;

  // Pedidos
  ordersCreated: number;
  ordersDelivered: number;
  ordersCancelled: number;
  /** Ticket promedio de los pedidos entregados ese día (GMV / entregados). */
  avgTicket: number;
  /** Minutos promedio entre creación y entrega, sobre lo entregado ese día. */
  avgDeliveryMinutes: number;

  // Dinero (todo en COP, de order.finance)
  gmv: number;
  platformGrossRevenue: number;
  promotionExpense: number;
  netRevenue: number;
  businessPayouts: number;
  driverPayouts: number;
  tips: number;
  tax: number;
  merchantFundedDiscount: number;
  platformFundedDiscount: number;
  /** Resultado de ZIPP del día según el libro mayor (fuente de las tres cifras anteriores). */
  platformResult: PlatformResult;

  // Métodos de pago (sobre lo entregado ese día)
  payDigitalCount: number;
  payDigitalAmount: number;
  payCashCount: number;
  payCashAmount: number;

  // Altas del día
  newClients: number;
  newBusinesses: number;
  newDrivers: number;

  // Operación de domiciliarios
  activeDrivers: number;
  /** Entregas por domiciliario activo ese día. */
  deliveriesPerActiveDriver: number;

  // Calidad y soporte
  reviewsCount: number;
  avgBusinessRating: number;
  avgDriverRating: number;
  lowRatingsCount: number;
  pqrsOpened: number;
  refundsCount: number;
  refundsAmount: number;
}

export interface TopBusiness {
  businessId: string;
  name: string;
  orders: number;
  gmv: number;
}

export interface CashByStatus {
  status: string;
  count: number;
  amount: number;
}

/** Una fila de la tabla "hoy vs. mismo día la semana pasada". */
export interface ComparisonRow {
  metric: keyof DaySnapshot;
  label: string;
  today: number;
  baseline: number;
  /** today - baseline */
  deltaAbs: number;
  /** Variación relativa; null cuando baseline es 0. */
  deltaPct: number | null;
  direction: 'up' | 'down' | 'flat';
  /** true si subir es bueno (GMV); false si subir es malo (cancelaciones). */
  goodWhenUp: boolean;
}

export interface HealthFlag {
  level: 'ok' | 'warn' | 'critical';
  code: string;
  message: string;
}

export interface DailySummary {
  date: string;
  generatedAt: string;
  today: DaySnapshot;
  /** Mismo día de la semana anterior (fecha - 7). */
  baseline: DaySnapshot;
  comparison: ComparisonRow[];
  flags: HealthFlag[];

  // Detalle no comparable (solo del día consultado)
  pqrsByType: Array<{ type: string; count: number }>;
  newUsersByRole: Array<{ role: string; count: number }>;
  topBusinessesByOrders: TopBusiness[];
  topBusinessesByGmv: TopBusiness[];
  cashByStatus: CashByStatus[];
  /** Pedidos sin cerrar en este momento. Solo se calcula si la fecha es hoy. */
  ordersInProgressNow: number | null;
}

// ── Límites del día ──────────────────────────────────────────────────

// El día es el día calendario de Bogotá (UTC-5), no el de la hora del servidor.
function dayBounds(dateStr: string): { start: Date; end: Date } {
  const { from, to } = bogotaDayRange(dateStr);
  return { start: from, end: to };
}

const shiftDays = shiftDateString;

// `order.finance` es la fuente de verdad; los pedidos anteriores a la
// migración de monetización no lo tienen, así que cada línea cae al campo
// plano equivalente antes de rendirse a 0.
const F = (field: string, legacy?: string) =>
  legacy
    ? { $ifNull: [`$finance.${field}`, { $ifNull: [`$${legacy}`, 0] }] }
    : { $ifNull: [`$finance.${field}`, 0] };

// ── Foto de un día ──────────────────────────────────────────────────

async function buildDaySnapshot(dateStr: string): Promise<DaySnapshot> {
  const { start, end } = dayBounds(dateStr);
  const inDay = { $gte: start, $lte: end };
  const deliveredInDay = { status: OrderStatus.DELIVERED, deliveredAt: inDay };

  const [
    createdCount,
    cancelledCount,
    money,
    payments,
    deliveryTime,
    driverAgg,
    newUsers,
    newBusinesses,
    newDrivers,
    reviews,
    pqrs,
    refunds,
    result,
  ] = await Promise.all([
    Order.countDocuments({ createdAt: inDay }),
    Order.countDocuments({ status: OrderStatus.CANCELLED, cancelledAt: inDay }),

    Order.aggregate([
      { $match: deliveredInDay },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          gmv: { $sum: F('customerTotal', 'total') },
          businessPayouts: { $sum: F('businessPayout', 'businessPayout') },
          driverPayouts: { $sum: F('driverPayout', 'driverPayout') },
          tips: { $sum: F('tip', 'tip') },
          tax: { $sum: F('taxPayable', 'tax') },
          merchantFundedDiscount: { $sum: F('merchantFundedDiscount') },
          platformFundedDiscount: { $sum: F('platformFundedDiscount') },
        },
      },
    ]),

    Order.aggregate([
      { $match: deliveredInDay },
      {
        $group: {
          _id: '$paymentMethod',
          count: { $sum: 1 },
          amount: { $sum: F('customerTotal', 'total') },
        },
      },
    ]),

    Order.aggregate([
      { $match: { ...deliveredInDay, createdAt: { $exists: true } } },
      {
        $group: {
          _id: null,
          avgMs: { $avg: { $subtract: ['$deliveredAt', '$createdAt'] } },
        },
      },
    ]),

    Order.aggregate([
      { $match: { ...deliveredInDay, driverId: { $ne: null } } },
      { $group: { _id: '$driverId', deliveries: { $sum: 1 } } },
      { $group: { _id: null, drivers: { $sum: 1 }, deliveries: { $sum: '$deliveries' } } },
    ]),

    User.aggregate([
      { $match: { createdAt: inDay } },
      { $group: { _id: '$role', count: { $sum: 1 } } },
    ]),
    Business.countDocuments({ createdAt: inDay }),
    Driver.countDocuments({ createdAt: inDay }),

    Review.aggregate([
      { $match: { createdAt: inDay } },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          avgBusiness: { $avg: '$businessRating' },
          avgDriver: { $avg: '$driverRating' },
          low: { $sum: { $cond: [{ $lte: ['$businessRating', 2] }, 1, 0] } },
        },
      },
    ]),
    Pqrs.countDocuments({ createdAt: inDay }),
    Refund.aggregate([
      { $match: { createdAt: inDay } },
      { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: '$amount' } } },
    ]),
    platformResultService.forRange({ from: start, to: end }),
  ]);

  const m = money[0] || {};
  const delivered = m.count || 0;
  const digital = payments.find((p) => p._id === PaymentMethod.ONLINE);
  const cash = payments.find((p) => p._id === PaymentMethod.CASH_ON_DELIVERY);
  const drv = driverAgg[0] || { drivers: 0, deliveries: 0 };
  const rv = reviews[0] || {};
  const rf = refunds[0] || {};
  const usersByRole = new Map<string, number>(newUsers.map((u) => [u._id, u.count]));

  return {
    date: dateStr,

    ordersCreated: createdCount,
    ordersDelivered: delivered,
    ordersCancelled: cancelledCount,
    avgTicket: delivered > 0 ? Math.round((m.gmv || 0) / delivered) : 0,
    avgDeliveryMinutes: deliveryTime[0]?.avgMs ? Math.round(deliveryTime[0].avgMs / 60000) : 0,

    gmv: m.gmv || 0,
    platformGrossRevenue: result.grossRevenue,
    promotionExpense: result.promotionExpense,
    netRevenue: result.netBeforeGatewayCosts,
    platformResult: result,
    businessPayouts: m.businessPayouts || 0,
    driverPayouts: m.driverPayouts || 0,
    tips: m.tips || 0,
    tax: m.tax || 0,
    merchantFundedDiscount: m.merchantFundedDiscount || 0,
    platformFundedDiscount: m.platformFundedDiscount || 0,

    payDigitalCount: digital?.count || 0,
    payDigitalAmount: digital?.amount || 0,
    payCashCount: cash?.count || 0,
    payCashAmount: cash?.amount || 0,

    newClients: usersByRole.get(UserRole.CLIENT) || 0,
    newBusinesses,
    newDrivers,

    activeDrivers: drv.drivers,
    deliveriesPerActiveDriver:
      drv.drivers > 0 ? Math.round((drv.deliveries / drv.drivers) * 10) / 10 : 0,

    reviewsCount: rv.count || 0,
    avgBusinessRating: rv.avgBusiness ? Math.round(rv.avgBusiness * 10) / 10 : 0,
    avgDriverRating: rv.avgDriver ? Math.round(rv.avgDriver * 10) / 10 : 0,
    lowRatingsCount: rv.low || 0,
    pqrsOpened: pqrs,
    refundsCount: rf.count || 0,
    refundsAmount: rf.amount || 0,
  };
}

// ── Detalle no comparable del día ───────────────────────────────────

async function buildDayDetail(dateStr: string) {
  const { start, end } = dayBounds(dateStr);
  const inDay = { $gte: start, $lte: end };
  const deliveredInDay = { status: OrderStatus.DELIVERED, deliveredAt: inDay };

  const [byBusiness, pqrsByType, newUsersByRole, cashRows] = await Promise.all([
    Order.aggregate([
      { $match: deliveredInDay },
      {
        $group: {
          _id: '$businessId',
          orders: { $sum: 1 },
          gmv: { $sum: F('customerTotal', 'total') },
        },
      },
      { $lookup: { from: 'businesses', localField: '_id', foreignField: '_id', as: 'biz' } },
      { $unwind: { path: '$biz', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          businessId: '$_id',
          name: { $ifNull: ['$biz.name', 'Comercio'] },
          orders: 1,
          gmv: 1,
        },
      },
    ]),

    Pqrs.aggregate([
      { $match: { createdAt: inDay } },
      { $group: { _id: '$type', count: { $sum: 1 } } },
      { $project: { _id: 0, type: '$_id', count: 1 } },
    ]),

    User.aggregate([
      { $match: { createdAt: inDay } },
      { $group: { _id: '$role', count: { $sum: 1 } } },
      { $project: { _id: 0, role: '$_id', count: 1 } },
    ]),

    CashReconciliation.aggregate([
      { $match: { createdAt: inDay } },
      { $group: { _id: '$status', count: { $sum: 1 }, amount: { $sum: '$amount' } } },
      { $project: { _id: 0, status: '$_id', count: 1, amount: 1 } },
    ]),
  ]);

  const businesses = byBusiness as TopBusiness[];
  const topBusinessesByOrders = [...businesses]
    .sort((a, b) => b.orders - a.orders)
    .slice(0, 5);
  const topBusinessesByGmv = [...businesses].sort((a, b) => b.gmv - a.gmv).slice(0, 5);

  return {
    topBusinessesByOrders,
    topBusinessesByGmv,
    pqrsByType: pqrsByType as Array<{ type: string; count: number }>,
    newUsersByRole: newUsersByRole as Array<{ role: string; count: number }>,
    cashByStatus: cashRows as CashByStatus[],
  };
}

/**
 * "Hoy vs. el mismo día la semana pasada", métrica a métrica.
 *
 * La comparación es contra el mismo día de la semana y no contra ayer, y
 * eso no es un detalle: en domicilios el viernes se parece a otro viernes
 * mucho más de lo que se parece al jueves anterior. Comparar días
 * consecutivos convierte el ritmo normal de la semana en una alarma.
 *
 * `deltaPct` es `null` cuando la base es cero, no infinito ni cien: pasar
 * de 0 a 3 pedidos no es "+300 %", es un dato que no admite porcentaje, y
 * decirlo con un hueco es más honesto que inventar una cifra que luego
 * alguien mete en una diapositiva.
 */
export function buildComparison(today: DaySnapshot, baseline: DaySnapshot): ComparisonRow[] {
  const METRICS: Array<{ key: keyof DaySnapshot; label: string; goodWhenUp: boolean }> = [
    { key: 'ordersDelivered', label: 'Pedidos entregados', goodWhenUp: true },
    { key: 'gmv', label: 'GMV', goodWhenUp: true },
    { key: 'netRevenue', label: 'Margen neto', goodWhenUp: true },
    { key: 'avgTicket', label: 'Ticket promedio', goodWhenUp: true },
    { key: 'ordersCancelled', label: 'Cancelaciones', goodWhenUp: false },
    { key: 'activeDrivers', label: 'Domiciliarios activos', goodWhenUp: true },
    { key: 'newClients', label: 'Clientes nuevos', goodWhenUp: true },
  ];

  // Umbral de "plano": ±1 %. Un día que se mueve medio punto no ha
  // cambiado, ha respirado, y pintarle una flecha hace que las flechas
  // dejen de significar nada. Con base cero no hay porcentaje que medir,
  // así que ahí manda el signo del valor absoluto.
  const UMBRAL_PLANO_PCT = 1;

  return METRICS.map(({ key, label, goodWhenUp }) => {
    const todayValue = Number(today[key] ?? 0);
    const baselineValue = Number(baseline[key] ?? 0);
    const deltaAbs = todayValue - baselineValue;

    const deltaPct =
      baselineValue === 0 ? null : Math.round((deltaAbs / baselineValue) * 100);

    const esPlano =
      deltaAbs === 0 || (deltaPct !== null && Math.abs(deltaPct) < UMBRAL_PLANO_PCT);

    return {
      metric: key,
      label,
      today: todayValue,
      baseline: baselineValue,
      deltaAbs,
      deltaPct,
      direction: esPlano ? 'flat' : deltaAbs > 0 ? 'up' : 'down',
      goodWhenUp,
    };
  });
}

/**
 * Las alertas del cierre del día.
 *
 * Cada una responde a una pregunta que alguien haría al mirar el cierre, y
 * ninguna se dispara por un número aislado: todas son proporciones. Diez
 * cancelaciones sobre mil pedidos es un martes; diez sobre veinte es un
 * problema, y solo la proporción distingue los dos casos.
 *
 * Los umbrales son deliberadamente pocos y redondos. Una lista larga de
 * avisos finos es una lista que nadie lee: si todo se enciende, nada
 * llama la atención. Se ordenan de más grave a menos, porque quien abre el
 * cierre por la mañana lee de arriba abajo y puede parar en la primera.
 *
 * Un día sin nada que señalar devuelve un único flag `ok`, no una lista
 * vacía: "no hay alertas" y "no se calcularon las alertas" tienen que
 * verse distinto en la pantalla.
 */
export function deriveHealthFlags(today: DaySnapshot): HealthFlag[] {
  const flags: HealthFlag[] = [];

  const pct = (parte: number, total: number) => (total > 0 ? parte / total : 0);
  const money = (v: number) => `$${Math.round(v).toLocaleString('es-CO')}`;

  // ── Crítico: el día costó dinero ──
  if (today.netRevenue < 0) {
    flags.push({
      level: 'critical',
      code: 'MARGEN_NEGATIVO',
      message:
        `El día cerró con margen negativo (${money(today.netRevenue)}). ` +
        'Revisa promociones activas y subsidios de domicilio.',
    });
  }

  // ── Crítico / aviso: se cancela demasiado ──
  const tasaCancelacion = pct(today.ordersCancelled, today.ordersCreated);
  if (tasaCancelacion > 0.3) {
    flags.push({
      level: 'critical',
      code: 'CANCELACION_ALTA',
      message:
        `Se canceló el ${Math.round(tasaCancelacion * 100)} % de los pedidos ` +
        `(${today.ordersCancelled} de ${today.ordersCreated}).`,
    });
  } else if (tasaCancelacion > 0.15) {
    flags.push({
      level: 'warn',
      code: 'CANCELACION_ALTA',
      message:
        `Cancelaciones por encima de lo normal: ${Math.round(tasaCancelacion * 100)} % ` +
        `(${today.ordersCancelled} de ${today.ordersCreated}).`,
    });
  }

  // ── Aviso: la promoción se está comiendo la venta ──
  if (today.gmv > 0 && today.promotionExpense > today.gmv * 0.1) {
    flags.push({
      level: 'warn',
      code: 'PROMOCION_CARA',
      message:
        `Las promociones costaron ${money(today.promotionExpense)}, ` +
        `más del 10 % del GMV (${money(today.gmv)}).`,
    });
  }

  // ── Aviso: reembolsos por encima de lo tolerable ──
  if (today.gmv > 0 && today.refundsAmount > today.gmv * 0.05) {
    flags.push({
      level: 'warn',
      code: 'REEMBOLSOS_ALTOS',
      message:
        `Se reembolsó ${money(today.refundsAmount)} (${today.refundsCount} pedidos), ` +
        'más del 5 % del GMV.',
    });
  }

  // ── Aviso: falta flota ──
  // Solo cuando hubo entregas: un día sin pedidos no tiene un problema de
  // cobertura, tiene un problema de demanda, y esa es otra conversación.
  if (today.ordersDelivered > 0 && today.deliveriesPerActiveDriver > 20) {
    flags.push({
      level: 'warn',
      code: 'COBERTURA_BAJA',
      message:
        `${Math.round(today.deliveriesPerActiveDriver)} entregas por domiciliario activo ` +
        `(${today.activeDrivers} en calle). Considera ampliar la flota.`,
    });
  }

  // ── Aviso: la calidad se resiente ──
  const tasaMalasNotas = pct(today.lowRatingsCount, today.reviewsCount);
  if (today.reviewsCount >= 5 && tasaMalasNotas > 0.2) {
    flags.push({
      level: 'warn',
      code: 'CALIFICACIONES_BAJAS',
      message:
        `${today.lowRatingsCount} de ${today.reviewsCount} calificaciones fueron bajas ` +
        `(${Math.round(tasaMalasNotas * 100)} %).`,
    });
  }

  if (flags.length === 0) {
    return [
      {
        level: 'ok',
        code: 'SIN_ALERTAS',
        message: 'Nada fuera de lo normal en el cierre del día.',
      },
    ];
  }

  const orden = { critical: 0, warn: 1, ok: 2 } as const;
  return flags.sort((a, b) => orden[a.level] - orden[b.level]);
}

// ── Orquestador ────────────────────────────────────────────────────

function todayStr(): string {
  return bogotaDateString();
}

export const dailySummaryService = {
  async generate(dateInput?: string): Promise<DailySummary> {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(dateInput || '') ? dateInput! : todayStr();
    const baselineDate = shiftDays(date, -7);
    const isToday = date === todayStr();

    const [today, baseline, detail, inProgressNow] = await Promise.all([
      buildDaySnapshot(date),
      buildDaySnapshot(baselineDate),
      buildDayDetail(date),
      isToday
        ? Order.countDocuments({
            status: { $nin: [OrderStatus.DELIVERED, OrderStatus.CANCELLED] },
          })
        : Promise.resolve(null),
    ]);

    return {
      date,
      generatedAt: new Date().toISOString(),
      today,
      baseline,
      comparison: buildComparison(today, baseline),
      flags: deriveHealthFlags(today),
      ...detail,
      ordersInProgressNow: inProgressNow,
    };
  },
};
