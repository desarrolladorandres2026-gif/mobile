import { useEffect, useRef, useState } from 'react';
import {
 Images, Plus, Search, X, AlertCircle, Trash2, Pencil, GripVertical,
 ToggleLeft, ToggleRight, ImagePlus, Link2, Store, Ban, LayoutGrid,
 MonitorSmartphone, Timer, ArrowRight,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import api from '../services/api';
import { Permission } from '../lib/permissions';
import { PermissionGate } from '../components/PermissionGate';
import { useAuthStore } from '../stores/authStore';
import { sizedImage } from '../lib/cloudinary';
import { fetchBusinessOptions } from '../lib/businessOptions';
import ConfirmDialog from '../components/ConfirmDialog';
import { apiMessage } from '../lib/apiError';
import CuratedHomeBlocks from './CuratedHomeBlocks';

type BannerStatus = 'active' | 'scheduled' | 'expired' | 'inactive';
type ActionType = 'none' | 'url' | 'business' | 'category' | 'screen' | 'search';
type Placement = 'home' | 'all';

interface Banner {
 _id: string;
 imageUrl: string;
 title: string;
 description: string;
 buttonText: string;
 actionType: ActionType;
 actionValue: string;
 displayOrder: number;
 durationSeconds: number;
 startDate: string;
 endDate: string;
 isActive: boolean;
 priority: number;
 placement: Placement;
 homeOrder: number | null;
 status: BannerStatus;
}

interface BannerForm {
 imageUrl: string;
 title: string;
 description: string;
 buttonText: string;
 actionType: ActionType;
 actionValue: string;
 durationSeconds: number;
 startDate: string;
 endDate: string;
 isActive: boolean;
 priority: number;
 placement: Placement;
 homeOrder: number | null;
}

/**
 * Listas cerradas del formulario. No se escriben aquí: las sirve
 * `GET /promotion-banners/options`, que es la misma fuente que el backend
 * usa para validar. Duplicarlas en el panel es cómo se termina ofreciendo
 * una opción que la API rechaza.
 */
interface BannerOptions {
 actionTypes: { key: ActionType; label: string }[];
 placements: { key: Placement; label: string }[];
 screens: { key: string; label: string }[];
 categories: string[];
 duration: { min: number; max: number; default: number };
}

const CATEGORY_LABELS: Record<string, string> = {
 restaurant: 'Restaurantes',
 fast_food: 'Comidas rápidas',
 pharmacy: 'Droguerías',
 cafe: 'Cafeterías',
 supermarket: 'Mercados',
};

const ACTION_ICONS: Record<ActionType, typeof Ban> = {
 none: Ban,
 url: Link2,
 business: Store,
 category: LayoutGrid,
 screen: MonitorSmartphone,
 search: Search,
};

const STATUS_STYLES: Record<BannerStatus, { label: string; bg: string; text: string }> = {
 active: { label: 'Activo', bg: '#FDF7E7', text: '#D69E26' },
 scheduled: { label: 'Programado', bg: '#FDF7E7', text: '#D69E26' },
 expired: { label: 'Vencido', bg: '#FEF3C7', text: '#F59E0B' },
 inactive: { label: 'Inactivo', bg: '#EDF1F5', text: '#0B0F19' },
};

const STATUS_TABS: { id: 'all' | BannerStatus; label: string }[] = [
 { id: 'all', label: 'Todos' },
 { id: 'active', label: 'Activos' },
 { id: 'scheduled', label: 'Programados' },
 { id: 'expired', label: 'Vencidos' },
 { id: 'inactive', label: 'Inactivos' },
];

const toDatetimeLocal = (iso: string) => {
 const d = new Date(iso);
 const pad = (n: number) => String(n).padStart(2, '0');
 return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const emptyForm = (duration: number): BannerForm => {
 const now = new Date();
 const inAMonth = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
 return {
 imageUrl: '', title: '', description: '', buttonText: '',
 actionType: 'none', actionValue: '',
 durationSeconds: duration,
 startDate: toDatetimeLocal(now.toISOString()),
 endDate: toDatetimeLocal(inAMonth.toISOString()),
 isActive: true, priority: 0, placement: 'home', homeOrder: null,
 };
};

type PanelTab = 'banners' | 'blocks';

export default function HomeBanners() {
 const [tab, setTab] = useState<PanelTab>('banners');

 return (
 <div className="space-y-3 animate-fade-in">
 <div className="flex gap-1.5">
 <button
 onClick={() => setTab('banners')}
 className={`px-4 py-2 text-xs font-bold whitespace-nowrap transition-all cursor-pointer border-b-2 ${tab === 'banners'
 ? 'border-[var(--color-primary)] text-[var(--color-primary)]'
 : 'border-transparent text-[var(--color-text-main)] hover:text-[var(--color-text-main)]'
 }`}
 >
 Banners de Inicio
 </button>
 <button
 onClick={() => setTab('blocks')}
 className={`px-4 py-2 text-xs font-bold whitespace-nowrap transition-all cursor-pointer border-b-2 ${tab === 'blocks'
 ? 'border-[var(--color-primary)] text-[var(--color-primary)]'
 : 'border-transparent text-[var(--color-text-main)] hover:text-[var(--color-text-main)]'
 }`}
 >
 Bloques Curados
 </button>
 </div>

 {tab === 'banners' ? <PromotionBannersPanel /> : <CuratedHomeBlocks />}
 </div>
 );
}

function PromotionBannersPanel() {
 const canManage = useAuthStore((s) => s.hasPermission(Permission.CONTENT_MANAGE));
 const queryClient = useQueryClient();
 const [banners, setBanners] = useState<Banner[]>([]);
 const [options, setOptions] = useState<BannerOptions | null>(null);
 const [businesses, setBusinesses] = useState<{ _id: string; name: string }[]>([]);
 const [loading, setLoading] = useState(true);
 const [error, setError] = useState('');
 const [search, setSearch] = useState('');
 const [statusFilter, setStatusFilter] = useState<'all' | BannerStatus>('all');

 const [showModal, setShowModal] = useState(false);
 const [editingId, setEditingId] = useState<string | null>(null);
 const [form, setForm] = useState<BannerForm>(emptyForm(5));
 const [uploading, setUploading] = useState(false);
 const [confirmDelete, setConfirmDelete] = useState<Banner | null>(null);

 const dragId = useRef<string | null>(null);
 const [dragOverId, setDragOverId] = useState<string | null>(null);

 const fetchAll = async () => {
 try {
 setLoading(true);
 setError('');
 const [resBanners, resOptions, resBiz] = await Promise.all([
 api.get('/promotion-banners?limit=100'),
 api.get('/promotion-banners/options'),
 fetchBusinessOptions(queryClient),
 ]);
 setBanners(resBanners.data.data);
 setOptions(resOptions.data.data);
 setBusinesses(resBiz.data.data);
 } catch (err) {
 console.error(err);
 setError('No se pudieron cargar los banners de inicio.');
 } finally {
 setLoading(false);
 }
 };

 useEffect(() => {
 fetchAll();
 }, []);

 const openCreate = () => {
 setEditingId(null);
 setForm(emptyForm(options?.duration.default ?? 5));
 setShowModal(true);
 };

 const openEdit = (b: Banner) => {
 setEditingId(b._id);
 setForm({
 imageUrl: b.imageUrl,
 title: b.title || '',
 description: b.description || '',
 buttonText: b.buttonText || '',
 actionType: b.actionType,
 actionValue: b.actionValue || '',
 durationSeconds: b.durationSeconds,
 startDate: toDatetimeLocal(b.startDate),
 endDate: toDatetimeLocal(b.endDate),
 isActive: b.isActive,
 priority: b.priority,
 placement: b.placement,
 homeOrder: b.homeOrder,
 });
 setShowModal(true);
 };

 const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
 const file = e.target.files?.[0];
 if (!file) return;
 setUploading(true);
 setError('');
 try {
 const fd = new FormData();
 fd.append('image', file);
 const { data } = await api.post('/promotion-banners/upload', fd, {
 headers: { 'Content-Type': undefined },
 });
 setForm((f) => ({ ...f, imageUrl: data.data.url }));
 } catch (err) {
 setError(apiMessage(err, 'No se pudo subir la imagen.'));
 } finally {
 setUploading(false);
 e.target.value = '';
 }
 };

 const handleSubmit = async (e: React.FormEvent) => {
 e.preventDefault();
 if (!form.imageUrl) {
 setError('Sube una imagen antes de guardar el banner.');
 return;
 }
 const payload = {
 imageUrl: form.imageUrl,
 title: form.title,
 description: form.description,
 buttonText: form.buttonText,
 actionType: form.actionType,
 actionValue: form.actionType === 'none' ? '' : form.actionValue,
 durationSeconds: Number(form.durationSeconds),
 startDate: new Date(form.startDate).toISOString(),
 endDate: new Date(form.endDate).toISOString(),
 isActive: form.isActive,
 priority: Number(form.priority),
 placement: form.placement,
 homeOrder: form.homeOrder === null || form.homeOrder === undefined || Number.isNaN(form.homeOrder)
 ? null
 : Number(form.homeOrder),
 };
 try {
 setError('');
 if (editingId) {
 await api.patch(`/promotion-banners/${editingId}`, payload);
 } else {
 await api.post('/promotion-banners', payload);
 }
 setShowModal(false);
 fetchAll();
 } catch (err) {
 setError(apiMessage(err, 'No se pudo guardar el banner.'));
 }
 };

 const handleToggle = async (b: Banner) => {
 try {
 const { data } = await api.patch(`/promotion-banners/${b._id}/toggle`);
 setBanners((prev) => prev.map((x) => (x._id === b._id ? data.data : x)));
 } catch (err) {
 setError(apiMessage(err, 'No se pudo cambiar el estado del banner.'));
 }
 };

 const handleDelete = async () => {
 if (!confirmDelete) return;
 try {
 await api.delete(`/promotion-banners/${confirmDelete._id}`);
 setBanners((prev) => prev.filter((b) => b._id !== confirmDelete._id));
 setConfirmDelete(null);
 } catch (err) {
 setError(apiMessage(err, 'No se pudo eliminar el banner.'));
 setConfirmDelete(null);
 }
 };

 /**
 * Arrastrar y soltar para reordenar.
 *
 * La lista se reacomoda de inmediato para que el arrastre se sienta
 * instantáneo, y se manda entera al servidor: el índice del arreglo es el
 * orden, así que no hay forma de que dos banners queden empatados. Si la
 * llamada falla se recarga desde la API en vez de dejar el panel
 * mostrando un orden que la app no tiene.
 */
 const handleDrop = async (targetId: string) => {
 const sourceId = dragId.current;
 dragId.current = null;
 setDragOverId(null);
 if (!sourceId || sourceId === targetId) return;

 const from = banners.findIndex((b) => b._id === sourceId);
 const to = banners.findIndex((b) => b._id === targetId);
 if (from < 0 || to < 0) return;

 const next = [...banners];
 const [moved] = next.splice(from, 1);
 next.splice(to, 0, moved);
 setBanners(next);

 try {
 const { data } = await api.patch('/promotion-banners/reorder', {
 ids: next.map((b) => b._id),
 });
 setBanners(data.data);
 } catch (err) {
 setError(apiMessage(err, 'No se pudo guardar el nuevo orden.'));
 fetchAll();
 }
 };

 const filtered = banners.filter((b) => {
 const haystack = `${b.title} ${b.description}`.toLowerCase();
 const matchesSearch = haystack.includes(search.toLowerCase());
 const matchesStatus = statusFilter === 'all' || b.status === statusFilter;
 return matchesSearch && matchesStatus;
 });

 // Exactamente lo que la app pedirá: activos, vigentes y en su orden.
 const live = banners.filter((b) => b.status === 'active');

 // Reordenar escribe: sin `content:manage` el backend respondería 403.
 const canDrag = statusFilter === 'all' && search === '' && canManage;

 const inputClass = 'w-full h-10 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] px-3.5 text-xs font-medium text-[var(--color-text-main)] focus:border-[var(--color-primary)] focus:bg-[var(--color-surface)] focus:outline-none transition-all placeholder:text-[var(--color-text-main)]';
 const labelClass = 'block text-[11px] font-bold text-[var(--color-text-main)] uppercase tracking-wider mb-1.5';

 return (
 <div className="space-y-3 animate-fade-in">
 <div className="page-header">
 <div>
 <h1 className="page-title">Banners de Inicio</h1>
 <p className="page-subtitle">
 El carrusel promocional que aparece sobre Categorías en la app
 </p>
 </div>
 <PermissionGate permission={Permission.CONTENT_MANAGE}>
 <button
 onClick={openCreate}
 className="px-4 py-2 bg-[var(--color-primary)] hover:bg-[#8A5D08] text-xs font-bold text-white rounded-lg transition-all shadow-xs cursor-pointer flex items-center justify-center gap-2"
 >
 <Plus className="w-4 h-4" />
 <span>Crear banner</span>
 </button>
 </PermissionGate>
 </div>

 {/* ── Cómo se ve ahora mismo en la app ── */}
 <MobilePreview banners={live} />

 <div className="flex flex-col md:flex-row gap-2.5 justify-between items-center pb-4 border-b border-[var(--color-border-light)]">
 <div className="relative w-full md:w-80">
 <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-main)]" />
 <input
 type="text"
 value={search}
 onChange={(e) => setSearch(e.target.value)}
 placeholder="Buscar por título o descripción..."
 className="w-full h-10 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] pl-9 pr-4 text-xs font-medium text-[var(--color-text-main)] placeholder-[var(--color-text-muted)] focus:border-[var(--color-primary)] focus:bg-[var(--color-surface)] focus:outline-none transition-all"
 />
 </div>

 <div className="flex gap-1.5 overflow-x-auto w-full md:w-auto pb-1 md:pb-0">
 {STATUS_TABS.map((tab) => (
 <button
 key={tab.id}
 onClick={() => setStatusFilter(tab.id)}
 className={`px-3 py-1.5 text-xs font-semibold whitespace-nowrap transition-all cursor-pointer border-b-2 ${statusFilter === tab.id
 ? 'border-[var(--color-primary)] text-[var(--color-primary)] font-bold'
 : 'border-transparent text-[var(--color-text-main)] hover:text-[var(--color-text-main)]'
 }`}
 >
 {tab.label}
 </button>
 ))}
 </div>
 </div>

 {error && (
 <div className="text-[var(--color-danger)] text-xs flex items-start gap-3">
 <AlertCircle className="w-4 h-4 text-[var(--color-danger)] shrink-0 mt-0.5" />
 <p className="flex-1 font-semibold">{error}</p>
 </div>
 )}

 {loading ? (
 <div className="table-container p-16 text-center text-[var(--color-text-main)] text-xs font-semibold">
 Cargando banners...
 </div>
 ) : (
 <div className="table-container overflow-x-auto">
 <table className="w-full min-w-[900px]">
 <thead>
 <tr className="border-b border-[var(--color-border-light)]">
 <th className="table-header-cell w-10" />
 <th className="table-header-cell">Estado</th>
 <th className="table-header-cell">Imagen</th>
 <th className="table-header-cell">Título</th>
 <th className="table-header-cell">Orden</th>
 <th className="table-header-cell">Inicio</th>
 <th className="table-header-cell">Finalización</th>
 <th className="table-header-cell">Activo</th>
 <th className="table-header-cell text-right">Acciones</th>
 </tr>
 </thead>
 <tbody>
 {filtered.map((b) => {
 const st = STATUS_STYLES[b.status];
 const ActionIcon = ACTION_ICONS[b.actionType];
 return (
 <tr
 key={b._id}
 draggable={canDrag}
 onDragStart={() => { dragId.current = b._id; }}
 onDragOver={(e) => { e.preventDefault(); setDragOverId(b._id); }}
 onDragLeave={() => setDragOverId((id) => (id === b._id ? null : id))}
 onDrop={() => handleDrop(b._id)}
 className={`border-b border-[var(--color-border-light)] last:border-0 transition-colors ${
 dragOverId === b._id ? 'bg-[var(--color-primary-bg)]' : 'hover:bg-[var(--color-bg)]'
 }`}
 >
 <td className="table-body-cell">
 <GripVertical
 className={`w-4 h-4 ${canDrag ? 'text-[var(--color-text-main)] cursor-grab' : 'text-[var(--color-border)]'}`}
 />
 </td>
 <td className="table-body-cell">
 <span
 className="text-[10px] px-2 py-0.5 rounded-md font-bold uppercase tracking-wider whitespace-nowrap"
 style={{ backgroundColor: st.bg, color: st.text }}
 >
 {st.label}
 </span>
 </td>
 <td className="table-body-cell">
 <div className="w-16 h-10 rounded-lg overflow-hidden bg-[var(--color-bg)] border border-[var(--color-border)]">
 <img src={sizedImage(b.imageUrl, 640)} alt={b.title || 'Banner'} loading="lazy" decoding="async" className="w-full h-full object-cover" />
 </div>
 </td>
 <td className="table-body-cell max-w-[240px]">
 <p className="text-xs font-bold text-[var(--color-text-main)] truncate">
 {b.title || <span className="text-[var(--color-text-main)] font-medium">Sin título</span>}
 </p>
 <p className="text-[11px] text-[var(--color-text-main)] truncate flex items-center gap-1.5 mt-0.5">
 <ActionIcon className="w-3 h-3 shrink-0 text-[var(--color-text-main)]" />
 {describeAction(b, businesses, options)}
 </p>
 </td>
 <td className="table-body-cell">
 <span className="px-2 py-0.5 rounded bg-[var(--color-bg-alt)] border border-[var(--color-border)] text-[var(--color-primary)] font-mono font-bold text-[11px]">
 {b.displayOrder}
 </span>
 </td>
 <td className="table-body-cell text-xs text-[var(--color-text-main)] whitespace-nowrap">
 {new Date(b.startDate).toLocaleDateString('es-CO')}
 </td>
 <td className="table-body-cell text-xs text-[var(--color-text-main)] whitespace-nowrap">
 {new Date(b.endDate).toLocaleDateString('es-CO')}
 </td>
 <td className="table-body-cell">
 <PermissionGate permission={Permission.CONTENT_MANAGE}>
 <button
 onClick={() => handleToggle(b)}
 className="cursor-pointer hover:scale-105 transition-transform"
 title={b.isActive ? 'Desactivar banner' : 'Activar banner'}
 >
 {b.isActive ? (
 <ToggleRight className="w-8 h-8 text-[var(--color-primary)]" />
 ) : (
 <ToggleLeft className="w-8 h-8 text-[var(--color-text-main)]" />
 )}
 </button>
 </PermissionGate>
 </td>
 <td className="table-body-cell">
 <div className="flex items-center justify-end gap-2">
 <PermissionGate permission={Permission.CONTENT_MANAGE}>
 <button
 onClick={() => openEdit(b)}
 className="p-2 rounded-lg text-[var(--color-text-main)] hover:text-[var(--color-primary)] hover:bg-[var(--color-primary-bg)] border border-[var(--color-border)] transition-colors cursor-pointer"
 title="Editar banner"
 >
 <Pencil className="w-4 h-4" />
 </button>
 </PermissionGate>
 <button
 onClick={() => setConfirmDelete(b)}
 className="p-2 rounded-lg text-[var(--color-text-main)] hover:text-[var(--color-danger)] hover:bg-[var(--color-danger-bg)] border border-[var(--color-border)] transition-colors cursor-pointer"
 title="Eliminar banner"
 >
 <Trash2 className="w-4 h-4" />
 </button>
 </div>
 </td>
 </tr>
 );
 })}
 </tbody>
 </table>

 {filtered.length === 0 && (
 <div className="p-12 text-center text-[var(--color-text-main)] text-xs font-semibold">
 {banners.length === 0
 ? 'Todavía no hay banners. Crea el primero y aparecerá en la pantalla inicial de la app.'
 : 'No hay banners que coincidan con la búsqueda.'}
 </div>
 )}

 {!canDrag && banners.length > 1 && (
 <p className="px-5 py-3 text-[11px] text-[var(--color-text-main)] border-t border-[var(--color-border-light)]">
 Quita el filtro y la búsqueda para reordenar arrastrando.
 </p>
 )}
 </div>
 )}

 {confirmDelete && (
 <ConfirmDialog
 title="Eliminar Banner"
 message={`¿Eliminar"${confirmDelete.title || 'este banner'}"? Es permanente y dejará de aparecer en la app de inmediato.`}
 confirmLabel="Eliminar Definitivamente"
 onConfirm={handleDelete}
 onCancel={() => setConfirmDelete(null)}
 variant="danger"
 />
 )}

 {showModal && options && (
 <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4 animate-fade-in">
 <div className="Zipp-modal w-full max-w-xl rounded-2xl p-6 space-y-3 max-h-[90vh] overflow-y-auto">
 <div className="flex justify-between items-center border-b border-[var(--color-border-light)] pb-4">
 <div className="flex items-center gap-2">
 <Images className="w-5 h-5 text-[var(--color-primary)]" />
 <h3 className="text-base font-bold text-[var(--color-text-main)]">
 {editingId ? 'Editar Banner' : 'Nuevo Banner de Inicio'}
 </h3>
 </div>
 <button onClick={() => setShowModal(false)} className="text-[var(--color-text-main)] hover:text-[var(--color-text-main)] p-1 rounded-lg cursor-pointer">
 <X className="w-5 h-5" />
 </button>
 </div>

 <form onSubmit={handleSubmit} className="space-y-2.5">
 <div>
 <label className={labelClass}>Imagen del Banner</label>
 {form.imageUrl ? (
 <div className="relative rounded-xl overflow-hidden border border-[var(--color-border)] group">
 <img src={form.imageUrl} alt="Banner" className="w-full h-40 object-cover" />
 <label
 htmlFor="banner-upload"
 className="absolute inset-0 bg-black/0 group-hover:bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all cursor-pointer text-white text-xs font-bold"
 >
 Cambiar imagen
 </label>
 </div>
 ) : (
 <label
 htmlFor="banner-upload"
 className="flex flex-col items-center justify-center h-40 rounded-xl border-2 border-dashed border-[var(--color-border)] text-[var(--color-text-main)] cursor-pointer hover:border-[var(--color-primary)] hover:text-[var(--color-primary)] transition-colors"
 >
 <ImagePlus className="w-6 h-6 mb-1.5" />
 <span className="text-xs font-semibold">
 {uploading ? 'Subiendo...' : 'Selecciona una imagen (JPG, PNG, WEBP · máx. 5MB)'}
 </span>
 </label>
 )}
 <input
 id="banner-upload" type="file" accept="image/jpeg,image/png,image/webp"
 onChange={handleFileChange} className="hidden" disabled={uploading}
 />
 <p className="mt-1.5 text-[11px] text-[var(--color-text-main)]">
 La tarjeta es apaisada (≈16:9). La imagen se recorta centrada para llenarla.
 </p>
 </div>

 <div>
 <label className={labelClass}>Título (opcional)</label>
 <input type="text" maxLength={60} value={form.title}
 onChange={(e) => setForm({ ...form, title: e.target.value })}
 className={inputClass} placeholder="Ej. 2x1 en hamburguesas" />
 </div>

 <div>
 <label className={labelClass}>Descripción (opcional)</label>
 <input type="text" maxLength={140} value={form.description}
 onChange={(e) => setForm({ ...form, description: e.target.value })}
 className={inputClass} placeholder="Ej. Solo hoy en Burger House" />
 </div>

 <div>
 <label className={labelClass}>Texto del Botón (opcional)</label>
 <input type="text" maxLength={24} value={form.buttonText}
 onChange={(e) => setForm({ ...form, buttonText: e.target.value })}
 className={inputClass} placeholder="Ej. Pedir ahora" />
 </div>

 <div>
 <label className={labelClass}>Acción al Tocar el Banner</label>
 <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5">
 {options.actionTypes.map((opt) => {
 const OptIcon = ACTION_ICONS[opt.key];
 return (
 <button
 key={opt.key}
 type="button"
 onClick={() => setForm({ ...form, actionType: opt.key, actionValue: '' })}
 className={`flex flex-col items-center justify-center gap-1 h-14 rounded-lg text-[11px] font-semibold transition-all cursor-pointer border px-1 text-center ${form.actionType === opt.key
 ? 'bg-[var(--color-primary)] text-white border-[var(--color-primary)]'
 : 'bg-[var(--color-bg)] text-[var(--color-text-main)] border-[var(--color-border)] hover:text-[var(--color-text-main)]'
 }`}
 >
 <OptIcon className="w-3.5 h-3.5" />
 <span className="leading-tight">{opt.label}</span>
 </button>
 );
 })}
 </div>
 </div>

 {form.actionType === 'url' && (
 <div>
 <label className={labelClass}>Enlace de Destino</label>
 <input type="url" required value={form.actionValue}
 onChange={(e) => setForm({ ...form, actionValue: e.target.value })}
 className={inputClass} placeholder="https://..." />
 </div>
 )}

 {form.actionType === 'business' && (
 <div>
 <label className={labelClass}>Negocio de Destino</label>
 <select required value={form.actionValue}
 onChange={(e) => setForm({ ...form, actionValue: e.target.value })}
 className={inputClass + ' cursor-pointer'}>
 <option value="">Selecciona un negocio</option>
 {businesses.map((b) => (
 <option key={b._id} value={b._id}>{b.name}</option>
 ))}
 </select>
 </div>
 )}

 {form.actionType === 'category' && (
 <div>
 <label className={labelClass}>Categoría de Destino</label>
 <select required value={form.actionValue}
 onChange={(e) => setForm({ ...form, actionValue: e.target.value })}
 className={inputClass + ' cursor-pointer'}>
 <option value="">Selecciona una categoría</option>
 {options.categories.map((cat) => (
 <option key={cat} value={cat}>{CATEGORY_LABELS[cat] ?? cat}</option>
 ))}
 </select>
 </div>
 )}

 {form.actionType === 'search' && (
 <div>
 <label className={labelClass}>Término a buscar</label>
 <input
 type="text"
 required
 minLength={2}
 maxLength={60}
 value={form.actionValue}
 onChange={(e) => setForm({ ...form, actionValue: e.target.value })}
 placeholder="Pizza"
 className={inputClass}
 />
 <p className="mt-1 text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
 Abre la búsqueda con esto ya escrito. Si nadie vende nada que
 coincida, el banner lleva a una pantalla vacía.
 </p>
 </div>
 )}

 {form.actionType === 'screen' && (
 <div>
 <label className={labelClass}>Pantalla de Destino</label>
 <select required value={form.actionValue}
 onChange={(e) => setForm({ ...form, actionValue: e.target.value })}
 className={inputClass + ' cursor-pointer'}>
 <option value="">Selecciona una pantalla</option>
 {options.screens.map((s) => (
 <option key={s.key} value={s.key}>{s.label}</option>
 ))}
 </select>
 </div>
 )}

 <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
 <div>
 <label className={labelClass}>Fecha de Inicio</label>
 <input type="datetime-local" required value={form.startDate}
 onChange={(e) => setForm({ ...form, startDate: e.target.value })}
 className={inputClass} />
 </div>
 <div>
 <label className={labelClass}>Fecha de Finalización</label>
 <input type="datetime-local" required value={form.endDate}
 onChange={(e) => setForm({ ...form, endDate: e.target.value })}
 className={inputClass} />
 </div>
 </div>

 <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
 <div>
 <label className={labelClass}>
 Duración en Pantalla ({options.duration.min}-{options.duration.max} s)
 </label>
 <input type="number" required
 min={options.duration.min} max={options.duration.max}
 value={form.durationSeconds}
 onChange={(e) => setForm({ ...form, durationSeconds: Number(e.target.value) })}
 className={inputClass} />
 </div>
 <div>
 <label className={labelClass}>Prioridad (0-100)</label>
 <input type="number" min={0} max={100} required value={form.priority}
 onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })}
 className={inputClass} />
 <p className="mt-1 text-[11px] text-[var(--color-text-main)]">Desempata cuando dos banners comparten posición.</p>
 </div>
 </div>

 <div>
 <label className={labelClass}>Dónde Aparece</label>
 <div className="flex gap-1.5">
 {options.placements.map((p) => (
 <button
 key={p.key}
 type="button"
 onClick={() => setForm({ ...form, placement: p.key })}
 className={`flex-1 h-10 rounded-lg text-xs font-semibold transition-all cursor-pointer border ${form.placement === p.key
 ? 'bg-[var(--color-primary)] text-white border-[var(--color-primary)]'
 : 'bg-[var(--color-bg)] text-[var(--color-text-main)] border-[var(--color-border)] hover:text-[var(--color-text-main)]'
 }`}
 >
 {p.label}
 </button>
 ))}
 </div>
 </div>

 <div>
 <label className={labelClass}>Posición en el Inicio (intercalar entre colecciones)</label>
 <input
 type="number"
 min={0}
 max={999}
 value={form.homeOrder ?? ''}
 onChange={(e) => setForm({ ...form, homeOrder: e.target.value === '' ? null : Number(e.target.value) })}
 className={inputClass}
 placeholder="Vacío = carrusel fijo de siempre"
 />
 <p className="mt-1 text-[11px] text-[var(--color-text-main)]">
 Si lo dejas vacío, el banner sigue en el carrusel fijo de siempre, arriba de Categorías.
 Si le pones un número, sale de ahí y aparece intercalado en esa posición del inicio,
 junto con las colecciones y los bloques curados.
 </p>
 </div>

 <label className="flex items-center gap-2.5 cursor-pointer w-fit">
 <input type="checkbox" checked={form.isActive}
 onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
 className="w-4 h-4 rounded accent-[var(--color-primary)] cursor-pointer" />
 <span className="text-xs font-semibold text-[var(--color-text-main)]">Promoción activa</span>
 </label>

 <button
 type="submit"
 disabled={uploading}
 className="w-full h-11 bg-[var(--color-primary)] hover:bg-[#8A5D08] disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold text-xs uppercase tracking-wider rounded-lg shadow-sm cursor-pointer mt-2"
 >
 {editingId ? 'Guardar Cambios' : 'Crear Banner'}
 </button>
 </form>
 </div>
 </div>
 )}
 </div>
 );
}

/** Resume el destino en una línea, con el nombre real y no el identificador. */
function describeAction(
 banner: Banner,
 businesses: { _id: string; name: string }[],
 options: BannerOptions | null
): string {
 switch (banner.actionType) {
 case 'url':
 return banner.actionValue;
 case 'business':
 return businesses.find((b) => b._id === banner.actionValue)?.name ?? 'Negocio eliminado';
 case 'category':
 return CATEGORY_LABELS[banner.actionValue] ?? banner.actionValue;
 case 'screen':
 return options?.screens.find((s) => s.key === banner.actionValue)?.label ?? banner.actionValue;
 case 'search':
 return `Buscar «${banner.actionValue}»`;
 default:
 return 'Sin acción al tocarlo';
 }
}

// ──────────────────────────────────────────────────────────────
// Previsualización
// ──────────────────────────────────────────────────────────────

/**
 * El carrusel como lo verá el cliente.
 *
 * Reproduce la composición del componente móvil —protagonista al centro,
 * laterales girados y atenuados, halo dorado, degradado sobre la imagen—
 * con las mismas proporciones y sólo con los banners que ahora mismo están
 * vigentes. Sirve para responder de un vistazo la pregunta que motiva la
 * pantalla:"¿qué está viendo la gente en este momento?".
 */
function MobilePreview({ banners }: { banners: Banner[] }) {
 const [index, setIndex] = useState(0);

 // El mismo temporizador que el móvil: cada banner manda su duración.
 useEffect(() => {
 if (banners.length < 2) return;
 const seconds = banners[index % banners.length]?.durationSeconds ?? 5;
 const timer = setTimeout(() => setIndex((i) => (i + 1) % banners.length), seconds * 1000);
 return () => clearTimeout(timer);
 }, [index, banners]);

 if (banners.length === 0) {
 return (
 <div className="zipp-card p-8 text-center">
 <p className="text-xs font-semibold text-[var(--color-text-main)]">
 No hay ningún banner vigente ahora mismo.
 </p>
 <p className="text-[11px] text-[var(--color-text-main)] mt-1">
 El espacio se oculta en la app y la sección"Categorías" sube automáticamente.
 </p>
 </div>
 );
 }

 const active = index % banners.length;
 const cardW = 200;
 const cardH = Math.round(cardW * 0.58);
 const offsetX = cardW * 0.56;

 return (
 <div className="zipp-card p-5">
 <div className="flex items-center justify-between mb-4">
 <div>
 <h2 className="text-sm font-bold text-[var(--color-text-main)]">Vista previa en la app</h2>
 <p className="text-[11px] text-[var(--color-text-main)]">
 {banners.length} {banners.length === 1 ? 'banner vigente' : 'banners vigentes'}, en su orden de aparición
 </p>
 </div>
 <span className="flex items-center gap-1.5 text-[11px] font-semibold text-[var(--color-text-main)]">
 <Timer className="w-3.5 h-3.5 text-[var(--color-text-main)]" />
 {banners[active].durationSeconds}s
 </span>
 </div>

 <div
 className="relative flex items-center justify-center rounded-xl bg-[var(--color-bg)] overflow-hidden"
 style={{ height: cardH + 48, perspective: 900 }}
 >
 {banners.map((b, i) => {
 const total = banners.length;
 const raw = ((i - active) % total + total) % total;
 const rel = raw > total / 2 ? raw - total : raw;
 const p = Math.max(-1, Math.min(1, rel));
 const hidden = Math.abs(rel) > 1;

 return (
 <div
 key={b._id}
 className="absolute rounded-2xl overflow-hidden transition-all duration-500 ease-out"
 style={{
 width: cardW,
 height: cardH,
 opacity: hidden ? 0 : 1 - Math.abs(p) * 0.45,
 zIndex: 10 - Math.abs(rel),
 transform: `translateX(${p * offsetX}px) rotateY(${p * -16}deg) rotateZ(${p * 3}deg) scale(${1 - Math.abs(p) * 0.14})`,
 boxShadow: rel === 0
 ? '0 10px 24px rgba(245, 158, 11,0.30)'
 : '0 2px 8px rgba(8, 11, 17,0.10)',
 }}
 >
 <img src={sizedImage(b.imageUrl, 640)} alt={b.title || 'Banner'} loading="lazy" decoding="async" className="w-full h-full object-cover" />
 {(b.title || b.description || b.buttonText) && (
 <div
 className="absolute inset-x-0 bottom-0 p-2.5"
 style={{
 background: 'linear-gradient(to top, rgba(8, 11, 17,0.92), rgba(8, 11, 17,0.55) 40%, transparent)',
 }}
 >
 {b.title && <p className="text-[11px] font-bold text-white truncate">{b.title}</p>}
 {b.description && (
 <p className="text-[10px] text-white/80 truncate">{b.description}</p>
 )}
 {b.buttonText && (
 <span className="mt-1 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[var(--color-warning)] text-[var(--color-sidebar-deep)] text-[10px] font-bold">
 {b.buttonText}
 <ArrowRight className="w-2.5 h-2.5" />
 </span>
 )}
 </div>
 )}
 </div>
 );
 })}
 </div>

 {banners.length > 1 && (
 <div className="flex justify-center items-center gap-1.5 mt-3">
 {banners.map((b, i) => (
 <button
 key={b._id}
 onClick={() => setIndex(i)}
 className={`h-1.5 rounded-full transition-all cursor-pointer ${
 i === active ? 'w-4 bg-[var(--color-warning)]' : 'w-1.5 bg-[var(--color-border-strong)]'
 }`}
 title={b.title || `Banner ${i + 1}`}
 />
 ))}
 </div>
 )}
 </div>
 );
}
