import { autoUpdater } from 'electron-updater';
import log from 'electron-log';
import https from 'node:https';
import { app } from 'electron';
import { config, isDev } from './config';
import { verifySignedManifest } from '../shared/manifest';
import { isQuietNow } from './ipc';
import { getMainWindow } from './window';
import { CHANNELS } from '../shared/channels';

/**
 * Las actualizaciones del contenedor (.exe). Dos verificaciones, no una:
 *
 * 1. `electron-updater` descarga y comprueba el instalador contra su
 *    propio `latest.yml` — eso ya lo hace la librería.
 * 2. Antes de instalar, se descarga además `release.json` + `release.json.sig`
 *    y se verifica con la llave pública Ed25519 incrustada en el build
 *    (`shared/manifest.ts`). Esa llave NUNCA sale del equipo donde se firmó
 *    una versión (`scripts/keygen.mjs`), así que un VPS comprometido no
 *    basta para empujar un instalador falso: tendría que falsear las dos
 *    cosas, y solo controla una.
 *
 * Nunca se instala sin pasar por la verificación de la firma, y nunca se
 * instala fuera de un "momento tranquilo" (`isQuietNow`, que refleja lo que
 * reportó el panel por `report-status`).
 */

let pollTimer: ReturnType<typeof setInterval> | null = null;
let pendingInstall = false;

function fetchText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} al pedir ${url}`));
          res.resume();
          return;
        }
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve(body));
      })
      .on('error', reject);
  });
}

function sendStatus(status: string, detail?: unknown): void {
  log.info(`[updater] ${status}`, detail ?? '');
  getMainWindow()?.webContents.send(CHANNELS.updateStatus, { status, detail });
}

/** Comprueba la firma contra el manifiesto publicado. No descarga el instalador: eso ya lo hizo electron-updater. */
async function verifyPublishedManifest(): Promise<boolean> {
  if (!config.updateFeedUrl || config.updatePublicKeys.length === 0) {
    log.warn('[updater] sin feed de actualizaciones configurado: se omite la verificación de firma');
    return false;
  }
  try {
    const [manifestJson, signatureBase64] = await Promise.all([
      fetchText(`${config.updateFeedUrl}/release.json`),
      fetchText(`${config.updateFeedUrl}/release.json.sig`),
    ]);
    const result = verifySignedManifest({
      manifestJson,
      signatureBase64: signatureBase64.trim(),
      publicKeyPem: config.updatePublicKeys,
      currentVersion: app.getVersion(),
    });
    if (!result.ok) {
      sendStatus('rejected', result.reason);
      return false;
    }
    return true;
  } catch (err) {
    log.error('[updater] no se pudo verificar el manifiesto firmado', err);
    return false;
  }
}

function installWhenQuiet(): void {
  if (!pendingInstall) return;
  if (!isQuietNow()) {
    sendStatus('waiting-for-quiet-moment');
    return;
  }
  sendStatus('installing');
  autoUpdater.quitAndInstall(true, true);
}

export function setupAutoUpdater(): void {
  if (isDev || !config.updateFeedUrl) {
    log.info('[updater] desactivado (desarrollo o sin feed configurado)');
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.setFeedURL({ provider: 'generic', url: config.updateFeedUrl });

  autoUpdater.on('update-available', (info) => sendStatus('downloading', info.version));
  autoUpdater.on('error', (err) => sendStatus('error', err.message));

  autoUpdater.on('update-downloaded', async () => {
    const verified = await verifyPublishedManifest();
    if (!verified) {
      log.error('[updater] el instalador se descargó pero la firma no verificó: no se instala');
      return;
    }
    pendingInstall = true;
    sendStatus('ready');
    installWhenQuiet();
  });

  // Cada vez que el panel reporta su estado (cada pocos segundos) se
  // reintenta instalar si había una actualización en espera de un momento
  // tranquilo.
  setInterval(installWhenQuiet, 30_000);

  checkForUpdatesNow();
  pollTimer = setInterval(checkForUpdatesNow, 4 * 60 * 60 * 1000);
}

export function checkForUpdatesNow(): void {
  if (isDev || !config.updateFeedUrl) return;
  autoUpdater.checkForUpdates().catch((err) => log.error('[updater] fallo al comprobar actualizaciones', err));
}

export function stopAutoUpdater(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}
