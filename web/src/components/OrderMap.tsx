import { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';

export interface LngLat { lat: number; lng: number }

interface Props {
  token: string;
  style: string;
  business?: (LngLat & { label?: string }) | null;
  destination?: (LngLat & { label?: string }) | null;
  driver?: (LngLat & { stale?: boolean }) | null;
  /** GeoJSON LineString de la ruta que falta por recorrer. */
  route?: { type: 'LineString'; coordinates: [number, number][] } | null;
}

/** Marcador de texto: una palabra sobre un fondo liso, sin iconos. */
function labelMarker(text: string, tone: 'business' | 'client' | 'driver'): HTMLElement {
  const el = document.createElement('div');
  el.textContent = text;
  el.style.cssText = [
    'padding:4px 8px',
    'font:600 13px "Source Sans 3", system-ui, sans-serif',
    'border-radius:4px',
    'white-space:nowrap',
    tone === 'driver' ? 'background:#1A1A1A;color:#FFFFFF' : tone === 'client' ? 'background:#DDA73A;color:#1A1A1A' : 'background:#FFFFFF;color:#1A1A1A;border:1px solid #1A1A1A',
  ].join(';');
  return el;
}

/**
 * Mapa de seguimiento. Dibuja comercio, destino y repartidor con etiquetas de
 * texto, y la ruta como una línea. Se carga bajo demanda: Mapbox GL pesa más
 * que el resto del sitio junto.
 */
export default function OrderMap({ token, style, business, destination, driver, route }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const driverMarker = useRef<mapboxgl.Marker | null>(null);
  const fixed = useRef<mapboxgl.Marker[]>([]);

  // Crea el mapa una sola vez.
  useEffect(() => {
    if (!container.current) return;
    mapboxgl.accessToken = token;
    const start = destination ?? business ?? driver ?? { lat: 2.1957, lng: -75.6264 };
    const map = new mapboxgl.Map({
      container: container.current,
      style,
      center: [start.lng, start.lat],
      zoom: 13,
      attributionControl: true,
    });
    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-right');
    mapRef.current = map;
    return () => {
      fixed.current.forEach((m) => m.remove());
      driverMarker.current?.remove();
      map.remove();
      mapRef.current = null;
      driverMarker.current = null;
      fixed.current = [];
    };
    // Solo al montar: los cambios de datos se aplican en los efectos de abajo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, style]);

  // Comercio y destino.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    fixed.current.forEach((m) => m.remove());
    fixed.current = [];
    if (business) fixed.current.push(new mapboxgl.Marker({ element: labelMarker('Comercio', 'business') }).setLngLat([business.lng, business.lat]).addTo(map));
    if (destination) fixed.current.push(new mapboxgl.Marker({ element: labelMarker('Tu dirección', 'client') }).setLngLat([destination.lng, destination.lat]).addTo(map));
  }, [business, destination]);

  // Repartidor: se mueve el mismo marcador, no se recrea.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!driver) {
      driverMarker.current?.remove();
      driverMarker.current = null;
      return;
    }
    if (!driverMarker.current) {
      driverMarker.current = new mapboxgl.Marker({ element: labelMarker('Repartidor', 'driver') }).setLngLat([driver.lng, driver.lat]).addTo(map);
    } else {
      driverMarker.current.setLngLat([driver.lng, driver.lat]);
    }
  }, [driver]);

  // Ruta.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const draw = () => {
      const data = { type: 'Feature' as const, properties: {}, geometry: route ?? { type: 'LineString' as const, coordinates: [] } };
      const source = map.getSource('ruta') as mapboxgl.GeoJSONSource | undefined;
      if (source) {
        source.setData(data);
        return;
      }
      map.addSource('ruta', { type: 'geojson', data });
      map.addLayer({
        id: 'ruta',
        type: 'line',
        source: 'ruta',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#1A1A1A', 'line-width': 4 },
      });
    };
    if (map.isStyleLoaded()) draw();
    else map.once('load', draw);
  }, [route]);

  // Encuadra los puntos conocidos cuando cambian los extremos (no a cada pulso del repartidor).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const points = [business, destination, driver].filter(Boolean) as LngLat[];
    if (points.length < 2) return;
    const bounds = new mapboxgl.LngLatBounds();
    points.forEach((p) => bounds.extend([p.lng, p.lat]));
    map.fitBounds(bounds, { padding: 60, maxZoom: 16, duration: 0 });
    // El repartidor se mueve a cada pulso; el encuadre solo se rehace si aparece o desaparece.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [business, destination, Boolean(driver)]);

  return <div ref={container} className="h-80 w-full border border-border-strong" role="img" aria-label="Mapa del seguimiento de tu pedido" />;
}
