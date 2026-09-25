import { Types } from 'mongoose';
import { ClientError, CrashResolution } from '../models';
import { AppError } from '../middlewares';

/**
 * Salud de la app: lo que reventó en los teléfonos, agrupado.
 *
 * `ClientError` solo tenía escritura (`POST /telemetry/crash`); sin lectura,
 * el reporte de crashes existía y nadie lo veía. Aquí se agrupa por mensaje
 * y versión —la primera pregunta es siempre "qué se rompe más y desde qué
 * versión"— y se devuelven contadores, no identidades: cuántas personas
 * afectó, no quiénes (`userId` y `deviceId` no salen de aquí).
 */

export const CRASH_DEFAULT_DAYS = 7;
export const CRASH_MAX_DAYS = 30; // el TTL de la colección

export interface CrashGroup {
  message: string;
  appVersion: string;
  count: number;
  fatal: number;
  usersAffected: number;
  platforms: string[];
  scope: string | null;
  firstAt: Date;
  lastAt: Date;
  /** Un pedido implicado, para poder reproducirlo. */
  sampleOrderId: string | null;
  stack: string | null;
  /**
   * `resolved`: el mensaje se marcó resuelto y esta versión ya estaba vista.
   * `regression`: se marcó resuelto pero reaparece en una versión nueva.
   */
  status: 'open' | 'resolved' | 'regression';
  resolvedAt: Date | null;
}

export async function crashes(days = CRASH_DEFAULT_DAYS, limit = 30) {
  const from = new Date(Date.now() - Math.min(Math.max(days, 1), CRASH_MAX_DAYS) * 24 * 60 * 60 * 1000);
  const match = { createdAt: { $gte: from } };

  const [groups, totals, byVersion] = await Promise.all([
    ClientError.aggregate([
      { $match: match },
      { $sort: { createdAt: 1 } },
      {
        $group: {
          _id: { message: '$message', appVersion: '$appVersion' },
          count: { $sum: 1 },
          fatal: { $sum: { $cond: ['$fatal', 1, 0] } },
          users: { $addToSet: '$userId' },
          platforms: { $addToSet: '$platform' },
          scope: { $last: '$scope' },
          firstAt: { $min: '$createdAt' },
          lastAt: { $max: '$createdAt' },
          sampleOrderId: { $last: '$orderId' },
          stack: { $last: '$stack' },
        },
      },
      { $sort: { fatal: -1, count: -1 } },
      { $limit: Math.min(limit, 50) },
    ]),
    ClientError.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          fatal: { $sum: { $cond: ['$fatal', 1, 0] } },
          users: { $addToSet: '$userId' },
        },
      },
    ]),
    ClientError.aggregate([
      { $match: match },
      {
        $group: {
          _id: '$appVersion',
          total: { $sum: 1 },
          fatal: { $sum: { $cond: ['$fatal', 1, 0] } },
        },
      },
      { $sort: { total: -1 } },
      { $limit: 10 },
    ]),
  ]);

  const resolutions = await CrashResolution.find({ message: { $in: groups.map((g) => g._id.message) } })
    .select('message versions resolvedAt')
    .lean();
  const resolutionOf = new Map(resolutions.map((r) => [r.message, r]));

  return {
    days: Math.round((Date.now() - from.getTime()) / 86_400_000),
    totals: {
      total: (totals[0]?.total as number | undefined) ?? 0,
      fatal: (totals[0]?.fatal as number | undefined) ?? 0,
      usersAffected: (totals[0]?.users as unknown[] | undefined)?.length ?? 0,
    },
    byVersion: byVersion.map((v) => ({ appVersion: v._id as string, total: v.total as number, fatal: v.fatal as number })),
    groups: groups.map(
      (g): CrashGroup => ({
        message: g._id.message,
        appVersion: g._id.appVersion,
        count: g.count,
        fatal: g.fatal,
        usersAffected: (g.users as unknown[]).length,
        platforms: g.platforms,
        scope: g.scope ?? null,
        firstAt: g.firstAt,
        lastAt: g.lastAt,
        sampleOrderId: g.sampleOrderId ? String(g.sampleOrderId) : null,
        stack: g.stack ?? null,
        ...statusOf(resolutionOf.get(g._id.message), g._id.appVersion),
      })
    ),
  };
}

function statusOf(
  resolution: { versions: string[]; resolvedAt: Date } | undefined,
  appVersion: string
): Pick<CrashGroup, 'status' | 'resolvedAt'> {
  if (!resolution) return { status: 'open', resolvedAt: null };
  return {
    status: resolution.versions.includes(appVersion) ? 'resolved' : 'regression',
    resolvedAt: resolution.resolvedAt,
  };
}

/**
 * Marca un mensaje como resuelto en todas las versiones donde se ha visto
 * hasta ahora. Volver a resolverlo (tras una regresión) suma las versiones
 * nuevas en vez de reemplazarlas.
 */
async function resolve(message: string, userId: string, note?: string | null) {
  const versions: string[] = await ClientError.distinct('appVersion', { message });
  if (versions.length === 0) throw new AppError('Ese error no aparece en los últimos 30 días', 404);
  return CrashResolution.findOneAndUpdate(
    { message },
    {
      $addToSet: { versions: { $each: versions } },
      $set: { resolvedBy: new Types.ObjectId(userId), resolvedAt: new Date(), note: note?.trim() || null },
    },
    { upsert: true, new: true, runValidators: true }
  );
}

/** Quita la marca: el error vuelve a contarse como abierto en todas sus versiones. */
async function reopen(message: string) {
  const removed = await CrashResolution.findOneAndDelete({ message });
  if (!removed) throw new AppError('Ese error no estaba marcado como resuelto', 404);
  return removed;
}

export const appHealthService = { crashes, resolve, reopen };
