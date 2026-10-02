import https from 'node:https';
import http from 'node:http';
import { app } from 'electron';
import log from 'electron-log';
import { config, isDev } from './config';
import { isNewerVersion } from '../shared/manifest';
import { checkForUpdatesNow } from './updater';

/**
 * El interruptor de emergencia de `GET /app/version?app=business-desktop`
 * (`backend/src/routes/appConfig.routes.ts`): si este contenedor queda por
 * debajo de la versión mínima, fuerza una comprobación de actualización ya
 * mismo en vez de esperar al ciclo de 4 horas.
 *
 * El contenedor normalmente ya se actualiza solo (`updater.ts`): esto es
 * para el día en que esa vía falle silenciosamente y una versión vieja con
 * un fallo conocido siga corriendo en el mostrador de un comercio sin que
 * nadie lo note. Mismo patrón que `VersionGate` en mobile, sin bloquear la
 * ventana — aquí no hay una pantalla propia que mostrar, el panel sigue
 * usándose mientras la actualización llega.
 */

interface VersionResponse {
  minSupported?: string;
}

function fetchJson(url: string): Promise<VersionResponse | null> {
  return new Promise((resolve) => {
    const client = url.startsWith('https:') ? https : http;
    const req = client.get(url, { timeout: 10_000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve(null);
        return;
      }
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          resolve(parsed?.data ?? null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => req.destroy());
  });
}

export async function checkMinVersion(): Promise<void> {
  if (isDev) return;
  const data = await fetchJson(`${config.apiUrl}/app/version?app=business-desktop`);
  if (!data?.minSupported) return;

  if (isNewerVersion(data.minSupported, app.getVersion())) {
    log.warn(
      `[min-version] esta versión (${app.getVersion()}) quedó por debajo de la mínima soportada (${data.minSupported}); forzando la comprobación de actualización`
    );
    checkForUpdatesNow();
  }
}

let pollTimer: ReturnType<typeof setInterval> | null = null;

/** Al arrancar y cada hora — más seguido que el ciclo normal de actualización, porque esto es la palanca de emergencia. */
export function startMinVersionGate(): void {
  if (isDev) return;
  checkMinVersion().catch((err) => log.error('[min-version] fallo al comprobar', err));
  pollTimer = setInterval(() => {
    checkMinVersion().catch((err) => log.error('[min-version] fallo al comprobar', err));
  }, 60 * 60_000);
  pollTimer.unref?.();
}

export function stopMinVersionGate(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}
