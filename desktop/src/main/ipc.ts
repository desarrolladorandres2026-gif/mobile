import { ipcMain, Notification } from 'electron';
import log from 'electron-log';
import { CHANNELS } from '../shared/channels';
import {
  validateAttention,
  validateReportStatus,
  validateSettingsGet,
  validateSettingsSet,
  type ReportStatusPayload,
} from '../shared/bridge';
import { getSetting, setSetting } from './store';
import { bringToFrontForAttention, getMainWindow } from './window';
import { printTicket } from './printing';
import { checkForUpdatesNow } from './updater';

/**
 * El extremo de confianza del puente `window.zippDesktop`.
 *
 * Cada canal valida su mensaje con `shared/bridge.ts` antes de tocar nada
 * del sistema — un XSS en el panel puede llamar a estas funciones con lo
 * que quiera, y la única barrera real está aquí, no en el preload.
 */

let lastStatus: ReportStatusPayload = { connection: 'offline', session: 'ended', storeOpen: false, quiet: true };
let lastAttentionCount = 0;
let connectionDownTimer: ReturnType<typeof setTimeout> | null = null;

/** Un parpadeo de red no debe interrumpir a nadie: solo se avisa si sigue caída pasado esto. */
const CONNECTION_DOWN_NOTICE_MS = 60_000;

export function getLastStatus(): ReportStatusPayload {
  return lastStatus;
}

export function isQuietNow(): boolean {
  return lastStatus.quiet;
}

function notify(title: string, body: string, onClick?: () => void): void {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title, body, silent: true });
  if (onClick) notification.on('click', onClick);
  notification.show();
}

export function registerIpcHandlers(): void {
  ipcMain.handle(CHANNELS.attention, (_event, payload) => {
    const result = validateAttention(payload);
    if (!result.ok) {
      log.warn(`[ipc] attention inválido: ${result.error}`);
      return { ok: false };
    }
    const { pattern, count, orderNumber } = result.value;

    // Solo se interrumpe cuando hay MÁS pedidos esperando que la última
    // vez: si el conteo bajó o se mantiene, es que ya se atendió algo, no
    // que haya algo nuevo que anunciar.
    if (pattern && count > lastAttentionCount) {
      bringToFrontForAttention();
      notify(
        orderNumber ? `Pedido nuevo #${orderNumber}` : 'Pedido nuevo',
        'Toca para abrirlo.',
        () => {
          const win = getMainWindow();
          if (win && orderNumber) win.webContents.send(CHANNELS.notificationClick, orderNumber);
        }
      );
    }
    lastAttentionCount = count;
    return { ok: true };
  });

  ipcMain.handle(CHANNELS.reportStatus, (_event, payload) => {
    const result = validateReportStatus(payload);
    if (!result.ok) {
      log.warn(`[ipc] report-status inválido: ${result.error}`);
      return { ok: false };
    }
    const wasEnded = lastStatus.session === 'active' && result.value.session === 'ended';
    const justWentDown = lastStatus.connection === 'online' && result.value.connection === 'offline';
    const backOnline = lastStatus.connection === 'offline' && result.value.connection === 'online';
    lastStatus = result.value;
    setSetting('lastKnownStoreOpen', result.value.storeOpen);

    if (justWentDown) {
      connectionDownTimer = setTimeout(() => {
        connectionDownTimer = null;
        if (lastStatus.connection === 'offline') notify('Sin conexión con ZIPP', 'Revisando la red para volver a conectar.');
      }, CONNECTION_DOWN_NOTICE_MS);
    } else if (backOnline && connectionDownTimer) {
      clearTimeout(connectionDownTimer);
      connectionDownTimer = null;
    }

    if (wasEnded) {
      bringToFrontForAttention();
      notify('Sesión terminada', 'Vuelve a entrar para seguir recibiendo pedidos.');
    }
    return { ok: true };
  });

  ipcMain.handle(CHANNELS.settingsGet, (_event, payload) => {
    const result = validateSettingsGet(payload);
    if (!result.ok) return { ok: false };
    return { ok: true, value: getSetting(result.value.key, null) };
  });

  ipcMain.handle(CHANNELS.settingsSet, (_event, payload) => {
    const result = validateSettingsSet(payload);
    if (!result.ok) return { ok: false };
    setSetting(result.value.key, result.value.value);
    return { ok: true };
  });

  // El crash lo reporta el PANEL (tiene el token de sesión; el proceso
  // principal nunca lo tiene). `get` no limpia solo: si el panel se cae
  // antes de confirmar el envío, el reporte sigue ahí para el próximo
  // arranque en vez de perderse.
  ipcMain.handle(CHANNELS.pendingCrashReportGet, () => ({ ok: true, value: getSetting('pendingCrashReport', null) }));
  ipcMain.handle(CHANNELS.pendingCrashReportClear, () => {
    setSetting('pendingCrashReport', null);
    return { ok: true };
  });

  ipcMain.handle(CHANNELS.updatesCheck, () => {
    checkForUpdatesNow();
    return { ok: true };
  });

  ipcMain.handle(CHANNELS.printTicket, async (_event, ticket) => printTicket(ticket));

  /** Las impresoras instaladas en este equipo, para elegir una en "Este equipo". */
  ipcMain.handle(CHANNELS.printersList, async () => {
    const win = getMainWindow();
    if (!win) return { ok: true, value: [] };
    const printers = await win.webContents.getPrintersAsync();
    return { ok: true, value: printers.map((p) => ({ name: p.name, displayName: p.displayName, isDefault: p.isDefault })) };
  });
}

/**
 * Le pide al panel que cierre el negocio antes de salir (botón "Cerrar el
 * negocio y salir" de la bandeja). El PATCH lo hace el panel, que es quien
 * tiene el token de sesión — el proceso principal no guarda credenciales.
 * Si el panel no contesta en 5 s (sesión caída, pantalla congelada), se
 * sale igual: un "Salir" que nunca termina es peor que uno que no alcanzó
 * a cerrar el negocio.
 */
export function reportStoreOpen(isActive: boolean): Promise<void> {
  if (isActive) return Promise.resolve();
  return new Promise((resolve) => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return resolve();
    const timer = setTimeout(resolve, 5_000);
    ipcMain.once(CHANNELS.closeStoreAck, () => {
      clearTimeout(timer);
      resolve();
    });
    win.webContents.send(CHANNELS.closeStoreRequest);
  });
}
