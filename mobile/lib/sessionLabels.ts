import type { ActiveSession } from '../services/endpoints';

/**
 * El nombre que la gente reconoce: "Samsung SM-A515F · Android".
 *
 * La app manda `Zipp/1.0 (Android 14; SM-A515F)` (ver `services/api.ts`) y de
 * ahí sale el modelo. Las sesiones abiertas antes de ese cambio traen el
 * agente de la librería de red y solo se sabe el sistema, si acaso.
 */
export function describeSession(s: Pick<ActiveSession, 'deviceInfo' | 'userAgent'>): string {
  const model = s.userAgent?.match(/^Zipp\/[^(]*\([^;]*;\s*([^)]+)\)/)?.[1]?.trim();
  const os = s.deviceInfo?.os && s.deviceInfo.os !== 'unknown' ? s.deviceInfo.os : undefined;
  if (model && os) return `${model} · ${os}`;
  if (model) return model;
  if (os) return `Teléfono ${os}`;
  if (s.deviceInfo?.browser && s.deviceInfo.browser !== 'unknown') return `Navegador ${s.deviceInfo.browser}`;
  return 'Dispositivo sin identificar';
}

/** "Activa ahora", "hace 3 h", "hace 2 días", "el 4 sep". */
export function lastSeen(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return '';
  const minutes = Math.round((now - new Date(iso).getTime()) / 60_000);
  if (minutes < 5) return 'Activa ahora';
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `hace ${days} ${days === 1 ? 'día' : 'días'}`;
  return `el ${new Date(iso).toLocaleDateString('es-CO', { day: 'numeric', month: 'short' })}`;
}
