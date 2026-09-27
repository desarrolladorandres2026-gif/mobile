/**
 * Identificador de este navegador para el centro de seguridad.
 *
 * Es un UUID v4 aleatorio que se genera la primera vez y se guarda aquí; no
 * sale de ninguna huella del equipo (nada de canvas, fuentes, MAC ni IMEI).
 * Sirve para que el servidor distinga "tu computador de siempre" de "un
 * dispositivo nuevo" y para que el admin pueda cerrar la sesión de uno
 * concreto. Sobrevive a cerrar sesión: es del navegador, no de la cuenta.
 *
 * Si el almacenamiento está bloqueado (modo privado estricto) se usa uno en
 * memoria: cada recarga contará como dispositivo nuevo, que es lo seguro.
 */

const STORAGE_KEY = 'zipp_device_id';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let memo: string | null = null;

/** `crypto.randomUUID` solo existe en contextos seguros (https, localhost); por IP de la red local no. */
function newDeviceId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function getDeviceId(): string {
  if (memo) return memo;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && UUID_V4.test(stored)) return (memo = stored);
  } catch {
    // Almacenamiento bloqueado: se sigue con uno en memoria.
  }
  memo = newDeviceId();
  try {
    localStorage.setItem(STORAGE_KEY, memo);
  } catch {
    // Igual que arriba.
  }
  return memo;
}

/** Cabecera que el backend lee en el login, el reto 2FA y el refresco. */
export const deviceHeaders = () => ({ 'X-Device-ID': getDeviceId() });
