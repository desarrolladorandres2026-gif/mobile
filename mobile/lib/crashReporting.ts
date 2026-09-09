import { Platform } from 'react-native';
import Constants from 'expo-constants';
import api from '../services/api';
import { useAuthStore } from '../stores/authStore';
import { getDeviceId } from './deviceId';

/**
 * Reporte de errores.
 *
 * Hasta ahora no había ninguno: un crash en producción era invisible. El
 * usuario desinstalaba y no quedaba rastro, así que el equipo se enteraba
 * de sus peores fallos por WhatsApp o no se enteraba.
 *
 * Va contra el propio backend en vez de contra un tercero. La razón no es
 * ideológica: un servicio externo necesita una cuenta y una DSN que hoy no
 * existen, y dejar el hueco "pendiente de configurar" es exactamente cómo
 * se llegó a que las notificaciones push nunca funcionaran. Esto reporta
 * desde el primer arranque. Si algún día se añade Sentry, el sitio donde
 * enchufarlo es `send()` y nada más.
 */

export interface CrashContext {
  /** Dónde pasó: nombre de pantalla, hook o acción. */
  scope?: string;
  /**
   * El pedido implicado, si lo hay.
   *
   * Es el dato que más falta hace y el que nunca sobra: un crash en el
   * checkout sin saber qué pedido era no se puede reproducir.
   */
  orderId?: string;
  /** Cualquier cosa que ayude a reconstruir el caso. */
  extra?: Record<string, unknown>;
}

interface CrashPayload extends CrashContext {
  message: string;
  stack?: string;
  fatal: boolean;
  platform: string;
  appVersion: string;
  at: string;
}

/**
 * Errores ya enviados en esta sesión, por firma.
 *
 * Un error de render se repite en bucle mientras la pantalla siga montada:
 * sin esto, un solo fallo puede convertirse en miles de peticiones desde un
 * teléfono que ya está roto. La primera vez importa; la número mil no dice
 * nada nuevo.
 */
const seen = new Set<string>();

/** Tope duro por sesión, por si las firmas varían (mensajes con ids dentro). */
const MAX_PER_SESSION = 20;
let sent = 0;

function signatureOf(message: string, stack?: string): string {
  // Solo el primer marco: el resto varía entre versiones y haría que el
  // mismo fallo pareciera nuevo cada vez.
  const frame = stack?.split('\n')[1]?.trim() ?? '';
  return `${message}::${frame}`;
}

async function send(payload: CrashPayload): Promise<void> {
  // Sin sesión no se manda: el endpoint exige autenticación, y encolar
  // errores de gente que aún no ha entrado añadiría un almacén persistente
  // por muy poco a cambio.
  if (!useAuthStore.getState().accessToken) return;

  try {
    // El id del dispositivo se resuelve aquí y no al construir el reporte:
    // `getDeviceId` lee de almacenamiento y es asíncrono, y `reportError`
    // tiene que poder llamarse desde cualquier `catch` sin ser `await`.
    const deviceId = await getDeviceId();
    await api.post('/telemetry/crash', { ...payload, deviceId });
  } catch {
    // Un fallo al reportar un fallo no puede tumbar la app. Se pierde el
    // reporte y ya: insistir aquí es cómo se construye un bucle infinito.
  }
}

/**
 * Reporta un error. Nunca lanza.
 *
 * `fatal` distingue el error que dejó la pantalla en blanco del que se
 * capturó y siguió: los dos importan, pero solo uno es una emergencia.
 */
export function reportError(
  error: unknown,
  context: CrashContext = {},
  fatal = false
): void {
  try {
    if (sent >= MAX_PER_SESSION) return;

    const err = error instanceof Error ? error : new Error(String(error));
    const signature = signatureOf(err.message, err.stack);
    if (seen.has(signature)) return;
    seen.add(signature);
    sent += 1;

    const payload: CrashPayload = {
      message: err.message.slice(0, 500),
      stack: err.stack?.slice(0, 4000),
      fatal,
      platform: `${Platform.OS} ${Platform.Version}`,
      appVersion: Constants.expoConfig?.version ?? 'desconocida',
      at: new Date().toISOString(),
      ...context,
    };

    // Sin `await` a propósito: reportar no puede retrasar lo que el usuario
    // esté haciendo, y quien llama a esto suele estar en un `catch`.
    void send(payload);

    if (__DEV__) console.error(`[Crash${fatal ? ' FATAL' : ''}]`, err, context);
  } catch {
    // Ni el propio reporter puede ser la causa de un crash.
  }
}

/**
 * Engancha el manejador global de errores no capturados.
 *
 * `ErrorBoundary` solo ve lo que revienta durante el render. Un fallo en un
 * `setTimeout`, en un listener del socket o en una promesa suelta pasa de
 * largo, y son justo los que no dejan rastro en pantalla.
 */
export function installGlobalHandler(): void {
  const g = globalThis as any;
  if (g.__zippCrashHandlerInstalled) return;
  g.__zippCrashHandlerInstalled = true;

  const previous = g.ErrorUtils?.getGlobalHandler?.();

  g.ErrorUtils?.setGlobalHandler?.((error: unknown, isFatal?: boolean) => {
    reportError(error, { scope: 'global' }, !!isFatal);
    // Se respeta el manejador anterior: en desarrollo es el que pinta la
    // pantalla roja, y quitarla haría más difícil depurar, no menos.
    previous?.(error, isFatal);
  });
}
