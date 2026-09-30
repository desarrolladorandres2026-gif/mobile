import { Types } from 'mongoose';
import {
  Driver,
  DriverDocument,
  DriverLocation,
  Order,
  Payout,
  Settlement,
  SosAlert,
  User,
} from '../models';
import { OrderStatus, PayoutBeneficiary, PayoutStatus } from '../types';
import { AuditAction, AuditLog } from '../security';
import { DriverVerification, VerificationStatus } from '../security/driverSecurity';
import { AppError } from '../middlewares/errorHandler';
import { cache } from '../cache';
import { driverService } from './driver.service';
import { driverDossierService } from './driverDossier.service';
import { driverShiftService } from './driverShift.service';
import { TERMINAL_ORDER_STATUSES } from './order.service';
import { maskLast4 } from './profileMasking';
import type { DocumentIndicator, DossierAccountStatus } from './driverDossier.logic';

/**
 * Lo que la ficha del domiciliario muestra además del perfil 360: identidad,
 * vehículo, conducción, operación, seguridad, cuenta e historial.
 *
 * No inventa nada: cada cifra sale de datos que el sistema ya guarda. Lo que
 * no existe llega como `null`/ausente y el panel lo dice ("sin registro"):
 *  - tiempo conectado: sale de `DriverShift`, que empieza a llenarse al desplegar;
 *  - distancia: se calcula del rastro GPS, que se borra a los
 *    `TRACKING_HISTORY_DAYS`, y se devuelve con el periodo que de verdad cubre;
 *  - última ubicación: solo con `drivers:track`.
 * Nunca incluye tokens, secretos 2FA ni el contenido de los dispositivos.
 */

const DAY_MS = 86_400_000;
/** Tope de puntos del rastro que se recorren por consulta: la ficha no debe tumbar Mongo. */
const MAX_TRAIL_POINTS = 150_000;
/** Un salto mayor a esto entre dos puntos seguidos no es conducir, es un hueco de señal. */
const MAX_GAP_MS = 10 * 60_000;
const HISTORY_LIMIT = 80;

export interface FichaDocument {
  type: string;
  label: string;
  group: 'personal' | 'vehicle';
  indicator: DocumentIndicator;
  message: string;
  documentId?: string;
  status?: string;
  reference?: string;
  uploadedAt?: Date;
  issuedAt?: Date;
  expiresAt?: Date;
  reviewedAt?: Date;
  reviewedByName?: string;
  rejectionReason?: string;
  hasFile: boolean;
}

export interface HistoryItem {
  at: Date;
  kind: 'registro' | 'documento' | 'vehiculo' | 'cuenta' | 'suspension' | 'sos' | 'pago' | 'liquidacion' | 'contrato';
  action: string;
  by?: string;
  detail?: string;
}

export interface DriverFicha {
  summary: {
    docsUpToDate: boolean;
    issues: string[];
    quick: Record<'identity' | 'license' | 'soat' | 'technical_review', DocumentIndicator>;
  };
  identity: {
    avatar?: string;
    birthDate?: Date;
    registeredAt?: Date;
    verification: 'verified' | 'in_review' | 'none';
    lastVerificationAt?: Date;
  };
  vehicle: {
    type: string;
    plate?: string;
    brand?: string;
    model?: string;
    year?: number;
    color?: string;
    engineCc?: number;
    ownerName?: string;
    /** Referencia de la tarjeta de propiedad (enmascarada sin `users:view_sensitive`). */
    registrationNumber?: string;
  };
  driving: {
    licenseNumber?: string;
    category?: string;
    issuedAt?: Date;
    expiresAt?: Date;
    indicator: DocumentIndicator;
    message: string;
    lastValidatedAt?: Date;
    validatedBy?: string;
  };
  documents: FichaDocument[];
  operation: {
    status: string;
    account: DossierAccountStatus;
    lastConnectionAt?: Date;
    /** null: todavía no hay turnos registrados. */
    connectedSeconds7d: number | null;
    connectedSeconds30d: number | null;
    activeOrders: number;
    completed: number;
    cancelled: number;
    /** Sobre las ofertas que dependían de él (aceptadas + rechazadas + vencidas), 30 días. null sin ofertas. */
    acceptanceRate: number | null;
    cancellationRate: number | null;
    /** Sumando tramos del rastro GPS conservado; `coveredDays` dice cuánto historial hay de verdad. */
    distanceKm: { last7d: number | null; last30d: number | null; coveredDays: number; truncated: boolean };
    /** Solo con `drivers:track` y solo si el dispositivo ha reportado posición alguna vez. */
    lastLocation?: { lat: number; lng: number; at: Date };
  };
  performance: {
    avgDeliveryMinutes: number | null;
    delivered7d: number;
    delivered30d: number;
    previous7d: number;
    trend: 'up' | 'down' | 'flat';
  };
  security: {
    emergencyContact?: { name: string; phone: string; relationship?: string; updatedAt?: Date };
    suspensions: Array<{ action: 'suspended' | 'reactivated'; at: Date; by?: string; reason?: string }>;
  };
  account: {
    createdAt?: Date;
    lastLoginAt?: Date;
    twoFactorEnabled: boolean;
    isBlocked: boolean;
    isActive: boolean;
    device?: { platform: string; updatedAt: Date };
    trustedDevices: number;
    blocks: Array<{ action: 'blocked' | 'unblocked'; at: Date; by?: string; reason?: string }>;
  };
  /** Solo con `finance:view`. */
  financeExtra: {
    totalEarned: number;
    totalPaid: number;
    totalPending: number;
    lastPayment?: { amount: number; at: Date };
  } | null;
  history: HistoryItem[];
}

export interface FichaOptions {
  /** `users:view_sensitive`: fecha de nacimiento y números completos. */
  sensitive?: boolean;
  /** `finance:view`. */
  finance?: boolean;
  /** `drivers:track`. */
  track?: boolean;
}

const rad = (deg: number) => (deg * Math.PI) / 180;

/** Distancia entre dos coordenadas [lng, lat], en km. */
export function haversineKm(a: [number, number], b: [number, number]): number {
  const dLat = rad(b[1] - a[1]);
  const dLng = rad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/**
 * Distancia recorrida, del rastro GPS, en una sola pasada para 7 y 30 días.
 * Descarta puntos poco fiables (precisión > 100 m) y tramos con hueco de señal.
 */
async function trailDistance(driverId: Types.ObjectId, retentionDays: number, now = new Date()) {
  const since = new Date(now.getTime() - 30 * DAY_MS);
  const since7 = now.getTime() - 7 * DAY_MS;

  const oldest = await DriverLocation.findOne({ driverId }).sort({ recordedAt: 1 }).select('recordedAt').lean();
  if (!oldest) return { last7d: null, last30d: null, coveredDays: 0, truncated: false };

  const coveredDays = Math.min(30, Math.max(0, Math.ceil((now.getTime() - oldest.recordedAt.getTime()) / DAY_MS)));

  let last: { at: number; p: [number, number] } | null = null;
  let km7 = 0;
  let km30 = 0;
  let points = 0;
  let truncated = false;

  const cursor = DriverLocation.find({ driverId, recordedAt: { $gte: since } })
    .sort({ recordedAt: 1 })
    .select('location.coordinates recordedAt accuracy')
    .lean()
    .cursor();

  for await (const doc of cursor) {
    if (++points > MAX_TRAIL_POINTS) {
      truncated = true;
      break;
    }
    if (doc.accuracy != null && doc.accuracy > 100) continue;
    const p = doc.location.coordinates as [number, number];
    const at = doc.recordedAt.getTime();
    if (last && at - last.at <= MAX_GAP_MS) {
      const d = haversineKm(last.p, p);
      km30 += d;
      if (at >= since7) km7 += d;
    }
    last = { at, p };
  }

  void retentionDays;
  return { last7d: Math.round(km7 * 10) / 10, last30d: Math.round(km30 * 10) / 10, coveredDays, truncated };
}

async function namesOf(ids: Array<string | undefined | null>): Promise<Map<string, string>> {
  const valid = [...new Set(ids.filter((i): i is string => !!i && Types.ObjectId.isValid(i)))];
  if (!valid.length) return new Map();
  const users = await User.find({ _id: { $in: valid } }).select('name').lean();
  return new Map(users.map((u) => [String(u._id), u.name]));
}

export async function buildFicha(driverId: string, options: FichaOptions = {}, now = new Date()): Promise<DriverFicha> {
  if (!Types.ObjectId.isValid(driverId)) throw new AppError('Identificador de domiciliario inválido', 400);
  const id = new Types.ObjectId(driverId);
  const sensitive = options.sensitive === true;

  const driver = await Driver.findById(id).lean();
  if (!driver) throw new AppError('Domiciliario no encontrado', 404);

  const [dossier, user] = await Promise.all([
    driverDossierService.build(driverId, now),
    User.findById(driver.userId)
      .select('twoFactorEnabled birthDate lastLoginAt createdAt isBlocked avatar +trustedDevices +lastDeviceId +pushTokens')
      .lean(),
  ]);
  if (!user) throw new AppError('El domiciliario no tiene usuario asociado', 404);

  const since30 = new Date(now.getTime() - 30 * DAY_MS);
  const since7 = new Date(now.getTime() - 7 * DAY_MS);
  const since14 = new Date(now.getTime() - 14 * DAY_MS);
  const retention = 30;

  const [
    performance,
    activeOrders,
    deliveredTotal,
    cancelledTotal,
    delivered7,
    deliveredPrev7,
    delivered30,
    cancelled30,
    avgRows,
    connected7,
    connected30,
    distance,
    lastVerification,
    docHistoryRows,
    auditRows,
    sos,
    payoutAgg,
    payoutRecent,
    settlements,
  ] = await Promise.all([
    driverService.getPerformance(String(driver.userId), 30),
    Order.countDocuments({ driverId: id, status: { $nin: TERMINAL_ORDER_STATUSES } }),
    Order.countDocuments({ driverId: id, status: OrderStatus.DELIVERED }),
    Order.countDocuments({ driverId: id, status: OrderStatus.CANCELLED }),
    Order.countDocuments({ driverId: id, status: OrderStatus.DELIVERED, deliveredAt: { $gte: since7 } }),
    Order.countDocuments({ driverId: id, status: OrderStatus.DELIVERED, deliveredAt: { $gte: since14, $lt: since7 } }),
    Order.countDocuments({ driverId: id, status: OrderStatus.DELIVERED, deliveredAt: { $gte: since30 } }),
    Order.countDocuments({ driverId: id, status: OrderStatus.CANCELLED, updatedAt: { $gte: since30 } }),
    Order.aggregate([
      { $match: { driverId: id, status: OrderStatus.DELIVERED, deliveredAt: { $gte: since30 }, pickedUpAt: { $type: 'date' } } },
      { $group: { _id: null, avgMs: { $avg: { $subtract: ['$deliveredAt', '$pickedUpAt'] } } } },
    ]),
    driverShiftService.connectedSeconds(id, 7, driver.lastLocationAt, now),
    driverShiftService.connectedSeconds(id, 30, driver.lastLocationAt, now),
    cache.wrap(`driver-ficha:distance:${driverId}`, 600, () => trailDistance(id, retention, now)),
    DriverVerification.findOne({ driverId, status: VerificationStatus.APPROVED }).sort({ reviewedAt: -1 }).select('reviewedAt').lean(),
    DriverDocument.find({ driverId: id }).select('+history type').lean(),
    AuditLog.find({
      $or: [
        { entity: 'driver', entityId: driverId },
        { entity: 'driver_contract', entityId: driverId },
        { entity: 'user', entityId: String(driver.userId), action: { $in: [AuditAction.USER_BLOCKED, AuditAction.USER_UNBLOCKED] } },
      ],
    })
      .sort({ timestamp: -1 })
      .limit(120)
      .lean(),
    SosAlert.find({ driverId: id }).sort({ createdAt: -1 }).limit(20).select('status createdAt note').lean(),
    options.finance
      ? Payout.aggregate([
          { $match: { driverId: id, beneficiary: PayoutBeneficiary.DRIVER } },
          { $group: { _id: '$status', total: { $sum: '$amount' } } },
        ])
      : Promise.resolve([]),
    options.finance
      ? Payout.find({ driverId: id, beneficiary: PayoutBeneficiary.DRIVER, status: PayoutStatus.SETTLED })
          .sort({ updatedAt: -1 })
          .limit(1)
          .select('amount updatedAt')
          .lean()
      : Promise.resolve([]),
    options.finance
      ? Settlement.find({ driverId: id }).sort({ createdAt: -1 }).limit(10).select('netAmount createdAt').lean()
      : Promise.resolve([]),
  ]);

  const mask = (v?: string) => (sensitive ? v : v ? maskLast4(v) ?? undefined : undefined);

  // ── Documentos ──
  const docs: FichaDocument[] = dossier.documents.map((d) => ({
    type: d.type,
    label: d.label,
    group: d.group,
    indicator: d.indicator,
    message: d.message,
    documentId: d.documentId,
    status: d.status,
    reference: mask(d.reference),
    uploadedAt: d.uploadedAt,
    issuedAt: d.issuedAt,
    expiresAt: d.effectiveExpiresAt,
    reviewedAt: d.reviewedAt,
    reviewedByName: d.reviewedByName,
    rejectionReason: d.rejectionReason,
    hasFile: d.hasFile,
  }));
  const byType = new Map(docs.map((d) => [d.type, d]));
  const license = byType.get('license')!;
  const registration = byType.get('vehicle_registration')!;
  const identityDoc = byType.get('identity')!;

  // ── Identidad ──
  const verification: DriverFicha['identity']['verification'] =
    identityDoc.status === 'approved' ? 'verified' : identityDoc.status === 'pending' ? 'in_review' : 'none';

  // ── Quién actuó (una sola consulta de nombres) ──
  const auditActors = await namesOf(auditRows.map((r) => r.userId));

  const reasonOf = (r: { metadata?: Record<string, unknown> | null }) =>
    typeof r.metadata?.reason === 'string' ? (r.metadata.reason as string) : undefined;

  const suspensions = auditRows
    .filter((r) => r.action === AuditAction.DRIVER_SUSPENDED || r.action === AuditAction.DRIVER_REACTIVATED)
    .map((r) => ({
      action: (r.action === AuditAction.DRIVER_SUSPENDED ? 'suspended' : 'reactivated') as 'suspended' | 'reactivated',
      at: r.timestamp,
      by: r.userId ? auditActors.get(r.userId) : undefined,
      reason: reasonOf(r),
    }));

  const blocks = auditRows
    .filter((r) => r.action === AuditAction.USER_BLOCKED || r.action === AuditAction.USER_UNBLOCKED)
    .map((r) => ({
      action: (r.action === AuditAction.USER_BLOCKED ? 'blocked' : 'unblocked') as 'blocked' | 'unblocked',
      at: r.timestamp,
      by: r.userId ? auditActors.get(r.userId) : undefined,
      reason: reasonOf(r),
    }));

  // ── Operación ──
  const lastSignal = driver.lastLocationAt ?? user.lastLoginAt;
  const decidable = performance.offers.accepted + performance.offers.declined + performance.offers.expired;
  const closed30 = delivered30 + cancelled30;
  const hasLocation = !!driver.lastLocationAt && driver.currentLocation?.coordinates?.length === 2;

  const trend: DriverFicha['performance']['trend'] =
    delivered7 > deliveredPrev7 ? 'up' : delivered7 < deliveredPrev7 ? 'down' : 'flat';

  // ── Cuenta ──
  const tokens = [...(user.pushTokens ?? [])].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

  // ── Finanzas ──
  const sumOf = (...statuses: string[]) =>
    (payoutAgg as Array<{ _id: string; total: number }>).filter((r) => statuses.includes(r._id)).reduce((n, r) => n + r.total, 0);

  // ── Historial cronológico ──
  const history: HistoryItem[] = [];
  history.push({ at: driver.createdAt, kind: 'registro', action: 'Perfil de domiciliario creado' });
  for (const d of docHistoryRows) {
    const label = dossier.documents.find((x) => x.type === d.type)?.label ?? d.type;
    for (const h of d.history ?? []) {
      const action =
        h.action === 'approved' ? 'Documento aprobado'
        : h.action === 'rejected' ? 'Documento rechazado'
        : h.action === 'submitted' ? 'Documento enviado'
        : h.action === 'update_requested' ? 'Actualización solicitada'
        : 'Observación interna';
      history.push({ at: h.at, kind: 'documento', action: `${action}: ${label}`, by: h.byName, detail: h.note });
    }
  }
  const auditLabels: Partial<Record<AuditAction, [HistoryItem['kind'], string]>> = {
    [AuditAction.DRIVER_APPROVED]: ['cuenta', 'Domiciliario aprobado'],
    [AuditAction.DRIVER_SUSPENDED]: ['suspension', 'Suspensión'],
    [AuditAction.DRIVER_REACTIVATED]: ['suspension', 'Reactivación'],
    [AuditAction.DRIVER_VEHICLE_UPDATED]: ['vehiculo', 'Datos del vehículo actualizados'],
    [AuditAction.DRIVER_CONTRACT_UPDATED]: ['contrato', 'Contrato modificado'],
    [AuditAction.USER_BLOCKED]: ['cuenta', 'Cuenta bloqueada'],
    [AuditAction.USER_UNBLOCKED]: ['cuenta', 'Cuenta desbloqueada'],
  };
  for (const r of auditRows) {
    const label = auditLabels[r.action as AuditAction];
    if (!label) continue;
    history.push({
      at: r.timestamp,
      kind: label[0],
      action: label[1],
      by: r.userId ? auditActors.get(r.userId) : undefined,
      detail: reasonOf(r) ?? (label[0] === 'vehiculo' ? undefined : r.description),
    });
  }
  for (const s of sos) {
    history.push({ at: s.createdAt, kind: 'sos', action: 'Alerta SOS', detail: s.note });
  }
  if (options.finance) {
    for (const s of settlements) history.push({ at: s.createdAt, kind: 'liquidacion', action: 'Liquidación', detail: `Neto $${s.netAmount.toLocaleString('es-CO')}` });
    for (const p of payoutRecent as Array<{ amount: number; updatedAt: Date }>) history.push({ at: p.updatedAt, kind: 'pago', action: 'Pago al domiciliario', detail: `$${p.amount.toLocaleString('es-CO')}` });
  }
  history.sort((a, b) => b.at.getTime() - a.at.getTime());

  return {
    summary: {
      docsUpToDate: dossier.compliance.upToDate,
      issues: dossier.compliance.issues,
      quick: {
        identity: identityDoc.indicator,
        license: license.indicator,
        soat: byType.get('soat')!.indicator,
        technical_review: byType.get('technical_review')!.indicator,
      },
    },
    identity: {
      avatar: user.avatar,
      birthDate: sensitive ? user.birthDate : undefined,
      registeredAt: user.createdAt,
      verification,
      lastVerificationAt: lastVerification?.reviewedAt ?? (identityDoc.status === 'approved' ? identityDoc.reviewedAt : undefined),
    },
    vehicle: {
      type: dossier.vehicle.type,
      plate: dossier.vehicle.plate,
      brand: dossier.vehicle.brand,
      model: dossier.vehicle.model,
      year: dossier.vehicle.year,
      color: dossier.vehicle.color,
      engineCc: dossier.vehicle.engineCc,
      ownerName: dossier.vehicle.ownerName,
      registrationNumber: registration.reference,
    },
    driving: {
      licenseNumber: license.reference,
      category: dossier.licenseCategory,
      issuedAt: license.issuedAt,
      expiresAt: license.expiresAt,
      indicator: license.indicator,
      message: license.message,
      lastValidatedAt: license.reviewedAt,
      validatedBy: license.reviewedByName,
    },
    documents: docs,
    operation: {
      status: driver.status,
      account: dossier.person.status,
      lastConnectionAt: lastSignal,
      connectedSeconds7d: connected7,
      connectedSeconds30d: connected30,
      activeOrders,
      completed: deliveredTotal,
      cancelled: cancelledTotal,
      acceptanceRate: decidable ? Math.round((performance.offers.accepted / decidable) * 100) : null,
      cancellationRate: closed30 ? Math.round((cancelled30 / closed30) * 100) : null,
      distanceKm: distance,
      lastLocation:
        options.track && hasLocation
          ? { lng: driver.currentLocation.coordinates[0], lat: driver.currentLocation.coordinates[1], at: driver.lastLocationAt! }
          : undefined,
    },
    performance: {
      avgDeliveryMinutes: avgRows[0]?.avgMs != null ? Math.round(avgRows[0].avgMs / 60_000) : null,
      delivered7d: delivered7,
      delivered30d: delivered30,
      previous7d: deliveredPrev7,
      trend,
    },
    security: {
      emergencyContact: driver.emergencyContact
        ? { ...driver.emergencyContact }
        : undefined,
      suspensions,
    },
    account: {
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
      twoFactorEnabled: !!user.twoFactorEnabled,
      isBlocked: !!user.isBlocked,
      isActive: driver.isActive,
      device: tokens[0] ? { platform: tokens[0].platform, updatedAt: tokens[0].updatedAt } : undefined,
      trustedDevices: user.trustedDevices?.length ?? 0,
      blocks,
    },
    financeExtra: options.finance
      ? {
          totalEarned: driver.totalEarnings ?? 0,
          totalPaid: sumOf(PayoutStatus.SETTLED),
          totalPending: sumOf(PayoutStatus.ACCRUED, PayoutStatus.PAYABLE),
          lastPayment: (payoutRecent as Array<{ amount: number; updatedAt: Date }>)[0]
            ? { amount: (payoutRecent as Array<{ amount: number; updatedAt: Date }>)[0].amount, at: (payoutRecent as Array<{ amount: number; updatedAt: Date }>)[0].updatedAt }
            : undefined,
        }
      : null,
    history: history.slice(0, HISTORY_LIMIT),
  };
}

export const driverFichaService = { build: buildFicha };
