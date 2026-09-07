import { useState, useEffect, useRef } from 'react';
import * as Location from 'expo-location';
import { Alert } from 'react-native';

interface LocationState {
  latitude: number;
  longitude: number;
  heading?: number | null;
}

export interface CapturedPosition {
  latitude: number;
  longitude: number;
  accuracy: number | null;
}

/**
 * Por qué no se pudo leer la ubicación.
 *
 * Cada motivo se arregla de una forma distinta —dar permiso, encender el
 * GPS, salir a la ventana— así que colapsarlos todos en `null` obliga a
 * mostrar un mensaje genérico que no dice qué hacer. Se distinguen aquí
 * para que la pantalla pueda dar la instrucción concreta.
 */
export type LocationFailure = 'permission' | 'disabled' | 'timeout' | 'unknown';

export type LocationResult =
  | {
      ok: true;
      position: CapturedPosition;
      /**
       * La posición viene del caché del sistema, no de un fix nuevo.
       *
       * Puede estar a varias cuadras. Quien la reciba tiene que decirlo y
       * dejar corregir el punto, no guardarla como si fuera exacta.
       */
      approximate: boolean;
    }
  | { ok: false; reason: LocationFailure };

/** Cuánto se espera un fix nuevo antes de conformarse con el caché. */
const FIX_TIMEOUT_MS = 12000;

/** Un caché de más de cinco minutos ya no describe dónde está el teléfono. */
const LAST_KNOWN_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Pide la posición del dispositivo, una vez, bajo demanda.
 *
 * Guardar una dirección sin coordenadas reales terminaba cayendo al centro
 * de la ciudad, lo que producía pedidos apuntando al lugar equivocado y un
 * costo de envío por una distancia que nadie recorría. Nunca inventa una
 * ubicación: o entrega uno de verdad, o dice por qué no pudo.
 *
 * El `timeout` explícito no es defensivo de más. `getCurrentPositionAsync`
 * con precisión alta no trae límite propio en Android: si el chip no logra
 * fijar satélites —bajo techo, primera vez en el día, dentro de un local—
 * la promesa se queda pendiente para siempre y quien la esperaba se queda
 * con el botón girando sin fin. Vencido el plazo se recurre a la última
 * posición conocida del sistema, marcada como aproximada.
 */
export async function captureCurrentPosition(
  options: { timeoutMs?: number } = {}
): Promise<LocationResult> {
  const timeoutMs = options.timeoutMs ?? FIX_TIMEOUT_MS;
  try {
    // Se pregunta por el servicio antes que por el permiso: con el GPS
    // apagado, conceder el permiso no arregla nada y el usuario habría
    // aceptado un diálogo para seguir sin ubicación igualmente.
    const servicesOn = await Location.hasServicesEnabledAsync();
    if (!servicesOn) return { ok: false, reason: 'disabled' };

    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') return { ok: false, reason: 'permission' };

    const fix = await withTimeout(
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
      timeoutMs
    );

    if (fix) return { ok: true, position: toCaptured(fix), approximate: false };

    const cached = await Location.getLastKnownPositionAsync({
      maxAge: LAST_KNOWN_MAX_AGE_MS,
    });
    if (cached) return { ok: true, position: toCaptured(cached), approximate: true };

    return { ok: false, reason: 'timeout' };
  } catch {
    return { ok: false, reason: 'unknown' };
  }
}

function toCaptured(loc: Location.LocationObject): CapturedPosition {
  return {
    latitude: loc.coords.latitude,
    longitude: loc.coords.longitude,
    accuracy: loc.coords.accuracy ?? null,
  };
}

/**
 * Resuelve a `null` si la promesa tarda demasiado.
 *
 * La promesa perdedora se deja correr: `expo-location` no expone forma de
 * cancelar una petición en vuelo, y su resultado tardío no le hace daño a
 * nadie porque ya nadie lo está esperando.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    promise.catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

/**
 * Posición para adjuntar como evidencia, o nada.
 *
 * En los pasos del repartidor la coordenada es un dato de apoyo: la foto y
 * el código son la prueba, y el punto solo registra desde dónde se hizo.
 * Nada de eso puede quedarse esperando al GPS, así que aquí sí se colapsa
 * el motivo del fallo —no hay nada que el repartidor pueda hacer con esa
 * distinción con el pedido en la mano— y el plazo es corto.
 */
export async function captureCoordsForEvidence(): Promise<CapturedPosition | null> {
  const result = await captureCurrentPosition({ timeoutMs: 4000 });
  return result.ok ? result.position : null;
}

/** Texto accionable para cada motivo de fallo. */
export function locationFailureMessage(reason: LocationFailure): string {
  switch (reason) {
    case 'permission':
      return 'Zipp necesita permiso de ubicación. Actívalo en los ajustes del teléfono y vuelve a intentar.';
    case 'disabled':
      return 'La ubicación del teléfono está apagada. Enciéndela y vuelve a intentar.';
    case 'timeout':
      return 'No conseguimos señal de GPS. Acércate a una ventana, o mueve el mapa hasta tu casa y ponlo tú.';
    default:
      return 'No pudimos leer tu ubicación. Mueve el mapa hasta tu casa y pon el punto tú.';
  }
}

export function useLocation(watchPosition = false) {
  const [location, setLocation] = useState<LocationState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const watchRef = useRef<Location.LocationSubscription | null>(null);

  useEffect(() => {
    let isMounted = true;

    const getPermissionAndLocation = async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') {
          setError('Permiso de ubicación denegado');
          setLoading(false);
          Alert.alert(
            'Ubicación requerida',
            'ZIPP necesita acceso a tu ubicación para mostrar negocios cercanos.',
            [{ text: 'OK' }]
          );
          return;
        }

        if (watchPosition) {
          watchRef.current = await Location.watchPositionAsync(
            {
              accuracy: Location.Accuracy.High,
              timeInterval: 5000,
              distanceInterval: 10,
            },
            (loc) => {
              if (isMounted) {
                setLocation({
                  latitude: loc.coords.latitude,
                  longitude: loc.coords.longitude,
                  heading: loc.coords.heading,
                });
                setLoading(false);
              }
            }
          );
        } else {
          const loc = await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Balanced,
          });
          if (isMounted) {
            setLocation({
              latitude: loc.coords.latitude,
              longitude: loc.coords.longitude,
            });
            setLoading(false);
          }
        }
      } catch (err: any) {
        if (isMounted) {
          setError(err.message || 'Error obteniendo ubicación');
          setLoading(false);
        }
      }
    };

    getPermissionAndLocation();

    return () => {
      isMounted = false;
      watchRef.current?.remove();
    };
  }, [watchPosition]);

  return { location, loading, error };
}
