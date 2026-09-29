import { useEffect, useState } from 'react';
import {
 Megaphone, Plus, Search, X, AlertCircle, AlertTriangle, Trash2, Pencil, Eye,
 ToggleLeft, ToggleRight, ImagePlus, Store, Ban, MousePointerClick,
 XOctagon, BarChart3, Clock, Wallet, Rocket, Compass,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import api from '../services/api';
import { Permission } from '../lib/permissions';
import { PermissionGate } from '../components/PermissionGate';
import { sizedImage } from '../lib/cloudinary';
import { fetchBusinessOptions } from '../lib/businessOptions';
import ConfirmDialog from '../components/ConfirmDialog';
import { apiMessage } from '../lib/apiError';
import NumericInput from '../components/NumericInput';
import SummaryGrid from '../components/SummaryGrid';

type AdStatus = 'scheduled' | 'active' | 'paused' | 'finished' | 'cancelled';
type ActionType = 'none' | 'business';
type Placement = 'splash' | 'explore';

interface Campaign {
 _id: string;
 campaignName: string;
 advertiserName: string;
 flyerUrl: string;
 startDate: string;
 endDate: string;
 isActive: boolean;
 priority: number;
 placement: Placement;
 actionType: ActionType;
 businessId: string | null;
 maxImpressions: number;
 impressionCount: number;
 clickCount: number;
 durationSeconds: number;
 pricePaid: number;
 internalNotes: string;
 status: AdStatus;
 /** Solo en las que compra un comercio por su cuenta. */
 approvalStatus?: 'pending' | 'approved' | 'rejected';
 billedToBusinessId?: string | null;
 pricingModel?: string;
 cpmRate?: number;
 cpcRate?: number;
 budget?: number;
 rejectionReason?: string;
}

interface CampaignForm {
 campaignName: string;
 advertiserName: string;
 flyerUrl: string;
 startDate: string;
 endDate: string;
 isActive: boolean;
 priority: number;
 placement: Placement;
 actionType: ActionType;
 businessId: string;
 maxImpressions: number;
 durationSeconds: number;
 pricePaid: number;
 internalNotes: string;
}

interface AdStats {
 totalImpressions: number;
 totalClicks: number;
 todayImpressions: number;
 todayClicks: number;
}

// Regla visual de flyers, por superficie: el de arranque es pantalla
// completa en 9:16; el de Explorar es un banner ancho, la misma relación
// que ya usa `SpotlightCarousel` en la app (`aspect = 0.58` → alto = 0.58 ×
// ancho). Las dos se recortan proporcionalmente (nunca se deforman);
// cualquier imagen fuera de la relación se acepta igual, solo se advierte.
const RATIO_BY_PLACEMENT: Record<Placement, { w: number; h: number; label: string }> = {
 splash: { w: 1080, h: 1920, label: '9:16 vertical' },
 explore: { w: 1080, h: 626, label: 'banner ancho' },
};
const FLYER_ASPECT_TOLERANCE = 0.03;

function readImageDimensions(file: File): Promise<{ width: number; height: number }> {
 return new Promise((resolve, reject) => {
 const url = URL.createObjectURL(file);
 const img = new Image();
 img.onload = () => {
 URL.revokeObjectURL(url);
 resolve({ width: img.naturalWidth, height: img.naturalHeight });
 };
 img.onerror = () => {
 URL.revokeObjectURL(url);
 reject(new Error('No se pudo leer la imagen'));
 };
 img.src = url;
 });
}

/** `null` cuando la imagen ya cumple la regla de esa superficie — nada que advertir. */
function checkFlyerAspect(width: number, height: number, placement: Placement): string | null {
 const target = RATIO_BY_PLACEMENT[placement];
 if (placement === 'splash' && height <= width) {
 return `La imagen es horizontal (${width}×${height}). El flyer de arranque debe ser vertical — se mostrará recortado a pantalla completa.`;
 }
 const targetAspect = target.w / target.h;
 const ratio = width / height;
 if (Math.abs(ratio - targetAspect) > FLYER_ASPECT_TOLERANCE) {
 return `La imagen es ${width}×${height}, no ${target.label}. Se recortará el sobrante de los bordes — recomendado ${target.w}×${target.h} px.`;
 }
 return null;
}

const toDatetimeLocal = (iso: string) => {
 const d = new Date(iso);
 const pad = (n: number) => String(n).padStart(2, '0');
 return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const emptyForm = (): CampaignForm => {
 const now = new Date();
 const inAWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
 return {
 campaignName: '', advertiserName: '', flyerUrl: '',
 startDate: toDatetimeLocal(now.toISOString()),
 endDate: toDatetimeLocal(inAWeek.toISOString()),
 isActive: true, priority: 0, placement: 'splash', actionType: 'none', businessId: '', maxImpressions: 0,
 durationSeconds: 5, pricePaid: 0, internalNotes: '',
 };
};

const PLACEMENT_LABEL: Record<Placement, string> = { splash: 'Arranque', explore: 'Explorar' };

const STATUS_STYLES: Record<AdStatus, { label: string; bg: string; text: string }> = {
 scheduled: { label: 'Programada', bg: 'var(--color-primary-bg)', text: 'var(--color-primary)' },
 active: { label: 'Activa', bg: 'var(--color-success-bg)', text: 'var(--color-success)' },
 paused: { label: 'Pausada', bg: 'var(--color-warning-bg)', text: 'var(--color-warning)' },
 finished: { label: 'Finalizada', bg: 'var(--color-bg-alt)', text: 'var(--color-text-muted)' },
 cancelled: { label: 'Cancelada', bg: 'var(--color-danger-bg)', text: 'var(--color-danger)' },
};

const STATUS_TABS: { id: 'all' | AdStatus; label: string }[] = [
 { id: 'all', label: 'Todas' },
 { id: 'active', label: 'Activas' },
 { id: 'scheduled', label: 'Programadas' },
 { id: 'paused', label: 'Pausadas' },
 { id: 'finished', label: 'Finalizadas' },
 { id: 'cancelled', label: 'Canceladas' },
];

export default function Campaigns() {
 const queryClient = useQueryClient();
 const [campaigns, setCampaigns] = useState<Campaign[]>([]);
 const [businesses, setBusinesses] = useState<{ _id: string; name: string }[]>([]);
 const [loading, setLoading] = useState(true);
 const [error, setError] = useState('');
 const [search, setSearch] = useState('');
 const [statusFilter, setStatusFilter] = useState<'all' | AdStatus>('all');

 const [showModal, setShowModal] = useState(false);
 const [editingId, setEditingId] = useState<string | null>(null);
 const [form, setForm] = useState<CampaignForm>(emptyForm());
 const [uploading, setUploading] = useState(false);
 const [aspectWarning, setAspectWarning] = useState('');
 const [previewCampaign, setPreviewCampaign] = useState<Campaign | null>(null);
 const [confirmDelete, setConfirmDelete] = useState<Campaign | null>(null);
 const [confirmCancel, setConfirmCancel] = useState<Campaign | null>(null);
 const [globalStats, setGlobalStats] = useState<AdStats | null>(null);
 const [statsCampaign, setStatsCampaign] = useState<Campaign | null>(null);
 const [statsData, setStatsData] = useState<AdStats | null>(null);
 const [statsLoading, setStatsLoading] = useState(false);

 const fetchAll = async () => {
 try {
 setLoading(true);
 setError('');
 const [resAds, resBiz, resStats] = await Promise.all([
 api.get('/advertisements?limit=100'),
 fetchBusinessOptions(queryClient),
 api.get('/advertisements/stats/summary').catch(() => null),
 ]);
 setCampaigns(resAds.data.data);
 setBusinesses(resBiz.data.data);
 if (resStats) setGlobalStats(resStats.data.data);
 } catch (err) {
 console.error(err);
 setError('No se pudieron cargar las campañas publicitarias.');
 } finally {
 setLoading(false);
 }
 };

 useEffect(() => {
 fetchAll();
 }, []);

 const openStats = async (c: Campaign) => {
 setStatsCampaign(c);
 setStatsData(null);
 setStatsLoading(true);
 try {
 const { data } = await api.get(`/advertisements/${c._id}/stats`);
 setStatsData(data.data);
 } catch (err) {
 setError(apiMessage(err, 'No se pudieron cargar las estadísticas.'));
 setStatsCampaign(null);
 } finally {
 setStatsLoading(false);
 }
 };

 const openCreate = () => {
 setEditingId(null);
 setForm(emptyForm());
 setAspectWarning('');
 setShowModal(true);
 };

 const openEdit = (c: Campaign) => {
 setEditingId(c._id);
 setAspectWarning('');
 setForm({
 campaignName: c.campaignName,
 advertiserName: c.advertiserName,
 flyerUrl: c.flyerUrl,
 startDate: toDatetimeLocal(c.startDate),
 endDate: toDatetimeLocal(c.endDate),
 isActive: c.isActive,
 priority: c.priority,
 placement: c.placement ?? 'splash',
 actionType: c.actionType,
 businessId: c.businessId || '',
 maxImpressions: c.maxImpressions,
 durationSeconds: c.durationSeconds,
 pricePaid: c.pricePaid,
 internalNotes: c.internalNotes || '',
 });
 setShowModal(true);
 };

 const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
 const file = e.target.files?.[0];
 if (!file) return;
 setUploading(true);
 setError('');
 setAspectWarning('');
 try {
 // Se lee el archivo elegido, antes de subirlo, para poder advertir de
 // inmediato — no depende de que el backend devuelva las dimensiones.
 try {
 const { width, height } = await readImageDimensions(file);
 setAspectWarning(checkFlyerAspect(width, height, form.placement) || '');
 } catch {
 // Si el navegador no puede leer las dimensiones, se sigue con la
 // subida igual: la validación de formato real corre en el backend.
 }

 const fd = new FormData();
 fd.append('flyer', file);
 const { data } = await api.post('/advertisements/upload', fd, {
 headers: { 'Content-Type': undefined },
 });
 setForm((f) => ({ ...f, flyerUrl: data.data.url }));
 } catch (err) {
 setError(apiMessage(err, 'No se pudo subir el flyer.'));
 } finally {
 setUploading(false);
 e.target.value = '';
 }
 };

 const handleSubmit = async (e: React.FormEvent) => {
 e.preventDefault();
 if (!form.flyerUrl) {
 setError('Sube un flyer antes de guardar la campaña.');
 return;
 }
 const payload = {
 campaignName: form.campaignName,
 advertiserName: form.advertiserName,
 flyerUrl: form.flyerUrl,
 startDate: new Date(form.startDate).toISOString(),
 endDate: new Date(form.endDate).toISOString(),
 isActive: form.isActive,
 priority: Number(form.priority),
 placement: form.placement,
 actionType: form.actionType,
 businessId: form.actionType === 'business' ? form.businessId || null : null,
 maxImpressions: Number(form.maxImpressions),
 durationSeconds: Number(form.durationSeconds),
 pricePaid: Number(form.pricePaid),
 internalNotes: form.internalNotes,
 };
 try {
 setError('');
 if (editingId) {
 await api.patch(`/advertisements/${editingId}`, payload);
 } else {
 await api.post('/advertisements', payload);
 }
 setShowModal(false);
 fetchAll();
 } catch (err) {
 setError(apiMessage(err, 'No se pudo guardar la campaña.'));
 }
 };

 const handleToggle = async (c: Campaign) => {
 try {
 const { data } = await api.patch(`/advertisements/${c._id}/toggle`);
 setCampaigns((prev) => prev.map((x) => (x._id === c._id ? data.data : x)));
 } catch (err) {
 setError(apiMessage(err, 'No se pudo cambiar el estado de la campaña.'));
 }
 };

 const handleApprove = async (c: Campaign) => {
 try {
 const { data } = await api.patch(`/advertisements/${c._id}/approve`);
 setCampaigns((prev) => prev.map((x) => (x._id === c._id ? data.data : x)));
 } catch (err) {
 setError(apiMessage(err, 'No se pudo aprobar la campaña.'));
 }
 };

 /**
 * Rechazar exige un motivo, y el servidor tambien lo exige.
 *
 * Un"no" sin explicacion obliga al comercio a adivinar que cambiar, y lo
 * normal es que reenvie exactamente lo mismo.
 */
 const handleReject = async (c: Campaign) => {
 const reason = window.prompt('¿Por qué se rechaza? El comercio va a leer esto.');
 if (!reason?.trim()) return;
 try {
 const { data } = await api.patch(`/advertisements/${c._id}/reject`, { reason: reason.trim() });
 setCampaigns((prev) => prev.map((x) => (x._id === c._id ? data.data : x)));
 } catch (err) {
 setError(apiMessage(err, 'No se pudo rechazar la campaña.'));
 }
 };

 /**
 * Cierra la campaña y emite su factura.
 *
 * Es el disparador de toda la cadena de cobro: sin este paso las
 * facturas no existen y el descuento en la liquidación del comercio no
 * se produce nunca. Se hace a mano y no por fecha porque cerrar es
 * cobrar, y cobrar solo debería pasar cuando alguien lo decide.
 */
 const handleClose = async (c: Campaign) => {
 try {
 const { data } = await api.post(`/advertisements/${c._id}/close`);
 await fetchAll();
 window.alert(
 `Campaña cerrada. Se facturaron $${(data.data.amount ?? 0).toLocaleString('es-CO')}` +
 (data.data.settledAgainstPayout
 ? ', que se descontarán de la próxima liquidación del comercio.'
 : '. Se cobra por fuera: aquí solo queda constancia.')
 );
 } catch (err) {
 setError(apiMessage(err, 'No se pudo cerrar la campaña.'));
 }
 };

 const handleDelete = async () => {
 if (!confirmDelete) return;
 try {
 await api.delete(`/advertisements/${confirmDelete._id}`);
 setCampaigns((prev) => prev.filter((c) => c._id !== confirmDelete._id));
 setConfirmDelete(null);
 } catch (err) {
 setError(apiMessage(err, 'No se pudo eliminar la campaña.'));
 setConfirmDelete(null);
 }
 };

 const handleCancel = async () => {
 if (!confirmCancel) return;
 try {
 const { data } = await api.patch(`/advertisements/${confirmCancel._id}/cancel`);
 setCampaigns((prev) => prev.map((x) => (x._id === confirmCancel._id ? data.data : x)));
 setConfirmCancel(null);
 } catch (err) {
 setError(apiMessage(err, 'No se pudo cancelar la campaña.'));
 setConfirmCancel(null);
 }
 };

 const filtered = campaigns.filter((c) => {
 const matchesSearch =
 c.campaignName.toLowerCase().includes(search.toLowerCase()) ||
 c.advertiserName.toLowerCase().includes(search.toLowerCase());
 const matchesStatus = statusFilter === 'all' || c.status === statusFilter;
 return matchesSearch && matchesStatus;
 });

 const inputClass = 'w-full h-10 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] px-3.5 text-xs font-medium text-[var(--color-text-main)] focus:border-[var(--color-primary)] focus:bg-[var(--color-surface)] focus:outline-none transition-all placeholder:text-[var(--color-text-main)]';
 const labelClass = 'block text-[11px] font-bold text-[var(--color-text-main)] uppercase tracking-wider mb-1.5';

 return (
 <div className="space-y-3 animate-fade-in">
 <div className="page-header">
 <div>
 <h1 className="page-title">Publicidad Patrocinada</h1>
 <p className="page-subtitle">Campañas patrocinadas: pantalla de carga al abrir la app, o intercaladas en Explorar</p>
 </div>
 <PermissionGate permission={Permission.ADS_MANAGE}>
 <button
 onClick={openCreate}
 className="px-4 py-2 bg-[var(--color-primary)] hover:bg-[#8A5D08] text-xs font-bold text-white rounded-lg transition-all shadow-xs cursor-pointer flex items-center justify-center gap-2"
 >
 <Plus className="w-4 h-4" />
 <span>Nueva Campaña</span>
 </button>
 </PermissionGate>
 </div>

 {globalStats && (
 <SummaryGrid
 items={[
 { label: 'Impresiones Totales', value: globalStats.totalImpressions.toLocaleString('es-CO') },
 { label: 'Impresiones Hoy', value: globalStats.todayImpressions.toLocaleString('es-CO') },
 { label: 'Clics Totales', value: globalStats.totalClicks.toLocaleString('es-CO') },
 { label: 'Clics Hoy', value: globalStats.todayClicks.toLocaleString('es-CO') },
 ]}
 />
 )}

 <div className="flex flex-col md:flex-row gap-2.5 justify-between items-center pb-4 border-b border-[var(--color-border-light)]">
 <div className="relative w-full md:w-80">
 <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-main)]" />
 <input
 type="text"
 value={search}
 onChange={(e) => setSearch(e.target.value)}
 placeholder="Buscar por campaña o anunciante..."
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
 Cargando campañas...
 </div>
 ) : (
 <div className="grid gap-2.5">
 {filtered.map((c) => {
 const st = STATUS_STYLES[c.status];
 return (
 <div key={c._id} className="zipp-card p-5 flex flex-col md:flex-row md:items-center justify-between gap-3">
 <div className="flex items-start gap-2.5 min-w-0">
 <button
 onClick={() => setPreviewCampaign(c)}
 className="w-20 h-14 rounded-lg overflow-hidden bg-[var(--color-bg)] border border-[var(--color-border)] flex-shrink-0 cursor-pointer"
 title="Vista previa del flyer"
 >
 <img src={sizedImage(c.flyerUrl, 640)} alt={c.campaignName} loading="lazy" decoding="async" className="w-full h-full object-cover" />
 </button>

 <div className="min-w-0 space-y-1.5">
 <div className="flex flex-wrap items-center gap-2.5">
 <h3 className="text-base font-bold text-[var(--color-text-main)] truncate">{c.campaignName}</h3>
 <span
 className="text-[10px] font-bold uppercase tracking-wider"
 style={{ color: st.text }}
 >
 {st.label}
 </span>
 <span className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-main)]">
 {c.placement === 'explore' ? <Compass className="w-3 h-3" /> : <Rocket className="w-3 h-3" />}
 {PLACEMENT_LABEL[c.placement ?? 'splash']}
 </span>
 </div>
 <p className="text-xs text-[var(--color-text-main)] font-medium">{c.advertiserName}</p>
 {/* Una campaña que compró un comercio y nadie ha
 mirado no sale en la app. Se avisa aquí porque
 esta es la lista donde se revisa. */}
 {c.approvalStatus === 'pending' ? (
 <p className="text-xs font-bold text-[var(--color-warning)]">
 La compró el comercio y espera revisión — no se está mostrando
 </p>
 ) : null}
 {c.approvalStatus === 'rejected' && c.rejectionReason ? (
 <p className="text-xs text-[var(--color-danger)]">Rechazada: {c.rejectionReason}</p>
 ) : null}
 {c.budget ? (
 <p className="text-xs text-[var(--color-text-main)]">
 {c.pricingModel === 'cpc'
 ? `$${(c.cpcRate ?? 0).toLocaleString('es-CO')} por clic`
 : `$${(c.cpmRate ?? 0).toLocaleString('es-CO')} por mil impresiones`}{' '}
 · tope ${c.budget.toLocaleString('es-CO')}
 </p>
 ) : null}
 <div className="flex flex-wrap items-center gap-2.5 text-xs text-[var(--color-text-main)]">
 <span>{new Date(c.startDate).toLocaleDateString('es-CO')} — {new Date(c.endDate).toLocaleDateString('es-CO')}</span>
 <span className="text-[var(--color-primary)] font-mono font-bold text-[11px]">
 Prioridad: {c.priority}
 </span>
 <span className="flex items-center gap-1">
 <Eye className="w-3.5 h-3.5 text-[var(--color-text-main)]" />
 {c.impressionCount}{c.maxImpressions > 0 ? ` / ${c.maxImpressions}` : ''}
 </span>
 <span className="flex items-center gap-1">
 <MousePointerClick className="w-3.5 h-3.5 text-[var(--color-text-main)]" />
 {c.clickCount}
 </span>
 <span className="flex items-center gap-1">
 <Clock className="w-3.5 h-3.5 text-[var(--color-text-main)]" />
 {c.durationSeconds}s
 </span>
 {c.pricePaid > 0 && (
 <span className="flex items-center gap-1">
 <Wallet className="w-3.5 h-3.5 text-[var(--color-text-main)]" />
 ${c.pricePaid.toLocaleString('es-CO')}
 </span>
 )}
 </div>
 </div>
 </div>

 <div className="flex items-center justify-between md:justify-end gap-2 border-t border-[var(--color-border-light)] md:border-0 pt-3 md:pt-0">
 {c.approvalStatus === 'pending' ? (
 <>
 <PermissionGate permission={Permission.ADS_MANAGE}>
 <button
 onClick={() => handleApprove(c)}
 className="px-3 py-1.5 rounded-lg bg-[var(--color-primary)] text-white text-[11px] font-bold uppercase tracking-wider cursor-pointer"
 >
 Aprobar
 </button>
 </PermissionGate>
 <button
 onClick={() => handleReject(c)}
 className="px-3 py-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text-main)] text-[11px] font-bold uppercase tracking-wider cursor-pointer"
 >
 Rechazar
 </button>
 </>
 ) : null}
 {/* Cerrar es cobrar: solo cuando ya terminó o se
 canceló, y solo si nadie la ha facturado antes
 —el índice único del servidor lo garantiza igual. */}
 {(c.status === 'finished' || c.status === 'cancelled') && c.budget ? (
 <PermissionGate permission={Permission.ADS_MANAGE}>
 <button
 onClick={() => handleClose(c)}
 className="px-3 py-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text-main)] text-[11px] font-bold uppercase tracking-wider cursor-pointer"
 title="Cerrar la campaña y emitir su factura"
 >
 Cerrar y facturar
 </button>
 </PermissionGate>
 ) : null}
 <button
 onClick={() => openStats(c)}
 className="p-2 rounded-lg text-[var(--color-text-main)] hover:text-[var(--color-primary)] hover:bg-[var(--color-primary-bg)] border border-[var(--color-border)] transition-colors cursor-pointer"
 title="Ver estadísticas"
 >
 <BarChart3 className="w-4 h-4" />
 </button>

 <PermissionGate permission={Permission.ADS_MANAGE}>
 <button
 onClick={() => openEdit(c)}
 className="p-2 rounded-lg text-[var(--color-text-main)] hover:text-[var(--color-primary)] hover:bg-[var(--color-primary-bg)] border border-[var(--color-border)] transition-colors cursor-pointer"
 title="Editar campaña"
 >
 <Pencil className="w-4 h-4" />
 </button>
 </PermissionGate>

 {c.status !== 'cancelled' && c.status !== 'finished' && (
 <PermissionGate permission={Permission.ADS_MANAGE}>
 <button
 onClick={() => handleToggle(c)}
 className="cursor-pointer hover:scale-105 transition-transform"
 title={c.isActive ? 'Pausar campaña' : 'Reactivar campaña'}
 >
 {c.isActive ? (
 <ToggleRight className="w-8 h-8" style={{ color: '#000000' }} />
 ) : (
 <ToggleLeft className="w-8 h-8" style={{ color: 'var(--color-danger)' }} />
 )}
 </button>
 </PermissionGate>
 )}

 {c.status !== 'cancelled' && (
 <PermissionGate permission={Permission.ADS_MANAGE}>
 <button
 onClick={() => setConfirmCancel(c)}
 className="p-2 rounded-lg text-[var(--color-text-main)] hover:text-[var(--color-danger)] hover:bg-[var(--color-danger-bg)] border border-[var(--color-border)] transition-colors cursor-pointer"
 title="Cancelar campaña"
 >
 <XOctagon className="w-4 h-4" />
 </button>
 </PermissionGate>
 )}

 <PermissionGate permission={Permission.ADS_MANAGE}>
 <button
 onClick={() => setConfirmDelete(c)}
 className="p-2 rounded-lg text-[var(--color-text-main)] hover:text-[var(--color-danger)] hover:bg-[var(--color-danger-bg)] border border-[var(--color-border)] transition-colors cursor-pointer"
 title="Eliminar campaña"
 >
 <Trash2 className="w-4 h-4" />
 </button>
 </PermissionGate>
 </div>
 </div>
 );
 })}

 {filtered.length === 0 && (
 <div className="zipp-card p-12 text-center text-[var(--color-text-main)] text-xs font-semibold">
 No hay campañas que coincidan con la búsqueda.
 </div>
 )}
 </div>
 )}

 {confirmDelete && (
 <ConfirmDialog
 title="Eliminar Campaña"
 message={`¿Eliminar"${confirmDelete.campaignName}"? Esta acción es permanente y la campaña dejará de mostrarse en la app.`}
 confirmLabel="Eliminar Definitivamente"
 onConfirm={handleDelete}
 onCancel={() => setConfirmDelete(null)}
 variant="danger"
 />
 )}

 {confirmCancel && (
 <ConfirmDialog
 title="Cancelar Campaña"
 message={`¿Cancelar"${confirmCancel.campaignName}"? A diferencia de pausarla, una campaña cancelada no se puede reactivar — el flyer y las estadísticas se conservan.`}
 confirmLabel="Cancelar Campaña"
 onConfirm={handleCancel}
 onCancel={() => setConfirmCancel(null)}
 variant="danger"
 />
 )}

 {statsCampaign && (
 <div
 className="fixed inset-0 z-[80] bg-black/70 backdrop-blur-xs flex items-center justify-center p-4 animate-fade-in"
 onClick={() => setStatsCampaign(null)}
 >
 <div className="zipp-modal w-full max-w-sm rounded-2xl p-6 space-y-3" onClick={(e) => e.stopPropagation()}>
 <div className="flex justify-between items-center border-b border-[var(--color-border-light)] pb-4">
 <div className="flex items-center gap-2">
 <BarChart3 className="w-5 h-5 text-[var(--color-primary)]" />
 <h3 className="text-base font-bold text-[var(--color-text-main)]">{statsCampaign.campaignName}</h3>
 </div>
 <button onClick={() => setStatsCampaign(null)} className="text-[var(--color-text-main)] hover:text-[var(--color-text-main)] p-1 rounded-lg cursor-pointer">
 <X className="w-5 h-5" />
 </button>
 </div>

 {statsLoading || !statsData ? (
 <p className="text-xs font-semibold text-[var(--color-text-main)] text-center py-8">Cargando estadísticas...</p>
 ) : (
 <div className="grid grid-cols-2 gap-3">
 {[
 { label: 'Impresiones Totales', value: statsData.totalImpressions },
 { label: 'Impresiones Hoy', value: statsData.todayImpressions },
 { label: 'Clics Totales', value: statsData.totalClicks },
 { label: 'Clics Hoy', value: statsData.todayClicks },
 ].map((kpi) => (
 <div key={kpi.label} className="border-b border-[var(--color-border)] py-2">
 <p className="text-[10px] font-bold text-[var(--color-text-main)] uppercase tracking-wider">{kpi.label}</p>
 <p className="text-xl font-bold text-[var(--color-text-main)] mt-1">{kpi.value.toLocaleString('es-CO')}</p>
 </div>
 ))}
 </div>
 )}
 </div>
 </div>
 )}

 {previewCampaign && (
 <div
 className="fixed inset-0 z-[80] bg-black/70 backdrop-blur-xs flex items-center justify-center p-4 animate-fade-in"
 onClick={() => setPreviewCampaign(null)}
 >
 <div className="relative w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
 <button
 onClick={() => setPreviewCampaign(null)}
 className="absolute -top-10 right-0 text-white/80 hover:text-white cursor-pointer"
 >
 <X className="w-6 h-6" />
 </button>
 <div className="rounded-2xl overflow-hidden bg-[var(--color-surface)] shadow-xl">
 {/* Misma composición que la app: recorte proporcional (cover),
 nunca deformado, en el ratio de la superficie de la campaña.
 El recuadro punteado es la zona segura — ahí deben quedar
 título, precio y logo. */}
 <div
 className="relative w-full"
 style={{
 aspectRatio: `${RATIO_BY_PLACEMENT[previewCampaign.placement ?? 'splash'].w} / ${RATIO_BY_PLACEMENT[previewCampaign.placement ?? 'splash'].h}`,
 }}
 >
 <img
 src={previewCampaign.flyerUrl}
 alt={previewCampaign.campaignName}
 className="absolute inset-0 w-full h-full object-cover"
 />
 <div className="absolute inset-x-6 inset-y-10 border-2 border-dashed border-white/70 rounded-lg pointer-events-none" />
 </div>
 <div className="p-4">
 <span className="text-[10px] font-bold text-[var(--color-text-main)] uppercase tracking-wider">Publicidad</span>
 <h3 className="text-sm font-bold text-[var(--color-text-main)] mt-0.5">{previewCampaign.campaignName}</h3>
 <p className="text-xs text-[var(--color-text-main)]">{previewCampaign.advertiserName}</p>
 </div>
 </div>
 </div>
 </div>
 )}

 {showModal && (
 <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4 animate-fade-in">
 <div className="zipp-modal w-full max-w-xl rounded-2xl p-6 space-y-3 max-h-[90vh] overflow-y-auto">
 <div className="flex justify-between items-center border-b border-[var(--color-border-light)] pb-4">
 <div className="flex items-center gap-2">
 <Megaphone className="w-5 h-5 text-[var(--color-primary)]" />
 <h3 className="text-base font-bold text-[var(--color-text-main)]">{editingId ? 'Editar Campaña' : 'Nueva Campaña Publicitaria'}</h3>
 </div>
 <button onClick={() => setShowModal(false)} className="text-[var(--color-text-main)] hover:text-[var(--color-text-main)] p-1 rounded-lg cursor-pointer">
 <X className="w-5 h-5" />
 </button>
 </div>

 <form onSubmit={handleSubmit} className="space-y-2.5">
 <div>
 <label className={labelClass}>Dónde Aparece</label>
 <div className="flex gap-1.5">
 {[
 { id: 'splash' as const, label: 'Arranque', icon: Rocket },
 { id: 'explore' as const, label: 'Explorar', icon: Compass },
 ].map((opt) => (
 <button
 key={opt.id}
 type="button"
 disabled={!!editingId}
 onClick={() => {
 setForm({ ...form, placement: opt.id });
 setAspectWarning('');
 }}
 title={editingId ? 'La superficie no se puede cambiar una vez creada la campaña' : undefined}
 className={`flex-1 flex items-center justify-center gap-1.5 h-10 rounded-lg text-xs font-semibold transition-all border disabled:opacity-50 disabled:cursor-not-allowed ${form.placement === opt.id
 ? 'bg-[var(--color-primary)] text-white border-[var(--color-primary)]'
 : 'bg-[var(--color-bg)] text-[var(--color-text-main)] border-[var(--color-border)] hover:text-[var(--color-text-main)]'
 } ${editingId ? '' : 'cursor-pointer'}`}
 >
 <opt.icon className="w-3.5 h-3.5" />
 {opt.label}
 </button>
 ))}
 </div>
 {form.placement === 'explore' ? (
 <p className="text-[11px] text-[var(--color-text-main)] mt-1.5">
 Se intercala entre las colecciones de Explorar, mezclada con los banners gratuitos.
 </p>
 ) : (
 <p className="text-[11px] text-[var(--color-text-main)] mt-1.5">
 Pantalla completa al abrir la app.
 </p>
 )}
 </div>

 <div>
 <label className={labelClass}>Flyer Publicitario</label>
 <p className="text-[11px] text-[var(--color-text-main)] mb-2">
 {RATIO_BY_PLACEMENT[form.placement].label} · recomendado {RATIO_BY_PLACEMENT[form.placement].w}×{RATIO_BY_PLACEMENT[form.placement].h} px.
 {form.placement === 'splash'
 ? ' Se muestra a pantalla completa; el sobrante de los bordes se recorta, la imagen nunca se deforma.'
 : ' Se muestra como banner ancho en Explorar; el sobrante de los bordes se recorta, la imagen nunca se deforma.'}
 </p>
 {form.flyerUrl ? (
 <div
 className="relative mx-auto w-full max-w-xs rounded-xl overflow-hidden border border-[var(--color-border)] group"
 style={{ aspectRatio: `${RATIO_BY_PLACEMENT[form.placement].w} / ${RATIO_BY_PLACEMENT[form.placement].h}` }}
 >
 <img src={form.flyerUrl} alt="Flyer" className="absolute inset-0 w-full h-full object-cover" />
 {/* Zona segura: título, precio y logo deben quedar dentro de este recuadro. */}
 <div className="absolute inset-x-2.5 inset-y-4 border-2 border-dashed border-white/70 rounded-md pointer-events-none" />
 <label
 htmlFor="flyer-upload"
 className="absolute inset-0 bg-black/0 group-hover:bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all cursor-pointer text-white text-xs font-bold text-center px-2"
 >
 Cambiar imagen
 </label>
 </div>
 ) : (
 <label
 htmlFor="flyer-upload"
 className="flex flex-col items-center justify-center h-40 rounded-xl border-2 border-dashed border-[var(--color-border)] text-[var(--color-text-main)] cursor-pointer hover:border-[var(--color-primary)] hover:text-[var(--color-primary)] transition-colors"
 >
 <ImagePlus className="w-6 h-6 mb-1.5" />
 <span className="text-xs font-semibold">{uploading ? 'Subiendo...' : 'Selecciona una imagen (JPG, PNG, WEBP · máx. 5MB)'}</span>
 </label>
 )}
 <input id="flyer-upload" type="file" accept="image/jpeg,image/png,image/webp" onChange={handleFileChange} className="hidden" disabled={uploading} />
 {aspectWarning && (
 <div className="mt-2 flex items-start gap-2 text-[11px] font-medium text-[var(--color-warning)]">
 <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
 <span>{aspectWarning} Puedes continuar y usarla igual.</span>
 </div>
 )}
 </div>

 <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
 <div>
 <label className={labelClass}>Nombre de la Campaña</label>
 <input type="text" required value={form.campaignName}
 onChange={(e) => setForm({ ...form, campaignName: e.target.value })}
 className={inputClass} placeholder="Ej. Lanzamiento Verano" />
 </div>
 <div>
 <label className={labelClass}>Nombre del Anunciante</label>
 <input type="text" required value={form.advertiserName}
 onChange={(e) => setForm({ ...form, advertiserName: e.target.value })}
 className={inputClass} placeholder="Ej. Pollo Frito" />
 </div>
 </div>

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
 <label className={labelClass}>Prioridad (0-100)</label>
 <input type="number" min={0} max={100} required value={form.priority}
 onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })}
 className={inputClass} />
 </div>
 <div>
 <label className={labelClass}>Máximo de Impresiones</label>
 <NumericInput value={form.maxImpressions}
 onValueChange={(d) => setForm({ ...form, maxImpressions: Number(d) })}
 className={inputClass} placeholder="0 = sin límite" />
 </div>
 </div>

 <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
 <div>
 <label className={labelClass}>Duración en Pantalla (segundos)</label>
 <input type="number" min={3} max={15} required value={form.durationSeconds}
 onChange={(e) => setForm({ ...form, durationSeconds: Number(e.target.value) })}
 className={inputClass} />
 </div>
 <div>
 <label className={labelClass}>Precio Pagado (COP)</label>
 <NumericInput value={form.pricePaid}
 onValueChange={(d) => setForm({ ...form, pricePaid: Number(d) })}
 className={inputClass} placeholder="0" />
 </div>
 </div>

 <div>
 <label className={labelClass}>Descripción Interna</label>
 <textarea
 value={form.internalNotes}
 onChange={(e) => setForm({ ...form, internalNotes: e.target.value })}
 maxLength={500}
 rows={2}
 placeholder="Notas del equipo comercial — nunca visibles para el anunciante ni la app."
 className="w-full rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] px-3.5 py-2.5 text-xs font-medium text-[var(--color-text-main)] focus:border-[var(--color-primary)] focus:bg-[var(--color-surface)] focus:outline-none transition-all placeholder:text-[var(--color-text-main)] resize-none"
 />
 </div>

 <div>
 <label className={labelClass}>Acción al Tocar el Anuncio</label>
 <div className="flex gap-1.5">
 {[
 { id: 'none', label: 'Ninguna', icon: Ban },
 { id: 'business', label: 'Ir a Negocio', icon: Store },
 ].map((opt) => (
 <button
 key={opt.id}
 type="button"
 onClick={() => setForm({ ...form, actionType: opt.id as ActionType })}
 className={`flex-1 flex items-center justify-center gap-1.5 h-10 rounded-lg text-xs font-semibold transition-all cursor-pointer border ${form.actionType === opt.id
 ? 'bg-[var(--color-primary)] text-white border-[var(--color-primary)]'
 : 'bg-[var(--color-bg)] text-[var(--color-text-main)] border-[var(--color-border)] hover:text-[var(--color-text-main)]'
 }`}
 >
 <opt.icon className="w-3.5 h-3.5" />
 {opt.label}
 </button>
 ))}
 </div>
 </div>

 {form.actionType === 'business' && (
 <div>
 <label className={labelClass}>Negocio de Destino</label>
 <select required value={form.businessId}
 onChange={(e) => setForm({ ...form, businessId: e.target.value })}
 className={inputClass + ' cursor-pointer'}>
 <option value="">Selecciona un negocio</option>
 {businesses.map((b) => (
 <option key={b._id} value={b._id}>{b.name}</option>
 ))}
 </select>
 </div>
 )}

 <label className="flex items-center gap-2.5 cursor-pointer w-fit">
 <input type="checkbox" checked={form.isActive}
 onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
 className="switch-activo" />
 <span className="text-xs font-semibold text-[var(--color-text-main)]">Campaña activa</span>
 </label>

 <button
 type="submit"
 disabled={uploading}
 className="w-full h-11 bg-[var(--color-primary)] hover:bg-[#8A5D08] disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold text-xs uppercase tracking-wider rounded-lg shadow-sm cursor-pointer mt-2"
 >
 {editingId ? 'Guardar Cambios' : 'Crear Campaña'}
 </button>
 </form>
 </div>
 </div>
 )}
 </div>
 );
}
