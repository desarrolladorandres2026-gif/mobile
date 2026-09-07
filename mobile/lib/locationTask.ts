import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { trackingApi } from '../services/endpoints';
import { socketService } from '../services/socket';
import { batteryLevelPercent } from './battery';

/**
 * Seguimiento del repartidor con la app en segundo plano.
 *
 * El nombre de la tarea es una constante compartida entre quien la define
 * y quien la arranca: si se escriben dos cadenas distintas, la tarea se
 * registra pero nunca se dispara, y el fallo es silencioso — el repartidor
 * simplemente desaparece del mapa al bloquear el teléfono y nadie ve un
 * error en ninguna consola.
 */
export const DRIVER_LOCATION_TASK = 'zipp-driver-location';

/**
 * Envía una posición por el canal que esté disponible.
 *
 * El socket es preferible: no paga cabeceras HTTP ni un handshake TLS por
 * cada punto, y en un turno de ocho horas esa diferencia es real en la
 * factura de datos del repartidor.
 *
 * Pero en segundo plano el socket a menudo no existe. Android congela la
 * app y cierra sus conexiones; la tarea se despierta unos segundos para
 * entregar la posición y se vuelve a dormir. Ahí la única vía es una
 * petición HTTP corta, que es exactamente lo que el sistema operativo
 * permite hacer en esa ventana.
 */
export async function reportPosition(payload: {
  lat: number;
  lng: number;
  accuracy?: number;
  heading?: number;
  speed?: number;
  batteryLevel?: number;
  isMocked?: boolean;
  recordedAt?: string;
}): Promise<void> {
  if (socketService.isConnected()) {
    socketService.emitDriverLocation(payload);
    return;
  }

  try {
    await trackingApi.ping(payload);
  } catch {
    // Una posición perdida no se reintenta: para cuando el reintento
    // llegara, ya habría una posición más nueva en camino. Insistir solo
    // gastaría batería y datos para entregar un dato caducado.
  }
}

/**
 * La tarea que el sistema operativo despierta con posiciones nuevas.
 *
 * `defineTask` tiene que ejecutarse en el ámbito del módulo y el módulo
 * tiene que importarse al arrancar la app —no dentro de un componente—
 * porque el sistema puede lanzar la app *directamente en esta tarea*, sin
 * pasar por ninguna pantalla. Si la definición vive dentro de un
 * `useEffect`, en ese arranque la tarea no existe y Expo registra un error
 * de tarea desconocida.
 */
TaskManager.defineTask(DRIVER_LOCATION_TASK, async ({ data, error }) => {
  if (error) {
    if (__DEV__) console.log('[Ubicación] Error en tarea de fondo:', error.message);
    return;
  }

  const locations = (data as { locations?: Location.LocationObject[] })?.locations ?? [];
  if (locations.length === 0) return;

  // El sistema entrega lotes: mientras la app dormía puede haber
  // acumulado varias posiciones. Solo interesa la última — las
  // intermedias describen dónde estuvo hace un minuto, y el servidor ya
  // habría descartado casi todas por frecuencia.
  const latest = locations[locations.length - 1];
  const battery = await batteryLevelPercent();

  await reportPosition({
    lat: latest.coords.latitude,
    lng: latest.coords.longitude,
    accuracy: latest.coords.accuracy ?? undefined,
    heading: latest.coords.heading ?? undefined,
    speed: latest.coords.speed != null && latest.coords.speed >= 0 ? latest.coords.speed : undefined,
    batteryLevel: battery ?? undefined,
    isMocked: (latest as { mocked?: boolean }).mocked ?? undefined,
    recordedAt: new Date(latest.timestamp).toISOString(),
  });
});

/** Si la tarea de fondo está corriendo ahora mismo. */
export async function isBackgroundTrackingActive(): Promise<boolean> {
  try {
    return await Location.hasStartedLocationUpdatesAsync(DRIVER_LOCATION_TASK);
  } catch {
    return false;
  }
}

export interface BackgroundTrackingOptions {
  accuracy: Location.LocationAccuracy;
  timeInterval: number;
  distanceInterval: number;
}

/**
 * Arranca (o reconfigura) el seguimiento en segundo plano.
 *
 * Llamarla con la tarea ya corriendo la detiene y la vuelve a arrancar:
 * `startLocationUpdatesAsync` no reconfigura una tarea viva, y sin el
 * `stop` previo los parámetros nuevos se ignoran en silencio — el
 * muestreo adaptativo parecería funcionar y en realidad se quedaría con
 * los primeros valores para siempre.
 */
export async function startBackgroundTracking(
  options: BackgroundTrackingOptions
): Promise<boolean> {
  try {
    if (await isBackgroundTrackingActive()) {
      await Location.stopLocationUpdatesAsync(DRIVER_LOCATION_TASK);
    }

    await Location.startLocationUpdatesAsync(DRIVER_LOCATION_TASK, {
      accuracy: options.accuracy,
      timeInterval: options.timeInterval,
      distanceInterval: options.distanceInterval,

      // Android exige una notificación permanente para rastrear en
      // segundo plano, y es una exigencia sensata: una app que sabe dónde
      // estás con la pantalla apagada tiene que decirlo. El texto explica
      // por qué está ahí, en vez del genérico del sistema.
      foregroundService: {
        notificationTitle: 'Zipp está en servicio',
        notificationBody: 'Compartiendo tu ubicación para asignarte pedidos cercanos.',
        notificationColor: '#141A2E',
      },

      // iOS: no dejar que el sistema pause las actualizaciones por su
      // cuenta. Las pausa cuando cree que el usuario dejó de moverse, y
      // reanudarlas exige movimiento significativo — un repartidor
      // esperando en la puerta de un restaurante desaparecería del mapa
      // justo en el momento en que el cliente más está mirando.
      pausesUpdatesAutomatically: false,
      activityType: Location.LocationActivityType.AutomotiveNavigation,
      showsBackgroundLocationIndicator: true,
    });

    return true;
  } catch (err) {
    if (__DEV__) console.log('[Ubicación] No se pudo iniciar el seguimiento:', err);
    return false;
  }
}

/** Detiene el seguimiento en segundo plano y quita la notificación. */
export async function stopBackgroundTracking(): Promise<void> {
  try {
    if (await isBackgroundTrackingActive()) {
      await Location.stopLocationUpdatesAsync(DRIVER_LOCATION_TASK);
    }
  } catch {
    // Si ya estaba detenida, no hay nada que hacer.
  }
}
