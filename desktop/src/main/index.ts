import { app } from 'electron';
import log from 'electron-log';
import { config, isDev } from './config';
import { createMainWindow, getMainWindow } from './window';
import { buildTray, maybeShowHideNotice } from './tray';
import { registerIpcHandlers } from './ipc';
import { startPowerSaveBlocker, stopPowerSaveBlocker } from './power';
import { setAutoStart, isAutoStartEnabled } from './autostart';
import { setupAutoUpdater, stopAutoUpdater } from './updater';
import { startMinVersionGate, stopMinVersionGate } from './minVersionGate';
import { getSetting, setSetting } from './store';

log.transports.file.level = 'info';

// El timbre tiene que seguir sonando con la ventana minimizada o detrás de
// otro programa: estos flags van ANTES de `app.whenReady()` porque Chromium
// los lee al arrancar el motor, no después.
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Necesario para que las notificaciones de Windows muestren el nombre y el
// icono de la app en vez de "Electron".
app.setAppUserModelId(config.appId);

/**
 * Una sola instancia. Abrir el instalador o un acceso directo dos veces no
 * debe sonar el timbre por duplicado ni abrir dos ventanas compitiendo por
 * la pantalla completa: la segunda apertura simplemente enfoca la primera.
 */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = getMainWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    const win = createMainWindow();

    // La X oculta la ventana en vez de cerrar la app: es la base del resto
    // del comportamiento de bandeja. El "Salir" real (tray.ts) usa
    // `app.exit()`, que termina el proceso sin pasar por este evento —
    // así que no hace falta distinguir aquí "la X" de "Salir de verdad".
    win.on('close', (event) => {
      event.preventDefault();
      win.hide();
      maybeShowHideNotice();
    });

    buildTray();
    registerIpcHandlers();
    startPowerSaveBlocker();
    setupAutoUpdater();
    startMinVersionGate();

    // Primera vez: se enciende el inicio automático por defecto, salvo que
    // la persona ya lo haya decidido explícitamente desde la bandeja.
    if (getSetting('launchAtLogin', null) === null) {
      setSetting('launchAtLogin', true);
      setAutoStart(true);
    } else if (!isDev) {
      setAutoStart(getSetting('launchAtLogin', true));
    }

    log.info(`[app] Zipp Negocios ${app.getVersion()} — panel: ${config.panelUrl}`);
  });

  app.on('before-quit', () => {
    stopPowerSaveBlocker();
    stopAutoUpdater();
    stopMinVersionGate();
  });

  // No hay manejador de `window-all-closed` a propósito: la única ventana
  // nunca llega a cerrarse sola (su `close` se intercepta arriba), así que
  // Electron no tiene ese evento del que "salirse por defecto". La única
  // salida real es `app.exit()` desde el menú de bandeja (tray.ts).
}
