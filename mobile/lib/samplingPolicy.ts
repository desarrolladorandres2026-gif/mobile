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
 * La política se lee de arriba abajo y la primera regla que aplica gana,
 * porque las tres preocupaciones no pesan lo mismo: la batería es una
 * restricción, la precisión es un objetivo, y una restricción siempre va
 * antes que un objetivo.
 *
 *  1. **Batería crítica y sin cargador.** Se degrada todo, aunque haya un
 *     pedido encima y un cliente mirando el mapa. Un punto que se
 *     actualiza cada quince segundos es peor que uno cada cinco; un
 *     teléfono apagado a mitad de reparto es peor que las dos cosas, y
 *     además se lleva por delante el chat, la foto de la entrega y el
 *     código del cliente.
 *
 *  2. **Sin pedido en curso.** Nadie está mirando ese punto: solo hace
 *     falta para asignarle el pedido más cercano cuando entre uno, y para
 *     eso sobra con saber en qué barrio está. Es el ahorro más grande de
 *     todos y el que menos cuesta, porque es la mayor parte de un turno.
 *
 *  3. **Con pedido, según lo que esté haciendo.** Parado en un semáforo o
 *     esperando en el mostrador, más fixes no traen información nueva: se
 *     espacia el tiempo pero se deja el umbral de distancia muy corto,
 *     así que en cuanto vuelve a moverse el mapa reacciona de inmediato
 *     sin haber estado quemando GPS mientras tanto. En avenida a 50 km/h
 *     recorre catorce metros por segundo y el punto se queda atrás
 *     enseguida, así que ahí es donde se gasta de verdad.
 *
 * `charging` levanta el freno de la batería: en el soporte de la moto el
 * consumo deja de ser el problema. Y en segundo plano se relaja un
 * escalón, porque Android e iOS van a agrupar las entregas de todas
 * formas: pedir más deprisa solo gasta, no acelera nada.
 *
 * Nunca se baja de `MIN_INTERVAL_MS`: el servidor descarta los puntos que
 * llegan antes de `TRACKING_MIN_PERSIST_MS`, así que pedirlos más rápido
 * gasta batería para producir puntos que se tiran.
 */

/** Por debajo de esto el servidor descarta el punto: pedirlo es gastar por nada. */
const MIN_INTERVAL_MS = 5_000;

/** Menos de 1 m/s es estar parado: un semáforo, una fila, el mostrador. */
const STOPPED_MPS = 1;

/** Por encima de esto va en avenida y el punto se queda atrás enseguida. */
const FAST_MPS = 10;

/** Sin cargador y por debajo de esto, proteger el teléfono es la prioridad. */
const LOW_BATTERY_PCT = 15;

export function samplingPolicy(context: TrackingContext): SamplingPolicy {
  const { hasActiveOrder, speedMps, batteryLevel, charging, foreground } = context;

  // En segundo plano el sistema agrupa y retrasa las entregas de todas
  // formas. Pedir más deprisa no adelanta nada: solo enciende el GPS más
  // veces para que el resultado espere en una cola.
  const relax = foreground ? 1 : 1.5;

  const build = (
    accuracy: Location.LocationAccuracy,
    timeInterval: number,
    distanceInterval: number
  ): SamplingPolicy => ({
    accuracy,
    timeInterval: Math.max(MIN_INTERVAL_MS, Math.round(timeInterval * relax)),
    distanceInterval,
  });

  // ── 1. Batería crítica ──
  // `charging` a `null` significa "no se sabe", y ante la duda se protege
  // el teléfono: equivocarse hacia el ahorro cuesta un mapa menos fluido;
  // equivocarse hacia el gasto cuesta un repartidor tirado.
  const bateriaCritica =
    batteryLevel !== null && batteryLevel <= LOW_BATTERY_PCT && charging !== true;

  if (bateriaCritica) {
    return hasActiveOrder
      ? // Con pedido encima no se apaga el seguimiento —el cliente sigue
        // esperando— pero se abarata todo lo que se puede sin perderlo.
        build(Location.LocationAccuracy.Balanced, 15_000, 60)
      : build(Location.LocationAccuracy.Low, 30_000, 100);
  }

  // ── 2. Sin pedido en curso ──
  // Localizable, no vigilado. Es la mayor parte del turno y el ahorro más
  // barato que existe.
  if (!hasActiveOrder) {
    return build(Location.LocationAccuracy.Balanced, 25_000, 80);
  }

  // ── 3. Con pedido, según el movimiento ──
  const velocidad = speedMps ?? 0;

  if (speedMps !== null && velocidad < STOPPED_MPS) {
    // Parado. Se espacia el tiempo pero el umbral de distancia se queda
    // corto: es lo que hace que arrancar se note en el mapa al instante
    // sin haber gastado GPS mientras no pasaba nada.
    return build(Location.LocationAccuracy.Balanced, 15_000, 15);
  }

  if (velocidad >= FAST_MPS) {
    // En avenida. Aquí es donde la precisión se paga y donde vale la pena
    // pagarla: a esta velocidad un fix tardío deja el punto una cuadra
    // atrás.
    return build(Location.LocationAccuracy.BestForNavigation, MIN_INTERVAL_MS, 20);
  }

  // Circulando por ciudad: el caso normal de un reparto.
  return build(Location.LocationAccuracy.High, 8_000, 25);
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
