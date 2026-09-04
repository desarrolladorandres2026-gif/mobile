import * as Location from 'expo-location';

/**
 * Cada cuánto pedirle una posición al GPS.
 *
 * Este archivo es el equilibrio entre tres cosas que tiran en direcciones
 * opuestas, y no hay una respuesta técnicamente "correcta": hay una
 * decisión de negocio.
 *
 * - **Precisión.** El cliente quiere ver al repartidor moverse de verdad.
 *   Con muestreo lento, el punto salta de esquina en esquina y la gente
 *   llama a soporte creyendo que la app se colgó.
 * - **Batería.** El GPS a máxima precisión es de lo más caro que puede
 *   hacer un teléfono. Un repartidor que termina el turno con el teléfono
 *   muerto no puede recibir el pedido siguiente — y probablemente culpe a
 *   Zipp, con razón.
 * - **Datos.** En Colombia muchos repartidores trabajan con planes
 *   prepago. Un punto cada dos segundos durante ocho horas son ~14.000
 *   peticiones al día; el mismo trabajo se puede hacer con una fracción.
 *
 * Lo que el servidor ya resuelve, y que **no** hay que duplicar aquí: si
 * llegan dos puntos demasiado seguidos o el repartidor no se ha movido,
 * `tracking.service.ts` los descarta. Ese filtro protege la base de
 * datos. Este archivo es otro problema: ahí el teléfono ya gastó la
 * batería pidiendo el fix. Lo único que ahorra batería es no pedirlo.
 */

export interface TrackingContext {
  /** Hay un pedido en curso ahora mismo. */
  hasActiveOrder: boolean;
  /** Velocidad en m/s del último fix. Null si no se sabe. */
  speedMps: number | null;
  /** Batería 0-100. Null si el dispositivo no lo reporta. */
  batteryLevel: number | null;
  /** El teléfono está cargando (soporte de moto). Null si no se sabe. */
  charging: boolean | null;
  /** La app está en primer plano. */
  foreground: boolean;
}

export interface SamplingPolicy {
  accuracy: Location.LocationAccuracy;
  /** Milisegundos mínimos entre fixes. */
  timeInterval: number;
  /** Metros de desplazamiento que fuerzan un fix, aunque no toque por tiempo. */
  distanceInterval: number;
}

/**
 * Traduce el contexto del repartidor a una configuración del GPS.
 *
 * ────────────────────────────────────────────────────────────────────
 *  TODO — ESTA ES LA DECISIÓN QUE TE TOCA A TI
 * ────────────────────────────────────────────────────────────────────
 *
 * Ahora mismo devuelve una política plana: la misma frecuencia siempre,
 * pase lo que pase. Funciona, pero desperdicia batería cuando no hace
 * falta y va lenta cuando sí.
 *
 * Los ejes que puedes usar, y lo que cada uno significa en la calle:
 *
 * - `hasActiveOrder` — el eje más rentable. Un repartidor conectado sin
 *   pedido solo necesita estar localizable para que se le asigne uno
 *   cercano; nadie está mirando su punto en una pantalla. Con un pedido
 *   encima, un cliente lo está mirando literalmente en tiempo real.
 *
 * - `speedMps` — parado en un semáforo o esperando en el restaurante, más
 *   fixes no aportan información nueva. A 40 km/h recorre 11 metros por
 *   segundo y el punto se queda atrás enseguida. (Referencia: 1.4 m/s
 *   caminando, 8 m/s en moto por ciudad, 14 m/s en avenida.)
 *
 * - `batteryLevel` / `charging` — por debajo del 15% conviene proteger el
 *   teléfono: sin batería no hay repartidor. Si está cargando en el
 *   soporte de la moto, el consumo deja de ser un problema.
 *
 * - `foreground` — con la app abierta el repartidor está mirando su
 *   propia ruta y espera fluidez. En segundo plano, Android e iOS van a
 *   agrupar y retrasar las entregas de todas formas.
 *
 * Valores de `accuracy` disponibles, de más caro a más barato:
 *   `BestForNavigation` › `High` › `Balanced` (~100 m) › `Low` (~1 km)
 *
 * Guía: `timeInterval` entre 3.000 y 30.000 ms cubre todos los casos
 * razonables; `distanceInterval` entre 10 y 100 m. El servidor de todas
 * formas no acepta más de un punto cada `TRACKING_MIN_PERSIST_MS` (5 s
 * por defecto), así que bajar de ahí gasta batería sin ganar nada.
 *
 * Escribe el cuerpo con tu criterio de operación — tú sabes cómo se
 * comportan tus repartidores mejor que yo.
 */
export function samplingPolicy(context: TrackingContext): SamplingPolicy {
  // ── Política provisional: la misma frecuencia siempre. ──
  // Es deliberadamente conservadora para no vaciar baterías mientras la
  // versión buena no exista. Reemplázala.
  return {
    accuracy: context.hasActiveOrder
      ? Location.LocationAccuracy.High
      : Location.LocationAccuracy.Balanced,
    timeInterval: context.hasActiveOrder ? 8000 : 25000,
    distanceInterval: context.hasActiveOrder ? 20 : 80,
  };
}

/**
 * Si dos políticas son la misma.
 *
 * Reconfigurar el GPS obliga a detener y rearrancar la tarea de fondo, y
 * ese ciclo pierde el primer fix. Sin esta comparación, cada render que
 * produjera una política idéntica reiniciaría el seguimiento y el
 * repartidor parpadearía en el mapa constantemente.
 */
export function samePolicy(a: SamplingPolicy | null, b: SamplingPolicy): boolean {
  if (!a) return false;
  return (
    a.accuracy === b.accuracy &&
    a.timeInterval === b.timeInterval &&
    a.distanceInterval === b.distanceInterval
  );
}
