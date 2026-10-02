/**
 * Los mensajes que el panel (proceso de render, sandboxeado) puede mandarle
 * al proceso principal por `window.zippDesktop`.
 *
 * El preload expone la API; el proceso principal es quien de verdad decide
 * si un mensaje vale, porque un XSS en el panel ejecuta JavaScript en el
 * render y puede llamar a `window.zippDesktop.*` con lo que quiera. Validar
 * aquí, en una función pura sin `electron`, es lo que permite probarlo con
 * `vitest` sin levantar una ventana.
 */

export type RingPattern = 'normal' | 'urgent';

export interface AttentionPayload {
  /** `null`: no hay nada esperando, para apagar la atención ya puesta. */
  pattern: RingPattern | null;
  count: number;
  orderNumber?: string;
}

export interface ReportStatusPayload {
  connection: 'online' | 'offline';
  session: 'active' | 'ended';
  storeOpen: boolean;
  /** Un "momento tranquilo" (`isQuietMoment`) en el que sí se puede reiniciar o actualizar. */
  quiet: boolean;
}

/** Ajustes que el contenedor recuerda entre arranques. Lista cerrada a propósito. */
export const SETTINGS_KEYS = ['launchAtLogin', 'printerName', 'paperWidthMm'] as const;
export type SettingKey = (typeof SETTINGS_KEYS)[number];

export interface SettingsGetPayload {
  key: SettingKey;
}

export interface SettingsSetPayload {
  key: SettingKey;
  value: string | number | boolean;
}

export type BridgeChannel =
  | 'attention'
  | 'report-status'
  | 'settings-get'
  | 'settings-set'
  | 'updates-check'
  | 'print-ticket';

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

function fail<T>(error: string): ValidationResult<T> {
  return { ok: false, error };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Entero no negativo, con un techo defensivo: un contador no tiene por qué pasar de unos pocos miles. */
function isSafeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 10_000;
}

export function validateAttention(payload: unknown): ValidationResult<AttentionPayload> {
  if (!isPlainObject(payload)) return fail('attention: el mensaje no es un objeto');
  const { pattern, count, orderNumber } = payload;
  if (pattern !== null && pattern !== 'normal' && pattern !== 'urgent') {
    return fail('attention: pattern inválido');
  }
  if (!isSafeCount(count)) return fail('attention: count inválido');
  if (orderNumber !== undefined && (typeof orderNumber !== 'string' || orderNumber.length > 40)) {
    return fail('attention: orderNumber inválido');
  }
  return { ok: true, value: { pattern, count, orderNumber } };
}

export function validateReportStatus(payload: unknown): ValidationResult<ReportStatusPayload> {
  if (!isPlainObject(payload)) return fail('report-status: el mensaje no es un objeto');
  const { connection, session, storeOpen, quiet } = payload;
  if (connection !== 'online' && connection !== 'offline') return fail('report-status: connection inválido');
  if (session !== 'active' && session !== 'ended') return fail('report-status: session inválido');
  if (typeof storeOpen !== 'boolean') return fail('report-status: storeOpen inválido');
  if (typeof quiet !== 'boolean') return fail('report-status: quiet inválido');
  return { ok: true, value: { connection, session, storeOpen, quiet } };
}

export function validateSettingsGet(payload: unknown): ValidationResult<SettingsGetPayload> {
  if (!isPlainObject(payload)) return fail('settings-get: el mensaje no es un objeto');
  const { key } = payload;
  if (typeof key !== 'string' || !SETTINGS_KEYS.includes(key as SettingKey)) {
    return fail('settings-get: key desconocida');
  }
  return { ok: true, value: { key: key as SettingKey } };
}

export function validateSettingsSet(payload: unknown): ValidationResult<SettingsSetPayload> {
  if (!isPlainObject(payload)) return fail('settings-set: el mensaje no es un objeto');
  const { key, value } = payload;
  if (typeof key !== 'string' || !SETTINGS_KEYS.includes(key as SettingKey)) {
    return fail('settings-set: key desconocida');
  }
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    return fail('settings-set: value inválido');
  }
  // Cada clave declara su propio tipo: una cadena en `launchAtLogin` no es
  // "casi booleano", es un mensaje mal formado.
  if (key === 'launchAtLogin' && typeof value !== 'boolean') return fail('settings-set: launchAtLogin debe ser booleano');
  if (key === 'printerName' && typeof value !== 'string') return fail('settings-set: printerName debe ser texto');
  if (key === 'paperWidthMm' && typeof value !== 'number') return fail('settings-set: paperWidthMm debe ser numérico');
  return { ok: true, value: { key: key as SettingKey, value } };
}
