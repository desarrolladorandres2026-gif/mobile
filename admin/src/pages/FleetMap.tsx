import { useEffect, useMemo, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { useQuery } from '@tanstack/react-query';
import { Bike, Motorbike, Clock, MapPin, Package, RefreshCw, WifiOff } from 'lucide-react';
import api from '../services/api';
import { useThemeStore } from '../stores/themeStore';
import { useAdminSocketEvents } from '../hooks/useAdminSocket';
import type { DriverLocationUpdate } from '../lib/apiTypes';

interface FleetDriver {
 id: string;
 userId: string;
 name: string;
 avatar: string | null;
 phone: string | null;
 status: 'available' | 'busy' | 'offline';
 vehicleType: string;
 licensePlate: string | null;
 location: { lat: number; lng: number } | null;
 heading: number | null;
 speed: number | null;
 batteryLevel: number | null;
 lastSeenAt: string | null;
 stale: boolean;
 activeOrder: { id: string; orderNumber: string; status: string } | null;
}

const STATUS_LABEL: Record<string, string> = {
 available: 'Activo',
 busy: 'En domicilio',
 offline: 'Inactivo',
};

/** Lo que debe leerse en el marcador: `stale` manda igual que en el color. */
function statusLabel(driver: FleetDriver): string {
 if (driver.stale) return 'Inactivo';
 return STATUS_LABEL[driver.status];
}

/**
 * Paleta del panel ("Obsidian & Gold Titanium"), en hex.
 *
 * Los colores de los marcadores van en `style` y no en clases de Tailwind
 * porque Mapbox crea sus elementos fuera de React: una clase construida
 * dinámicamente no sobrevive a la purga del build, así que el marcador
 * saldría sin color en producción y perfecto en desarrollo — el peor sitio
 * donde puede aparecer un fallo.
 */
const PALETTE = {
 obsidian: '#141B2A',
 gold: '#D69E26',
 muted: '#7C8BA1',
 available: '#E5B242',
} as const;

/**
 * Colores del marcador por estado.
 *
 * `stale` gana a todo: un repartidor que figura"en entrega" pero lleva dos
 * minutos sin reportar no está donde dice el mapa. Pintarlo igual que a uno
 * con señal viva convertiría el mapa en algo en lo que no se puede confiar
 * para despachar, que es exactamente para lo que existe.
 */
function markerColor(driver: FleetDriver): string {
 if (driver.stale) return PALETTE.muted;
 if (driver.status === 'busy') return PALETTE.gold;
 if (driver.status === 'available') return PALETTE.available;
 return PALETTE.muted;
}

/** Iniciales para el marcador de un repartidor sin foto de perfil. */
function initials(name: string): string {
 const parts = name.trim().split(/\s+/);
 return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
}

function minutesAgo(iso: string | null): string {
 if (!iso) return 'sin datos';
 const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
 if (minutes < 1) return 'ahora';
 if (minutes < 60) return `hace ${minutes} min`;
 return `hace ${Math.floor(minutes / 60)} h`;
}

/**
 * Mapa de operaciones: dónde está cada repartidor, ahora.
 *
 * Se construye con Mapbox GL JS. `Zones.tsx` sigue con Leaflet y
 * leaflet-draw intactos: el dibujo de polígonos de cobertura funciona y
 * migrarlo a mapbox-gl-draw habría sido reescribir código que sirve para
 * ganar consistencia de librerías, no funcionalidad.
 *
 * Los datos llegan por dos vías, igual que en la app: una carga REST con la
 * foto completa y luego el socket con las posiciones según se mueven. El
 * refresco periódico existe además del socket porque el estado del
 * repartidor y su pedido activo cambian por eventos que no viajan con la
 * posición.
 */
export default function FleetMap() {
 const containerRef = useRef<HTMLDivElement | null>(null);
 const mapRef = useRef<mapboxgl.Map | null>(null);
 const markersRef = useRef<Record<string, mapboxgl.Marker>>({});
 const theme = useThemeStore((s) => s.theme);

 const [selected, setSelected] = useState<string | null>(null);
 const [live, setLive] = useState<Record<string, { lat: number; lng: number; heading: number | null; at: number }>>({});
 const [mapError, setMapError] = useState<string | null>(null);
 /**
 * Sube cada vez que un mapa nuevo termina de cargar. Los marcadores
 * dependen de él: si la flota llegaba antes que la configuración del
 * mapa (lo normal, porque son dos peticiones en paralelo), el efecto de
 * marcadores corría sin mapa, no pintaba nada, y la flota no aparecía
 * hasta la siguiente posición por socket. Lo mismo al cambiar de tema.
 */
 const [mapVersion, setMapVersion] = useState(0);

 const { data: config } = useQuery({
 queryKey: ['tracking', 'config'],
 queryFn: () => api.get('/tracking/config').then((r) => r.data.data),
 staleTime: Infinity,
 });

 const { data: fleet = [], refetch, isFetching } = useQuery<FleetDriver[]>({
 queryKey: ['tracking', 'fleet'],
 queryFn: () => api.get('/tracking/fleet').then((r) => r.data.data),
 refetchInterval: 30_000,
 });

 // ── Mapa ──
 useEffect(() => {
 if (!containerRef.current || mapRef.current) return;
 if (!config?.accessToken) return;

 mapboxgl.accessToken = config.accessToken;

 const map = new mapboxgl.Map({
 container: containerRef.current,
 style: theme === 'dark' ? config.styleDark : config.style,
 center: [-75.6258, 2.1958],
 zoom: 12,
 attributionControl: false,
 });

 map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-right');
 map.on('error', (e) => setMapError(e.error?.message ?? 'Error del mapa'));
 map.on('load', () => setMapVersion((v) => v + 1));

 mapRef.current = map;

 return () => {
 map.remove();
 mapRef.current = null;
 markersRef.current = {};
 };
 }, [config, theme]);

 // ── Socket: posiciones según llegan ──
 //
 // Con la flota entera moviéndose, llegan varias posiciones por segundo y
 // cada una re-renderizaba la página completa. Se juntan las de un mismo
 // fotograma y se aplican de una vez.
 const pendingRef = useRef<Record<string, { lat: number; lng: number; heading: number | null; at: number }>>({});
 const frameRef = useRef<number | null>(null);
 useEffect(() => () => {
 if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
 }, []);

 // El backend mete a los administradores en la sala `admin` al conectar,
 // así que no hay que suscribirse a nada: la flota entera llega sola.
 useAdminSocketEvents({
 'driver:location:update': (payload: DriverLocationUpdate) => {
 const { driverId, location } = payload;
 if (!driverId || !location) return;
 pendingRef.current[driverId] = {
 lat: location.lat,
 lng: location.lng,
 heading: payload.heading ?? null,
 at: Date.now(),
 };
 if (frameRef.current !== null) return;
 frameRef.current = requestAnimationFrame(() => {
 frameRef.current = null;
 const batch = pendingRef.current;
 pendingRef.current = {};
 setLive((current) => ({ ...current, ...batch }));
 });
 },
 'driver:status:update': () => refetch(),
 });

 /** La flota con la posición más reciente de las dos fuentes aplicada. */
 const drivers = useMemo(
 () =>
 fleet.map((driver) => {
 const fresh = live[driver.userId];
 if (!fresh) return driver;
 return {
 ...driver,
 location: { lat: fresh.lat, lng: fresh.lng },
 heading: fresh.heading ?? driver.heading,
 lastSeenAt: new Date(fresh.at).toISOString(),
 // Una posición que acaba de llegar por socket no puede estar
 //"perdida", diga lo que diga la última carga REST.
 stale: false,
 };
 }),
 [fleet, live]
 );

 // ── Marcadores ──
 useEffect(() => {
 const map = mapRef.current;
 if (!map) return;

 const seen = new Set<string>();

 for (const driver of drivers) {
 if (!driver.location) continue;
 seen.add(driver.id);

 const position: [number, number] = [driver.location.lng, driver.location.lat];
 const existing = markersRef.current[driver.id];

 if (existing) {
 existing.setLngLat(position);
 const el = existing.getElement();
 el.style.opacity = driver.stale ? '0.5' : '1';
 const ring = el.querySelector<HTMLElement>('[data-role="ring"]');
 if (ring) ring.style.borderColor = markerColor(driver);
 const status = el.querySelector<HTMLElement>('[data-role="status"]');
 if (status) {
 status.textContent = statusLabel(driver);
 status.style.background = markerColor(driver);
 }
 continue;
 }

 // El marcador ya se construía a mano con `document.createElement`
 // (Mapbox pinta fuera del árbol de React), así que la foto + nombre
 // se arman igual: un contenedor en columna, sin depender de ninguna
 // librería nueva.
 const el = document.createElement('button');
 el.type = 'button';
 el.title = driver.name;
 el.style.cssText = [
 'display:flex', 'flex-direction:column', 'align-items:center', 'gap:2px',
 'background:transparent', 'border:none', 'cursor:pointer', 'padding:0',
 driver.stale ? 'opacity:0.5' : '',
 ].join(';');

 const ring = document.createElement('div');
 ring.dataset.role = 'ring';
 ring.style.cssText = [
 'width:36px', 'height:36px', 'border-radius:18px', 'overflow:hidden',
 `border:3px solid ${markerColor(driver)}`, 'box-shadow:0 2px 6px rgba(0,0,0,.35)',
 'background:#7C8BA1', 'display:flex', 'align-items:center', 'justify-content:center',
 ].join(';');

 if (driver.avatar) {
 const img = document.createElement('img');
 img.src = driver.avatar;
 img.alt = '';
 img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
 ring.appendChild(img);
 } else {
 const fallback = document.createElement('span');
 fallback.textContent = initials(driver.name);
 fallback.style.cssText = 'color:white;font-size:12px;font-weight:800;';
 ring.appendChild(fallback);
 }

 const label = document.createElement('span');
 label.textContent = driver.name.split(' ')[0] ?? driver.name;
 label.style.cssText = [
 'max-width:80px', 'overflow:hidden', 'text-overflow:ellipsis', 'white-space:nowrap',
 'font-size:10px', 'font-weight:700', 'color:white',
 'background:rgba(20,27,42,.75)', 'padding:1px 6px', 'border-radius:8px',
 ].join(';');

 // Aparte del color del anillo, el estado se lee en texto: el color
 // solo no basta para saber si un repartidor está en domicilio o
 // simplemente activo, y menos a golpe de vista sobre un mapa lleno
 // de puntos parecidos.
 const status = document.createElement('span');
 status.dataset.role = 'status';
 status.textContent = statusLabel(driver);
 status.style.cssText = [
 'font-size:9px', 'font-weight:800', 'color:#141B2A',
 `background:${markerColor(driver)}`, 'padding:1px 6px', 'border-radius:8px',
 'box-shadow:0 1px 3px rgba(0,0,0,.3)',
 ].join(';');

 el.appendChild(ring);
 el.appendChild(label);
 el.appendChild(status);
 el.addEventListener('click', () => setSelected(driver.id));

 markersRef.current[driver.id] = new mapboxgl.Marker({ element: el, anchor: 'bottom' })
 .setLngLat(position)
 .addTo(map);
 }

 // Un repartidor que se desconecta sale de la lista; su marcador tiene
 // que salir del mapa o se quedaría ahí para siempre, marcando una
 // posición de hace horas como si fuera actual.
 for (const [id, marker] of Object.entries(markersRef.current)) {
 if (!seen.has(id)) {
 marker.remove();
 delete markersRef.current[id];
 }
 }
 }, [drivers, mapVersion]);

 const focus = (driver: FleetDriver) => {
 setSelected(driver.id);
 if (driver.location && mapRef.current) {
 mapRef.current.easeTo({
 center: [driver.location.lng, driver.location.lat],
 zoom: 15,
 duration: 700,
 });
 }
 };

 const withSignal = drivers.filter((d) => !d.stale).length;
 const delivering = drivers.filter((d) => d.activeOrder).length;

 if (config && !config.enabled) {
 return (
 <div className="animate-fade-in">
 <div className="page-header">
 <div>
 <h1 className="page-title">Flota en Vivo</h1>
 <p className="page-subtitle">Ubicación de los domiciliarios en tiempo real</p>
 </div>
 </div>
 <div className="zipp-card p-16 text-center">
 <MapPin className="mx-auto mb-4 h-10 w-10 text-[var(--color-text-main)]" />
 <p className="text-base font-bold text-[var(--color-text-main)]">Mapa no configurado</p>
 <p className="mx-auto mt-2 max-w-md text-xs font-semibold text-[var(--color-text-main)] dark:text-[#7184A8]">
 Define <code className="font-mono font-bold">MAPBOX_ACCESS_TOKEN</code>{' '}
 en el <code className="font-mono font-bold">.env</code> del backend
 y reinicia el servidor. El resto del seguimiento funciona sin mapa.
 </p>
 </div>
 </div>
 );
 }

 return (
 <div className="flex h-[calc(100vh-9rem)] flex-col animate-fade-in">
 <div className="page-header">
 <div>
 <h1 className="page-title">Flota en Vivo</h1>
 <p className="page-subtitle">
 {drivers.length} en operación · {withSignal} con señal · {delivering} entregando
 </p>
 </div>
 <button
 onClick={() => refetch()}
 className="flex items-center justify-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs font-bold text-[var(--color-text-main)] shadow-xs transition hover:border-[var(--color-border-strong)] dark:border-[#232E46] dark:bg-[#141B2A] dark:hover:border-[#2E3D5C]"
 >
 <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} />
 Actualizar
 </button>
 </div>

 {mapError ? (
 <div className="mb-4 flex items-start gap-3 text-xs text-[var(--color-danger)]">
 <WifiOff className="mt-0.5 h-4 w-4 shrink-0" />
 <span className="flex-1 font-semibold">{mapError}</span>
 </div>
 ) : null}

 <div className="flex min-h-0 flex-1 flex-col gap-2.5 lg:flex-row">
 <div
 ref={containerRef}
 className="zipp-card min-h-75 flex-1 overflow-hidden p-0"
 />

 <aside className="zipp-card w-full shrink-0 overflow-y-auto p-0 lg:w-80 lg:border-l lg:border-[var(--color-border)] dark:lg:border-[#232E46]">
 {drivers.length === 0 ? (
 <p className="p-8 text-center text-xs font-semibold text-[var(--color-text-main)] dark:text-[#7184A8]">
 No hay domiciliarios en operación ahora mismo.
 </p>
 ) : (
 <ul className="divide-y divide-[var(--color-border)] dark:divide-[#232E46]">
 {drivers.map((driver) => (
 <li key={driver.id}>
 <button
 onClick={() => focus(driver)}
 className={`w-full px-4 py-3 text-left transition hover:bg-[var(--color-bg)] dark:hover:bg-[#1B2438] ${
 selected === driver.id ? 'bg-[var(--color-bg)] dark:bg-[#1B2438]' : ''
 }`}
 >
 <div className="flex items-center gap-2">
 <span
 className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[var(--color-text-muted)] text-[9px] font-extrabold text-white"
 style={{ border: `2px solid ${markerColor(driver)}` }}
 >
 {driver.avatar ? (
 <img src={driver.avatar} alt="" className="h-full w-full object-cover" />
 ) : (
 initials(driver.name)
 )}
 </span>
 <span className="truncate text-sm font-bold text-[var(--color-text-main)]">
 {driver.name}
 </span>
 {driver.stale ? (
 <WifiOff className="ml-auto h-3.5 w-3.5 shrink-0 text-[var(--color-text-main)]" />
 ) : null}
 </div>

 <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-semibold text-[var(--color-text-main)] dark:text-[#7184A8]">
 <span
 className={`flex items-center gap-1 ${
 driver.status === 'available' ? 'text-[var(--color-primary)]' : ''
 }`}
 >
 {driver.status === 'available' ? (
 <Motorbike className="h-3 w-3" />
 ) : (
 <Bike className="h-3 w-3" />
 )}
 {statusLabel(driver)}
 </span>
 <span className="flex items-center gap-1">
 <Clock className="h-3 w-3" />
 {minutesAgo(driver.lastSeenAt)}
 </span>
 </div>

 {driver.activeOrder ? (
 <div className="mt-1.5 flex items-center gap-1 text-xs font-semibold text-[var(--color-text-main)]">
 <Package className="h-3 w-3" />
 Pedido #{driver.activeOrder.orderNumber}
 </div>
 ) : null}
 </button>
 </li>
 ))}
 </ul>
 )}
 </aside>
 </div>
 </div>
 );
}
