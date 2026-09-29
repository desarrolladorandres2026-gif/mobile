import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
 Ticket, Plus, Search, X, AlertCircle, Pencil, Percent,
 ToggleLeft, ToggleRight, Banknote, Truck, History, Building2, Landmark,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import api from '../services/api';
import { Permission } from '../lib/permissions';
import { PermissionGate } from '../components/PermissionGate';
import { fetchBusinessOptions } from '../lib/businessOptions';
import ConfirmDialog from '../components/ConfirmDialog';
import Pagination from '../components/Pagination';
import { apiFieldMessage, apiMessage } from '../lib/apiError';
import type { CouponHistory } from '../lib/apiTypes';
import NumericInput from '../components/NumericInput';

type CouponType = 'percentage' | 'fixed' | 'free_delivery';
type FundedBy = 'platform' | 'business';
type Scope = 'product' | 'delivery' | 'service_fee';
type EstadoFiltro = 'all' | 'active' | 'expired' | 'inactive';

interface Coupon {
 _id: string;
 code: string;
 title: string;
 description: string;
 type: CouponType;
 value: number;
 maxDiscount: number;
 fundedBy: FundedBy;
 scope: Scope;
 maxDiscountAmount: number;
 budgetLimit: number;
 budgetSpent: number;
 minimumContributionMargin: number;
 campaignApproved: boolean;
 minOrderAmount: number;
 validFrom: string;
 validUntil: string;
 usageLimit: number;
 usedCount: number;
 perUserLimit: number;
 businessId: string | null;
 city: string;
 firstOrderOnly: boolean;
 validDays: number[];
 validFromTime: string;
 validUntilTime: string;
 isActive: boolean;
 isPublic: boolean;
 updatedAt: string;
}

interface CouponForm {
 code: string;
 title: string;
 description: string;
 type: CouponType;
 value: number;
 maxDiscount: number;
 fundedBy: FundedBy;
 scope: Scope;
 maxDiscountAmount: number;
 budgetLimit: number;
 minimumContributionMargin: number;
 minOrderAmount: number;
 validFrom: string;
 validUntil: string;
 usageLimit: number;
 perUserLimit: number;
 businessId: string;
 city: string;
 firstOrderOnly: boolean;
 validDays: number[];
 validFromTime: string;
 validUntilTime: string;
 isActive: boolean;
 isPublic: boolean;
}

const DIAS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

const TIPOS: { id: CouponType; label: string; icon: typeof Percent }[] = [
 { id: 'percentage', label: 'Porcentaje', icon: Percent },
 { id: 'fixed', label: 'Monto fijo', icon: Banknote },
 { id: 'free_delivery', label: 'Envío gratis', icon: Truck },
];

const toDateInput = (iso: string) => new Date(iso).toISOString().slice(0, 10);

const cop = (n: number) => `$${(n || 0).toLocaleString('es-CO')}`;

const emptyForm = (): CouponForm => {
 const hoy = new Date();
 const enUnMes = new Date(hoy.getTime() + 30 * 86_400_000);
 return {
 code: '', title: '', description: '',
 type: 'percentage', value: 10, maxDiscount: 0,
 fundedBy: 'platform', scope: 'product',
 maxDiscountAmount: 0, budgetLimit: 0, minimumContributionMargin: -1,
 minOrderAmount: 0,
 validFrom: toDateInput(hoy.toISOString()),
 validUntil: toDateInput(enUnMes.toISOString()),
 usageLimit: 0, perUserLimit: 1,
 businessId: '', city: '', firstOrderOnly: false,
 validDays: [], validFromTime: '', validUntilTime: '',
 isActive: true, isPublic: false,
 };
};

/** Estado derivado, calculado igual que lo hace el motor de cupones. */
function estadoDe(c: Coupon): EstadoFiltro {
 if (!c.isActive) return 'inactive';
 if (new Date(c.validUntil) < new Date()) return 'expired';
 return 'active';
}

const ESTADO_ESTILO: Record<Exclude<EstadoFiltro, 'all'>, { label: string; bg: string; text: string }> = {
 active: { label: 'Vigente', bg: 'var(--color-primary-bg)', text: 'var(--color-primary)' },
 expired: { label: 'Vencido', bg: 'var(--color-warning-bg)', text: 'var(--color-warning)' },
 inactive: { label: 'Inactivo', bg: 'var(--color-bg-alt)', text: 'var(--color-text-muted)' },
};

/** Frase legible del beneficio, con la misma lógica que aplica el backend. */
function describirBeneficio(c: Coupon | CouponForm): string {
 if (c.type === 'free_delivery') return 'Envío gratis';
 if (c.type === 'percentage') {
 return c.maxDiscount > 0
 ? `${c.value}% (tope ${cop(c.maxDiscount)})`
 : `${c.value}% de descuento`;
 }
 return `${cop(c.value)} de descuento`;
}

/**
 * Exposición máxima: cuánto puede llegar a costar esta promoción en el peor
 * caso, con la configuración que el administrador tiene en pantalla.
 *
 * Devuelve `null` cuando el riesgo es ilimitado, para que la interfaz pueda
 * advertirlo en vez de mostrar un número tranquilizador y falso.
 *
 * El presupuesto manda sobre todo lo demás cuando existe; si no, el techo
 * es"lo peor que cuesta un canje" por"cuántos canjes caben". Cuando
 * alguna de las dos mitades no tiene techo, la respuesta honesta es que no
 * hay número, y por eso devuelve `null` en vez de una cifra grande: una
 * cifra grande tranquiliza, y aquí tranquilizar sería mentir.
 */
function exposicionMaxima(f: CouponForm): number | null {
 // Un cupón que financia el comercio no le cuesta nada a ZIPP. La
 // pregunta que responde este aviso es"cuánto puede costarnos ESTO", así
 // que un descuento ajeno tiene exposición cero, no ilimitada.
 if (f.fundedBy === 'business') return 0;

 // El presupuesto es un techo duro: el backend deja de canjear el cupón
 // cuando `budgetSpent` lo alcanza (ver CouponService.redeem), pase lo
 // que pase con el resto de la configuración. Si existe, manda.
 if (f.budgetLimit > 0) return f.budgetLimit;

 // Lo que cuesta un canje en el peor caso.
 //
 // El porcentaje sin tope es el único caso genuinamente ilimitado: el
 // descuento crece con el pedido y no hay pedido máximo. Los demás sí
 // tienen un peor caso conocido, incluido el envío gratis — no se puede
 // acotar desde aquí porque la tarifa depende de la distancia, así que
 // se trata como ilimitado y se dice.
 let porCanje: number | null;
 if (f.type === 'fixed') {
 porCanje = f.value;
 } else if (f.type === 'percentage') {
 const tope = f.maxDiscountAmount || f.maxDiscount;
 porCanje = tope > 0 ? tope : null;
 } else {
 porCanje = null;
 }

 if (porCanje === null) return null;

 // Sin límite de usos, un coste por canje acotado sigue sin acotar el
 // total: cien mil canjes de $5.000 son quinientos millones.
 if (f.usageLimit <= 0) return null;

 return porCanje * f.usageLimit;
}

export default function Coupons() {
 const queryClient = useQueryClient();
 const [coupons, setCoupons] = useState<Coupon[]>([]);
 const [businesses, setBusinesses] = useState<{ _id: string; name: string }[]>([]);
 const [loading, setLoading] = useState(true);
 const [error, setError] = useState('');
 // La búsqueda global lleva aquí con `?search=<código>`.
 const [urlParams] = useSearchParams();
 const urlSearch = urlParams.get('search') ?? '';
 const [search, setSearch] = useState(urlSearch);
 useEffect(() => {
 if (urlSearch) setSearch(urlSearch);
 }, [urlSearch]);
 const [estadoFiltro, setEstadoFiltro] = useState<EstadoFiltro>('all');
 const [page, setPage] = useState(1);
 const [meta, setMeta] = useState({ total: 0, totalPages: 1, limit: 25 });
 const PAGE_SIZE = 25;

 const [showModal, setShowModal] = useState(false);
 const [editingId, setEditingId] = useState<string | null>(null);
 const [form, setForm] = useState<CouponForm>(emptyForm());
 const [confirmToggle, setConfirmToggle] = useState<Coupon | null>(null);

 const [historial, setHistorial] = useState<{ coupon: Coupon; data: CouponHistory } | null>(null);

 // La búsqueda se manda al servidor, igual que en Users.tsx: filtrar en
 // el navegador sobre la página actual solo encontraría coincidencias
 // dentro de los 25 cupones ya cargados.
 const [debouncedSearch, setDebouncedSearch] = useState('');
 useEffect(() => {
 const t = setTimeout(() => setDebouncedSearch(search.trim()), 350);
 return () => clearTimeout(t);
 }, [search]);
 useEffect(() => { setPage(1); }, [estadoFiltro, debouncedSearch]);

 const fetchAll = useCallback(async () => {
 try {
 setLoading(true);
 setError('');
 const params: Record<string, string | number> = { page, limit: PAGE_SIZE };
 if (debouncedSearch) params.search = debouncedSearch;
 // El backend sólo distingue activo/inactivo (`isActive`); no sabe
 // de vencimiento."Vigentes" y"Vencidos" comparten ese mismo
 // `isActive: true` en el servidor y se terminan de separar abajo,
 // sobre lo que llegó en esta página.
 if (estadoFiltro === 'inactive') params.isActive = 'false';
 else if (estadoFiltro === 'active' || estadoFiltro === 'expired') params.isActive = 'true';
 const [resCoupons, resBiz] = await Promise.all([
 api.get('/coupons', { params }),
 fetchBusinessOptions(queryClient),
 ]);
 setCoupons(resCoupons.data.data);
 if (resCoupons.data.meta) setMeta(resCoupons.data.meta);
 setBusinesses(resBiz.data.data);
 } catch (err) {
 console.error(err);
 setError('No se pudieron cargar los cupones.');
 } finally {
 setLoading(false);
 }
 }, [page, debouncedSearch, estadoFiltro]);

 useEffect(() => { fetchAll(); }, [fetchAll]);

 const openCreate = () => {
 setEditingId(null);
 setForm(emptyForm());
 setShowModal(true);
 };

 const openEdit = (c: Coupon) => {
 setEditingId(c._id);
 setForm({
 code: c.code, title: c.title, description: c.description || '',
 type: c.type, value: c.value, maxDiscount: c.maxDiscount,
 fundedBy: c.fundedBy, scope: c.scope,
 maxDiscountAmount: c.maxDiscountAmount, budgetLimit: c.budgetLimit,
 minimumContributionMargin: c.minimumContributionMargin,
 minOrderAmount: c.minOrderAmount,
 validFrom: toDateInput(c.validFrom),
 validUntil: toDateInput(c.validUntil),
 usageLimit: c.usageLimit, perUserLimit: c.perUserLimit,
 businessId: c.businessId || '', city: c.city || '',
 firstOrderOnly: c.firstOrderOnly,
 validDays: c.validDays || [],
 validFromTime: c.validFromTime || '', validUntilTime: c.validUntilTime || '',
 isActive: c.isActive, isPublic: c.isPublic,
 });
 setShowModal(true);
 };

 const verHistorial = async (c: Coupon) => {
 try {
 const { data } = await api.get(`/coupons/${c._id}/redemptions?limit=50`);
 setHistorial({ coupon: c, data: data.data });
 } catch (err) {
 setError(apiMessage(err, 'No se pudo cargar el historial de uso.'));
 }
 };

 const handleSubmit = async (e: React.FormEvent) => {
 e.preventDefault();

 // El backend rechaza estas dos combinaciones, pero avisar aquí evita que
 // el administrador llene el formulario entero para recibir un 400 al final.
 if (form.fundedBy === 'business' && !form.businessId) {
 setError('Un cupón financiado por el comercio debe indicar cuál comercio lo asume.');
 return;
 }
 if (form.fundedBy === 'business' && form.scope !== 'product') {
 setError('Un comercio sólo puede financiar descuentos sobre sus productos, nunca sobre el domicilio ni el fee de servicio: esa plata es del repartidor y de la plataforma.');
 return;
 }

 const payload: Record<string, unknown> = {
 code: form.code.trim().toUpperCase(),
 title: form.title.trim(),
 description: form.description.trim(),
 type: form.type,
 value: form.type === 'free_delivery' ? 0 : Number(form.value),
 maxDiscount: Number(form.maxDiscount),
 fundedBy: form.fundedBy,
 scope: form.type === 'free_delivery' ? 'delivery' : form.scope,
 maxDiscountAmount: Number(form.maxDiscountAmount),
 budgetLimit: Number(form.budgetLimit),
 minimumContributionMargin: Number(form.minimumContributionMargin),
 minOrderAmount: Number(form.minOrderAmount),
 validFrom: new Date(form.validFrom).toISOString(),
 validUntil: new Date(`${form.validUntil}T23:59:59`).toISOString(),
 usageLimit: Number(form.usageLimit),
 perUserLimit: Number(form.perUserLimit),
 businessId: form.businessId || null,
 city: form.city.trim(),
 firstOrderOnly: form.firstOrderOnly,
 validDays: form.validDays,
 isActive: form.isActive,
 isPublic: form.isPublic,
 };
 if (form.validFromTime) payload.validFromTime = form.validFromTime;
 if (form.validUntilTime) payload.validUntilTime = form.validUntilTime;

 try {
 setError('');
 if (editingId) await api.patch(`/coupons/${editingId}`, payload);
 else await api.post('/coupons', payload);
 setShowModal(false);
 fetchAll();
 } catch (err) {
 setError(apiFieldMessage(err) ?? apiMessage(err, 'No se pudo guardar el cupón.'));
 }
 };

 /**
 * Desactivar, no borrar. El backend hace lo mismo: los canjes referencian
 * el cupón y los informes tienen que seguir funcionando.
 */
 const handleToggle = async () => {
 if (!confirmToggle) return;
 const c = confirmToggle;
 try {
 if (c.isActive) await api.delete(`/coupons/${c._id}`);
 else await api.patch(`/coupons/${c._id}`, { isActive: true });
 setConfirmToggle(null);
 fetchAll();
 } catch (err) {
 setError(apiMessage(err, 'No se pudo cambiar el estado del cupón.'));
 setConfirmToggle(null);
 }
 };

 // La búsqueda ya viene filtrada del servidor."Vigente" vs"Vencido"
 // se termina de decidir aquí porque el backend no distingue esos dos
 // dentro de `isActive: true` (ver `fetchAll`).
 const filtered = coupons.filter((c) => estadoFiltro === 'all' || estadoDe(c) === estadoFiltro);

 const inputClass = 'w-full h-10 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] px-3.5 text-xs font-medium text-[var(--color-text-main)] focus:border-[var(--color-primary)] focus:bg-[var(--color-surface)] focus:outline-none transition-all placeholder:text-[var(--color-text-main)]';
 const labelClass = 'block text-[11px] font-bold text-[var(--color-text-main)] uppercase tracking-wider mb-1.5';

 const exposicion = exposicionMaxima(form);

 return (
 <div className="space-y-3 animate-fade-in">
 <div className="page-header">
 <div>
 <h1 className="page-title">Cupones y Promociones</h1>
 <p className="page-subtitle">Códigos de descuento, quién los financia y cuánto pueden costar</p>
 </div>
 <PermissionGate permission={Permission.COUPONS_MANAGE}>
 <button
 onClick={openCreate}
 className="px-4 py-2 bg-[var(--color-primary)] hover:bg-[#8A5D08] text-xs font-bold text-white rounded-lg transition-all shadow-xs cursor-pointer flex items-center justify-center gap-2"
 >
 <Plus className="w-4 h-4" />
 <span>Nuevo Cupón</span>
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
 placeholder="Buscar por código..."
 className="w-full h-10 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] pl-9 pr-4 text-xs font-medium text-[var(--color-text-main)] placeholder-[var(--color-text-muted)] focus:border-[var(--color-primary)] focus:bg-[var(--color-surface)] focus:outline-none transition-all"
 />
 </div>

 <div className="flex gap-1.5 overflow-x-auto w-full md:w-auto pb-1 md:pb-0">
 {([
 { id: 'all', label: 'Todos' },
 { id: 'active', label: 'Vigentes' },
 { id: 'expired', label: 'Vencidos' },
 { id: 'inactive', label: 'Inactivos' },
 ] as { id: EstadoFiltro; label: string }[]).map((tab) => (
 <button
 key={tab.id}
 onClick={() => setEstadoFiltro(tab.id)}
 className={`px-3 py-1.5 text-xs font-semibold whitespace-nowrap transition-all cursor-pointer border-b-2 ${estadoFiltro === tab.id
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
 Cargando cupones...
 </div>
 ) : filtered.length === 0 ? (
 <div className="table-container p-16 text-center space-y-1">
 <p className="text-sm font-bold text-[var(--color-text-main)]">No hay cupones que coincidan</p>
 <p className="text-xs text-[var(--color-text-main)]">Crea uno nuevo o cambia el filtro.</p>
 </div>
 ) : (
 <div className="table-container">
 <div className="overflow-x-auto">
 <table className="data-grid">
 <thead>
 <tr className="text-left">
 <th className="table-header-cell">Código</th>
 <th className="table-header-cell">Título</th>
 <th className="table-header-cell">Estado</th>
 <th className="table-header-cell">Beneficio</th>
 <th className="table-header-cell">Lo asume</th>
 <th className="table-header-cell">Mínimo</th>
 <th className="table-header-cell">Condiciones</th>
 <th className="table-header-cell">Vence</th>
 <th className="table-header-cell">Usos</th>
 <th className="table-header-cell">Presupuesto</th>
 <th className="table-header-cell">Modificado</th>
 <th className="table-header-cell">Acciones</th>
 </tr>
 </thead>
 <tbody>
 {filtered.map((c) => {
 const st = ESTADO_ESTILO[estadoDe(c) as Exclude<EstadoFiltro, 'all'>];
 const negocio = businesses.find((b) => b._id === c.businessId);
 const presupuestoPct = c.budgetLimit > 0 ? Math.min(100, (c.budgetSpent / c.budgetLimit) * 100) : 0;

 return (
 <tr key={c._id}>
 <td className="table-body-cell text-[var(--color-primary)]">{c.code}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{c.title}</td>
 <td className="table-body-cell" style={{ color: st.text }}>{st.label}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{describirBeneficio(c)}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{c.fundedBy === 'business' ? (negocio?.name || 'El comercio') : 'ZIPP'}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{c.minOrderAmount > 0 ? cop(c.minOrderAmount) : '—'}</td>
 <td className="table-body-cell text-[var(--color-primary)]">
 {[c.firstOrderOnly && 'Solo primer pedido', c.isPublic && 'Visible en la app'].filter(Boolean).join(' · ') || '—'}
 </td>
 <td className="table-body-cell text-[var(--color-text-main)]">{new Date(c.validUntil).toLocaleDateString('es-CO')}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{c.usedCount}{c.usageLimit > 0 ? ` / ${c.usageLimit}` : ' · sin límite'}</td>
 <td className={`table-body-cell ${presupuestoPct >= 90 ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-main)]'}`}>
 {cop(c.budgetSpent)}{c.budgetLimit > 0 ? ` / ${cop(c.budgetLimit)}` : ' · sin tope'}
 </td>
 <td className="table-body-cell text-[var(--color-text-main)]">{new Date(c.updatedAt).toLocaleString('es-CO')}</td>
 <td className="table-body-cell">
 <div className="flex items-center gap-1">
 <button
 onClick={() => verHistorial(c)}
 title="Historial de uso"
 className="cursor-pointer text-[var(--color-text-main)] hover:text-[var(--color-primary)]"
 >
 <History className="w-4 h-4" />
 </button>
 <PermissionGate permission={Permission.COUPONS_MANAGE}>
 <button
 onClick={() => openEdit(c)}
 title="Editar"
 className="cursor-pointer text-[var(--color-text-main)] hover:text-[var(--color-primary)]"
 >
 <Pencil className="w-4 h-4" />
 </button>
 </PermissionGate>
 <button
 onClick={() => setConfirmToggle(c)}
 title={c.isActive ? 'Desactivar' : 'Reactivar'}
 className="cursor-pointer text-[var(--color-text-main)]"
 >
 {c.isActive
 ? <ToggleRight className="w-4 h-4" style={{ color: '#000000' }} />
 : <ToggleLeft className="w-4 h-4" style={{ color: 'var(--color-danger)' }} />}
 </button>
 </div>
 </td>
 </tr>
 );
 })}
 </tbody>
 </table>
 </div>
 </div>
 )}

 {!loading && (
 <Pagination page={page} totalPages={meta.totalPages} total={meta.total} limit={meta.limit} onPageChange={setPage} />
 )}

 {/* ── Historial de uso ── */}
 {historial && (
 <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4 animate-fade-in">
 <div className="zipp-modal w-full max-w-2xl rounded-2xl p-6 space-y-3 max-h-[85vh] overflow-y-auto">
 <div className="flex justify-between items-center border-b border-[var(--color-border-light)] pb-4">
 <div className="flex items-center gap-2">
 <History className="w-5 h-5 text-[var(--color-primary)]" />
 <h3 className="text-base font-bold text-[var(--color-text-main)]">
 Uso de <span className="font-mono text-[var(--color-primary)]">{historial.coupon.code}</span>
 </h3>
 </div>
 <button onClick={() => setHistorial(null)} className="text-[var(--color-text-main)] hover:text-[var(--color-text-main)] p-1 rounded-lg cursor-pointer">
 <X className="w-5 h-5" />
 </button>
 </div>

 <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 pb-4 border-b border-[var(--color-border-light)]">
 <div>
 <p className="text-[10px] font-bold text-[var(--color-text-main)] uppercase tracking-wider">Canjes</p>
 <p className="text-lg font-bold text-[var(--color-text-main)] font-mono">{historial.data.usedCount}</p>
 </div>
 <div>
 <p className="text-[10px] font-bold text-[var(--color-text-main)] uppercase tracking-wider">Descontado</p>
 <p className="text-lg font-bold text-[var(--color-text-main)] font-mono">{cop(historial.data.totalDiscounted)}</p>
 </div>
 <div>
 <p className="text-[10px] font-bold text-[var(--color-text-main)] uppercase tracking-wider">Presupuesto usado</p>
 <p className="text-lg font-bold text-[var(--color-text-main)] font-mono">{cop(historial.data.budgetSpent)}</p>
 </div>
 </div>

 {historial.data.redemptions.length === 0 ? (
 <p className="text-xs text-[var(--color-text-main)] text-center py-8 font-semibold">
 Este cupón todavía no se ha usado.
 </p>
 ) : (
 <div className="divide-y divide-[var(--color-border-light)] border-y border-[var(--color-border-light)]">
 {historial.data.redemptions.map((r) => (
 <div key={r._id} className="p-3.5 flex items-center justify-between gap-2.5 hover:bg-[var(--color-bg)] transition-colors">
 <div className="min-w-0">
 <p className="text-xs font-bold text-[var(--color-text-main)] truncate">
 {r.userId?.name || 'Usuario eliminado'}
 </p>
 <p className="text-[10px] text-[var(--color-text-main)] font-mono">
 Pedido {r.orderId?.orderNumber || '—'} · {new Date(r.createdAt).toLocaleString('es-CO')}
 </p>
 </div>
 <span className="text-xs font-bold text-[var(--color-danger)] font-mono shrink-0">
 −{cop(r.discountAmount)}
 </span>
 </div>
 ))}
 </div>
 )}
 </div>
 </div>
 )}

 {/* ── Crear / editar ── */}
 {showModal && (
 <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4 animate-fade-in">
 <div className="zipp-modal w-full max-w-2xl rounded-2xl p-6 space-y-3 max-h-[90vh] overflow-y-auto">
 <div className="flex justify-between items-center border-b border-[var(--color-border-light)] pb-4">
 <div className="flex items-center gap-2">
 <Ticket className="w-5 h-5 text-[var(--color-primary)]" />
 <h3 className="text-base font-bold text-[var(--color-text-main)]">
 {editingId ? 'Editar Cupón' : 'Nuevo Cupón'}
 </h3>
 </div>
 <button onClick={() => setShowModal(false)} className="text-[var(--color-text-main)] hover:text-[var(--color-text-main)] p-1 rounded-lg cursor-pointer">
 <X className="w-5 h-5" />
 </button>
 </div>

 <form onSubmit={handleSubmit} className="space-y-3">
 {/* Identidad */}
 <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
 <div>
 <label className={labelClass}>Código</label>
 <input
 type="text" required minLength={3} maxLength={24}
 value={form.code}
 onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
 className={inputClass + ' font-mono font-bold'}
 placeholder="BIENVENIDO"
 />
 </div>
 <div>
 <label className={labelClass}>Título visible</label>
 <input
 type="text" required minLength={3} maxLength={80}
 value={form.title}
 onChange={(e) => setForm({ ...form, title: e.target.value })}
 className={inputClass}
 placeholder="20% en tu primer pedido"
 />
 </div>
 </div>

 <div>
 <label className={labelClass}>Descripción</label>
 <input
 type="text" maxLength={200}
 value={form.description}
 onChange={(e) => setForm({ ...form, description: e.target.value })}
 className={inputClass}
 placeholder="Opcional. Se muestra bajo el título en la app."
 />
 </div>

 {/* Beneficio */}
 <div className="space-y-2.5 pt-4 border-t border-[var(--color-border-light)]">
 <p className="text-[11px] font-bold text-[var(--color-text-main)] uppercase tracking-wider">Beneficio</p>

 <div className="flex gap-1.5">
 {TIPOS.map((t) => (
 <button
 key={t.id} type="button"
 onClick={() => setForm({
 ...form,
 type: t.id,
 scope: t.id === 'free_delivery' ? 'delivery' : form.scope,
 })}
 className={`flex-1 flex items-center justify-center gap-1.5 h-10 rounded-lg text-xs font-semibold transition-all cursor-pointer border ${form.type === t.id
 ? 'bg-[var(--color-primary)] text-white border-[var(--color-primary)]'
 : 'bg-[var(--color-bg)] text-[var(--color-text-main)] border-[var(--color-border)] hover:text-[var(--color-text-main)]'
 }`}
 >
 <t.icon className="w-3.5 h-3.5" />
 {t.label}
 </button>
 ))}
 </div>

 {form.type !== 'free_delivery' && (
 <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
 <div>
 <label className={labelClass}>
 {form.type === 'percentage' ? 'Porcentaje (1-100)' : 'Monto en pesos'}
 </label>
 <NumericInput
 required
 maxDigits={form.type === 'percentage' ? 3 : 12}
 value={form.value}
 onValueChange={(d) => setForm({ ...form, value: Number(d) })}
 className={inputClass + ' font-mono'}
 />
 </div>
 {form.type === 'percentage' && (
 <div>
 <label className={labelClass}>Tope del descuento</label>
 <NumericInput
 value={form.maxDiscount}
 onValueChange={(d) => setForm({ ...form, maxDiscount: Number(d) })}
 className={inputClass + ' font-mono'}
 placeholder="0 = sin tope"
 />
 </div>
 )}
 </div>
 )}

 {form.type !== 'free_delivery' && (
 <div>
 <label className={labelClass}>Sobre qué línea aplica</label>
 <select
 value={form.scope}
 onChange={(e) => setForm({ ...form, scope: e.target.value as Scope })}
 className={inputClass + ' cursor-pointer'}
 >
 <option value="product">Productos</option>
 <option value="delivery">Domicilio</option>
 <option value="service_fee">Fee de servicio</option>
 </select>
 </div>
 )}
 </div>

 {/* Financiación */}
 <div className="space-y-2.5 pt-4 border-t border-[var(--color-border-light)]">
 <div>
 <p className="text-[11px] font-bold text-[var(--color-text-main)] uppercase tracking-wider">Quién lo paga</p>
 <p className="text-[11px] text-[var(--color-text-main)] mt-1">
 Determina de qué bolsillo sale el descuento y si la comisión se
 calcula antes o después de aplicarlo.
 </p>
 </div>

 <div className="flex gap-1.5">
 {([
 { id: 'platform', label: 'ZIPP', icon: Landmark },
 { id: 'business', label: 'El comercio', icon: Building2 },
 ] as { id: FundedBy; label: string; icon: typeof Landmark }[]).map((f) => (
 <button
 key={f.id} type="button"
 onClick={() => setForm({
 ...form,
 fundedBy: f.id,
 scope: f.id === 'business' ? 'product' : form.scope,
 })}
 className={`flex-1 flex items-center justify-center gap-1.5 h-10 rounded-lg text-xs font-semibold transition-all cursor-pointer border ${form.fundedBy === f.id
 ? 'bg-[var(--color-primary)] text-white border-[var(--color-primary)]'
 : 'bg-[var(--color-bg)] text-[var(--color-text-main)] border-[var(--color-border)] hover:text-[var(--color-text-main)]'
 }`}
 >
 <f.icon className="w-3.5 h-3.5" />
 {f.label}
 </button>
 ))}
 </div>

 {form.fundedBy === 'business' && form.type === 'free_delivery' && (
 <div className="text-[var(--color-danger)] text-[11px] font-semibold">
 Un comercio no puede financiar envío gratis: esa plata es del
 repartidor y de la plataforma. Cambia el financiador a ZIPP.
 </div>
 )}

 <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
 <div>
 <label className={labelClass}>Tope por canje</label>
 <NumericInput
 value={form.maxDiscountAmount}
 onValueChange={(d) => setForm({ ...form, maxDiscountAmount: Number(d) })}
 className={inputClass + ' font-mono'}
 placeholder="0 = usa el tope global"
 />
 </div>
 <div>
 <label className={labelClass}>Presupuesto total de la campaña</label>
 <NumericInput
 value={form.budgetLimit}
 onValueChange={(d) => setForm({ ...form, budgetLimit: Number(d) })}
 className={inputClass + ' font-mono'}
 placeholder="0 = sin tope"
 />
 </div>
 </div>
 </div>

 {/* Condiciones */}
 <div className="space-y-2.5 pt-4 border-t border-[var(--color-border-light)]">
 <p className="text-[11px] font-bold text-[var(--color-text-main)] uppercase tracking-wider">Condiciones de uso</p>

 <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
 <div>
 <label className={labelClass}>Pedido mínimo</label>
 <NumericInput
 value={form.minOrderAmount}
 onValueChange={(d) => setForm({ ...form, minOrderAmount: Number(d) })}
 className={inputClass + ' font-mono'}
 />
 </div>
 <div>
 <label className={labelClass}>Usos totales</label>
 <NumericInput
 value={form.usageLimit}
 onValueChange={(d) => setForm({ ...form, usageLimit: Number(d) })}
 className={inputClass + ' font-mono'}
 placeholder="0 = ilimitado"
 />
 </div>
 <div>
 <label className={labelClass}>Usos por persona</label>
 <input
 type="number" min={0}
 value={form.perUserLimit}
 onChange={(e) => setForm({ ...form, perUserLimit: Number(e.target.value) })}
 className={inputClass + ' font-mono'}
 placeholder="0 = ilimitado"
 />
 </div>
 </div>

 <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
 <div>
 <label className={labelClass}>Válido desde</label>
 <input
 type="date" required value={form.validFrom}
 onChange={(e) => setForm({ ...form, validFrom: e.target.value })}
 className={inputClass}
 />
 </div>
 <div>
 <label className={labelClass}>Vence el</label>
 <input
 type="date" required value={form.validUntil}
 onChange={(e) => setForm({ ...form, validUntil: e.target.value })}
 className={inputClass}
 />
 </div>
 </div>

 <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
 <div>
 <label className={labelClass}>Desde la hora</label>
 <input
 type="time" value={form.validFromTime}
 onChange={(e) => setForm({ ...form, validFromTime: e.target.value })}
 className={inputClass}
 />
 </div>
 <div>
 <label className={labelClass}>Hasta la hora</label>
 <input
 type="time" value={form.validUntilTime}
 onChange={(e) => setForm({ ...form, validUntilTime: e.target.value })}
 className={inputClass}
 />
 </div>
 </div>

 <div>
 <label className={labelClass}>Días de la semana</label>
 <div className="flex gap-1.5 flex-wrap">
 {DIAS.map((d, i) => {
 const activo = form.validDays.includes(i);
 return (
 <button
 key={d} type="button"
 onClick={() => setForm({
 ...form,
 validDays: activo
 ? form.validDays.filter((x) => x !== i)
 : [...form.validDays, i].sort(),
 })}
 className={`px-3 h-9 rounded-lg text-xs font-semibold transition-all cursor-pointer border ${activo
 ? 'bg-[var(--color-primary)] text-white border-[var(--color-primary)]'
 : 'bg-[var(--color-bg)] text-[var(--color-text-main)] border-[var(--color-border)] hover:text-[var(--color-text-main)]'
 }`}
 >
 {d}
 </button>
 );
 })}
 </div>
 <p className="text-[10px] text-[var(--color-text-main)] mt-1.5">
 Sin días seleccionados, el cupón vale todos los días.
 </p>
 </div>

 <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
 <div>
 <label className={labelClass}>Sólo en este comercio</label>
 <select
 value={form.businessId}
 onChange={(e) => setForm({ ...form, businessId: e.target.value })}
 className={inputClass + ' cursor-pointer'}
 >
 <option value="">Toda la plataforma</option>
 {businesses.map((b) => (
 <option key={b._id} value={b._id}>{b.name}</option>
 ))}
 </select>
 </div>
 <div>
 <label className={labelClass}>Sólo en esta ciudad</label>
 <input
 type="text" maxLength={80}
 value={form.city}
 onChange={(e) => setForm({ ...form, city: e.target.value })}
 className={inputClass}
 placeholder="Vacío = cualquier ciudad"
 />
 </div>
 </div>

 <div className="flex flex-col gap-2.5">
 <label className="flex items-center gap-2.5 cursor-pointer w-fit">
 <input
 type="checkbox" checked={form.firstOrderOnly}
 onChange={(e) => setForm({ ...form, firstOrderOnly: e.target.checked })}
 className="w-4 h-4 rounded accent-[var(--color-primary)] cursor-pointer"
 />
 <span className="text-xs font-semibold text-[var(--color-text-main)]">Sólo para el primer pedido del cliente</span>
 </label>
 <label className="flex items-center gap-2.5 cursor-pointer w-fit">
 <input
 type="checkbox" checked={form.isPublic}
 onChange={(e) => setForm({ ...form, isPublic: e.target.checked })}
 className="w-4 h-4 rounded accent-[var(--color-primary)] cursor-pointer"
 />
 <span className="text-xs font-semibold text-[var(--color-text-main)]">Mostrarlo en la app sin que lo pidan</span>
 </label>
 <label className="flex items-center gap-2.5 cursor-pointer w-fit">
 <input
 type="checkbox" checked={form.isActive}
 onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
 className="switch-activo"
 />
 <span className="text-xs font-semibold text-[var(--color-text-main)]">Cupón activo</span>
 </label>
 </div>
 </div>

 {/* Exposición máxima */}
 <div className={`text-xs font-semibold flex items-start gap-2.5 ${exposicion === null
 ? 'text-[var(--color-chart-purple)]'
 : 'text-[var(--color-text-main)]'
 }`}>
 <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
 <div className="space-y-0.5">
 <p>
 {exposicion === null
 ? 'Exposición máxima: sin límite'
 : `Exposición máxima: ${cop(exposicion)}`}
 </p>
 <p className="font-medium opacity-80">
 {exposicion === null
 ? 'Esta promoción no tiene techo de gasto. Ponle un presupuesto o un límite de usos.'
 : 'Lo máximo que puede costar esta campaña con la configuración actual.'}
 </p>
 </div>
 </div>

 <button
 type="submit"
 className="w-full h-11 bg-[var(--color-primary)] hover:bg-[#8A5D08] text-white font-bold text-xs uppercase tracking-wider rounded-lg shadow-sm cursor-pointer"
 >
 {editingId ? 'Guardar Cambios' : 'Crear Cupón'}
 </button>
 </form>
 </div>
 </div>
 )}

 {confirmToggle && (
 <ConfirmDialog
 title={confirmToggle.isActive ? 'Desactivar cupón' : 'Reactivar cupón'}
 message={
 confirmToggle.isActive
 ? `"${confirmToggle.code}" dejará de aceptarse en el checkout de inmediato. Los canjes ya hechos se conservan para los informes.`
 : `"${confirmToggle.code}" volverá a aceptarse en el checkout, siempre que no esté vencido ni haya agotado sus límites.`
 }
 confirmLabel={confirmToggle.isActive ? 'Desactivar' : 'Reactivar'}
 variant={confirmToggle.isActive ? 'danger' : 'default'}
 onConfirm={handleToggle}
 onCancel={() => setConfirmToggle(null)}
 />
 )}
 </div>
 );
}
