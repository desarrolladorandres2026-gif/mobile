import { useEffect, useMemo, useRef, useState } from 'react';
import { View, StyleSheet, ActivityIndicator, ViewStyle } from 'react-native';
import { Text, Icon } from '../ui';
import { useTheme } from '../../hooks/useTheme';
import { BorderRadius } from '../../theme/tokens';
import { getMapConfig, buildMapHtml, MapPalette } from '../../lib/mapbox';
import type { ZippMapProps } from './ZippMap';

/**
 * El mismo mapa, en la versión web de la app.
 *
 * Metro resuelve este archivo en lugar de `ZippMap.tsx` al exportar a web,
 * donde `react-native-webview` no existe. La diferencia es solo el
 * anfitrión: allí un WebView, aquí un iframe. El documento que se dibuja
 * dentro sale del mismo `buildMapHtml`, así que un arreglo en el mapa
 * llega a las dos plataformas a la vez — que es justo lo que no pasa
 * cuando se escriben dos implementaciones "parecidas".
 *
 * El iframe va en `sandbox` con los permisos mínimos que Mapbox necesita:
 * scripts (dibujar) y same-origin (WebGL y el caché de tiles). Sin
 * `allow-top-navigation`, un enlace inesperado dentro del mapa no puede
 * sacar al usuario de la app.
 */
export function ZippMap({
  markers,
  route,
  trail,
  center,
  zoom,
  follow = false,
  fitAll = false,
  height = 260,
  style,
}: ZippMapProps) {
  const { c, isDark } = useTheme();
  const frameRef = useRef<HTMLIFrameElement | null>(null);
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

  const html = useMemo(
    () => (token && styleUrl ? buildMapHtml({ accessToken: token, style: styleUrl, palette }) : null),
    [token, styleUrl, palette]
  );

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // Solo se escucha al propio iframe. Sin esta comprobación, cualquier
      // otro frame de la página podría declarar el mapa listo y provocar
      // que se le empujara estado a un destino que no es el mapa.
      if (frameRef.current && event.source !== frameRef.current.contentWindow) return;
      try {
        const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
        if (data?.type === 'ready') setReady(true);
        if (data?.type === 'error' && __DEV__) console.log('[Mapa]', data.message);
      } catch {
        // Mensaje ajeno al puente.
      }
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    if (!ready) return;
    frameRef.current?.contentWindow?.postMessage(
      JSON.stringify({
        __zipp: 'state',
        state: { markers, route, trail, center, zoom, follow, fitAll },
      }),
      '*'
    );
  }, [ready, markers, route, trail, center, zoom, follow, fitAll]);

  const frame = [
    styles.frame,
    { height, backgroundColor: c.surfaceLight, borderColor: c.border },
    style,
  ];

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
      <iframe
        ref={frameRef}
        srcDoc={html}
        title="Mapa de seguimiento"
        sandbox="allow-scripts allow-same-origin"
        style={{ border: 'none', width: '100%', height: '100%', background: 'transparent' }}
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
});
