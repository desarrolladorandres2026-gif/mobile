import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { Text, Icon, Button, Card, Badge } from '../ui';
import { ZippMap } from './ZippMap';
import { useTheme } from '../../hooks/useTheme';
import { useDriverTrackingContext } from '../../hooks/useDriverTracking';
import { formatEta } from '../../hooks/useOrderTracking';
import { socketService } from '../../services/socket';
import { trackingApi } from '../../services/endpoints';
import { distanceToRoute } from '../../lib/geo';
import { tap } from '../../lib/haptics';
import { Spacing } from '../../theme/tokens';
import type { MapMarker, MapRoute } from '../../lib/mapbox';

/**
 * Cuántos metros fuera del trazado cuentan como desvío.
 *
 * 80 m es aproximadamente una manzana. Más abajo y el ruido del GPS en
 * una calle con edificios altos dispararía recálculos constantes; más
 * arriba y el repartidor ya está en otra avenida antes de que la app se
 * entere.
 */
const OFF_ROUTE_METERS = 80;

/**
 * Cuánto tiene que llevar desviado antes de recalcular.
 *
 * Sin esta espera, un solo fix malo —de los que el GPS lanza al pasar bajo
 * un puente— provocaría un recálculo completo. Exigir que el desvío
 * persista tres lecturas convierte un error del sensor en lo que es:
 * ruido, no un cambio de ruta.
 */
const OFF_ROUTE_CONFIRMATIONS = 3;

export interface DriverRouteCardProps {
  orderId: string;
  /** Cambia con la etapa del pedido: al cambiar, se pide ruta nueva. */
  status: string;
}

interface RouteData {
  phase: 'to_business' | 'to_client' | 'idle';
  targetLabel: string;
  targetAddress: string;
  to: { lat: number; lng: number };
  route: {
    geometry: MapRoute;
    distanceMeters: number;
    durationSeconds: number;
    source: 'mapbox' | 'estimate';
  };
}

/**
 * Ruta óptima del repartidor, con recálculo al desviarse.
 *
 * El recálculo se decide en el teléfono y no en el servidor a propósito.
 * El servidor solo ve los puntos que sobreviven a su filtro —uno cada
 * cinco segundos como mucho— mientras que aquí llegan todos los fixes del
 * GPS. Detectar un desvío es exactamente el caso donde importa reaccionar
 * a la primera lectura buena y no a la que se salvó del filtro.
 */
export function DriverRouteCard({ orderId, status }: DriverRouteCardProps) {
  const { c } = useTheme();
  const { position } = useDriverTrackingContext();

  const [data, setData] = useState<RouteData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offRoute, setOffRoute] = useState(false);
  const offRouteCount = useRef(0);

  const fetchRoute = useCallback(
    async (reason: 'initial' | 'recalculate') => {
      setLoading(true);
      setError(null);
      try {
        // La posición actual va en la petición: sin ella el servidor rutea
        // desde el último punto que le llegó, que en un recálculo es justo
        // el que ya no sirve.
        const from = position ? { lat: position.lat, lng: position.lng } : undefined;
        const result = (await trackingApi.getRoute(orderId, from)) as RouteData;
        setData(result);
        offRouteCount.current = 0;
        setOffRoute(false);
        if (reason === 'recalculate') tap('success');
      } catch (err: any) {
        setError(err?.response?.data?.message ?? 'No pudimos calcular la ruta');
      } finally {
        setLoading(false);
      }
    },
    [orderId, position]
  );

  // Ruta nueva al entrar y en cada cambio de etapa. `status` está en las
  // dependencias porque recoger el pedido cambia el destino del local al
  // cliente: sin esto el repartidor seguiría viendo la ruta al restaurante
  // del que acaba de salir.
  useEffect(() => {
    fetchRoute('initial');
    // `fetchRoute` cambia con cada posición nueva; incluirlo aquí pediría
    // una ruta por cada fix del GPS.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId, status]);

  // Escucha las rutas que llegan por socket (el canal del recálculo en
  // marcha, que no paga un handshake HTTP nuevo).
  useEffect(() => {
    const onUpdated = (payload: RouteData) => {
      setData(payload);
      offRouteCount.current = 0;
      setOffRoute(false);
      setLoading(false);
    };
    const onError = (payload: { message?: string }) => {
      setError(payload?.message ?? 'No pudimos calcular la ruta');
      setLoading(false);
    };

    socketService.onRouteUpdated(onUpdated);
    socketService.onRouteError(onError);
    return () => {
      socketService.offRouteUpdated(onUpdated);
      socketService.offRouteError(onError);
    };
  }, []);

  // ── Detección de desvío ──
  useEffect(() => {
    if (!position || !data?.route?.geometry?.coordinates) return;

    const away = distanceToRoute(position, data.route.geometry.coordinates);
    if (away == null) return;

    if (away > OFF_ROUTE_METERS) {
      offRouteCount.current += 1;
      if (offRouteCount.current >= OFF_ROUTE_CONFIRMATIONS && !offRoute) {
        setOffRoute(true);
        tap('warning');
      }
    } else {
      // Volver a la ruta borra el contador entero, no lo decrementa: dos
      // desvíos separados por diez minutos de conducción correcta no deben
      // sumarse como si fueran uno solo.
      offRouteCount.current = 0;
      if (offRoute) setOffRoute(false);
    }
  }, [position, data, offRoute]);

  const markers: MapMarker[] = useMemo(() => {
    const list: MapMarker[] = [];
    if (data?.to) {
      list.push({
        id: 'target',
        kind: data.phase === 'to_business' ? 'business' : 'client',
        ...data.to,
        label: data.targetLabel,
      });
    }
    if (position) {
      list.push({
        id: 'me',
        kind: 'driver',
        lat: position.lat,
        lng: position.lng,
        heading: position.heading,
      });
    }
    return list;
  }, [data, position]);

  if (error && !data) {
    return (
      <Card style={styles.card}>
        <View style={styles.row}>
          <Icon name="atencion" size="sm" color={c.warningText} />
          <Text v="bodyS" tone="textSecondary" style={styles.flex}>{error}</Text>
        </View>
        <Button title="Reintentar" variant="secondary" size="sm" onPress={() => fetchRoute('initial')} loading={loading} />
      </Card>
    );
  }

  return (
    <Card style={styles.card}>
      <View style={styles.header}>
        <View style={styles.flex}>
          <Text v="caption" tone="textMuted">
            {data?.phase === 'to_business' ? 'RUTA AL LOCAL' : 'RUTA AL CLIENTE'}
          </Text>
          <Text v="titleM" numberOfLines={1}>{data?.targetLabel ?? '—'}</Text>
        </View>
        {data?.route ? (
          <Badge
            // El "~" marca que el tiempo sale de una estimación geométrica
            // porque Mapbox no respondió, no de una ruta real.
            label={
              data.route.source === 'mapbox'
                ? (formatEta(data.route.durationSeconds) ?? '—')
                : `~${formatEta(data.route.durationSeconds) ?? '—'}`
            }
            tone="lime"
            icon="minutos"
          />
        ) : null}
      </View>

      <ZippMap
        markers={markers}
        route={data?.route?.geometry ?? null}
        follow
        zoom={16}
        height={220}
      />

      {/*
        El desvío se avisa, no se corrige solo.

        Recalcular en silencio ante cada desvío convierte la ruta en algo
        que cambia bajo los pies del repartidor mientras conduce — y a
        veces el desvío es intencionado: una gasolinera, un atajo que él
        conoce mejor que Mapbox. Se le dice lo que pasa y decide él.
      */}
      {offRoute ? (
        <View style={[styles.alert, { backgroundColor: c.warningSoft, borderColor: c.warning }]}>
          <Icon name="atencion" size="sm" color={c.warningText} />
          <Text v="bodyS" tone="warningText" style={styles.flex}>
            Te saliste de la ruta propuesta.
          </Text>
          <Button
            title="Recalcular"
            size="sm"
            variant="lime"
            loading={loading}
            onPress={() => { tap('light'); fetchRoute('recalculate'); }}
          />
        </View>
      ) : (
        <View style={styles.row}>
          <Icon name="ruta" size="sm" color={c.textMuted} />
          <Text v="bodyS" tone="textSecondary" style={styles.flex} numberOfLines={1}>
            {data?.targetAddress ?? ''}
          </Text>
          <Button
            title="Recalcular"
            size="sm"
            variant="secondary"
            loading={loading}
            onPress={() => { tap('light'); fetchRoute('recalculate'); }}
          />
        </View>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: Spacing.md },
  flex: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  alert: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    padding: Spacing.md,
    borderRadius: 12,
    borderWidth: 1,
  },
});
