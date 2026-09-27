import { useEffect, useRef, useState } from 'react';
import {
 MapPin, Plus, Search, X, AlertCircle, Pencil, Trash2, Layers, ArrowUpDown,
} from 'lucide-react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet-draw';
import 'leaflet-draw/dist/leaflet.draw.css';
import api from '../services/api';
import { Permission } from '../lib/permissions';
import { PermissionGate } from '../components/PermissionGate';
import ConfirmDialog from '../components/ConfirmDialog';
import { apiFieldMessage, apiMessage } from '../lib/apiError';

interface Zone {
 _id: string;
 name: string;
 city: string;
 area: { type: 'Polygon'; coordinates: number[][][] };
 baseFee: number | null;
 perKm: number | null;
 surcharge: number;
 minOrder: number;
 priority: number;
 isActive: boolean;
 updatedAt: string;
}

interface ZoneVersion {
 version: number;
 baseFee: number | null;
 perKm: number | null;
 surcharge: number;
 minOrder: number;
 changeReason?: string;
 changedByName?: string;
 changedAt: string;
}

interface ZoneForm {
 name: string;
 city: string;
 baseFee: string; // vacío = null = usa la tarifa global
 perKm: string;
 surcharge: number;
 minOrder: number;
 priority: number;
 isActive: boolean;
}

/** Centro por defecto del mapa; no es una regla de negocio. */
const DEFAULT_CENTER: [number, number] = [2.1975, -75.6289];
const DEFAULT_ZOOM = 14;

const cop = (n: number) => `$${(n || 0).toLocaleString('es-CO')}`;

const emptyForm = (): ZoneForm => ({
 name: '', city: 'Garzón', baseFee: '', perKm: '',
 surcharge: 0, minOrder: 0, priority: 0, isActive: true,
});

/** GeoJSON [lng, lat], cerrado → pares [lat, lng] para Leaflet, sin el punto de cierre. */
function geoJsonToLatLngs(coordinates: number[][][]): L.LatLngExpression[] {
 const ring = coordinates[0] ?? [];
 const open = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
 ? ring.slice(0, -1)
 : ring;
 return open.map(([lng, lat]) => [lat, lng]);
}

export default function Zones() {
 const [zones, setZones] = useState<Zone[]>([]);
 const [loading, setLoading] = useState(true);
 const [error, setError] = useState('');
 const [search, setSearch] = useState('');

 const [showModal, setShowModal] = useState(false);
 const [editingId, setEditingId] = useState<string | null>(null);
 const [form, setForm] = useState<ZoneForm>(emptyForm());
 const [polygonError, setPolygonError] = useState('');
 const [confirmDelete, setConfirmDelete] = useState<Zone | null>(null);
 const [reason, setReason] = useState('');
 const [original, setOriginal] = useState<Zone | null>(null);
 const [history, setHistory] = useState<{ zone: Zone; versions: ZoneVersion[] } | null>(null);

 // El mapa vive fuera de React: Leaflet es dueño del DOM dentro de este div.
 const mapContainerRef = useRef<HTMLDivElement | null>(null);
 const mapRef = useRef<L.Map | null>(null);
 const drawnItemsRef = useRef<L.FeatureGroup | null>(null);

 const fetchAll = async () => {
 try {
 setLoading(true);
 setError('');
 const { data } = await api.get('/zones/admin');
 setZones(data.data);
 } catch (err) {
 console.error(err);
 setError('No se pudieron cargar las zonas de cobertura.');
 } finally {
 setLoading(false);
 }
 };

 useEffect(() => { fetchAll(); }, []);

 // ── Mapa: se crea al abrir el modal y se destruye al cerrarlo ──
 useEffect(() => {
 if (!showModal || !mapContainerRef.current) return;

 const map = L.map(mapContainerRef.current).setView(DEFAULT_CENTER, DEFAULT_ZOOM);
 mapRef.current = map;

 L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
 attribution: '&copy; OpenStreetMap',
 maxZoom: 19,
 }).addTo(map);

 const drawnItems = new L.FeatureGroup();
 drawnItemsRef.current = drawnItems;
 map.addLayer(drawnItems);

 if (editingId) {
 const zone = zones.find((z) => z._id === editingId);
 if (zone) {
 const layer = L.polygon(geoJsonToLatLngs(zone.area.coordinates));
 drawnItems.addLayer(layer);
 map.fitBounds(layer.getBounds(), { padding: [30, 30] });
 }
 }

 // Sólo polígonos: una zona es un área, no un punto ni una línea. Y sólo
 // uno a la vez — el modelo guarda un único polígono por zona.
 // `@types/leaflet-draw` ya está instalado y amplía el namespace `L`
 // a través del `import 'leaflet-draw'` de arriba, así que los `as any`
 // que había aquí no compraban nada: solo apagaban la comprobación de
 // las opciones del control, que es justo donde una errata (`polygone`)
 // no da error y deja el dibujo de zonas sin funcionar.
 const drawControl = new L.Control.Draw({
 draw: {
 polygon: {
 allowIntersection: false,
 showArea: true,
 shapeOptions: { color: '#D69E26' },
 },
 marker: false, circle: false, circlemarker: false,
 rectangle: false, polyline: false,
 },
 edit: { featureGroup: drawnItems, remove: true },
 });
 map.addControl(drawControl);

 map.on(L.Draw.Event.CREATED, (e) => {
 // Reemplaza cualquier polígono anterior: uno solo por zona.
 drawnItems.clearLayers();
 drawnItems.addLayer(e.layer);
 setPolygonError('');
 });
 map.on(L.Draw.Event.DELETED, () => setPolygonError(''));

 // El modal anima su entrada; Leaflet calcula su tamaño en el frame en que
 // se monta, y si el contenedor todavía mide 0 el mapa queda cortado.
 setTimeout(() => map.invalidateSize(), 80);

 return () => {
 map.remove();
 mapRef.current = null;
 drawnItemsRef.current = null;
 };
 // eslint-disable-next-line react-hooks/exhaustive-deps
 }, [showModal, editingId]);

 const openCreate = () => {
 setEditingId(null);
 setOriginal(null);
 setReason('');
 setForm(emptyForm());
 setPolygonError('');
 setShowModal(true);
 };

 const openEdit = (z: Zone) => {
 setEditingId(z._id);
 setOriginal(z);
 setReason('');
 setForm({
 name: z.name, city: z.city,
 baseFee: z.baseFee === null ? '' : String(z.baseFee),
 perKm: z.perKm === null ? '' : String(z.perKm),
 surcharge: z.surcharge, minOrder: z.minOrder,
 priority: z.priority, isActive: z.isActive,
 });
 setPolygonError('');
 setShowModal(true);
 };

 const handleSubmit = async (e: React.FormEvent) => {
 e.preventDefault();

 const layers = drawnItemsRef.current?.getLayers() ?? [];
 if (layers.length === 0) {
 setPolygonError('Dibuja el polígono de la zona en el mapa antes de guardar.');
 return;
 }

 const geoJson = (layers[0] as L.Polygon).toGeoJSON();
 const coordinates = (geoJson.geometry as GeoJSON.Polygon).coordinates;

 const tariffChanged =
 !!editingId &&
 !!original &&
 (original.baseFee !== (form.baseFee === '' ? null : Number(form.baseFee)) ||
 original.perKm !== (form.perKm === '' ? null : Number(form.perKm)) ||
 original.surcharge !== Number(form.surcharge) ||
 original.minOrder !== Number(form.minOrder));
 if (tariffChanged && reason.trim().length < 5) {
 setPolygonError('Cambiaste una tarifa: escribe el motivo (mínimo 5 caracteres). Queda en el historial de la zona.');
 return;
 }

 const payload = {
 ...(reason.trim() ? { reason: reason.trim() } : {}),
 name: form.name.trim(),
 city: form.city.trim(),
 coordinates,
 baseFee: form.baseFee === '' ? null : Number(form.baseFee),
 perKm: form.perKm === '' ? null : Number(form.perKm),
 surcharge: Number(form.surcharge),
 minOrder: Number(form.minOrder),
 priority: Number(form.priority),
 isActive: form.isActive,
 };

 try {
 setError('');
 setPolygonError('');
 if (editingId) await api.patch(`/zones/${editingId}`, payload);
 else await api.post('/zones', payload);
 setShowModal(false);
 fetchAll();
 } catch (err) {
 setError(apiFieldMessage(err) ?? apiMessage(err, 'No se pudo guardar la zona.'));
 }
 };

 const openHistory = async (z: Zone) => {
 try {
 setError('');
 const { data } = await api.get(`/zones/${z._id}/versions`);
 setHistory({ zone: z, versions: data.data?.versions ?? [] });
 } catch (err) {
 setError(apiMessage(err, 'No se pudo cargar el historial de la zona.'));
 }
 };

 const handleDelete = async () => {
 if (!confirmDelete) return;
 try {
 await api.delete(`/zones/${confirmDelete._id}`);
 setZones((prev) => prev.filter((z) => z._id !== confirmDelete._id));
 setConfirmDelete(null);
 } catch (err) {
 setError(apiMessage(err, 'No se pudo eliminar la zona.'));
 setConfirmDelete(null);
 }
 };

 const filtered = zones.filter(
 (z) =>
 z.name.toLowerCase().includes(search.toLowerCase()) ||
 z.city.toLowerCase().includes(search.toLowerCase())
 );

 const inputClass = 'w-full h-10 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] px-3.5 text-xs font-medium text-[var(--color-text-main)] focus:border-[var(--color-primary)] focus:bg-[var(--color-surface)] focus:outline-none transition-all placeholder:text-[var(--color-text-main)]';
 const labelClass = 'block text-[11px] font-bold text-[var(--color-text-main)] uppercase tracking-wider mb-1.5';

 return (
 <div className="space-y-3 animate-fade-in">
 <div className="page-header">
 <div>
 <h1 className="page-title">Zonas de Cobertura</h1>
 <p className="page-subtitle">Polígonos que definen tarifa y pedido mínimo por sector</p>
 </div>
 <PermissionGate permission={Permission.ZONES_MANAGE}>
 <button
 onClick={openCreate}
 className="px-4 py-2 bg-[var(--color-primary)] hover:bg-[#8A5D08] text-xs font-bold text-white rounded-lg transition-all shadow-xs cursor-pointer flex items-center justify-center gap-2"
 >
 <Plus className="w-4 h-4" />
 <span>Nueva Zona</span>
 </button>
 </PermissionGate>
 </div>

 <div className="flex flex-col md:flex-row gap-2.5 justify-between items-center pb-4 border-b border-[var(--color-border-light)]">
 <div className="relative w-full md:w-80">
 <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-main)]" />
 <input
 type="text"
 value={search}
 onChange={(e) => setSearch(e.target.value)}
 placeholder="Buscar por nombre o ciudad..."
 className="w-full h-10 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] pl-9 pr-4 text-xs font-medium text-[var(--color-text-main)] placeholder-[var(--color-text-muted)] focus:border-[var(--color-primary)] focus:bg-[var(--color-surface)] focus:outline-none transition-all"
 />
 </div>
 <p className="text-[11px] text-[var(--color-text-main)] font-medium flex items-center gap-1.5">
 <ArrowUpDown className="w-3.5 h-3.5" />
 Cuando dos zonas se superponen, gana la de mayor prioridad
 </p>
 </div>

 {error && (
 <div className="text-[var(--color-danger)] text-xs flex items-start gap-3">
 <AlertCircle className="w-4 h-4 text-[var(--color-danger)] shrink-0 mt-0.5" />
 <p className="flex-1 font-semibold">{error}</p>
 </div>
 )}

 {loading ? (
 <div className="table-container p-16 text-center text-[var(--color-text-main)] text-xs font-semibold">
 Cargando zonas...
 </div>
 ) : filtered.length === 0 ? (
 <div className="table-container p-16 text-center space-y-1">
 <p className="text-sm font-bold text-[var(--color-text-main)]">No hay zonas configuradas</p>
 <p className="text-xs text-[var(--color-text-main)]">
 Sin zonas, toda la cobertura usa las tarifas y el pedido mínimo globales.
 </p>
 </div>
 ) : (
 <div className="grid gap-2.5">
 {filtered.map((z) => (
 <div key={z._id} className="zipp-card p-5 flex flex-col md:flex-row md:items-center justify-between gap-2.5">
 <div className="min-w-0 space-y-1.5">
 <div className="flex flex-wrap items-center gap-2.5">
 <div className="w-8 h-8 rounded-lg bg-[var(--color-primary-bg)] text-[var(--color-primary)] flex items-center justify-center shrink-0">
 <MapPin className="w-4 h-4" />
 </div>
 <h3 className="text-base font-bold text-[var(--color-text-main)]">{z.name}</h3>
 <span className="text-[10px] px-2 py-0.5 rounded-md font-bold uppercase tracking-wider bg-[var(--color-bg-alt)] text-[var(--color-text-main)]">
 {z.city}
 </span>
 <span
 className="text-[10px] px-2 py-0.5 rounded-md font-bold uppercase tracking-wider"
 style={z.isActive ? { backgroundColor: '#FDF7E7', color: '#D69E26' } : { backgroundColor: '#EDF1F5', color: '#0B0F19' }}
 >
 {z.isActive ? 'Activa' : 'Inactiva'}
 </span>
 </div>
 <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--color-text-main)] pl-11">
 <span>Base: {z.baseFee === null ? 'tarifa global' : cop(z.baseFee)}</span>
 <span>Km: {z.perKm === null ? 'tarifa global' : cop(z.perKm)}</span>
 {z.surcharge > 0 && <span>Recargo {cop(z.surcharge)}</span>}
 {z.minOrder > 0 && <span>Mínimo {cop(z.minOrder)}</span>}
 <span className="flex items-center gap-1">
 <Layers className="w-3 h-3" /> Prioridad {z.priority}
 </span>
 </div>
 </div>

 <div className="flex items-center gap-1.5 shrink-0">
 <button
 onClick={() => openHistory(z)}
 title="Historial de tarifas"
 className="px-2 py-1.5 rounded-lg text-[11px] font-semibold text-[var(--color-text-main)] hover:text-[var(--color-primary)] cursor-pointer"
 >
 Historial
 </button>
 <PermissionGate permission={Permission.ZONES_MANAGE}>
 <button
 onClick={() => openEdit(z)}
 title="Editar"
 className="p-2 rounded-lg text-[var(--color-text-main)] hover:text-[var(--color-primary)] hover:bg-[var(--color-bg)] transition-colors cursor-pointer"
 >
 <Pencil className="w-4 h-4" />
 </button>
 </PermissionGate>
 <button
 onClick={() => setConfirmDelete(z)}
 title="Eliminar"
 className="p-2 rounded-lg text-[var(--color-text-main)] hover:text-[var(--color-danger)] hover:bg-[var(--color-bg)] transition-colors cursor-pointer"
 >
 <Trash2 className="w-4 h-4" />
 </button>
 </div>
 </div>
 ))}
 </div>
 )}

 {showModal && (
 <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4 animate-fade-in">
 <div className="Zipp-modal w-full max-w-3xl rounded-2xl p-6 space-y-3 max-h-[92vh] overflow-y-auto">
 <div className="flex justify-between items-center border-b border-[var(--color-border-light)] pb-4">
 <div className="flex items-center gap-2">
 <MapPin className="w-5 h-5 text-[var(--color-primary)]" />
 <h3 className="text-base font-bold text-[var(--color-text-main)]">
 {editingId ? 'Editar Zona' : 'Nueva Zona de Cobertura'}
 </h3>
 </div>
 <button onClick={() => setShowModal(false)} className="text-[var(--color-text-main)] hover:text-[var(--color-text-main)] p-1 rounded-lg cursor-pointer">
 <X className="w-5 h-5" />
 </button>
 </div>

 <form onSubmit={handleSubmit} className="space-y-2.5">
 <div>
 <label className={labelClass}>Dibuja el polígono de la zona</label>
 <div
 ref={mapContainerRef}
 className="w-full h-72 rounded-xl border border-[var(--color-border)] overflow-hidden"
 />
 <p className="text-[10px] text-[var(--color-text-main)] mt-1.5">
 Usa el ícono de polígono de la esquina superior izquierda del mapa. Dibujar uno nuevo reemplaza al anterior.
 </p>
 {polygonError && (
 <p className="text-[11px] text-[var(--color-danger)] font-semibold mt-1.5">{polygonError}</p>
 )}
 </div>

 <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
 <div>
 <label className={labelClass}>Nombre de la Zona</label>
 <input type="text" required minLength={2} maxLength={80} value={form.name}
 onChange={(e) => setForm({ ...form, name: e.target.value })}
 className={inputClass} placeholder="Ej. Centro, La Vega" />
 </div>
 <div>
 <label className={labelClass}>Ciudad</label>
 <input type="text" required maxLength={80} value={form.city}
 onChange={(e) => setForm({ ...form, city: e.target.value })}
 className={inputClass} />
 </div>
 </div>

 <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
 <div>
 <label className={labelClass}>Tarifa Base (opcional)</label>
 <input type="number" min={0} value={form.baseFee}
 onChange={(e) => setForm({ ...form, baseFee: e.target.value })}
 className={inputClass + ' font-mono'} placeholder="Vacío = tarifa global" />
 </div>
 <div>
 <label className={labelClass}>Valor por Km (opcional)</label>
 <input type="number" min={0} value={form.perKm}
 onChange={(e) => setForm({ ...form, perKm: e.target.value })}
 className={inputClass + ' font-mono'} placeholder="Vacío = tarifa global" />
 </div>
 </div>

 <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
 <div>
 <label className={labelClass}>Recargo</label>
 <input type="number" min={0} value={form.surcharge}
 onChange={(e) => setForm({ ...form, surcharge: Number(e.target.value) })}
 className={inputClass + ' font-mono'} placeholder="0" />
 </div>
 <div>
 <label className={labelClass}>Pedido Mínimo</label>
 <input type="number" min={0} value={form.minOrder}
 onChange={(e) => setForm({ ...form, minOrder: Number(e.target.value) })}
 className={inputClass + ' font-mono'} placeholder="0" />
 </div>
 <div>
 <label className={labelClass}>Prioridad</label>
 <input type="number" value={form.priority}
 onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })}
 className={inputClass + ' font-mono'} />
 </div>
 </div>

 {editingId && (
 <div>
 <label className={labelClass}>Motivo del cambio de tarifa</label>
 <input type="text" value={reason} maxLength={300}
 onChange={(e) => setReason(e.target.value)}
 className={inputClass} placeholder="Obligatorio si cambias base, km, recargo o mínimo" />
 </div>
 )}

 <label className="flex items-center gap-2.5 cursor-pointer w-fit">
 <input type="checkbox" checked={form.isActive}
 onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
 className="w-4 h-4 rounded accent-[var(--color-primary)] cursor-pointer" />
 <span className="text-xs font-semibold text-[var(--color-text-main)]">Zona activa</span>
 </label>

 <button
 type="submit"
 className="w-full h-11 bg-[var(--color-primary)] hover:bg-[#8A5D08] text-white font-bold text-xs uppercase tracking-wider rounded-lg shadow-sm cursor-pointer mt-2"
 >
 {editingId ? 'Guardar Cambios' : 'Crear Zona'}
 </button>
 </form>
 </div>
 </div>
 )}

 {history && (
 <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4 animate-fade-in">
 <div className="zipp-modal w-full max-w-xl rounded-2xl p-6 space-y-3 max-h-[85vh] overflow-y-auto">
 <div className="flex items-start justify-between gap-3 border-b border-[var(--color-border-light)] pb-3">
 <div>
 <h3 className="text-base font-bold text-[var(--color-text-main)]">Historial de tarifas</h3>
 <p className="text-xs text-[var(--color-text-main)]">{history.zone.name} · cada pedido guarda la versión que usó</p>
 </div>
 <button onClick={() => setHistory(null)} aria-label="Cerrar" className="cursor-pointer p-1 text-[var(--color-text-main)]">
 <X className="w-5 h-5" />
 </button>
 </div>
 <ul className="divide-y divide-[var(--color-border-light)] text-xs">
 {history.versions.map((v) => (
 <li key={v.version} className="space-y-0.5 py-3">
 <p className="font-bold text-[var(--color-text-main)]">
 Versión {v.version} · {new Date(v.changedAt).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' })}
 {v.changedByName ? ` · ${v.changedByName}` : ''}
 </p>
 <p className="text-[var(--color-text-main)]">
 Base {v.baseFee === null ? 'global' : cop(v.baseFee)} · Km {v.perKm === null ? 'global' : cop(v.perKm)} · Recargo {cop(v.surcharge)} · Mínimo {cop(v.minOrder)}
 </p>
 {v.changeReason && <p className="text-[var(--color-text-main)]">Motivo: {v.changeReason}</p>}
 </li>
 ))}
 {history.versions.length === 0 && <li className="py-6 text-center text-[var(--color-text-main)]">Sin versiones registradas.</li>}
 </ul>
 </div>
 </div>
 )}

 {confirmDelete && (
 <ConfirmDialog
 title="Eliminar zona"
 message={`"${confirmDelete.name}" dejará de aplicar tarifa y pedido mínimo propios. Las direcciones dentro de su polígono pasarán a usar la configuración global o la de otra zona superpuesta.`}
 confirmLabel="Eliminar"
 variant="danger"
 onConfirm={handleDelete}
 onCancel={() => setConfirmDelete(null)}
 />
 )}
 </div>
 );
}
