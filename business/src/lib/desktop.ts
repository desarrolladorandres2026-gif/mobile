/**
 * Acceso tipado a `window.zippDesktop`, el puente que expone
 * `desktop/src/preload.ts` dentro de la app de escritorio Zipp Negocios.
 *
 * En el navegador normal `window.zippDesktop` no existe: cada función de
 * aquí comprueba su presencia y no hace nada si falta, así que todo el
 * panel puede llamarlas sin ramificar "¿estoy en escritorio?" en cada
 * sitio. Nunca se detecta por el user agent — el contenedor añade
 * `ZippNegocios/x.y.z` ahí solo para que el backend etiquete el
 * dispositivo (`parseUserAgent`), no para que el panel decida nada con eso.
 */

type RingPattern = 'normal' | 'urgent';

export interface AttentionPayload {
  pattern: RingPattern | null;
  count: number;
  orderNumber?: string;
}

export interface ReportStatusPayload {
  connection: 'online' | 'offline';
  session: 'active' | 'ended';
  storeOpen: boolean;
  quiet: boolean;
}

interface ZippDesktopApi {
  attention(payload: AttentionPayload): Promise<{ ok: boolean }>;
  reportStatus(payload: ReportStatusPayload): Promise<{ ok: boolean }>;
  settings: {
    get(key: string): Promise<{ ok: boolean; value?: unknown }>;
    set(key: string, value: string | number | boolean): Promise<{ ok: boolean }>;
  };
  updates: {
    checkNow(): Promise<{ ok: boolean }>;
    onStatus(callback: (status: { status: string; detail?: unknown }) => void): () => void;
  };
  printTicket(ticket: unknown): Promise<{ ok: boolean; error?: string }>;
  listPrinters(): Promise<{ ok: boolean; value?: DesktopPrinter[] }>;
  onNotificationClick(callback: (orderNumber: string) => void): () => void;
  onCloseStoreRequest(callback: () => Promise<void> | void): () => void;
  crashReport: {
    get(): Promise<{ ok: boolean; value?: DesktopCrashReport | null }>;
    clear(): Promise<{ ok: boolean }>;
  };
}

/** Lo que guardó `desktop/src/main/window.ts` cuando el render se cayó o se congeló. */
export interface DesktopCrashReport {
  message: string;
  fatal: boolean;
  platform: 'windows-desktop';
  appVersion: string;
  at: string;
  extra?: Record<string, unknown>;
}

export interface DesktopPrinter {
  name: string;
  displayName: string;
  isDefault: boolean;
}

declare global {
  interface Window {
    zippDesktop?: ZippDesktopApi;
  }
}

export function isDesktop(): boolean {
  return typeof window !== 'undefined' && !!window.zippDesktop;
}

/** No-op fuera de la app de escritorio: siempre seguro de llamar. */
export function desktopAttention(payload: AttentionPayload): void {
  window.zippDesktop?.attention(payload).catch(() => {});
}

export function desktopReportStatus(payload: ReportStatusPayload): void {
  window.zippDesktop?.reportStatus(payload).catch(() => {});
}

export function onDesktopNotificationClick(callback: (orderNumber: string) => void): () => void {
  return window.zippDesktop?.onNotificationClick(callback) ?? (() => {});
}

/**
 * El contenedor pide cerrar el negocio antes de salir ("Cerrar el negocio y
 * salir" de la bandeja). `onClose` hace el `PATCH .../open` real, con la
 * sesión que el proceso principal no tiene.
 */
export function onDesktopCloseStoreRequest(onClose: () => Promise<void> | void): () => void {
  return window.zippDesktop?.onCloseStoreRequest(onClose) ?? (() => {});
}

/** Ajustes de "Este equipo": impresora, ancho de papel, inicio automático. */
export const desktopSettings = {
  get: (key: string) => window.zippDesktop?.settings.get(key) ?? Promise.resolve({ ok: false }),
  set: (key: string, value: string | number | boolean) =>
    window.zippDesktop?.settings.set(key, value) ?? Promise.resolve({ ok: false }),
};

export async function listDesktopPrinters(): Promise<DesktopPrinter[]> {
  const result = await window.zippDesktop?.listPrinters();
  return result?.ok ? result.value ?? [] : [];
}

export async function printTicketOnDesktop(ticket: unknown): Promise<{ ok: boolean; error?: string }> {
  const result = await window.zippDesktop?.printTicket(ticket);
  return result ?? { ok: false, error: 'No es la app de escritorio' };
}

/**
 * El reporte de un crash que pasó ANTES de esta carga (el proceso principal
 * no tiene sesión para mandarlo él mismo). `clear()` se llama solo después
 * de que el POST a `/telemetry/crash` respondió bien — si la petición
 * falla, el reporte se queda para el próximo intento en vez de perderse.
 */
export async function takePendingDesktopCrashReport(): Promise<DesktopCrashReport | null> {
  const result = await window.zippDesktop?.crashReport.get();
  return result?.ok ? result.value ?? null : null;
}

export async function clearDesktopCrashReport(): Promise<void> {
  await window.zippDesktop?.crashReport.clear();
}
