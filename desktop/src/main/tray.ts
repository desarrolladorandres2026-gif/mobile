import { Tray, Menu, app, nativeImage, dialog, Notification } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import log from 'electron-log';
import { config } from './config';
import { getMainWindow, showMainWindow, toggleFullscreen, recordPendingCrashReport } from './window';
import { getSetting, setSetting } from './store';
import { setAutoStart } from './autostart';
import { checkForUpdatesNow } from './updater';
import { reportStoreOpen } from './ipc';

/**
 * El icono junto al reloj.
 *
 * Cerrar la ventana con la X nunca cierra la app — la oculta aquí. Salir de
 * verdad es siempre una decisión explícita desde este menú, con el aviso
 * del negocio Abierto que pide el plan.
 */

let tray: Tray | null = null;
let shownHideNotice = false;

function icon(): Electron.NativeImage {
  const file = path.join(__dirname, '..', '..', 'assets', 'tray.png');
  const image = nativeImage.createFromPath(file);
  return image.isEmpty() ? nativeImage.createEmpty() : image;
}

async function confirmQuitWithOpenStore(): Promise<'quit-and-close-store' | 'quit' | 'cancel'> {
  const win = getMainWindow();
  const result = await dialog.showMessageBox(win ?? undefined as any, {
    type: 'warning',
    title: config.productName,
    message: 'El negocio sigue Abierto y este equipo dejará de sonar.',
    detail: 'Si vas a cerrar el local, cierra también el negocio para que ZIPP deje de mandarle pedidos.',
    buttons: ['Cerrar el negocio y salir', 'Salir sin cerrarlo', 'Cancelar'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });
  if (result.response === 0) return 'quit-and-close-store';
  if (result.response === 1) return 'quit';
  return 'cancel';
}

/** Cuánto del archivo de log se adjunta: suficiente para ver qué pasó justo antes, no el historial entero. */
const DIAGNOSTIC_LOG_TAIL_CHARS = 4_000;

/**
 * "Enviar diagnóstico": las últimas líneas del log de electron-log, para
 * cuando algo se ve raro pero no llegó a ser un `render-process-gone` que
 * se reportara solo. Se guarda igual que un crash (el panel lo manda con
 * su sesión en cuanto recarga) y no se instala nada nuevo para esto.
 */
function sendDiagnostics(): void {
  let logTail = '';
  try {
    const logPath = log.transports.file.getFile().path;
    const content = fs.readFileSync(logPath, 'utf8');
    logTail = content.slice(-DIAGNOSTIC_LOG_TAIL_CHARS);
  } catch (err) {
    log.error('[tray] no se pudo leer el log para el diagnóstico', err);
  }

  recordPendingCrashReport('Diagnóstico manual', { log: logTail }, false);
  getMainWindow()?.webContents.reload();
  new Notification({
    title: config.productName,
    body: 'El diagnóstico se enviará a soporte en cuanto el panel vuelva a cargar.',
  }).show();
}

async function handleQuit(): Promise<void> {
  const storeOpen = getSetting('lastKnownStoreOpen', false);
  if (storeOpen) {
    const choice = await confirmQuitWithOpenStore();
    if (choice === 'cancel') return;
    if (choice === 'quit-and-close-store') {
      await reportStoreOpen(false).catch(() => {});
    }
  }
  app.exit(0);
}

export function buildTray(): Tray {
  tray = new Tray(icon());
  tray.setToolTip(config.productName);

  const rebuildMenu = () => {
    const launchAtLogin = getSetting('launchAtLogin', true);
    tray?.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Abrir', click: () => showMainWindow() },
        { label: 'Pantalla completa', type: 'checkbox', checked: getMainWindow()?.isFullScreen() ?? true, click: () => toggleFullscreen() },
        { type: 'separator' },
        {
          label: 'Iniciar con Windows',
          type: 'checkbox',
          checked: launchAtLogin,
          click: (item) => {
            setSetting('launchAtLogin', item.checked);
            setAutoStart(item.checked);
          },
        },
        { label: 'Buscar actualizaciones', click: () => checkForUpdatesNow() },
        { label: 'Enviar diagnóstico', click: () => sendDiagnostics() },
        { label: `Versión ${app.getVersion()}`, enabled: false },
        { type: 'separator' },
        { label: 'Salir', click: () => { void handleQuit(); } },
      ])
    );
  };

  rebuildMenu();
  tray.on('click', () => showMainWindow());

  return tray;
}

/** El primer "ocultar" explica dónde quedó la app. Solo una vez por instalación. */
export function maybeShowHideNotice(): void {
  if (shownHideNotice || getSetting('sawHideNotice', false)) return;
  shownHideNotice = true;
  setSetting('sawHideNotice', true);
  tray?.displayBalloon({
    title: config.productName,
    content: `${config.productName} sigue abierto junto al reloj. Para salir de verdad, usa el menú de este icono.`,
  });
}
