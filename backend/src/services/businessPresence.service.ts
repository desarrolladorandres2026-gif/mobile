import { Business } from '../models';
import { notificationService } from './notification.service';

/**
 * "¿Hay un panel escuchando este negocio?" — y el aviso cuando, estando
 * Abierto, nadie lo está.
 *
 * Antes no existía ninguna noción de presencia: un pedido PENDING podía
 * esperar para siempre si el comercio tenía el panel cerrado, sin que nadie
 * se enterara hasta que el cliente llamara a preguntar. Se guarda en Mongo
 * y no en memoria (PM2 corre una sola instancia `fork`, pero un reinicio no
 * debería hacer que todo el mundo parezca recién desconectado).
 */

/** Sin panel visto en más de esto, un negocio Abierto está "sin nadie escuchando". */
export const PANEL_SEEN_THRESHOLD_MS = 15 * 60_000;

/**
 * Se llama al conectar el socket de un negocio (dueño o personal activo).
 * También limpia `panelDisconnectedNotifiedAt`: una reconexión cierra el
 * episodio de desconexión, así que la próxima que ocurra debe volver a
 * avisar.
 */
export async function markPanelSeen(businessIds: readonly string[]): Promise<void> {
  if (businessIds.length === 0) return;
  await Business.updateMany(
    { _id: { $in: businessIds } },
    { $set: { panelSeenAt: new Date(), panelDisconnectedNotifiedAt: null } }
  );
}

export interface PanelDisconnectedAlert {
  businessId: string;
  ownerId: string;
}

/**
 * Negocios Abiertos, aprobados y no suspendidos cuyo panel no se ve desde
 * hace más de `thresholdMs`, y que todavía no se avisaron (o que
 * reconectaron desde el último aviso, lo que limpia la bandera). Marca a
 * cada uno como avisado y devuelve con quién hablar.
 */
export async function sweepUnseenOpenBusinesses(
  thresholdMs = PANEL_SEEN_THRESHOLD_MS
): Promise<PanelDisconnectedAlert[]> {
  const cutoff = new Date(Date.now() - thresholdMs);

  const candidates = await Business.find({
    isActive: true,
    isArchived: { $ne: true },
    isSuspended: { $ne: true },
    isApproved: true,
    panelDisconnectedNotifiedAt: null,
    $or: [{ panelSeenAt: null }, { panelSeenAt: { $lt: cutoff } }],
  })
    .select('ownerId')
    .lean();

  if (candidates.length === 0) return [];

  const ids = candidates.map((b) => b._id);
  // Se marca ANTES de notificar: si `notificationService.create` falla a
  // mitad de la tanda, el siguiente barrido (5 min después) no repite el
  // aviso a quien ya lo recibió, solo reintenta con los que de verdad
  // quedaron sin marcar.
  await Business.updateMany({ _id: { $in: ids } }, { $set: { panelDisconnectedNotifiedAt: new Date() } });

  return candidates.map((b) => ({ businessId: b._id.toString(), ownerId: b.ownerId.toString() }));
}

export async function notifyPanelDisconnected(alerts: readonly PanelDisconnectedAlert[]): Promise<void> {
  await Promise.all(
    alerts.map((alert) =>
      notificationService.notifyBusinessPanelDisconnected(alert.ownerId, alert.businessId).catch(console.error)
    )
  );
}

// ── Barrido de proceso ──────────────────────────────────────────────
//
// Mismo patrón que `startCashOverdueSweeper`: un `setInterval` de proceso,
// no un cron externo, porque PM2 corre esta app en una sola instancia.
let presenceSweepTimer: ReturnType<typeof setInterval> | null = null;

export function startPanelPresenceSweeper(intervalMs = 5 * 60_000): void {
  if (presenceSweepTimer) return;
  presenceSweepTimer = setInterval(() => {
    sweepUnseenOpenBusinesses()
      .then(notifyPanelDisconnected)
      .catch((error) => console.error('[panel-presence-sweep]', error));
  }, intervalMs);
  presenceSweepTimer.unref?.();
}

export function stopPanelPresenceSweeper(): void {
  if (presenceSweepTimer) {
    clearInterval(presenceSweepTimer);
    presenceSweepTimer = null;
  }
}
