import { useEffect, useMemo, useRef, useState } from 'react';
import { View, StyleSheet, ActivityIndicator, ViewStyle } from 'react-native';
import { WebView } from 'react-native-webview';
import { Text, Icon } from '../ui';
import { useTheme } from '../../hooks/useTheme';
import { BorderRadius } from '../../theme/tokens';
import {
  getMapConfig,
  buildMapHtml,
  MapMarker,
  MapPoint,
  MapRoute,
  MapPalette,
} from '../../lib/mapbox';

/**
 * Sin marcadores. Constante de módulo y no un `[]` recién creado: el efecto
 * que empuja el estado al mapa compara por identidad, y un array nuevo en
 * cada render volvería a inyectar JavaScript en el WebView sin que nada
 * hubiera cambiado.
 */
const NO_MARKERS: MapMarker[] = [];

export interface ZippMapProps {
  /** Vacío en modo `pick`, donde el objetivo del centro sustituye al pin. */
  markers?: MapMarker[];
  route?: MapRoute | null;
  trail?: MapPoint[] | null;
  center?: MapPoint | null;
  zoom?: number;
  /** Sigue al repartidor. Para la pantalla de navegación del domiciliario. */
  follow?: boolean;
  /** Encuadra todo lo dibujado. Para la pantalla de seguimiento del cliente. */
  fitAll?: boolean;
  height?: number;
  style?: ViewStyle;
  /**
   * Modo "elegir punto": objetivo fijo en el centro, el mapa se arrastra
   * debajo. Cambia el contrato del componente — deja de dibujar `markers`
   * y `route`, y su salida pasa a ser `onPick`.
   */
  pick?: boolean;
  /** Coordenada bajo el objetivo, al soltar el arrastre. Solo con `pick`. */
  onPick?: (point: MapPoint) => void;
  /**
   * Cambia este número para devolver la cámara a `center`.
   *
   * En modo `pick` la cámara ignora `center` mientras esta llave no cambie,
   * porque el arrastre del usuario manda sobre el estado del padre.
   */
  recenterKey?: number;
}

/**
 * Mapa de ZIPP.
 *
 * Mapbox GL JS dentro de un WebView. Se eligió sobre el SDK nativo porque
 * la app sigue distribuyéndose por Expo Go y exportándose a web, y
 * `@rnmapbox/maps` habría roto las dos cosas a cambio de un rendimiento
 * que esta pantalla no necesita: aquí se sigue un punto que se mueve a
 * 30 km/h, no se renderiza un videojuego.
 *
 * El HTML se construye **una sola vez**. A partir de ahí las
 * actualizaciones entran por `injectJavaScript`, no recargando la página:
 * volver a montar el documento en cada posición nueva significaría
 * descargar los tiles otra vez y ver el mapa parpadear cada cinco
 * segundos.
 */
export function ZippMap({
  markers = NO_MARKERS,
  route,
  trail,
  center,
  zoom,
  follow = false,
  fitAll = false,
  height = 260,
  style,
  pick = false,
  onPick,
  recenterKey,
}: ZippMapProps) {
  const { c, isDark } = useTheme();
  const webRef = useRef<WebView>(null);
  const [token, setToken] = useState<string | null>(null);
  const [styleUrl, setStyleUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    getMapConfig().then((config) => {
      if (!alive) return;
      if (!config?.enabled || !config.accessToken) {
        setFailed(true);
        return;
      }
      setToken(config.accessToken);
      setStyleUrl(isDark ? config.styleDark : config.style);
    });
    return () => {
      alive = false;
    };
  }, [isDark]);

  const palette: MapPalette = useMemo(
    () => ({
      route: c.primary,
      trail: c.textMuted,
      driver: c.primary,
      business: c.warning,
      client: c.lime,
      stale: c.textMuted,
      onMarker: c.background,
      background: c.surfaceLight,
    }),
    [c]
  );

  // El HTML depende del token, del estilo y de la paleta — nada más. Sin
  // este `useMemo` cualquier render del padre (una posición nueva, que es
  // lo que más ocurre aquí) generaría una cadena distinta, `source`
  // cambiaría de identidad y el WebView recargaría el mapa entero.
  const html = useMemo(
    () => (token && styleUrl ? buildMapHtml({ accessToken: token, style: styleUrl, palette, pick }) : null),
    [token, styleUrl, palette, pick]
  );

  // Empuja el estado al mapa cada vez que cambia algo dibujable.
  useEffect(() => {
    if (!ready || !webRef.current) return;

    const state = { markers, route, trail, center, zoom, follow, fitAll, recenterKey };
    webRef.current.injectJavaScript(
      `window.__zippMap && window.__zippMap.apply(${JSON.stringify(state)}); true;`
    );
  }, [ready, markers, route, trail, center, zoom, follow, fitAll, recenterKey]);

  const frame = [styles.frame, { height, backgroundColor: c.surfaceLight, borderColor: c.border }, style];

  // Sin mapa la pantalla sigue siendo útil: el resto del seguimiento —los
  // pasos, el estado, el chat, el ETA— no depende de Mapbox. Un proveedor
  // caído no puede llevarse por delante la pantalla entera.
  if (failed) {
    return (
      <View style={[...frame, styles.center]}>
        <Icon name="ubicacion" size="lg" color={c.textMuted} />
        <Text v="bodyS" tone="textMuted" center>
          El mapa no está disponible ahora mismo
        </Text>
      </View>
    );
  }

  if (!html) {
    return (
      <View style={[...frame, styles.center]}>
        <ActivityIndicator color={c.primary} />
      </View>
    );
  }

  return (
    <View style={frame}>
      <WebView
        ref={webRef}
        source={{ html }}
        // El fondo va por estilo y no por la prop `backgroundColor`, que
        // react-native-webview retiró en la 13.16. El documento pinta
        // además el mismo color (ver `buildMapHtml`): sin eso, el blanco
        // por defecto del WebView da un destello claro al abrir el mapa en
        // modo oscuro, justo mientras se descargan los tiles.
        style={[styles.web, { backgroundColor: c.surfaceLight }]}
        // El mapa no navega a ninguna parte: es una superficie de dibujo.
        // Sin esta guarda, un enlace o una redirección inesperada cargaría
        // una página arbitraria dentro del WebView que lleva el token de
        // Mapbox en memoria.
        //
        // Solo se deja pasar el documento propio. Se comprueba por
        // esquema y no por igualdad con "about:blank" porque cada
        // plataforma nombra distinto el HTML inyectado —iOS lo sirve con
        // baseURL vacía, Android como about:blank— y una comparación
        // exacta impediría que el mapa llegara siquiera a cargar en una de
        // las dos. Las peticiones de tiles no pasan por aquí: esto son
        // navegaciones, no XHR.
        originWhitelist={['*']}
        onShouldStartLoadWithRequest={(request) =>
          !request.url || request.url === 'about:blank' || request.url.startsWith('data:')
        }
        javaScriptEnabled
        domStorageEnabled
        scrollEnabled={false}
        onMessage={(event) => {
          try {
            const data = JSON.parse(event.nativeEvent.data);
            if (data.type === 'ready') setReady(true);
            if (data.type === 'moved' && onPick) onPick({ lat: data.lat, lng: data.lng });
            if (data.type === 'error' && __DEV__) console.log('[Mapa]', data.message);
          } catch {
            // Un mensaje que no es JSON no viene de nuestro puente.
          }
        }}
        onError={() => setFailed(true)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    borderRadius: BorderRadius.lg,
    overflow: 'hidden',
    borderWidth: 1,
  },
  center: { alignItems: 'center', justifyContent: 'center', gap: 8, padding: 16 },
  web: { flex: 1 },
});
