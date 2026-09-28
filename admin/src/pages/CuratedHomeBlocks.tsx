import { useEffect, useState } from 'react';
import {
 LayoutGrid, Plus, Search, X, AlertCircle, Trash2, Pencil,
 ToggleLeft, ToggleRight, Image as ImageIcon, Store, Check,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import api from '../services/api';
import { Permission } from '../lib/permissions';
import { PermissionGate } from '../components/PermissionGate';
import { fetchBusinessOptions } from '../lib/businessOptions';
import ConfirmDialog from '../components/ConfirmDialog';
import { apiMessage } from '../lib/apiError';

type BlockKind = 'productBanner' | 'businessBanner' | 'businessCollection';
type BlockStatus = 'active' | 'scheduled' | 'expired' | 'inactive';

interface CuratedBlock {
 _id: string;
 kind: BlockKind;
 title: string;
 subtitle?: string;
 items: string[];
 order: number;
 isActive: boolean;
 startDate?: string;
 endDate?: string;
 dayparts?: Daypart[];
 weekdays?: number[];
}

type Daypart = 'madrugada' | 'manana' | 'tarde' | 'noche';

interface OrderSlot {
 order: number;
 source: 'collection' | 'curated' | 'promo';
 title: string;
 live: boolean;
 reason: string | null;
 outranked: boolean;
}

const DAYPART_OPTIONS: { key: Daypart; label: string }[] = [
 { key: 'madrugada', label: 'Madrugada (23–5 h)' },
 { key: 'manana', label: 'Mañana (5–11 h)' },
 { key: 'tarde', label: 'Tarde (11–18 h)' },
 { key: 'noche', label: 'Noche (18–23 h)' },
];

const WEEKDAY_OPTIONS = [
 { key: 1, label: 'Lun' }, { key: 2, label: 'Mar' }, { key: 3, label: 'Mié' },
 { key: 4, label: 'Jue' }, { key: 5, label: 'Vie' }, { key: 6, label: 'Sáb' }, { key: 0, label: 'Dom' },
];

const SOURCE_LABEL: Record<OrderSlot['source'], string> = {
 collection: 'Colección automática',
 curated: 'Bloque curado',
 promo: 'Banner anclado',
};

interface BlockForm {
 kind: BlockKind;
 title: string;
 subtitle: string;
 items: string[];
 order: number;
 isActive: boolean;
 hasSchedule: boolean;
 startDate: string;
 endDate: string;
 dayparts: Daypart[];
 weekdays: number[];
}

interface PickerProduct { _id: string; name: string; imageUrl?: string; businessId?: string }
interface PickerBusiness { _id: string; name: string }

const KIND_OPTIONS: { key: BlockKind; label: string; hint: string }[] = [
 { key: 'productBanner', label: 'Banner de productos', hint: 'Spotlight de exactamente 3 productos' },
 { key: 'businessBanner', label: 'Banner de negocios', hint: 'Spotlight de exactamente 3 negocios' },
 { key: 'businessCollection', label: 'Colección de negocios', hint: 'Fila con nombre propio, de 4 a 20 negocios' },
];

const KIND_LABELS: Record<BlockKind, string> = {
 productBanner: 'Banner de productos',
 businessBanner: 'Banner de negocios',
 businessCollection: 'Colección de negocios',
};

const ITEM_BOUNDS: Record<BlockKind, { min: number; max: number }> = {
 productBanner: { min: 3, max: 3 },
 businessBanner: { min: 3, max: 3 },
 businessCollection: { min: 4, max: 20 },
};

const STATUS_STYLES: Record<BlockStatus, { label: string; bg: string; text: string }> = {
 active: { label: 'Activo', bg: '#FDF7E7', text: '#D69E26' },
 scheduled: { label: 'Programado', bg: '#FDF7E7', text: '#D69E26' },
 expired: { label: 'Vencido', bg: '#FEF3C7', text: '#F59E0B' },
 inactive: { label: 'Inactivo', bg: '#EDF1F5', text: '#0B0F19' },
};

const toDatetimeLocal = (iso: string) => {
 const d = new Date(iso);
 const pad = (n: number) => String(n).padStart(2, '0');
 return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** Mismo criterio de estado que `PromotionBanner.status`, pero con fechas opcionales:
 * sin `startDate`/`endDate` un bloque activo está siempre vigente. */
const computeStatus = (b: CuratedBlock): BlockStatus => {
 if (!b.isActive) return 'inactive';
 const now = Date.now();
 if (b.startDate && new Date(b.startDate).getTime() > now) return 'scheduled';
 if (b.endDate && new Date(b.endDate).getTime() < now) return 'expired';
 return 'active';
};

const emptyForm = (): BlockForm => ({
 kind: 'productBanner',
 title: '',
 subtitle: '',
 items: [],
 order: 0,
 isActive: true,
 hasSchedule: false,
 startDate: toDatetimeLocal(new Date().toISOString()),
 endDate: toDatetimeLocal(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()),
 dayparts: [],
 weekdays: [],
});

export default function CuratedHomeBlocks() {
 const queryClient = useQueryClient();
 const [blocks, setBlocks] = useState<CuratedBlock[]>([]);
 const [businesses, setBusinesses] = useState<PickerBusiness[]>([]);
 const [loading, setLoading] = useState(true);
 const [error, setError] = useState('');
 const [kindFilter, setKindFilter] = useState<'all' | BlockKind>('all');
 const [orderMap, setOrderMap] = useState<OrderSlot[]>([]);
 const [showOrderMap, setShowOrderMap] = useState(false);

 const [showModal, setShowModal] = useState(false);
 const [editingId, setEditingId] = useState<string | null>(null);
 const [form, setForm] = useState<BlockForm>(emptyForm());
 const [saving, setSaving] = useState(false);
 const [confirmDelete, setConfirmDelete] = useState<CuratedBlock | null>(null);

 // Picker de productos: depende del negocio elegido, porque no hay un
 // endpoint que liste todos los productos de la plataforma de una vez
 // (solo `GET /products/business/:businessId`).
 const [productBusinessId, setProductBusinessId] = useState('');
 const [products, setProducts] = useState<PickerProduct[]>([]);
 const [loadingProducts, setLoadingProducts] = useState(false);
 const [pickerSearch, setPickerSearch] = useState('');

 const fetchAll = async () => {
 try {
 setLoading(true);
 setError('');
 const [resBlocks, resBiz, resMap] = await Promise.all([
 api.get('/curated-home-blocks?limit=100'),
 fetchBusinessOptions(queryClient),
 api.get('/curated-home-blocks/order-map').catch(() => ({ data: { data: [] } })),
 ]);
 setBlocks(resBlocks.data.data);
 setBusinesses(resBiz.data.data);
 setOrderMap(resMap.data.data ?? []);
 } catch (err) {
 console.error(err);
 setError('No se pudieron cargar los bloques curados.');
 } finally {
 setLoading(false);
 }
 };

 useEffect(() => {
 fetchAll();
 }, []);

 useEffect(() => {
 if (!productBusinessId) {
 setProducts([]);
 return;
 }
 (async () => {
 try {
 setLoadingProducts(true);
 const { data } = await api.get(`/products/business/${productBusinessId}`);
 setProducts(data.data);
 } catch (err) {
 setError(apiMessage(err, 'No se pudieron cargar los productos de ese negocio.'));
 } finally {
 setLoadingProducts(false);
 }
 })();
 }, [productBusinessId]);

 const openCreate = () => {
 setEditingId(null);
 setForm(emptyForm());
 setProductBusinessId('');
 setPickerSearch('');
 setShowModal(true);
 };

 const openEdit = (b: CuratedBlock) => {
 setEditingId(b._id);
 setForm({
 kind: b.kind,
 title: b.title,
 subtitle: b.subtitle || '',
 items: b.items,
 order: b.order,
 isActive: b.isActive,
 hasSchedule: !!(b.startDate || b.endDate),
 startDate: b.startDate ? toDatetimeLocal(b.startDate) : emptyForm().startDate,
 endDate: b.endDate ? toDatetimeLocal(b.endDate) : emptyForm().endDate,
 dayparts: b.dayparts ?? [],
 weekdays: b.weekdays ?? [],
 });
 setPickerSearch('');
 if (b.kind === 'productBanner') {
 // No sabemos a qué negocio pertenecen los productos ya elegidos sin
 // consultarlos; se deja que el admin vuelva a elegir el negocio si
 // quiere cambiar la selección de productos.
 setProductBusinessId('');
 setProducts([]);
 }
 setShowModal(true);
 };

 const toggleItem = (id: string) => {
 setForm((f) => {
 const has = f.items.includes(id);
 if (has) return { ...f, items: f.items.filter((x) => x !== id) };
 const bounds = ITEM_BOUNDS[f.kind];
 if (f.items.length >= bounds.max) return f;
 return { ...f, items: [...f.items, id] };
 });
 };

 const handleSubmit = async (e: React.FormEvent) => {
 e.preventDefault();
 const bounds = ITEM_BOUNDS[form.kind];
 if (form.items.length < bounds.min || form.items.length > bounds.max) {
 setError(
 bounds.min === bounds.max
 ? `${KIND_LABELS[form.kind]} necesita exactamente ${bounds.min} elementos (llevas ${form.items.length}).`
 : `${KIND_LABELS[form.kind]} necesita entre ${bounds.min} y ${bounds.max} elementos (llevas ${form.items.length}).`
 );
 return;
 }
 if (!form.title.trim()) {
 setError('El título es requerido.');
 return;
 }

 const payload: Record<string, unknown> = {
 kind: form.kind,
 title: form.title.trim(),
 subtitle: form.subtitle.trim() || undefined,
 items: form.items,
 order: Number(form.order),
 isActive: form.isActive,
 dayparts: form.dayparts,
 weekdays: form.weekdays,
 };
 if (form.hasSchedule) {
 payload.startDate = new Date(form.startDate).toISOString();
 payload.endDate = new Date(form.endDate).toISOString();
 } else {
 payload.startDate = null;
 payload.endDate = null;
 }

 try {
 setSaving(true);
 setError('');
 if (editingId) {
 await api.patch(`/curated-home-blocks/${editingId}`, payload);
 } else {
 await api.post('/curated-home-blocks', payload);
 }
 setShowModal(false);
 fetchAll();
 } catch (err) {
 setError(apiMessage(err, 'No se pudo guardar el bloque.'));
 } finally {
 setSaving(false);
 }
 };

 const handleToggle = async (b: CuratedBlock) => {
 try {
 const { data } = await api.patch(`/curated-home-blocks/${b._id}/toggle`);
 setBlocks((prev) => prev.map((x) => (x._id === b._id ? data.data : x)));
 } catch (err) {
 setError(apiMessage(err, 'No se pudo cambiar el estado del bloque.'));
 }
 };

 const handleDelete = async () => {
 if (!confirmDelete) return;
 try {
 await api.delete(`/curated-home-blocks/${confirmDelete._id}`);
 setBlocks((prev) => prev.filter((b) => b._id !== confirmDelete._id));
 setConfirmDelete(null);
 } catch (err) {
 setError(apiMessage(err, 'No se pudo eliminar el bloque.'));
 setConfirmDelete(null);
 }
 };

 const filtered = blocks.filter((b) => kindFilter === 'all' || b.kind === kindFilter);

 const inputClass = 'w-full h-10 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] px-3.5 text-xs font-medium text-[var(--color-text-main)] focus:border-[var(--color-primary)] focus:bg-[var(--color-surface)] focus:outline-none transition-all placeholder:text-[var(--color-text-main)]';
 const labelClass = 'block text-[11px] font-bold text-[var(--color-text-main)] uppercase tracking-wider mb-1.5';

 const pickerPool: { id: string; label: string; sub?: string }[] =
 form.kind === 'productBanner'
 ? products
 .filter((p) => p.name.toLowerCase().includes(pickerSearch.toLowerCase()))
 .map((p) => ({ id: p._id, label: p.name }))
 : businesses
 .filter((b) => b.name.toLowerCase().includes(pickerSearch.toLowerCase()))
 .map((b) => ({ id: b._id, label: b.name }));

 const bounds = ITEM_BOUNDS[form.kind];

 return (
 <div className="space-y-3 animate-fade-in">
 <div className="page-header">
 <div>
 <h1 className="page-title">Bloques Curados del Inicio</h1>
 <p className="page-subtitle">
 Spotlights de productos, de negocios y colecciones con nombre propio, intercalados entre las secciones automáticas
 </p>
 </div>
 <PermissionGate permission={Permission.CONTENT_MANAGE}>
 <button
 onClick={openCreate}
 className="px-4 py-2 bg-[var(--color-primary)] hover:bg-[#8A5D08] text-xs font-bold text-white rounded-lg transition-all shadow-xs cursor-pointer flex items-center justify-center gap-2"
 >
 <Plus className="w-4 h-4" />
 <span>Crear bloque</span>
 </button>
 </PermissionGate>
 </div>

 <div className="border-b border-[var(--color-border-light)] pb-3">
 <button
 onClick={() => setShowOrderMap((v) => !v)}
 className="cursor-pointer text-xs font-bold text-[var(--color-primary)]"
 >
 {showOrderMap ? 'Ocultar' : 'Ver'} el orden del Inicio
 </button>
 {showOrderMap && (
 <div className="mt-3 space-y-2">
 <p className="text-[11px] text-[var(--color-text-main)]">
 Colecciones automáticas, bloques curados y banners anclados comparten un mismo número de orden.
 Si dos comparten el número, gana la colección automática, luego el bloque curado y por último el banner:
 la que pierde sigue apareciendo, pero después. La publicidad de pago no ocupa huecos del Inicio (va en el splash y en Explorar).
 </p>
 <ul>
 {orderMap.map((slot, i) => (
 <li key={`${slot.source}-${i}`} className="flex flex-wrap items-baseline gap-x-4 border-b border-[var(--color-border-light)] py-1.5 text-xs">
 <span className="w-10 font-bold tabular-nums text-[var(--color-text-main)]">{slot.order}</span>
 <span className={`flex-1 font-semibold ${slot.live ? 'text-[var(--color-text-main)]' : 'text-[var(--color-text-main)]'}`}>{slot.title}</span>
 <span className="text-[var(--color-text-main)]">{SOURCE_LABEL[slot.source]}</span>
 <span className="w-56 text-right text-[var(--color-text-main)]">
 {!slot.live ? slot.reason : slot.outranked ? 'Comparte número: va después' : 'En el Inicio ahora'}
 </span>
 </li>
 ))}
 {orderMap.length === 0 && <li className="py-3 text-xs text-[var(--color-text-main)]">Sin datos.</li>}
 </ul>
 </div>
 )}
 </div>

 <div className="flex gap-1.5 overflow-x-auto pb-1">
 {(['all', ...KIND_OPTIONS.map((k) => k.key)] as ('all' | BlockKind)[]).map((k) => (
 <button
 key={k}
 onClick={() => setKindFilter(k)}
 className={`px-3 py-1.5 text-xs font-semibold whitespace-nowrap transition-all cursor-pointer border-b-2 ${kindFilter === k
 ? 'border-[var(--color-primary)] text-[var(--color-primary)] font-bold'
 : 'border-transparent text-[var(--color-text-main)] hover:text-[var(--color-text-main)]'
 }`}
 >
 {k === 'all' ? 'Todos' : KIND_LABELS[k]}
 </button>
 ))}
 </div>

 {error && (
 <div className="text-[var(--color-danger)] text-xs flex items-start gap-3">
 <AlertCircle className="w-4 h-4 text-[var(--color-danger)] shrink-0 mt-0.5" />
 <p className="flex-1 font-semibold">{error}</p>
 </div>
 )}

 {loading ? (
 <div className="table-container p-16 text-center text-[var(--color-text-main)] text-xs font-semibold">
 Cargando bloques...
 </div>
 ) : (
 <div className="table-container overflow-x-auto">
 <table className="w-full min-w-[820px]">
 <thead>
 <tr className="border-b border-[var(--color-border-light)]">
 <th className="table-header-cell">Estado</th>
 <th className="table-header-cell">Tipo</th>
 <th className="table-header-cell">Título</th>
 <th className="table-header-cell">Elementos</th>
 <th className="table-header-cell">Orden</th>
 <th className="table-header-cell">Activo</th>
 <th className="table-header-cell text-right">Acciones</th>
 </tr>
 </thead>
 <tbody>
 {filtered.map((b) => {
 const status = computeStatus(b);
 const st = STATUS_STYLES[status];
 return (
 <tr key={b._id} className="border-b border-[var(--color-border-light)] last:border-0 hover:bg-[var(--color-bg)] transition-colors">
 <td className="table-body-cell">
 <span
 className="text-[10px] px-2 py-0.5 rounded-md font-bold uppercase tracking-wider whitespace-nowrap"
 style={{ backgroundColor: st.bg, color: st.text }}
 >
 {st.label}
 </span>
 </td>
 <td className="table-body-cell">
 <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-[var(--color-text-main)]">
 {b.kind === 'businessCollection' ? <LayoutGrid className="w-3.5 h-3.5" /> : b.kind === 'businessBanner' ? <Store className="w-3.5 h-3.5" /> : <ImageIcon className="w-3.5 h-3.5" />}
 {KIND_LABELS[b.kind]}
 </span>
 </td>
 <td className="table-body-cell max-w-[240px]">
 <p className="text-xs font-bold text-[var(--color-text-main)] truncate">{b.title}</p>
 {b.subtitle && <p className="text-[11px] text-[var(--color-text-main)] truncate mt-0.5">{b.subtitle}</p>}
 </td>
 <td className="table-body-cell text-xs text-[var(--color-text-main)]">{b.items.length}</td>
 <td className="table-body-cell">
 <span className="px-2 py-0.5 rounded bg-[var(--color-bg-alt)] border border-[var(--color-border)] text-[var(--color-primary)] font-mono font-bold text-[11px]">
 {b.order}
 </span>
 </td>
 <td className="table-body-cell">
 <PermissionGate permission={Permission.CONTENT_MANAGE}>
 <button
 onClick={() => handleToggle(b)}
 className="cursor-pointer hover:scale-105 transition-transform"
 title={b.isActive ? 'Desactivar bloque' : 'Activar bloque'}
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
 title="Editar bloque"
 >
 <Pencil className="w-4 h-4" />
 </button>
 </PermissionGate>
 <button
 onClick={() => setConfirmDelete(b)}
 className="p-2 rounded-lg text-[var(--color-text-main)] hover:text-[var(--color-danger)] hover:bg-[var(--color-danger-bg)] border border-[var(--color-border)] transition-colors cursor-pointer"
 title="Eliminar bloque"
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
 {blocks.length === 0
 ? 'Todavía no hay bloques curados. Crea el primero y aparecerá intercalado en el inicio de la app.'
 : 'No hay bloques que coincidan con el filtro.'}
 </div>
 )}
 </div>
 )}

 {confirmDelete && (
 <ConfirmDialog
 title="Eliminar Bloque"
 message={`¿Eliminar"${confirmDelete.title}"? Es permanente y dejará de aparecer en la app de inmediato.`}
 confirmLabel="Eliminar Definitivamente"
 onConfirm={handleDelete}
 onCancel={() => setConfirmDelete(null)}
 variant="danger"
 />
 )}

 {showModal && (
 <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4 animate-fade-in">
 <div className="zipp-modal w-full max-w-xl rounded-2xl p-6 space-y-3 max-h-[90vh] overflow-y-auto">
 <div className="flex justify-between items-center border-b border-[var(--color-border-light)] pb-4">
 <div className="flex items-center gap-2">
 <LayoutGrid className="w-5 h-5 text-[var(--color-primary)]" />
 <h3 className="text-base font-bold text-[var(--color-text-main)]">
 {editingId ? 'Editar Bloque' : 'Nuevo Bloque Curado'}
 </h3>
 </div>
 <button onClick={() => setShowModal(false)} className="text-[var(--color-text-main)] hover:text-[var(--color-text-main)] p-1 rounded-lg cursor-pointer">
 <X className="w-5 h-5" />
 </button>
 </div>

 <form onSubmit={handleSubmit} className="space-y-2.5">
 <div>
 <label className={labelClass}>Tipo de Bloque</label>
 <div className="grid grid-cols-1 gap-1.5">
 {KIND_OPTIONS.map((opt) => (
 <button
 key={opt.key}
 type="button"
 disabled={!!editingId}
 onClick={() => setForm({ ...form, kind: opt.key, items: [] })}
 className={`flex flex-col items-start gap-0.5 rounded-lg text-left px-3 py-2 transition-all cursor-pointer border disabled:cursor-not-allowed disabled:opacity-60 ${form.kind === opt.key
 ? 'bg-[var(--color-primary)] text-white border-[var(--color-primary)]'
 : 'bg-[var(--color-bg)] text-[var(--color-text-main)] border-[var(--color-border)] hover:text-[var(--color-text-main)]'
 }`}
 >
 <span className="text-xs font-bold">{opt.label}</span>
 <span className={`text-[11px] ${form.kind === opt.key ? 'text-white/80' : 'text-[var(--color-text-main)]'}`}>{opt.hint}</span>
 </button>
 ))}
 </div>
 {editingId && (
 <p className="mt-1.5 text-[11px] text-[var(--color-text-main)]">
 El tipo no se puede cambiar al editar: crea un bloque nuevo si necesitas otro formato.
 </p>
 )}
 </div>

 <div>
 <label className={labelClass}>Título</label>
 <input type="text" required maxLength={80} value={form.title}
 onChange={(e) => setForm({ ...form, title: e.target.value })}
 className={inputClass} placeholder="Ej. Lo nuevo esta semana" />
 </div>

 <div>
 <label className={labelClass}>Subtítulo (opcional)</label>
 <input type="text" maxLength={140} value={form.subtitle}
 onChange={(e) => setForm({ ...form, subtitle: e.target.value })}
 className={inputClass} placeholder="Ej. Elegidos a mano por el equipo Zipp" />
 </div>

 <div>
 <div className="flex items-center justify-between mb-1.5">
 <label className={labelClass + ' mb-0'}>
 {form.kind === 'productBanner' ? 'Productos' : 'Negocios'} ({form.items.length}/{bounds.max})
 </label>
 <span className="text-[11px] text-[var(--color-text-main)]">
 {bounds.min === bounds.max ? `Exactamente ${bounds.min}` : `Entre ${bounds.min} y ${bounds.max}`}
 </span>
 </div>

 {form.kind === 'productBanner' && (
 <select
 value={productBusinessId}
 onChange={(e) => setProductBusinessId(e.target.value)}
 className={inputClass + ' cursor-pointer mb-2'}
 >
 <option value="">Elige un negocio para ver sus productos</option>
 {businesses.map((b) => (
 <option key={b._id} value={b._id}>{b.name}</option>
 ))}
 </select>
 )}

 <div className="relative mb-2">
 <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--color-text-main)]" />
 <input
 type="text"
 value={pickerSearch}
 onChange={(e) => setPickerSearch(e.target.value)}
 placeholder="Buscar por nombre..."
 className={inputClass + ' pl-8'}
 />
 </div>

 <div className="rounded-lg border border-[var(--color-border)] max-h-48 overflow-y-auto divide-y divide-[var(--color-border-light)]">
 {loadingProducts && form.kind === 'productBanner' ? (
 <p className="p-3 text-[11px] text-[var(--color-text-main)]">Cargando productos...</p>
 ) : pickerPool.length === 0 ? (
 <p className="p-3 text-[11px] text-[var(--color-text-main)]">
 {form.kind === 'productBanner' && !productBusinessId
 ? 'Elige un negocio primero.'
 : 'Sin resultados.'}
 </p>
 ) : (
 pickerPool.map((item) => {
 const selected = form.items.includes(item.id);
 const disabled = !selected && form.items.length >= bounds.max;
 return (
 <button
 type="button"
 key={item.id}
 onClick={() => toggleItem(item.id)}
 disabled={disabled}
 className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-xs font-semibold transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 ${
 selected ? 'bg-[var(--color-primary-bg)] text-[var(--color-primary)]' : 'text-[var(--color-text-main)] hover:bg-[var(--color-bg)]'
 }`}
 >
 <span className="truncate">{item.label}</span>
 {selected && <Check className="w-4 h-4 shrink-0" />}
 </button>
 );
 })
 )}
 </div>
 </div>

 <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
 <div>
 <label className={labelClass}>Orden (0-999)</label>
 <input type="number" min={0} max={999} required value={form.order}
 onChange={(e) => setForm({ ...form, order: Number(e.target.value) })}
 className={inputClass} />
 <p className="mt-1 text-[11px] text-[var(--color-text-main)]">Mismo espacio numérico que las colecciones automáticas (10, 20, 30…).</p>
 </div>
 <div className="flex items-end pb-2">
 <label className="flex items-center gap-2.5 cursor-pointer w-fit">
 <input type="checkbox" checked={form.isActive}
 onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
 className="w-4 h-4 rounded accent-[var(--color-primary)] cursor-pointer" />
 <span className="text-xs font-semibold text-[var(--color-text-main)]">Bloque activo</span>
 </label>
 </div>
 </div>

 <div>
 <label className="flex items-center gap-2.5 cursor-pointer w-fit mb-2">
 <input type="checkbox" checked={form.hasSchedule}
 onChange={(e) => setForm({ ...form, hasSchedule: e.target.checked })}
 className="w-4 h-4 rounded accent-[var(--color-primary)] cursor-pointer" />
 <span className="text-xs font-semibold text-[var(--color-text-main)]">Limitar a un rango de fechas</span>
 </label>
 {form.hasSchedule ? (
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
 ) : (
 <p className="text-[11px] text-[var(--color-text-main)]">
 Sin fechas, el bloque queda siempre vigente mientras esté activo.
 </p>
 )}
 </div>

 <div>
 <label className={labelClass}>Franja del día (hora de Bogotá)</label>
 <div className="flex flex-wrap gap-x-4 gap-y-1.5">
 {DAYPART_OPTIONS.map((d) => (
 <label key={d.key} className="flex items-center gap-1.5 text-xs font-medium text-[var(--color-text-main)] cursor-pointer">
 <input
 type="checkbox"
 checked={form.dayparts.includes(d.key)}
 onChange={() => setForm((f) => ({
 ...f,
 dayparts: f.dayparts.includes(d.key) ? f.dayparts.filter((x) => x !== d.key) : [...f.dayparts, d.key],
 }))}
 className="w-4 h-4 rounded accent-[var(--color-primary)] cursor-pointer"
 />
 {d.label}
 </label>
 ))}
 </div>
 <label className={`${labelClass} mt-3`}>Días de la semana</label>
 <div className="flex flex-wrap gap-x-4 gap-y-1.5">
 {WEEKDAY_OPTIONS.map((d) => (
 <label key={d.key} className="flex items-center gap-1.5 text-xs font-medium text-[var(--color-text-main)] cursor-pointer">
 <input
 type="checkbox"
 checked={form.weekdays.includes(d.key)}
 onChange={() => setForm((f) => ({
 ...f,
 weekdays: f.weekdays.includes(d.key) ? f.weekdays.filter((x) => x !== d.key) : [...f.weekdays, d.key],
 }))}
 className="w-4 h-4 rounded accent-[var(--color-primary)] cursor-pointer"
 />
 {d.label}
 </label>
 ))}
 </div>
 <p className="mt-1.5 text-[11px] text-[var(--color-text-main)]">
 Sin marcar nada, el bloque sale a cualquier hora y cualquier día. El cambio de franja tarda hasta un minuto en verse en la app.
 </p>
 </div>

 <button
 type="submit"
 disabled={saving}
 className="w-full h-11 bg-[var(--color-primary)] hover:bg-[#8A5D08] disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold text-xs uppercase tracking-wider rounded-lg shadow-sm cursor-pointer mt-2"
 >
 {editingId ? 'Guardar Cambios' : 'Crear Bloque'}
 </button>
 </form>
 </div>
 </div>
 )}
 </div>
 );
}
