import { BrowserWindow, shell, app, session, Notification } from 'electron';
import path from 'node:path';
import log from 'electron-log';
import { config, isDev } from './config';
import { decideNavigation } from '../shared/navigation';
import { setSetting } from './store';

const PARTITION = 'persist:zipp-negocios';
/** Lo único que un comercio necesita de verdad: el campo de ubicación y copiar/pegar. Todo lo demás, no. */
const ALLOWED_PERMISSIONS = new Set(['geolocation', 'clipboard-read', 'clipboard-sanitized-write']);

/**
 * Permisos del navegador (cámara, micrófono, notificaciones del propio
 * sitio, etc.): lista blanca explícita en vez de la respuesta por defecto
 * de Electron, que es conceder todo. El panel no pide nada más hoy, y que
 * algo nuevo pida acceso sin que nadie lo haya decidido es exactamente el
 * tipo de sorpresa silenciosa que esto evita.
 */
function hardenPermissions(): void {
  const ses = session.fromPartition(PARTITION);
  ses.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission));
  });
  ses.setPermissionCheckHandler((_webContents, permission) => ALLOWED_PERMISSIONS.has(permission));

  // Las liquidaciones (CSV) y los documentos del negocio: a la carpeta de
  // Descargas de Windows, con un aviso — sin eso, una descarga silenciosa
  // en una app que vive en pantalla completa es fácil de no notar nunca.
  ses.on('will-download', (_event, item) => {
    const destination = path.join(app.getPath('downloads'), item.getFilename());
    item.setSavePath(destination);
    item.once('done', (_doneEvent, state) => {
      if (state !== 'completed') return;
      if (!Notification.isSupported()) return;
      new Notification({
        title: config.productName,
        body: `Se descargó "${item.getFilename()}" en tu carpeta de Descargas.`,
      }).show();
    });
  });
}

/**
 * La ventana principal: carga el panel y nada más.
 *
 * Toda decisión de "¿esto se queda dentro, se abre afuera o se bloquea?"
 * vive en `shared/navigation.ts` — aquí solo se aplica. Es la misma
 * separación que `resolveOrderAccess` en el backend: la regla en un sitio,
 * para que cambiarla no signifique encontrar los cuatro lugares donde se
 * repitió a mano.
 */

const OFFLINE_RETRY_MS = [2_000, 4_000, 8_000, 16_000, 30_000];
const OFFLINE_HTML = path.join(__dirname, '..', '..', 'static', 'offline.html');

let mainWindow: BrowserWindow | null = null;
let offlineRetryIndex = 0;
let offlineRetryTimer: ReturnType<typeof setTimeout> | null = null;

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

function clearOfflineRetry(): void {
  if (offlineRetryTimer) clearTimeout(offlineRetryTimer);
  offlineRetryTimer = null;
  offlineRetryIndex = 0;
}

function scheduleOfflineRetry(win: BrowserWindow): void {
  const delay = OFFLINE_RETRY_MS[Math.min(offlineRetryIndex, OFFLINE_RETRY_MS.length - 1)];
  offlineRetryIndex++;
  offlineRetryTimer = setTimeout(() => {
    if (win.isDestroyed()) return;
    log.info(`[window] reintentando cargar el panel (${delay}ms de espera)`);
    win.loadURL(config.panelUrl).catch(() => {});
  }, delay);
}

function lockDownNavigation(win: BrowserWindow): void {
  const panelOrigin = config.panelUrl;

  const handle = (event: Electron.Event, url: string) => {
    const decision = decideNavigation(url, panelOrigin);
    if (decision.action === 'allow') return; // Deja que Electron navegue normalmente.
    event.preventDefault();
    if (decision.action === 'open-external') {
      shell.openExternal(url).catch((err) => log.error('[window] no se pudo abrir externamente', err));
    } else {
      log.warn(`[window] navegación bloqueada: ${url}`);
    }
  };

  win.webContents.on('will-navigate', handle);

  // Un enlace con target="_blank" o `window.open` nunca abre una ventana
  // nueva de Electron (que heredaría los mismos privilegios): o se queda
  // en esta misma ventana (si es el panel) o sale al navegador del sistema.
  win.webContents.setWindowOpenHandler(({ url }) => {
    const decision = decideNavigation(url, panelOrigin);
    if (decision.action === 'open-external') {
      shell.openExternal(url).catch((err) => log.error('[window] no se pudo abrir externamente', err));
    } else if (decision.action === 'allow') {
      win.loadURL(url).catch(() => {});
    } else {
      log.warn(`[window] ventana nueva bloqueada: ${url}`);
    }
    return { action: 'deny' };
  });

  // Un <webview> le daría a esa página un proceso con las mismas
  // preferencias que el panel. No hay ningún uso legítimo de esto aquí.
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());

  win.webContents.on('did-fail-load', (_event, errorCode, _desc, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3 /* ERR_ABORTED: navegación cancelada a propósito */) return;
    log.warn(`[window] falló la carga de ${validatedURL} (${errorCode}); mostrando pantalla de espera`);
    win.loadFile(OFFLINE_HTML).catch(() => {});
    scheduleOfflineRetry(win);
  });

  win.webContents.on('did-finish-load', () => {
    const url = win.webContents.getURL();
    if (decideNavigation(url, panelOrigin).action === 'allow') clearOfflineRetry();
  });
}

/**
 * Guarda un crash pendiente para que lo reporte el PANEL, no el contenedor:
 * el proceso principal no tiene token de sesión (a propósito, ver
 * `docs/ESCRITORIO-NEGOCIOS.md`), así que no puede llamar él mismo a
 * `POST /telemetry/crash`. Al recargar, `business/src/lib/desktop.ts` lo
 * recoge y lo envía con la sesión que sí tiene.
 */
export function recordPendingCrashReport(
  message: string,
  extra: Record<string, unknown> = {},
  fatal = true
): void {
  setSetting('pendingCrashReport', {
    message,
    fatal,
    platform: 'windows-desktop',
    appVersion: app.getVersion(),
    at: new Date().toISOString(),
    extra,
  });
}

/** Cuánto se espera a que una pestaña congelada vuelva sola antes de darla por perdida. */
const UNRESPONSIVE_RELOAD_MS = 15_000;

function watchForCrashes(win: BrowserWindow): void {
  win.webContents.on('render-process-gone', (_event, details) => {
    log.error(`[window] el proceso de render terminó: ${details.reason}`);
    recordPendingCrashReport(`render-process-gone: ${details.reason}`, { exitCode: details.exitCode });
    win.loadURL(config.panelUrl).catch(() => {});
  });

  let unresponsiveTimer: ReturnType<typeof setTimeout> | null = null;
  win.webContents.on('unresponsive', () => {
    log.warn('[window] la ventana dejó de responder; esperando antes de recargar');
    unresponsiveTimer = setTimeout(() => {
      if (win.isDestroyed()) return;
      log.error('[window] siguió sin responder: recargando');
      recordPendingCrashReport('unresponsive', {});
      win.loadURL(config.panelUrl).catch(() => {});
    }, UNRESPONSIVE_RELOAD_MS);
  });
  win.webContents.on('responsive', () => {
    if (unresponsiveTimer) clearTimeout(unresponsiveTimer);
    unresponsiveTimer = null;
  });
}

export function createMainWindow(): BrowserWindow {
  hardenPermissions();

  const win = new BrowserWindow({
    show: false,
    fullscreen: true,
    backgroundColor: '#14120F', // Obsidiana: nunca un destello blanco al abrir.
    autoHideMenuBar: true,
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // El timbre tiene que seguir sonando con la ventana minimizada o
      // detrás de otro programa: es justo el problema que resuelve esta
      // app. Sin esto, Chromium frena los timers del panel en segundo
      // plano igual que en un navegador normal.
      backgroundThrottling: false,
      // Fuera de desarrollo no hay consola que abrir, ni con F12 ni con
      // Ctrl+Shift+I: nadie en el mostrador necesita las DevTools, y es
      // justo lo primero que probaría alguien buscando husmear la sesión.
      devTools: isDev,
      preload: path.join(__dirname, '..', 'preload.js'),
    },
  });

  // El backend etiqueta la sesión por esto (`parseUserAgent`, Fase 5 del
  // plan): "Zipp Negocios x.y.z · Windows" en vez de "Chrome · Windows".
  // Nunca se usa para que el PANEL decida nada — eso es `window.zippDesktop`.
  win.webContents.setUserAgent(`${win.webContents.getUserAgent()} ZippNegocios/${app.getVersion()}`);

  lockDownNavigation(win);
  watchForCrashes(win);

  win.once('ready-to-show', () => win.show());

  win.loadURL(config.panelUrl).catch((err) => {
    log.error('[window] fallo inicial cargando el panel', err);
  });

  win.on('closed', () => {
    mainWindow = null;
  });

  mainWindow = win;
  return win;
}

/** F11 y el menú de la bandeja alternan pantalla completa; nunca cierran la app. */
export function toggleFullscreen(): void {
  if (!mainWindow) return;
  mainWindow.setFullScreen(!mainWindow.isFullScreen());
}

export function showMainWindow(): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/**
 * Trae la ventana al frente para un pedido nuevo: restaurar, mostrar,
 * un instante por encima de todo y el parpadeo del icono en la barra de
 * tareas si Windows no deja pasar el foco (pasa con una app minimizada
 * hace rato).
 */
export function bringToFrontForAttention(): void {
  if (!mainWindow) return;
  showMainWindow();
  mainWindow.setAlwaysOnTop(true);
  mainWindow.focus();
  setTimeout(() => mainWindow?.setAlwaysOnTop(false), 1_500);
  if (!mainWindow.isFocused()) mainWindow.flashFrame(true);
}

app.on('browser-window-focus', () => mainWindow?.flashFrame(false));
