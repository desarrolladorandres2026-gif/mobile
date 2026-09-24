import { Types } from 'mongoose';
import { Order, Review, Pqrs, Payout, Settlement, CashReconciliation, DriverDocument, SosAlert, User, Zone } from '../models';
import { OrderStatus, PayoutBeneficiary, CashReconciliationStatus } from '../types';
import { AuditLog, AuditAction } from '../security';
import { AppError } from '../middlewares/errorHandler';
import { driverService, DriverDetail } from './driver.service';

/**
 * Todo lo que se sabe de un domiciliario, en una sola llamada.
 *
 * Hermano de `userProfile360.service.ts`: mismo criterio (lo reciente y los
 * totales, no el historial completo) para que quien atiende entienda el caso
 * en segundos. Cada lista está acotada y va con `.lean()`.
 *
 * Nunca incluye `reputationScore`: es un puntaje interno para riesgo y
 * despacho, no un juicio humano para el panel. La señal pública es `rating`.
 */

export interface DriverProfile360 {
  driver: DriverDetail;
  documents: Array<{
    _id: string;
    type: string;
    reference?: string;
    imageUrl?: string;
    expiresAt?: Date;
    status: string;
    reviewedAt?: Date;
  }>;
  activity: {
    totals: { delivered: number; cancelled: number };
    recentOrders: Array<{
      _id: string;
      orderNumber: string;
      status: string;
      total: number;
      createdAt: Date;
      deliveredAt?: Date;
    }>;
    reviews: Array<{ _id: string; rating: number; comment?: string; createdAt: Date }>;
    /** Aproximación: destino de los últimos ~100 pedidos entregados (zona, o ciudad si no hay zona). */
    coverageZones: Array<{ zone: string; count: number }>;
  };
  finance: {
    baseFund: number;
    currentFund: number;
    totalEarnings: number;
    earningsLast30Days: number;
    payouts: Array<{ _id: string; orderId?: string; amount: number; status: string; createdAt: Date }>;
    settlements: Array<{ _id: string; periodStart: Date; periodEnd: Date; netAmount: number; createdAt: Date }>;
    pendingDebts: {
      count: number;
      total: number;
      items: Array<{
        _id: string;
        orderId?: string;
        amount: number;
        createdAt: Date;
        status: string;
        dueAt: Date;
      }>;
    };
  };
  incidents: {
    sos: Array<{
      _id: string;
      status: string;
      note?: string;
      createdAt: Date;
      resolvedAt?: Date | null;
      resolution?: string;
    }>;
    sanctions: Array<{
      _id: string;
      action: string;
      description?: string;
      createdAt: Date;
      actorName?: string;
    }>;
    pqrs: Array<{ _id: string; subject?: string; status: string; createdAt: Date }>;
    /** Todavía no hay modelo de notas internas. */
    notes: never[];
  };
}

const DAY_MS = 86_400_000;
/** Pedidos recientes que se miran para cruzar PQRS (join indirecto por `orderId`). */
const PQRS_ORDER_WINDOW = 50;
const ZONE_ORDER_WINDOW = 100;

export async function profile360(driverId: string): Promise<DriverProfile360> {
  if (!Types.ObjectId.isValid(driverId)) {
    throw new AppError('Identificador de domiciliario inválido', 400);
  }
  const id = new Types.ObjectId(driverId);

  const driver = await driverService.getDetail(driverId);

  // Los pedidos recientes alimentan dos secciones (lista y PQRS): una sola
  // consulta, y el cruce con PQRS espera a que llegue.
  const recentOrdersP = Order.find({ driverId: id })
    .sort({ createdAt: -1 })
    .limit(PQRS_ORDER_WINDOW)
    .select('orderNumber status total createdAt deliveredAt')
    .lean()
    // `.exec()`: una Query de Mongoose no es una promesa, y encadenarle `.then` y
    // luego esperarla otra vez la ejecuta dos veces ("Query was already executed").
    .exec();

  const pqrsP = recentOrdersP.then((orders) =>
    orders.length
      ? Pqrs.find({ orderId: { $in: orders.map((o) => o._id) } })
          .sort({ createdAt: -1 })
          .limit(10)
          .select('subject status createdAt')
          .lean()
      : []
  );

  const [
    recentOrders,
    pqrs,
    documents,
    totalsRows,
    reviews,
    deliveredForZones,
    earningsRows,
    payouts,
    settlements,
    debtItems,
    debtTotals,
    sos,
    sanctionRows,
  ] = await Promise.all([
    recentOrdersP,
    pqrsP,
    DriverDocument.find({ driverId: id })
      .sort({ type: 1 })
      .limit(10)
      .select('type reference imageUrl expiresAt status reviewedAt')
      .lean(),
    Order.aggregate([
      { $match: { driverId: id, status: { $in: [OrderStatus.DELIVERED, OrderStatus.CANCELLED] } } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    // Calificación cliente -> domiciliario. Las ocultas por moderación no cuentan.
    Review.find({ driverId: id, driverRating: { $gt: 0 }, isHidden: { $ne: true } })
      .sort({ createdAt: -1 })
      .limit(10)
      .select('driverRating comment createdAt')
      .lean(),
    Order.find({ driverId: id, status: OrderStatus.DELIVERED })
      .sort({ deliveredAt: -1 })
      .limit(ZONE_ORDER_WINDOW)
      .select('zoneId city')
      .lean(),
    // Igual que `getEarningsRange`: tarifa garantizada + propina, enteros COP.
    Order.aggregate([
      {
        $match: {
          driverId: id,
          status: OrderStatus.DELIVERED,
          deliveredAt: { $gte: new Date(Date.now() - 30 * DAY_MS) },
        },
      },
      {
        $group: {
          _id: null,
          total: {
            $sum: {
              $add: [
                { $ifNull: ['$finance.driverDeliveryPayout', 0] },
                { $ifNull: ['$finance.tip', 0] },
              ],
            },
          },
        },
      },
    ]),
    Payout.find({ driverId: id, beneficiary: PayoutBeneficiary.DRIVER })
      .sort({ createdAt: -1 })
      .limit(10)
      .select('orderId amount status createdAt')
      .lean(),
    Settlement.find({ driverId: id })
      .sort({ createdAt: -1 })
      .limit(5)
      .select('periodStart periodEnd netAmount createdAt')
      .lean(),
    // `DriverDebt` es un modelo muerto desde la migración 001: la deuda de
    // efectivo real vive en `CashReconciliation` (ver `outstandingFor`).
    // PENDING/REPORTED/OVERDUE son estados vivos; VERIFIED y SETTLED ya no
    // son deuda.
    CashReconciliation.find({
      driverId: id,
      status: {
        $in: [
          CashReconciliationStatus.PENDING,
          CashReconciliationStatus.REPORTED,
          CashReconciliationStatus.OVERDUE,
        ],
      },
    })
      .sort({ dueAt: 1 })
      .limit(10)
      .select('orderId amount createdAt status dueAt')
      .lean(),
    CashReconciliation.aggregate([
      {
        $match: {
          driverId: id,
          status: {
            $in: [
              CashReconciliationStatus.PENDING,
              CashReconciliationStatus.REPORTED,
              CashReconciliationStatus.OVERDUE,
            ],
          },
        },
      },
      { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$amount' } } },
    ]),
    SosAlert.find({ driverId: id })
      .sort({ createdAt: -1 })
      .limit(10)
      .select('status note createdAt resolvedAt resolution')
      .lean(),
    AuditLog.find({
      entity: 'driver',
      entityId: driverId,
      action: {
        $in: [AuditAction.DRIVER_APPROVED, AuditAction.DRIVER_SUSPENDED, AuditAction.DRIVER_REACTIVATED],
      },
    })
      .sort({ timestamp: -1 })
      .limit(20)
      .lean(),
  ]);

  const countOf = (status: OrderStatus) =>
    totalsRows.find((r: { _id: string; count: number }) => r._id === status)?.count ?? 0;

  // Zonas: se cuenta en JS sobre a lo sumo 100 filas, y los nombres de zona
  // se piden una sola vez para las distintas que aparezcan.
  const zoneCounts = new Map<string, number>();
  const zoneIds = new Set<string>();
  for (const o of deliveredForZones) if (o.zoneId) zoneIds.add(o.zoneId.toString());
  const zoneNames = new Map<string, string>();
  if (zoneIds.size) {
    const zones = await Zone.find({ _id: { $in: [...zoneIds] } }).select('name').lean();
    for (const z of zones) zoneNames.set(z._id.toString(), z.name);
  }
  for (const o of deliveredForZones) {
    const label = (o.zoneId && zoneNames.get(o.zoneId.toString())) || o.city;
    if (!label) continue;
    zoneCounts.set(label, (zoneCounts.get(label) ?? 0) + 1);
  }
  const coverageZones = [...zoneCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([zone, count]) => ({ zone, count }));

  // Quién actuó en cada sanción: una sola consulta de nombres.
  const actorIds = [...new Set(sanctionRows.map((s) => s.userId).filter((u): u is string => !!u && Types.ObjectId.isValid(u)))];
  const actors = actorIds.length ? await User.find({ _id: { $in: actorIds } }).select('name').lean() : [];
  const actorName = new Map(actors.map((u) => [u._id.toString(), u.name]));

  return {
    driver,
    documents: documents as unknown as DriverProfile360['documents'],
    activity: {
      totals: { delivered: countOf(OrderStatus.DELIVERED), cancelled: countOf(OrderStatus.CANCELLED) },
      recentOrders: recentOrders.slice(0, 10) as unknown as DriverProfile360['activity']['recentOrders'],
      reviews: reviews.map((r) => ({
        _id: r._id.toString(),
        rating: r.driverRating as number,
        comment: r.comment,
        createdAt: r.createdAt,
      })),
      coverageZones,
    },
    finance: {
      baseFund: driver.baseFund,
      currentFund: driver.currentFund,
      totalEarnings: driver.totalEarnings ?? 0,
      earningsLast30Days: earningsRows[0]?.total ?? 0,
      payouts: payouts as unknown as DriverProfile360['finance']['payouts'],
      settlements: settlements as unknown as DriverProfile360['finance']['settlements'],
      pendingDebts: {
        count: debtTotals[0]?.count ?? 0,
        total: debtTotals[0]?.total ?? 0,
        items: debtItems as unknown as DriverProfile360['finance']['pendingDebts']['items'],
      },
    },
    incidents: {
      sos: sos as unknown as DriverProfile360['incidents']['sos'],
      sanctions: sanctionRows.map((s) => ({
        _id: s._id.toString(),
        action: s.action,
        description: s.description,
        createdAt: s.timestamp,
        actorName: s.userId ? actorName.get(s.userId) : undefined,
      })),
      pqrs: pqrs as unknown as DriverProfile360['incidents']['pqrs'],
      notes: [],
    },
  };
}

export const driverProfile360Service = { profile360 };
