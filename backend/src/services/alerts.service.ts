import { Types } from 'mongoose';
import { AlertReceipt } from '../models/AlertReceipt';
import { cache } from '../cache';
import { getIO, adminRoom } from '../sockets/emitter';
import { AppError } from '../middlewares/errorHandler';
import type { Incident, IncidentKind, IncidentSeverity, PermissionCheck } from './incidentCenter.service';

/**
 * Bandeja de alertas del equipo (Fase 2, B2).
 *
 * Las alertas no se guardan: se calculan con `incidentCenterService` (la
 * única fuente, así Incidentes y la Bandeja no divergen) y desaparecen
 * cuando el dominio las resuelve. Lo único que se persiste es la "vista" por
 * persona (`AlertReceipt`).
 *
 * Este módulo lo importan emisores de bajo nivel (antifraude, SOS, reembolsos):
 * `incidentCenter` solo se importa por tipo o como constante, y el servicio se
 * carga bajo demanda dentro de `computeAll` para no crear ciclos.
 */

export const ALERTS_CACHE_KEY = 'alerts:open:v1';
export const ALERTS_CACHE_TTL_SECONDS = 15;
export const ALERTS_DEFAULT_LIMIT = 50;
export const ALERTS_MAX_LIMIT = 100;
export const ALERTS_MAX_SEEN_KEYS = 100;

export interface AlertItem {
  key: string;
  kind: IncidentKind;
  severity: IncidentSeverity;
  title: string;
  detail: string;
  at: string;
  links: { orderId?: string; userId?: string; businessId?: string; driverId?: string };
  seen: boolean;
}

export interface AlertsView {
  items: AlertItem[];
  unseen: number;
  generatedAt: string;
  truncated: boolean;
}

type CachedIncident = Omit<Incident, 'at'> & { at: string };

interface AllAlerts {
  generatedAt: string;
  incidents: CachedIncident[];
}

/** Todo lo abierto, sin filtrar por permiso. Una sola vez cada 15 s aunque haya muchas personas conectadas. */
async function computeAll(): Promise<AllAlerts> {
  return cache.wrap<AllAlerts>(ALERTS_CACHE_KEY, ALERTS_CACHE_TTL_SECONDS, async () => {
    const { incidentCenterService } = await import('./incidentCenter.service');
    const incidents = await incidentCenterService.open(() => true);
    return {
      generatedAt: new Date().toISOString(),
      incidents: incidents.map((i) => ({ ...i, at: new Date(i.at).toISOString() })),
    };
  });
}

async function list(params: { userId: string; allows: PermissionCheck; limit?: number }): Promise<AlertsView> {
  const limit = Math.min(Math.max(Math.trunc(params.limit ?? ALERTS_DEFAULT_LIMIT) || ALERTS_DEFAULT_LIMIT, 1), ALERTS_MAX_LIMIT);
  const all = await computeAll();
  const { INCIDENT_PERMISSION } = await import('./incidentCenter.service');

  // El filtro por permiso se aplica por petición; un tipo sin permiso ni se
  // menciona. `allows` falla cerrado y se consulta una vez por tipo.
  const verdicts = new Map<string, boolean>();
  const visible = all.incidents.filter((i) => {
    const perm = INCIDENT_PERMISSION[i.kind];
    if (!perm) return false;
    if (!verdicts.has(i.kind)) verdicts.set(i.kind, params.allows(perm));
    return verdicts.get(i.kind) === true;
  });

  const seenKeys = new Set<string>();
  if (visible.length) {
    const receipts = await AlertReceipt.find({
      userId: new Types.ObjectId(params.userId),
      key: { $in: visible.map((i) => i.key) },
    })
      .select('key')
      .lean();
    for (const r of receipts) seenKeys.add(r.key);
  }

  const unseen = visible.filter((i) => !seenKeys.has(i.key)).length;

  const items: AlertItem[] = visible.slice(0, limit).map((i) => ({
    key: i.key,
    kind: i.kind,
    severity: i.severity,
    title: i.title,
    detail: i.detail,
    at: i.at,
    links: {
      ...(i.orderId ? { orderId: i.orderId } : {}),
      ...(i.userId ? { userId: i.userId } : {}),
      ...(i.businessId ? { businessId: i.businessId } : {}),
      ...(i.driverId ? { driverId: i.driverId } : {}),
    },
    seen: seenKeys.has(i.key),
  }));

  return { items, unseen, generatedAt: all.generatedAt, truncated: visible.length > limit };
}

/**
 * Marca alertas como vistas por esta persona. Idempotente: el upsert usa SOLO
 * `$setOnInsert` (filtro `{userId, key}`), así repetirlo no cambia nada ni
 * choca con otro operador (`ConflictingUpdateOperators`).
 */
const ALERT_KEY_FORMAT = /^[a-z_]+:[0-9a-f]{24}:[a-z0-9_]+$/;

async function markSeen(userId: string, keys: string[], allows?: PermissionCheck): Promise<void> {
  let unique = Array.from(new Set(keys));
  if (unique.length > ALERTS_MAX_SEEN_KEYS) throw new AppError(`Máximo ${ALERTS_MAX_SEEN_KEYS} alertas por petición`, 400);
  if (unique.some((k) => typeof k !== 'string' || !ALERT_KEY_FORMAT.test(k))) throw new AppError('Clave de alerta inválida', 400);
  // Con `allows`, solo se marcan alertas abiertas que esta persona puede ver:
  // así no se siembran recibos arbitrarios (basura con TTL de 30 días).
  if (allows) {
    const visible = new Set((await list({ userId, allows, limit: ALERTS_MAX_LIMIT })).items.map((i) => i.key));
    unique = unique.filter((k) => visible.has(k));
  }
  if (!unique.length) return;
  const uid = new Types.ObjectId(userId);
  const seenAt = new Date();
  await AlertReceipt.bulkWrite(
    unique.map((key) => ({
      updateOne: {
        filter: { userId: uid, key },
        update: { $setOnInsert: { seenAt } },
        upsert: true,
      },
    })),
    { ordered: false }
  );
}

/**
 * Algo que alimenta la bandeja cambió: invalida la caché y avisa a la sala
 * `admin:alerts` SIN contenido (el panel vuelve a pedir la bandeja por REST,
 * que es donde se filtra por permiso). Nunca lanza: una alerta que no avisa
 * no debe tumbar la operación que la originó. Los llamadores no lo esperan
 * (`void notifyAlertsChanged(...)`); devuelve la promesa para poder probarlo.
 */
function notifyAlertsChanged(kind: string): Promise<void> {
  try {
    return cache
      .del(ALERTS_CACHE_KEY)
      .catch(() => undefined)
      .then(() => {
        try {
          getIO()?.to(adminRoom('alerts')).emit('alerts:changed', { kind });
        } catch {
          /* sin socket no hay aviso; el sondeo del panel lo cubre */
        }
      });
  } catch {
    return Promise.resolve();
  }
}

export const alertsService = { list, markSeen, computeAll, notifyAlertsChanged };
export { notifyAlertsChanged };
