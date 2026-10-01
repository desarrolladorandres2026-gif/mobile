import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useLiveReload } from '../hooks/useLiveReload';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, BatteryLow, LocateFixed, MapPin, WifiOff } from 'lucide-react';
import api from '../services/api';
import { useThemeStore } from '../stores/themeStore';
import { useAdminSocketEvents } from '../hooks/useAdminSocket';
import EntityLink from '../components/EntityLink';
import { vehicleLabel } from '../lib/drivers';
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

/**
 * Lo que el despachador necesita saber de un repartidor, en una palabra.
 *
 * `stale` gana a todo: un repartidor que figura "en domicilio" pero lleva
 * minutos sin reportar no está donde dice el mapa. Pintarlo igual que a uno
 * con señal viva convertiría el mapa en algo en lo que no se puede confiar
 * para despachar, que es exactamente para lo que existe.
 */
type FleetState = 'available' | 'busy' | 'stale' | 'offline';

function fleetState(driver: FleetDriver): FleetState {
 if (driver.stale) return 'stale';
 if (driver.status === 'busy') return 'busy';
 if (driver.status === 'available') return 'available';
 return 'offline';
}

const STATE_LABEL: Record<FleetState, string> = {
 available: 'Libre',
 busy: 'En domicilio',
 stale: 'Sin señal',
 offline: 'Desconectado',
};

/**
 * Colores por estado, en hex.
 *
 * Van en `style` y no en clases de Tailwind porque Mapbox crea sus elementos
 * fuera de React: una clase construida dinámicamente no sobrevive a la purga
 * del build, así que el marcador saldría sin color en producción y perfecto
 * en desarrollo — el peor sitio donde puede aparecer un fallo.
 *
 * Libre y En domicilio eran antes dos dorados casi idénticos (#E5B242 y
 * #D69E26): a golpe de vista sobre el mapa no se distinguían, que es
 * justamente la pregunta que el mapa tiene que contestar. Libre pasa al
 * verde de éxito del sistema; el dorado de marca queda para quien trabaja.
 */
const STATE_COLOR: Record<FleetState, string> = {
 available: '#10B981',
 busy: '#D69E26',
 stale: '#7C8BA1',
 offline: '#7C8BA1',
};

/** Prioridad en la lista: primero lo que pide atención. */
const STATE_ORDER: Record<FleetState, number> = { stale: 0, busy: 1, available: 2, offline: 3 };

const ORDER_STAGE: Record<string, string> = {
 ready: 'Va a recoger',
 picked_up: 'Recogido',
 on_way: 'Rumbo al cliente',
};

type Filter = 'all' | FleetState;

const FILTERS: { key: Filter; label: string }[] = [
 { key: 'all', label: 'Todos' },
 { key: 'available', label: 'Libres' },
 { key: 'busy', label: 'En domicilio' },
 { key: 'stale', label: 'Sin señal' },
 { key: 'offline', label: 'Desconectados' },
];

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
 * Aplica al marcador todo lo que cambia con el tiempo: estado, selección y
 * hover. Un solo sitio para crear y actualizar evita que un marcador recién
 * creado y uno actualizado se pinten distinto.
 *
 * El nombre solo aparece al apuntar o al seleccionar: con quince marcadores
 * en el centro de Garzón, foto + nombre + estado en cada uno se tapaban
 * entre sí y el mapa dejaba de leerse.
 */
function paintMarker(el: HTMLElement, driver: FleetDriver, isSelected: boolean) {
 const state = fleetState(driver);
 const hover = el.dataset.hover === '1';

 el.style.opacity = state === 'stale' || state === 'offline' ? '0.6' : '1';
 el.style.zIndex = isSelected ? '3' : hover ? '2' : '1';

 const ring = el.querySelector<HTMLElement>('[data-role="ring"]');
 if (ring) {
 ring.style.borderColor = STATE_COLOR[state];
 // Punteado = "estaba aquí, ya no lo sé". Distingue sin señal de
 // desconectado sin añadir otro color.
 ring.style.borderStyle = state === 'stale' ? 'dashed' : 'solid';
 ring.style.transform = isSelected ? 'scale(1.25)' : 'scale(1)';
 }

 const label = el.querySelector<HTMLElement>('[data-role="label"]');
 if (label) label.style.opacity = isSelected || hover ? '1' : '0';
}

function buildMarker(driver: FleetDriver, onClick: () => void, onHover: () => void): HTMLElement {
 const el = document.createElement('button');
 el.type = 'button';
 el.title = driver.name;
 el.setAttribute('aria-label', driver.name);
 el.style.cssText = [
 'position:relative', 'background:transparent', 'border:none',
 'cursor:pointer', 'padding:0', 'transition:opacity .2s',
 ].join(';');

 const ring = document.createElement('div');
 ring.dataset.role = 'ring';
 ring.style.cssText = [
 'width:30px', 'height:30px', 'border-radius:15px', 'overflow:hidden',
 'border-width:3px', 'box-shadow:0 2px 6px rgba(0,0,0,.35)',
 'background:#7C8BA1', 'display:flex', 'align-items:center', 'justify-content:center',
 'transition:transform .15s ease-out',
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
 fallback.style.cssText = 'color:white;font-size:11px;font-weight:800;';
 ring.appendChild(fallback);
 }

 const label = document.createElement('span');
 label.dataset.role = 'label';
 label.textContent = driver.name.split(' ')[0] ?? driver.name;
 label.style.cssText = [
 'position:absolute', 'top:calc(100% + 6px)', 'left:50%', 'transform:translateX(-50%)',
 'white-space:nowrap', 'pointer-events:none', 'transition:opacity .15s',
 'font-size:11px', 'font-weight:700', 'color:#141B2A',
 // Halo de texto en vez de una píldora con fondo: se lee sobre
 // cualquier calle sin poner otra caja encima del mapa.
 'text-shadow:0 0 3px #fff,0 0 3px #fff,0 0 3px #fff',
 ].join(';');

 el.appendChild(ring);
 el.appendChild(label);
 el.addEventListener('click', onClick);
 el.addEventListener('mouseenter', () => { el.dataset.hover = '1'; onHover(); });
 el.addEventListener('mouseleave', () => { el.dataset.hover = '0'; onHover(); });
 return el;
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
 const [filter, setFilter] = useState<Filter>('all');
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
 /** Versión del mapa que ya se encuadró sobre la flota (una vez por mapa). */
 const fittedRef = useRef(0);
 /** Estado vigente para los listeners del marcador, que viven fuera de React. */
 const selectedRef = useRef<string | null>(null);
 const driversByIdRef = useRef<Record<string, FleetDriver>>({});

 const { data: config } = useQuery({
 queryKey: ['tracking', 'config'],
 queryFn: () => api.get('/tracking/config').then((r) => r.data.data),
 staleTime: Infinity,
 });

 const { data: fleet = [], refetch } = useQuery<FleetDriver[]>({
 queryKey: ['tracking', 'fleet'],
 queryFn: () => api.get('/tracking/fleet').then((r) => r.data.data),
 });

 useLiveReload(['drivers', 'orders'], () => void refetch());

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
 // "perdida", diga lo que diga la última carga REST.
 stale: false,
 };
 }),
 [fleet, live]
 );

 const counts = useMemo(() => {
 const c: Record<Filter, number> = { all: drivers.length, available: 0, busy: 0, stale: 0, offline: 0 };
 for (const d of drivers) c[fleetState(d)] += 1;
 return c;
 }, [drivers]);

 // Lo que pide atención va arriba: sin señal con pedido encima, porque es
 // un pedido del que nadie sabe dónde está.
 const visible = useMemo(
 () =>
 drivers
 .filter((d) => filter === 'all' || fleetState(d) === filter)
 .sort((a, b) => {
 const byState = STATE_ORDER[fleetState(a)] - STATE_ORDER[fleetState(b)];
 if (byState !== 0) return byState;
 const byOrder = Number(!!b.activeOrder) - Number(!!a.activeOrder);
 if (byOrder !== 0) return byOrder;
 return a.name.localeCompare(b.name, 'es');
 }),
 [drivers, filter]
 );

 const visibleIds = useMemo(() => new Set(visible.map((d) => d.id)), [visible]);
 const selectedDriver = drivers.find((d) => d.id === selected) ?? null;

 // ── Marcadores ──
 useEffect(() => {
 const map = mapRef.current;
 if (!map) return;

 selectedRef.current = selected;
 driversByIdRef.current = Object.fromEntries(drivers.map((d) => [d.id, d]));
 const seen = new Set<string>();

 for (const driver of drivers) {
 // El filtro también limpia el mapa: ver "Libres" en la lista y a
 // toda la flota en el mapa obligaría a cruzar dos cosas con la vista.
 if (!driver.location || (!visibleIds.has(driver.id) && driver.id !== selected)) continue;
 seen.add(driver.id);

 const position: [number, number] = [driver.location.lng, driver.location.lat];
 const existing = markersRef.current[driver.id];

 if (existing) {
 existing.setLngLat(position);
 paintMarker(existing.getElement(), driver, driver.id === selected);
 continue;
 }

 // El hover repinta solo ese marcador sin pasar por React: un
 // setState por cada mouseenter re-renderizaría la página entera.
 const el = buildMarker(
 driver,
 () => setSelected(driver.id),
 () => {
 const current = driversByIdRef.current[driver.id];
 if (current) paintMarker(el, current, selectedRef.current === driver.id);
 }
 );
 paintMarker(el, driver, driver.id === selected);

 markersRef.current[driver.id] = new mapboxgl.Marker({ element: el, anchor: 'center' })
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

 // Primer encuadre: la flota entera a la vista, no el centro fijo de
 // la ciudad. Solo una vez por mapa para no pelear con el despachador
 // cada vez que alguien se mueve.
 const located = drivers.filter((d) => d.location);
 if (fittedRef.current !== mapVersion && located.length > 0) {
 fittedRef.current = mapVersion;
 const bounds = new mapboxgl.LngLatBounds();
 for (const d of located) bounds.extend([d.location!.lng, d.location!.lat]);
 map.fitBounds(bounds, { padding: 80, maxZoom: 15, duration: 0 });
 }
 }, [drivers, visibleIds, selected, mapVersion]);

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

 if (config && !config.enabled) {
 return (
 <div className="animate-fade-in">
 <div className="page-header">
 <div>
 <h1 className="page-title">Flota en Vivo</h1>
 <p className="page-subtitle">Ubicación de los domiciliarios en tiempo real</p>
 </div>
 </div>
 <div className="p-16 text-center">
 <MapPin className="mx-auto mb-4 h-10 w-10 text-[var(--color-text-main)]" />
 <p className="text-base font-bold text-[var(--color-text-main)]">Mapa no configurado</p>
 <p className="mx-auto mt-2 max-w-md text-xs font-semibold text-[var(--color-text-secondary)]">
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
 {counts.all} en operación · {counts.busy} en domicilio · {counts.available} libres
 {counts.stale > 0 ? ` · ${counts.stale} sin señal` : ''}
 </p>
 </div>
 </div>

 {/* Filtros: también son la leyenda del mapa (punto = color del anillo). */}
 <nav className="mb-3 flex gap-5 overflow-x-auto border-b border-[var(--color-border)]" aria-label="Filtrar flota">
 {FILTERS.map((f) => {
 const active = filter === f.key;
 return (
 <button
 key={f.key}
 type="button"
 onClick={() => setFilter(f.key)}
 aria-pressed={active}
 className={`-mb-px flex shrink-0 cursor-pointer items-center gap-1.5 border-b-2 pb-2 text-xs transition ${
 active
 ? 'border-[var(--color-primary)] font-bold text-[var(--color-text-main)]'
 : 'border-transparent font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)]'
 }`}
 >
 {f.key !== 'all' ? (
 <span
 className="h-2 w-2 rounded-full"
 style={{
 background: f.key === 'stale' ? 'transparent' : STATE_COLOR[f.key],
 border: f.key === 'stale' ? `1.5px dashed ${STATE_COLOR.stale}` : 'none',
 }}
 />
 ) : null}
 {f.label}
 <span className="tabular-nums">{counts[f.key]}</span>
 </button>
 );
 })}
 </nav>

 {mapError ? (
 <div className="mb-3 flex items-start gap-3 text-xs text-[var(--color-danger)]">
 <WifiOff className="mt-0.5 h-4 w-4 shrink-0" />
 <span className="flex-1 font-semibold">{mapError}</span>
 </div>
 ) : null}

 <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
 <div ref={containerRef} className="min-h-75 flex-1 overflow-hidden" />

 <aside className="w-full shrink-0 overflow-y-auto border-t border-[var(--color-border)] lg:w-80 lg:border-t-0 lg:border-l">
 {selectedDriver ? (
 <DriverDetail
 driver={selectedDriver}
 onBack={() => setSelected(null)}
 onCenter={() => focus(selectedDriver)}
 />
 ) : visible.length === 0 ? (
 <p className="p-8 text-center text-xs font-semibold text-[var(--color-text-secondary)]">
 {drivers.length === 0
 ? 'No hay domiciliarios en operación ahora mismo.'
 : 'Nadie en este estado ahora mismo.'}
 </p>
 ) : (
 <ul className="divide-y divide-[var(--color-border)]">
 {visible.map((driver) => (
 <DriverRow key={driver.id} driver={driver} onSelect={() => focus(driver)} />
 ))}
 </ul>
 )}
 </aside>
 </div>
 </div>
 );
}

function Avatar({ driver, size }: { driver: FleetDriver; size: number }) {
 const state = fleetState(driver);
 return (
 <span
 className="flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-[var(--color-chart-titanium)] font-extrabold text-white"
 style={{
 width: size,
 height: size,
 fontSize: Math.round(size * 0.36),
 border: `${size > 40 ? 3 : 2}px ${state === 'stale' ? 'dashed' : 'solid'} ${STATE_COLOR[state]}`,
 }}
 >
 {driver.avatar ? <img src={driver.avatar} alt="" className="h-full w-full object-cover" /> : initials(driver.name)}
 </span>
 );
}

function DriverRow({ driver, onSelect }: { driver: FleetDriver; onSelect: () => void }) {
 const state = fleetState(driver);
 const lostWithOrder = state === 'stale' && driver.activeOrder;

 return (
 <li>
 <button
 type="button"
 onClick={onSelect}
 className="flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left transition hover:bg-[var(--color-surface-hover)]"
 >
 <Avatar driver={driver} size={32} />
 <span className="min-w-0 flex-1">
 <span className="block truncate text-sm font-bold text-[var(--color-text-main)]">{driver.name}</span>
 <span className="mt-0.5 block truncate text-xs font-semibold text-[var(--color-text-secondary)]">
 <span style={{ color: lostWithOrder ? 'var(--color-danger)' : undefined }}>
 {lostWithOrder ? 'Sin señal con pedido' : STATE_LABEL[state]}
 </span>
 {driver.activeOrder ? ` · #${driver.activeOrder.orderNumber}` : ''}
 </span>
 </span>
 <span className="shrink-0 text-[11px] font-semibold tabular-nums text-[var(--color-text-secondary)]">
 {minutesAgo(driver.lastSeenAt)}
 </span>
 </button>
 </li>
 );
}

function DriverDetail({
 driver,
 onBack,
 onCenter,
}: {
 driver: FleetDriver;
 onBack: () => void;
 onCenter: () => void;
}) {
 const state = fleetState(driver);
 const lowBattery = driver.batteryLevel !== null && driver.batteryLevel < 20;
 // La velocidad de un repartidor sin señal es la de hace minutos: mostrarla
 // sugeriría que sigue moviéndose.
 const speedKmh = state !== 'stale' && driver.speed !== null ? Math.round(driver.speed * 3.6) : null;

 const rows: { label: string; value: ReactNode }[] = [
 { label: 'Última señal', value: minutesAgo(driver.lastSeenAt) },
 {
 label: 'Vehículo',
 value: `${vehicleLabel(driver.vehicleType)}${driver.licensePlate ? ` · ${driver.licensePlate}` : ''}`,
 },
 {
 label: 'Batería',
 value:
 driver.batteryLevel === null ? (
 'sin datos'
 ) : (
 <span className={`inline-flex items-center gap-1 ${lowBattery ? 'text-[var(--color-danger)]' : ''}`}>
 {lowBattery ? <BatteryLow className="h-3.5 w-3.5" /> : null}
 {Math.round(driver.batteryLevel)}%
 </span>
 ),
 },
 { label: 'Velocidad', value: speedKmh === null ? '—' : `${speedKmh} km/h` },
 {
 label: 'Teléfono',
 value: driver.phone ? (
 <a href={`tel:${driver.phone}`} className="underline-offset-2 hover:underline">
 {driver.phone}
 </a>
 ) : (
 '—'
 ),
 },
 ];

 return (
 <div className="px-5 py-4">
 <button
 type="button"
 onClick={onBack}
 className="flex cursor-pointer items-center gap-1.5 text-xs font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)]"
 >
 <ArrowLeft className="h-3.5 w-3.5" />
 Toda la flota
 </button>

 <div className="mt-5 flex items-center gap-3">
 <Avatar driver={driver} size={52} />
 <div className="min-w-0">
 <EntityLink type="driver" id={driver.id} className="block truncate text-base font-bold text-[var(--color-text-main)]">
 {driver.name}
 </EntityLink>
 <p className="mt-0.5 flex items-center gap-1.5 text-xs font-bold" style={{ color: state === 'stale' || state === 'offline' ? 'var(--color-text-secondary)' : STATE_COLOR[state] }}>
 {state === 'stale' ? <WifiOff className="h-3.5 w-3.5" /> : null}
 {STATE_LABEL[state]}
 </p>
 </div>
 </div>

 {driver.activeOrder ? (
 <div className="mt-6">
 <p className="text-[10px] font-bold uppercase tracking-widest text-[var(--color-text-secondary)]">Pedido activo</p>
 <EntityLink type="order" id={driver.activeOrder.id} className="mt-1 block text-lg font-bold tabular-nums text-[var(--color-text-main)]">
 #{driver.activeOrder.orderNumber}
 </EntityLink>
 <p className="text-xs font-semibold text-[var(--color-text-secondary)]">
 {ORDER_STAGE[driver.activeOrder.status] ?? driver.activeOrder.status}
 </p>
 </div>
 ) : null}

 <dl className="mt-6 divide-y divide-[var(--color-border)] border-t border-[var(--color-border)]">
 {rows.map((row) => (
 <div key={row.label} className="flex items-center justify-between gap-3 py-2.5 text-xs">
 <dt className="font-semibold text-[var(--color-text-secondary)]">{row.label}</dt>
 <dd className="text-right font-bold tabular-nums text-[var(--color-text-main)]">{row.value}</dd>
 </div>
 ))}
 </dl>

 {driver.location ? (
 <button
 type="button"
 onClick={onCenter}
 className="mt-6 flex cursor-pointer items-center gap-1.5 text-xs font-bold text-[var(--color-primary)] hover:underline"
 >
 <LocateFixed className="h-3.5 w-3.5" />
 Centrar en el mapa
 </button>
 ) : null}
 </div>
 );
}
