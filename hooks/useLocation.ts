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
 * Requests the device position once, on demand.
 *
 * Saving an address without real coordinates used to fall back to the
 * centre of Garzón, which produced orders pointing at the wrong place and
 * a delivery fee for a distance nobody was travelling. Callers must get a
 * real position (or let the user place the pin) before saving.
 *
 * Returns null when permission is denied or the fix fails; it never
 * invents a location.
 */
export async function captureCurrentPosition(): Promise<CapturedPosition | null> {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') return null;

    const loc = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.High,
    });

    return {
      latitude: loc.coords.latitude,
      longitude: loc.coords.longitude,
      accuracy: loc.coords.accuracy ?? null,
    };
  } catch {
    return null;
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
