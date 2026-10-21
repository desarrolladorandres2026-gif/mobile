import { useCallback, useEffect, useState } from 'react';
import api from '../services/api';
import { Permission } from '../lib/permissions';
import { PermissionGate } from '../components/PermissionGate';
import ConfirmDialog from '../components/ConfirmDialog';
import Pagination from '../components/Pagination';
import { apiMessage } from '../lib/apiError';
import type { AdminUser } from '../lib/apiTypes';
import EntityLink from '../components/EntityLink';
import { useFicha } from '../lib/entityLinks';

interface Business {
 _id: string;
 name: string;
 category: string;
 city?: string;
 rating: number;
 totalReviews?: number;
 address: string;
 deliveryTime: number;
 commissionRateBps: number;
 /** Interruptor del dueño: abierto o cerrado hoy. */
 isActive: boolean;
 /** Suspensión de ZIPP: el dueño no puede quitarla. */
 isSuspended?: boolean;
 suspensionReason?: string;
 isApproved: boolean;
 isFeatured: boolean;
 isArchived?: boolean;
 archivedAt?: string;
 archiveReason?: string;
 ownerId?: { _id: string; name?: string; phone?: string } | string | null;
 createdAt?: string;
}

const CATEGORIES = [
 { id: 'all', label: 'Todas' },
 { id: 'restaurant', label: 'Restaurantes' },
 { id: 'fast_food', label: 'Comidas Rápidas' },
 { id: 'pharmacy', label: 'Droguerías' },
 { id: 'cafe', label: 'Cafeterías' },
 { id: 'supermarket', label: 'Supermercados' },
];

const CATEGORY_LABEL: Record<string, string> = {
 restaurant: 'Restaurante',
 fast_food: 'Comidas Rápidas',
 pharmacy: 'Droguería',
 cafe: 'Cafetería',
 supermarket: 'Supermercado',
};

const PAGE_SIZE = 25;

const ownerOf = (b: Business) => (b.ownerId && typeof b.ownerId === 'object' ? b.ownerId : null);

type PendingAction =
 | { kind: 'suspend'; business: Business }
 | { kind: 'lift'; business: Business }
 | { kind: 'archive'; business: Business }
 | { kind: 'restore'; business: Business };

export default function Businesses() {
 const { open: openFicha } = useFicha();
 const [businesses, setBusinesses] = useState<Business[]>([]);
 const [loading, setLoading] = useState(true);
 const [error, setError] = useState('');
 const [search, setSearch] = useState('');
 const [debouncedSearch, setDebouncedSearch] = useState('');
 const [selectedCategory, setSelectedCategory] = useState('all');
 const [archived, setArchived] = useState(false);
 const [page, setPage] = useState(1);
 const [meta, setMeta] = useState({ total: 0, totalPages: 1, limit: PAGE_SIZE });
 const [pending, setPending] = useState<PendingAction | null>(null);

 const [showModal, setShowModal] = useState(false);
 const [form, setForm] = useState({
 name: '',
 description: '',
 category: 'restaurant',
 address: '',
 phone: '',
 latitude: 2.1958,
 longitude: -75.6258,
 deliveryTime: 30,
 commissionRate: 0.10,
 ownerId: '',
 });
 const [owners, setOwners] = useState<AdminUser[]>([]);

 useEffect(() => {
 const t = setTimeout(() => setDebouncedSearch(search.trim()), 350);
 return () => clearTimeout(t);
 }, [search]);
 useEffect(() => { setPage(1); }, [selectedCategory, debouncedSearch, archived]);

 // `/admin/businesses` y no el catálogo público: el público solo sirve
 // comercios aprobados y sin datos comerciales, que es lo correcto para la app.
 const fetchBusinesses = useCallback(async () => {
 try {
 setLoading(true);
 setError('');
 const params: Record<string, string | number | boolean> = { page, limit: PAGE_SIZE };
 if (selectedCategory !== 'all') params.category = selectedCategory;
 if (debouncedSearch) params.search = debouncedSearch;
 if (archived) params.archived = true;
 const { data } = await api.get('/admin/businesses', { params });
 setBusinesses(data.data);
 if (data.meta) setMeta(data.meta);
 } catch (err) {
 setError(apiMessage(err, 'No se pudieron cargar los negocios.'));
 } finally {
 setLoading(false);
 }
 }, [page, selectedCategory, debouncedSearch, archived]);

 const fetchOwners = async () => {
 try {
 const { data } = await api.get('/admin/users?role=business&limit=100');
 setOwners(data.data);
 if (data.data.length > 0) {
 setForm((prev) => ({ ...prev, ownerId: data.data[0]._id }));
 }
 } catch (err) {
 console.error(err);
 }
 };

 useEffect(() => { fetchBusinesses(); }, [fetchBusinesses]);
 useEffect(() => { fetchOwners(); }, []);

 const patchLocal = (id: string, patch: Partial<Business>) =>
 setBusinesses((prev) => prev.map((b) => (b._id === id ? { ...b, ...patch } : b)));

 const handleToggleFeatured = async (business: Business) => {
 try {
 setError('');
 const { data } = await api.patch(`/admin/businesses/${business._id}/featured`);
 patchLocal(business._id, { isFeatured: data.data.isFeatured });
 } catch (err) {
 setError(apiMessage(err, 'No se pudo destacar el comercio.'));
 }
 };

 const confirmPending = async (reason?: string) => {
 if (!pending) return;
 const { kind, business } = pending;
 setPending(null);
 try {
 setError('');
 if (kind === 'suspend' || kind === 'lift') {
 // Motivo en las dos direcciones: levantar una suspensión también queda a nombre de quien la autoriza.
 const { data } = await api.patch(`/admin/businesses/${business._id}/toggle`, { reason });
 patchLocal(business._id, { isSuspended: data.data.isSuspended, suspensionReason: data.data.suspensionReason });
 } else if (kind === 'archive') {
 await api.patch(`/admin/businesses/${business._id}/archive`, { reason });
 setBusinesses((prev) => prev.filter((b) => b._id !== business._id));
 } else {
 await api.patch(`/admin/businesses/${business._id}/restore`, { reason });
 setBusinesses((prev) => prev.filter((b) => b._id !== business._id));
 }
 } catch (err) {
 setError(apiMessage(err, 'No se pudo actualizar el comercio.'));
 }
 };

 const handleCreateBusiness = async (e: React.FormEvent) => {
 e.preventDefault();
 if (!form.ownerId) {
 setError('Debe existir al menos un usuario con rol Negocio para asignarlo como dueño.');
 return;
 }
 try {
 setError('');
 const { data } = await api.post('/businesses', {
 ownerId: form.ownerId,
 name: form.name,
 description: form.description || undefined,
 category: form.category,
 address: form.address,
 phone: form.phone,
 latitude: Number(form.latitude),
 longitude: Number(form.longitude),
 deliveryTime: Number(form.deliveryTime),
 });

 // Se fija la comisión, pero NO se aprueba: aprobar es dar por buenos los
 // papeles de alguien a quien se le va a transferir dinero, y vive en
 // Verificar Comercios con los documentos delante.
 await api.patch(`/finance/businesses/${data.data._id}/terms`, {
 commissionRateBps: Math.round(Number(form.commissionRate) * 10000),
 });

 setShowModal(false);
 fetchBusinesses();
 setForm({
 name: '', description: '', category: 'restaurant', address: '', phone: '',
 latitude: 2.1958, longitude: -75.6258, deliveryTime: 30,
 commissionRate: 0.10, ownerId: owners[0]?._id || '',
 });
 } catch (err) {
 setError(apiMessage(err, 'No se pudo registrar el comercio.'));
 }
 };

 const inputClass = 'w-full h-10 rounded bg-[var(--color-bg)] border border-[var(--color-border)] px-3.5 text-xs font-medium text-[var(--color-text-main)] focus:border-[var(--color-primary)] focus:bg-[var(--color-surface)] focus:outline-none transition-all placeholder:text-[var(--color-text-main)]';
 const labelClass = 'block text-xs font-bold text-[var(--color-text-main)] mb-1.5';
 const headClass = 'px-3 py-3 text-left text-xs font-bold text-[var(--color-surface)] whitespace-nowrap';
 const cellClass = 'px-3 py-3.5 text-xs align-middle border-t border-[var(--color-border-light)] text-[var(--color-text-main)]';

 const dialog = pending
 ? pending.kind === 'suspend'
 ? {
 title: 'Suspender comercio',
 message: `"${pending.business.name}" deja de aparecer en la app y no recibe pedidos. El dueño ve el motivo en su panel y no puede quitar la suspensión.`,
 confirmLabel: 'Suspender',
 variant: 'warning' as const,
 reason: { label: 'Motivo (lo ve el comercio)', placeholder: 'Ej. documentos vencidos: SOAT y concepto sanitario' },
 }
 : pending.kind === 'lift'
 ? {
 title: 'Levantar suspensión',
 message: `"${pending.business.name}" vuelve a la app y puede recibir pedidos si su dueño lo tiene abierto. Tu nombre y el motivo quedan registrados como quien autorizó la reactivación.`,
 confirmLabel: 'Levantar suspensión',
 variant: 'default' as const,
 reason: { label: 'Motivo de la reactivación', placeholder: 'Ej. subsanó los documentos y la apelación fue aceptada' },
 }
 : pending.kind === 'archive'
 ? {
 title: 'Archivar comercio',
 message: `"${pending.business.name}" sale de la app y del catálogo. Sus pedidos, liquidaciones y cobros se conservan, y se puede restaurar.`,
 confirmLabel: 'Archivar',
 variant: 'danger' as const,
 reason: { label: 'Motivo del archivo', placeholder: 'Ej. cerró definitivamente el local' },
 }
 : {
 title: 'Restaurar comercio',
 message: `"${pending.business.name}" vuelve al listado de comercios y a la app si está aprobado.`,
 confirmLabel: 'Restaurar',
 variant: 'default' as const,
 reason: { label: 'Motivo de la reactivación', placeholder: 'Ej. reabrió con documentos al día' },
 }
 : null;

 return (
 <div className="space-y-3">
 <div className="page-header">
 <div>
 <h1 className="page-title">Comercios aliados</h1>
 <p className="page-subtitle">
 {meta.total} {archived ? 'archivados' : 'registrados'}
 </p>
 </div>
 <button
 onClick={() => setShowModal(true)}
 className="px-4 py-2 bg-[var(--color-primary)] hover:bg-[var(--accent-fill-hover)] text-xs font-bold text-white rounded transition-all cursor-pointer flex items-center justify-center gap-2"
 >
 
 <span>Nuevo establecimiento</span>
 </button>
 </div>

 <div className="space-y-2.5 pb-4 border-b border-[var(--color-border-light)]">
 <div className="flex flex-col md:flex-row gap-2.5 justify-between md:items-center">
 <div className="relative w-full md:w-80">
 
 <input
 type="text"
 value={search}
 onChange={(e) => setSearch(e.target.value)}
 placeholder="Buscar por nombre o ciudad…"
 className="field"
 />
 </div>
 <div className="flex gap-1.5">
 {[
 { value: false, label: 'Operando' },
 { value: true, label: 'Archivados' },
 ].map((tab) => (
 <button
 key={tab.label}
 onClick={() => setArchived(tab.value)}
 className={`px-3 py-1.5 text-xs font-semibold whitespace-nowrap transition-all cursor-pointer border-b-2 ${
 archived === tab.value
 ? 'border-[var(--color-primary)] text-[var(--color-text-main)] font-bold'
 : 'border-transparent text-[var(--color-text-main)] hover:text-[var(--color-text-main)]'
 }`}
 >
 {tab.label}
 </button>
 ))}
 </div>
 </div>
 <div className="flex gap-1.5 overflow-x-auto">
 {CATEGORIES.map((cat) => (
 <button
 key={cat.id}
 onClick={() => setSelectedCategory(cat.id)}
 className={`px-3 py-1.5 text-xs font-semibold whitespace-nowrap transition-all cursor-pointer border-b-2 ${
 selectedCategory === cat.id
 ? 'border-[var(--color-primary)] text-[var(--color-text-main)] font-bold'
 : 'border-transparent text-[var(--color-text-main)] hover:text-[var(--color-text-main)]'
 }`}
 >
 {cat.label}
 </button>
 ))}
 </div>
 </div>

 {error && (
 <p className="flex items-start gap-2 text-xs font-semibold text-[var(--color-danger)]">
  {error}
 </p>
 )}

 {loading ? (
 <p className="state-line">
 Cargando comercios...
 </p>
 ) : (
 <>
 <div className="overflow-x-auto">
 <table className="data-grid min-w-[980px]">
 <thead>
 <tr>
 <th className={headClass}>Comercio</th>
 <th className={headClass}>Dueño</th>
 <th className={headClass}>Estado</th>
 <th className={headClass}>Calificación</th>
 <th className={headClass}>Entrega</th>
 <th className={headClass}>Comisión</th>
 <th className={`${headClass} text-right`}>Acciones</th>
 </tr>
 </thead>
 <tbody>
 {businesses.map((b) => {
 const owner = ownerOf(b);
 return (
 <tr
 key={b._id}
 onClick={() => openFicha('business', b._id)}
 className="cursor-pointer hover:bg-[var(--color-bg)] transition-colors"
 >
 <td className={cellClass}>
 <div className="flex items-center gap-3">
 <div className="min-w-0">
 <p className="font-bold truncate max-w-[220px]">
 <EntityLink type="business" id={b._id}>{b.name}</EntityLink>
 </p>
 <p className="text-[var(--color-text-main)] truncate max-w-[220px]">
 {CATEGORY_LABEL[b.category] ?? b.category} · {b.address}
 </p>
 </div>
 </div>
 </td>
 <td className={cellClass}>
 <p>
 {owner?.name ? <EntityLink type="user" id={owner._id}>{owner.name}</EntityLink> : '—'}
 </p>
 <p className="font-mono text-[var(--color-text-main)]">{owner?.phone ?? ''}</p>
 </td>
 <td className={cellClass}>
 {b.isArchived ? (
 <>
 <p className="text-xs font-bold text-[var(--color-text-main)]">Archivado</p>
 {b.archiveReason && (
 <p className="text-[var(--color-text-main)] max-w-[200px] truncate" title={b.archiveReason}>
 {b.archiveReason}
 </p>
 )}
 </>
 ) : !b.isApproved ? (
 <p className="text-xs font-bold text-[var(--color-text-main)]">Sin aprobar</p>
 ) : b.isSuspended ? (
 <>
 <p className="text-xs font-bold text-[var(--color-danger)]">Suspendido por ZIPP</p>
 {b.suspensionReason && (
 <p className="text-[var(--color-text-main)] max-w-[200px] truncate" title={b.suspensionReason}>
 {b.suspensionReason}
 </p>
 )}
 </>
 ) : (
 <p className={`text-xs font-bold ${b.isActive ? 'text-[var(--color-success)]' : 'text-[var(--color-text-main)]'}`}>
 {b.isActive ? 'Abierto' : 'Cerrado por el dueño'}
 </p>
 )}
 {b.isFeatured && !b.isArchived && (
 <p className="text-xs font-bold text-[var(--color-text-main)]">Destacado</p>
 )}
 </td>
 <td className={`${cellClass} whitespace-nowrap`}>
 <span className="inline-flex items-center gap-1 font-medium">
 
 {b.rating ? b.rating.toFixed(1) : 'S/V'}
 <span className="text-[var(--color-text-main)]">({b.totalReviews ?? 0})</span>
 </span>
 </td>
 <td className={cellClass}>{b.deliveryTime} min</td>
 <td className={`${cellClass} font-mono font-semibold`}>
 {b.commissionRateBps >= 0 ? `${(b.commissionRateBps / 100).toFixed(1)}%` : 'Global'}
 </td>
 <td className={cellClass}>
 {/* Las acciones no deben abrir la ficha de la fila. */}
 <div className="flex items-center justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
 {b.isArchived ? (
 <PermissionGate permission={Permission.BUSINESSES_UPDATE_ALL}>
 <button
 onClick={() => setPending({ kind: 'restore', business: b })}
 className="flex items-center gap-1.5 px-2.5 py-2 rounded border border-[var(--color-border)] text-xs font-semibold cursor-pointer"
 >
  Restaurar
 </button>
 </PermissionGate>
 ) : (
 <>
 <PermissionGate permission={Permission.BUSINESSES_UPDATE_ALL}>
 <button
 onClick={() => handleToggleFeatured(b)}
 title={b.isFeatured ? 'Quitar de destacados' : 'Destacar'}
 className={`p-2 rounded border border-[var(--color-border)] cursor-pointer ${b.isFeatured ? 'text-[var(--color-text-main)]' : 'text-[var(--color-text-main)]'}`}
 >{b.isFeatured ? 'Quitar de destacados' : 'Destacar'}
 
 </button>
 </PermissionGate>
 <button
 onClick={() => setPending({ kind: b.isSuspended ? 'lift' : 'suspend', business: b })}
 title={b.isSuspended ? 'Levantar suspensión' : 'Suspender'}
 className={`p-2 rounded border cursor-pointer ${b.isSuspended ? 'border-[var(--color-primary)] text-[var(--color-text-main)]' : 'border-[var(--color-border)] text-[var(--color-danger)]'}`}
 >{b.isSuspended ? 'Levantar suspensión' : 'Suspender'}
 
 </button>
 <PermissionGate permission={Permission.BUSINESSES_UPDATE_ALL}>
 <button
 onClick={() => setPending({ kind: 'archive', business: b })}
 title="Archivar"
 className="p-2 rounded border border-[var(--color-border)] text-[var(--color-text-main)] hover:text-[var(--color-danger)] cursor-pointer"
 >Archivar
 
 </button>
 </PermissionGate>
 </>
 )}
 </div>
 </td>
 </tr>
 );
 })}
 {businesses.length === 0 && (
 <tr>
 <td colSpan={7} className="state-line">
 {archived ? 'No hay comercios archivados.' : 'No hay comercios que coincidan con la búsqueda.'}
 </td>
 </tr>
 )}
 </tbody>
 </table>
 </div>
 <Pagination page={page} totalPages={meta.totalPages} total={meta.total} limit={meta.limit} onPageChange={setPage} />
 </>
 )}

 {pending && dialog && (
 <ConfirmDialog
 title={dialog.title}
 message={dialog.message}
 confirmLabel={dialog.confirmLabel}
 variant={dialog.variant}
 reason={dialog.reason}
 onConfirm={confirmPending}
 onCancel={() => setPending(null)}
 />
 )}

 {showModal && (
 <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
 <div className="zipp-modal w-full max-w-xl rounded p-6 space-y-3 max-h-[90vh] overflow-y-auto">
 <div className="flex justify-between items-center border-b border-[var(--color-border-light)] pb-4">
 <div className="flex items-center gap-2">
 
 <h3 className="text-base font-bold text-[var(--color-text-main)]">Nuevo comercio aliado</h3>
 </div>
 <button onClick={() => setShowModal(false)} className="text-[var(--color-text-main)] hover:text-[var(--color-text-main)] p-1 rounded">Cerrar
 
 </button>
 </div>

 <form onSubmit={handleCreateBusiness} className="space-y-2.5">
 <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
 <div>
 <label className={labelClass}>Nombre del establecimiento</label>
 <input type="text" required value={form.name}
 onChange={(e) => setForm({ ...form, name: e.target.value })}
 className={inputClass} placeholder="Ej. Pollo Frito" />
 </div>
 <div>
 <label className={labelClass}>Usuario propietario</label>
 <select value={form.ownerId}
 onChange={(e) => setForm({ ...form, ownerId: e.target.value })}
 className={inputClass + ' cursor-pointer'}>
 {owners.map((o) => (
 <option key={o._id} value={o._id} className="text-[var(--color-text-main)]">
 {o.name} ({o.phone})
 </option>
 ))}
 </select>
 </div>
 </div>

 <div>
 <label className={labelClass}>Descripción del Menú / Especialidad</label>
 <textarea value={form.description}
 onChange={(e) => setForm({ ...form, description: e.target.value })}
 className="w-full p-3 rounded bg-[var(--color-bg)] border border-[var(--color-border)] text-xs text-[var(--color-text-main)] focus:border-[var(--color-primary)] focus:bg-[var(--color-surface)] outline-none min-h-[60px] placeholder:text-[var(--color-text-main)]"
 placeholder="Descripción atractiva para los usuarios" />
 </div>

 <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
 <div>
 <label className={labelClass}>Categoría principal</label>
 <select value={form.category}
 onChange={(e) => setForm({ ...form, category: e.target.value })}
 className={inputClass + ' cursor-pointer'}>
 <option value="restaurant">Restaurante</option>
 <option value="fast_food">Comidas Rápidas</option>
 <option value="pharmacy">Droguería</option>
 <option value="cafe">Cafetería</option>
 <option value="supermarket">Supermercado</option>
 </select>
 </div>
 <div>
 <label className={labelClass}>Teléfono de contacto</label>
 <input type="tel" required value={form.phone}
 onChange={(e) => setForm({ ...form, phone: e.target.value })}
 className={inputClass} placeholder="3151234567" />
 </div>
 </div>

 <div>
 <label className={labelClass}>Dirección exacta</label>
 <input type="text" required value={form.address}
 onChange={(e) => setForm({ ...form, address: e.target.value })}
 className={inputClass} placeholder="Calle 7 # 10-45" />
 </div>

 <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
 <div>
 <label className={labelClass}>Tiempo Promedio de Entrega (min)</label>
 <input type="number" required value={form.deliveryTime}
 onChange={(e) => setForm({ ...form, deliveryTime: Number(e.target.value) })}
 className={inputClass} />
 </div>
 <div>
 <label className={labelClass}>Comisión ZIPP (Decimal, ej: 0.12 = 12%)</label>
 <input type="number" step="0.01" required value={form.commissionRate}
 onChange={(e) => setForm({ ...form, commissionRate: Number(e.target.value) })}
 className={inputClass} />
 </div>
 </div>

 <button
 type="submit"
 className="w-full h-11 bg-[var(--color-primary)] hover:bg-[var(--accent-fill-hover)] text-white font-bold text-xs rounded cursor-pointer mt-2"
 >
 Crear comercio (queda pendiente de aprobación)
 </button>
 </form>
 </div>
 </div>
 )}
 </div>
 );
}
