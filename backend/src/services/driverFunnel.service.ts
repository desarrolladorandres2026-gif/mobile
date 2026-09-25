import { Types } from 'mongoose';
import { Driver, DriverDocument, User } from '../models';
import { UserRole } from '../types';

/**
 * Embudo de alta de domiciliarios.
 *
 * Quien se registra y se queda a medias es invisible: la cola de documentos
 * solo muestra lo que ya se subió, así que alguien sin perfil, sin papeles, o
 * con todo rechazado y sin reenviar no aparece en ninguna pantalla. Aquí se
 * lee esa cola de espera por etapa, para saber a quién escribirle.
 */

export type FunnelStage = 'no_profile' | 'no_documents' | 'rejected_stuck' | 'in_review' | 'ready_to_approve';

export interface FunnelItem {
  stage: FunnelStage;
  userId: string;
  driverId: string | null;
  name: string;
  phone: string | null;
  /** Desde cuándo está en la etapa como tope: registro o última actividad de sus documentos. */
  since: string;
  daysWaiting: number;
  documents?: { pending: number; approved: number; rejected: number; expired: number };
}

export interface DriverFunnel {
  counts: Record<FunnelStage, number>;
  items: FunnelItem[];
  truncated: boolean;
}

const DAY_MS = 86_400_000;
const PER_STAGE_LIMIT = 50;

export function classifyDriver(docs: { pending: number; approved: number; rejected: number; expired: number }): Exclude<FunnelStage, 'no_profile'> {
  const total = docs.pending + docs.approved + docs.rejected + docs.expired;
  if (docs.pending > 0) return 'in_review';
  if (total === 0) return 'no_documents';
  if (docs.rejected > 0 || docs.expired > 0) return 'rejected_stuck';
  return 'ready_to_approve';
}

export async function driverFunnel(now: Date = new Date()): Promise<DriverFunnel> {
  const counts: Record<FunnelStage, number> = { no_profile: 0, no_documents: 0, rejected_stuck: 0, in_review: 0, ready_to_approve: 0 };
  const items: FunnelItem[] = [];
  const perStage: Record<FunnelStage, number> = { ...counts };

  const push = (item: FunnelItem) => {
    counts[item.stage]++;
    if (perStage[item.stage] < PER_STAGE_LIMIT) {
      perStage[item.stage]++;
      items.push(item);
    }
  };

  const profiles = await Driver.find({}).select('userId isApproved createdAt').lean();
  const profileUserIds = profiles.map((p) => p.userId);

  // Rol DRIVER sin perfil: se registró en la app y nunca completó el alta.
  const orphans = await User.find({ role: UserRole.DRIVER, isActive: { $ne: false }, _id: { $nin: profileUserIds } })
    .select('name phone createdAt').sort({ createdAt: 1 }).lean();
  for (const u of orphans) {
    push({
      stage: 'no_profile', userId: String(u._id), driverId: null, name: u.name, phone: u.phone ?? null,
      since: u.createdAt.toISOString(), daysWaiting: Math.floor((now.getTime() - u.createdAt.getTime()) / DAY_MS),
    });
  }

  const pending = profiles.filter((p) => !p.isApproved);
  if (pending.length === 0) return { counts, items, truncated: counts.no_profile > PER_STAGE_LIMIT };

  const grouped = await DriverDocument.aggregate<{ _id: Types.ObjectId; last: Date; pending: number; approved: number; rejected: number; expired: number }>([
    { $match: { driverId: { $in: pending.map((p) => p._id) } } },
    { $group: {
      _id: '$driverId',
      last: { $max: '$updatedAt' },
      pending: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } },
      approved: { $sum: { $cond: [{ $eq: ['$status', 'approved'] }, 1, 0] } },
      rejected: { $sum: { $cond: [{ $eq: ['$status', 'rejected'] }, 1, 0] } },
      expired: { $sum: { $cond: [{ $eq: ['$status', 'expired'] }, 1, 0] } },
    } },
  ]);
  const byDriver = new Map(grouped.map((g) => [String(g._id), g]));

  const users = await User.find({ _id: { $in: pending.map((p) => p.userId) } }).select('name phone').lean();
  const userById = new Map(users.map((u) => [String(u._id), u]));

  for (const d of pending) {
    const g = byDriver.get(String(d._id));
    const docs = { pending: g?.pending ?? 0, approved: g?.approved ?? 0, rejected: g?.rejected ?? 0, expired: g?.expired ?? 0 };
    const since = g?.last ?? d.createdAt;
    const user = userById.get(String(d.userId));
    push({
      stage: classifyDriver(docs), userId: String(d.userId), driverId: String(d._id),
      name: user?.name ?? 'Domiciliario', phone: user?.phone ?? null,
      since: since.toISOString(), daysWaiting: Math.floor((now.getTime() - since.getTime()) / DAY_MS), documents: docs,
    });
  }

  // Lo que lleva más tiempo esperando, primero.
  items.sort((a, b) => b.daysWaiting - a.daysWaiting);
  return { counts, items, truncated: Object.values(counts).some((n) => n > PER_STAGE_LIMIT) };
}
