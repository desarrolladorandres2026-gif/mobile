import { useCallback, useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { LocateFixed, Search, AlertCircle, X, RefreshCw } from 'lucide-react';
import api from '../services/api';
import { apiMessage } from '../lib/apiError';

/**
 * Dónde recoge el domiciliario, con un punto que de verdad se puede mover.
 *
 * Hasta ahora el campo "Dirección" de Ajustes solo cambiaba el texto que
 * lee el cliente: el punto del mapa —lo único que el repartidor sigue de
 * verdad— se quedaba donde estaba desde el alta del negocio. Un comercio
 * que se mudó de local no tenía manera de corregirlo desde aquí.
 *
 * Mapa con Leaflet y teselas de OpenStreetMap, igual que `Zones.tsx` en el
 * panel de administración: sin token, sin cuota, y ya probado en este
 * mismo repositorio. El buscador reutiliza `/addresses/search`, que ya
 * existe para el cliente y no distingue el rol de quien pregunta.
 *
 * Elegir un resultado de la búsqueda solo mueve el pin, nunca reescribe el
 * campo "Dirección": ese texto puede llevar un piso, una referencia o un
 * nombre de local que el comercio ya redactó a su manera, y pisarlo con lo
 * que devuelve el geocodificador sería perder esa precisión.
 */

/** Centro por defecto cuando el negocio todavía no tiene punto puesto. */
const DEFAULT_CENTER: [number, number] = [2.1975, -75.6289];
const DEFAULT_ZOOM = 15;
const PICKED_ZOOM = 17;

export interface LatLng {
  lat: number;
  lng: number;
}

interface PlaceSuggestion {
  address: string;
  neighborhood?: string;
  city?: string;
  full: string;
  lat: number;
  lng: number;
}

interface Props {
  /** Punto actual del negocio, o null si nunca se puso uno válido. */
  value: LatLng | null;
  onChange: (point: LatLng) => void;
}

/** Un pin propio en SVG: sin esto, Leaflet pide sus imágenes por una ruta
 * que el empaquetador no resuelve y el marcador sale roto. */
function pinIcon(color: string): L.DivIcon {
  return L.divIcon({
    className: '',
    html: `<svg width="30" height="40" viewBox="0 0 24 32" fill="none" xmlns="http://www.w3.org/2000/svg" style="filter: drop-shadow(0 2px 3px rgba(0,0,0,0.35))">
      <path d="M12 0C5.373 0 0 5.373 0 12c0 9 12 20 12 20s12-11 12-20c0-6.627-5.373-12-12-12z" fill="${color}"/>
      <circle cx="12" cy="12" r="5" fill="white"/>
    </svg>`,
    iconSize: [30, 40],
    iconAnchor: [15, 40],
  });
}

export default function BusinessLocationField({ value, onChange }: Props) {
  const mapRef = useRef<HTMLDivElement | null>(null);
  const map = useRef<L.Map | null>(null);
  const marker = useRef<L.Marker | null>(null);

  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [locating, setLocating] = useState(false);

  const place = useCallback((point: LatLng) => {
    if (!map.current) return;

    if (marker.current) {
      marker.current.setLatLng(point);
    } else {
      marker.current = L.marker(point, {
        icon: pinIcon('#D69E26'),
        draggable: true,
      }).addTo(map.current);
      marker.current.on('dragend', () => {
        const pos = marker.current!.getLatLng();
        onChange({ lat: pos.lat, lng: pos.lng });
      });
    }
    onChange(point);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Mapa: se crea una sola vez ──
  useEffect(() => {
    if (!mapRef.current || map.current) return;

    const center = value ?? { lat: DEFAULT_CENTER[0], lng: DEFAULT_CENTER[1] };
    map.current = L.map(mapRef.current, {
      center,
      zoom: value ? PICKED_ZOOM : DEFAULT_ZOOM,
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap',
      maxZoom: 19,
    }).addTo(map.current);

    if (value) {
      marker.current = L.marker(value, { icon: pinIcon('#D69E26'), draggable: true }).addTo(
        map.current
      );
      marker.current.on('dragend', () => {
        const pos = marker.current!.getLatLng();
        onChange({ lat: pos.lat, lng: pos.lng });
      });
    }

    // Un toque en cualquier punto del mapa mueve el pin ahí. Es más rápido
    // que arrastrar cuando el punto correcto está lejos del actual.
    map.current.on('click', (e: L.LeafletMouseEvent) => {
      place({ lat: e.latlng.lat, lng: e.latlng.lng });
      map.current!.panTo(e.latlng);
    });

    return () => {
      map.current?.remove();
      map.current = null;
      marker.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const flyTo = useCallback((point: LatLng, zoom = PICKED_ZOOM) => {
    map.current?.setView(point, zoom);
    place(point);
  }, [place]);

  // ── Búsqueda de dirección ──
  const searchSeq = useRef(0);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);

    const trimmed = query.trim();
    if (trimmed.length < 3) {
      setSuggestions([]);
      setSearching(false);
      return;
    }

    setSearching(true);
    searchTimer.current = setTimeout(async () => {
      const seq = ++searchSeq.current;
      try {
        setSearchError('');
        const params: Record<string, string> = { q: trimmed };
        // El mismo texto encuentra calles distintas según la ciudad; con
        // el punto actual como pista, Mapbox ordena primero lo cercano.
        const center = marker.current?.getLatLng() ?? value;
        if (center) {
          params.lat = String(center.lat);
          params.lng = String(center.lng);
        }
        const { data } = await api.get('/addresses/search', { params });
        if (seq !== searchSeq.current) return;
        setSuggestions(data.data ?? []);
      } catch (err) {
        if (seq !== searchSeq.current) return;
        setSearchError(apiMessage(err, 'No se pudo buscar esa dirección.'));
        setSuggestions([]);
      } finally {
        if (seq === searchSeq.current) setSearching(false);
      }
    }, 400);

    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [query, value]);

  const pickSuggestion = (s: PlaceSuggestion) => {
    flyTo({ lat: s.lat, lng: s.lng });
    setQuery('');
    setSuggestions([]);
  };

  // ── Mi ubicación actual ──
  const useMyLocation = () => {
    if (!navigator.geolocation) return;
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        flyTo({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setLocating(false);
      },
      () => setLocating(false),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  return (
    <div className="space-y-2">
      <div className="relative">
        <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-[var(--color-surface)] border border-[var(--color-border)] focus-within:border-[var(--color-primary)]">
          {searching ? (
            <RefreshCw className="w-4 h-4 text-[var(--color-text-muted)] shrink-0 animate-spin" />
          ) : (
            <Search className="w-4 h-4 text-[var(--color-text-muted)] shrink-0" />
          )}
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Busca la dirección para ubicar el pin…"
            className="flex-1 bg-transparent text-sm text-[var(--color-text-main)] outline-none min-w-0"
          />
          {query && (
            <button
              type="button"
              onClick={() => { setQuery(''); setSuggestions([]); }}
              className="text-[var(--color-text-muted)] cursor-pointer"
              aria-label="Borrar búsqueda"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {suggestions.length > 0 && (
          <div className="absolute z-[500] top-full left-0 right-0 mt-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] shadow-md overflow-hidden">
            {suggestions.map((s, i) => (
              <button
                key={i}
                type="button"
                onClick={() => pickSuggestion(s)}
                className="w-full text-left px-3 py-2 text-xs hover:bg-[var(--color-surface-hover)] cursor-pointer border-b border-[var(--color-border)] last:border-b-0"
              >
                <span className="block font-semibold text-[var(--color-text-main)]">{s.address}</span>
                <span className="block text-[var(--color-text-secondary)]">{s.full}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {searchError && (
        <p className="text-xs font-semibold text-[var(--color-danger)] flex items-start gap-1.5">
          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          {searchError}
        </p>
      )}

      <div className="relative rounded-md overflow-hidden border border-[var(--color-border)]" style={{ height: 260 }}>
        <div ref={mapRef} className="w-full h-full" />

        <button
          type="button"
          onClick={useMyLocation}
          disabled={locating}
          title="Usar mi ubicación actual"
          className="absolute bottom-3 right-3 z-[400] w-8 h-8 rounded-md bg-[var(--color-surface)] border border-[var(--color-border-strong)] grid place-items-center cursor-pointer disabled:opacity-50"
        >
          <LocateFixed className={`w-4 h-4 text-[var(--color-primary)] ${locating ? 'animate-pulse' : ''}`} />
        </button>
      </div>

      <p className="text-xs text-[var(--color-text-secondary)]">
        {value
          ? 'Toca el mapa, arrastra el pin o busca arriba para mover el punto donde te recoge el domiciliario.'
          : 'Este negocio no tiene un punto válido todavía — búscalo o toca el mapa para ponerlo.'}
      </p>
    </div>
  );
}
