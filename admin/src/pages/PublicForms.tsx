import { useCallback, useEffect, useState } from 'react';
import api from '../services/api';
import { Permission } from '../lib/permissions';
import { PermissionGate } from '../components/PermissionGate';
import ConfirmDialog from '../components/ConfirmDialog';
import { apiMessage } from '../lib/apiError';

/**
 * Bandeja de lo que llega del sitio público sin sesión: mensajes del formulario
 * de soporte y solicitudes de comercios y repartidores. Ninguna de las dos cosas
 * crea ni cambia cuentas por sí sola: aprobar a un aliado es una decisión de
 * quien atiende, y el servidor exige además el permiso de cambio de rol.
 */

type Tab = 'contacto' | 'aliados';
type ContactStatus = 'new' | 'in_progress' | 'resolved';
type PartnerStatus = 'new' | 'contacted' | 'approved' | 'rejected';

interface ContactRequest {
 _id: string;
 name: string;
 contact: string;
 type: string;
 subject?: string;
 detail: string;
 status: ContactStatus;
 response?: string;
 createdAt: string;
}

interface PartnerApplication {
 _id: string;
 type: 'business' | 'driver';
 name: string;
 phone: string;
 email?: string;
 city: string;
 businessName?: string;
 category?: string;
 address?: string;
 vehicleType?: string;
 experience?: string;
 notes?: string;
 status: PartnerStatus;
 adminNote?: string;
 userId?: string;
 businessId?: string;
 createdAt: string;
}

const CONTACT_STATUS: Record<ContactStatus, string> = { new: 'Nuevo', in_progress: 'En curso', resolved: 'Resuelto' };
const PARTNER_STATUS: Record<PartnerStatus, string> = { new: 'Nueva', contacted: 'Contactada', approved: 'Aprobada', rejected: 'Rechazada' };
const CONTACT_TYPE: Record<string, string> = { question: 'Pregunta', complaint: 'Queja', claim: 'Reclamo', suggestion: 'Sugerencia', other: 'Otro' };
const VEHICLE: Record<string, string> = { moto: 'Moto', bicicleta: 'Bicicleta', carro: 'Carro', a_pie: 'A pie' };
const CATEGORIES = [
 { value: 'restaurant', label: 'Restaurante' },
 { value: 'fast_food', label: 'Comida rápida' },
 { value: 'pharmacy', label: 'Droguería' },
 { value: 'cafe', label: 'Cafetería' },
 { value: 'supermarket', label: 'Mercado' },
];

const fieldClass =
 'w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text-main)]';
const buttonClass =
 'cursor-pointer rounded border border-[var(--color-border)] px-3 py-1.5 text-xs font-semibold text-[var(--color-text-main)]';
const primaryClass = 'cursor-pointer rounded bg-[var(--color-primary)] px-3 py-1.5 text-xs font-bold text-white';

const when = (iso: string) =>
 new Date(iso).toLocaleString('es-CO', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function ContactList() {
 const [rows, setRows] = useState<ContactRequest[]>([]);
 const [status, setStatus] = useState<ContactStatus | ''>('new');
 const [loading, setLoading] = useState(true);
 const [error, setError] = useState('');
 const [response, setResponse] = useState<Record<string, string>>({});

 const load = useCallback(async () => {
 try {
 setLoading(true);
 setError('');
 const { data } = await api.get('/admin/contact-requests', { params: { status: status || undefined, limit: 50 } });
 setRows(data.data ?? []);
 } catch (err) {
 setError(apiMessage(err, 'No se pudieron cargar los mensajes.'));
 } finally {
 setLoading(false);
 }
 }, [status]);

 useEffect(() => { load(); }, [load]);

 const update = async (row: ContactRequest, next: ContactStatus) => {
 try {
 setError('');
 await api.patch(`/admin/contact-requests/${row._id}`, { status: next, response: response[row._id]?.trim() || undefined });
 await load();
 } catch (err) {
 setError(apiMessage(err, 'No se pudo actualizar el mensaje.'));
 }
 };

 return (
 <div className="space-y-4">
 <label className="flex items-center gap-2 text-xs font-semibold text-[var(--color-text-main)]">
 Estado
 <select value={status} onChange={(e) => setStatus(e.target.value as ContactStatus | '')} className={`${fieldClass} w-auto`}>
 <option value="">Todos</option>
 {(Object.keys(CONTACT_STATUS) as ContactStatus[]).map((s) => <option key={s} value={s}>{CONTACT_STATUS[s]}</option>)}
 </select>
 </label>
 {error && <p className="text-xs font-semibold text-[var(--color-danger)]">{error}</p>}
 {loading ? (
 <p className="state-line">Cargando…</p>
 ) : rows.length === 0 ? (
 <p className="state-line">No hay mensajes con ese estado.</p>
 ) : (
 <ul>
 {rows.map((row) => (
 <li key={row._id} className="border-b border-[var(--color-border-light)] py-4">
 <p className="font-bold text-[var(--color-text-main)]">
 {row.name} <span className="font-normal text-[var(--color-text-secondary)]">· {row.contact}</span>
 </p>
 <p className="text-xs text-[var(--color-text-main)]">
 {CONTACT_TYPE[row.type] ?? row.type} · {CONTACT_STATUS[row.status]} · {when(row.createdAt)}
 </p>
 {row.subject && <p className="mt-1 text-sm font-semibold text-[var(--color-text-main)]">{row.subject}</p>}
 <p className="mt-1 whitespace-pre-wrap text-sm text-[var(--color-text-main)]">{row.detail}</p>
 {row.response && <p className="mt-2 text-xs text-[var(--color-text-secondary)]">Respuesta registrada: {row.response}</p>}
 <PermissionGate permission={Permission.SUPPORT_MANAGE}>
 <div className="mt-3 space-y-2">
 <textarea
 value={response[row._id] ?? ''}
 onChange={(e) => setResponse({ ...response, [row._id]: e.target.value })}
 rows={2}
 maxLength={2000}
 placeholder="Nota de lo que se le respondió (opcional)"
 className={fieldClass}
 />
 <div className="flex flex-wrap gap-2">
 {row.status !== 'in_progress' && <button onClick={() => update(row, 'in_progress')} className={buttonClass}>Marcar en curso</button>}
 {row.status !== 'resolved' && <button onClick={() => update(row, 'resolved')} className={primaryClass}>Marcar resuelto</button>}
 </div>
 </div>
 </PermissionGate>
 </li>
 ))}
 </ul>
 )}
 </div>
 );
}

function PartnerList() {
 const [rows, setRows] = useState<PartnerApplication[]>([]);
 const [status, setStatus] = useState<PartnerStatus | ''>('new');
 const [type, setType] = useState<'business' | 'driver' | ''>('');
 const [loading, setLoading] = useState(true);
 const [error, setError] = useState('');
 const [notice, setNotice] = useState('');
 const [notes, setNotes] = useState<Record<string, string>>({});
 const [category, setCategory] = useState<Record<string, string>>({});
 const [toApprove, setToApprove] = useState<PartnerApplication | null>(null);

 const load = useCallback(async () => {
 try {
 setLoading(true);
 setError('');
 const { data } = await api.get('/admin/partner-applications', {
 params: { status: status || undefined, type: type || undefined, limit: 50 },
 });
 setRows(data.data ?? []);
 } catch (err) {
 setError(apiMessage(err, 'No se pudieron cargar las solicitudes.'));
 } finally {
 setLoading(false);
 }
 }, [status, type]);

 useEffect(() => { load(); }, [load]);

 const setState = async (row: PartnerApplication, next: PartnerStatus) => {
 try {
 setError('');
 setNotice('');
 await api.patch(`/admin/partner-applications/${row._id}`, { status: next, adminNote: notes[row._id]?.trim() || undefined });
 await load();
 } catch (err) {
 setError(apiMessage(err, 'No se pudo actualizar la solicitud.'));
 }
 };

 const approve = async () => {
 if (!toApprove) return;
 const row = toApprove;
 setToApprove(null);
 try {
 setError('');
 const { data } = await api.post(`/admin/partner-applications/${row._id}/approve`, {
 adminNote: notes[row._id]?.trim() || undefined,
 businessCategory: row.type === 'business' ? (category[row._id] || undefined) : undefined,
 });
 setNotice(
 data.data?.needsAccount
 ? `Aprobada. ${row.name} todavía no tiene cuenta: debe registrarse primero como cliente con el ${row.phone}.`
 : 'Aprobada. La cuenta ya tiene el nuevo rol.',
 );
 await load();
 } catch (err) {
 setError(apiMessage(err, 'No se pudo aprobar la solicitud.'));
 }
 };

 return (
 <div className="space-y-4">
 <div className="flex flex-wrap gap-4">
 <label className="flex items-center gap-2 text-xs font-semibold text-[var(--color-text-main)]">
 Estado
 <select value={status} onChange={(e) => setStatus(e.target.value as PartnerStatus | '')} className={`${fieldClass} w-auto`}>
 <option value="">Todos</option>
 {(Object.keys(PARTNER_STATUS) as PartnerStatus[]).map((s) => <option key={s} value={s}>{PARTNER_STATUS[s]}</option>)}
 </select>
 </label>
 <label className="flex items-center gap-2 text-xs font-semibold text-[var(--color-text-main)]">
 Tipo
 <select value={type} onChange={(e) => setType(e.target.value as 'business' | 'driver' | '')} className={`${fieldClass} w-auto`}>
 <option value="">Todos</option>
 <option value="business">Comercio</option>
 <option value="driver">Repartidor</option>
 </select>
 </label>
 </div>
 {error && <p className="text-xs font-semibold text-[var(--color-danger)]">{error}</p>}
 {notice && <p className="text-xs font-semibold text-[var(--color-text-main)]">{notice}</p>}
 {loading ? (
 <p className="state-line">Cargando…</p>
 ) : rows.length === 0 ? (
 <p className="state-line">No hay solicitudes con esos filtros.</p>
 ) : (
 <ul>
 {rows.map((row) => (
 <li key={row._id} className="border-b border-[var(--color-border-light)] py-4">
 <p className="font-bold text-[var(--color-text-main)]">
 {row.type === 'business' ? row.businessName : row.name}
 <span className="font-normal text-[var(--color-text-secondary)]"> · {row.type === 'business' ? 'Comercio' : 'Repartidor'} · {row.city}</span>
 </p>
 <p className="text-xs text-[var(--color-text-main)]">
 {PARTNER_STATUS[row.status]} · {when(row.createdAt)} · {row.name} · {row.phone}{row.email ? ` · ${row.email}` : ''}
 </p>
 {row.type === 'business' && (
 <p className="mt-1 text-sm text-[var(--color-text-main)]">{row.category} · {row.address}</p>
 )}
 {row.type === 'driver' && (
 <p className="mt-1 text-sm text-[var(--color-text-main)]">
 {VEHICLE[row.vehicleType ?? ''] ?? row.vehicleType}{row.experience ? ` · ${row.experience}` : ''}
 </p>
 )}
 {row.notes && <p className="mt-1 whitespace-pre-wrap text-sm text-[var(--color-text-main)]">{row.notes}</p>}
 {row.adminNote && <p className="mt-2 text-xs text-[var(--color-text-secondary)]">Nota interna: {row.adminNote}</p>}
 {row.businessId && <p className="mt-1 text-xs text-[var(--color-text-main)]">Comercio en borrador creado: complétalo y apruébalo en Aprobaciones.</p>}
 <PermissionGate permission={Permission.SUPPORT_MANAGE}>
 {(row.status === 'new' || row.status === 'contacted') && (
 <div className="mt-3 space-y-2">
 <textarea
 value={notes[row._id] ?? ''}
 onChange={(e) => setNotes({ ...notes, [row._id]: e.target.value })}
 rows={2}
 maxLength={1000}
 placeholder="Nota interna (opcional)"
 className={fieldClass}
 />
 {row.type === 'business' && (
 <label className="flex items-center gap-2 text-xs font-semibold text-[var(--color-text-main)]">
 Categoría del comercio
 <select
 value={category[row._id] ?? ''}
 onChange={(e) => setCategory({ ...category, [row._id]: e.target.value })}
 className={`${fieldClass} w-auto`}
 >
 <option value="">Según la solicitud</option>
 {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
 </select>
 </label>
 )}
 <div className="flex flex-wrap gap-2">
 {row.status === 'new' && <button onClick={() => setState(row, 'contacted')} className={buttonClass}>Marcar contactada</button>}
 <button onClick={() => setState(row, 'rejected')} className={`${buttonClass} border-[var(--color-danger)] text-[var(--color-danger)]`}>Rechazar</button>
 <button onClick={() => setToApprove(row)} className={primaryClass}>Aprobar</button>
 </div>
 </div>
 )}
 </PermissionGate>
 </li>
 ))}
 </ul>
 )}

 {toApprove && (
 <ConfirmDialog
 title="Aprobar solicitud"
 message={
 toApprove.type === 'business'
 ? `Se cambia el rol de la cuenta ${toApprove.phone} a comercio y se crea el comercio en borrador. El dueño sube los documentos y administración lo aprueba con el flujo normal.`
 : `Se cambia el rol de la cuenta ${toApprove.phone} a domiciliario. El perfil y los documentos los completa en la app.`
 }
 confirmLabel="Aprobar"
 onConfirm={approve}
 onCancel={() => setToApprove(null)}
 />
 )}
 </div>
 );
}

export default function PublicForms() {
 const [tab, setTab] = useState<Tab>('aliados');

 return (
 <div className="space-y-6">
 <div>
 <h1 className="page-title">Solicitudes del sitio</h1>
 <p className="text-xs text-[var(--color-text-main)]">
 Lo que llega del sitio público sin sesión. Los celulares ya vienen verificados por código.
 </p>
 </div>
 <div className="flex gap-6 border-b border-[var(--color-border-light)]" role="tablist">
 {([['aliados', 'Aliados'], ['contacto', 'Mensajes']] as const).map(([key, label]) => (
 <button
 key={key}
 role="tab"
 aria-selected={tab === key}
 onClick={() => setTab(key)}
 className={`cursor-pointer border-b-2 pb-2 text-sm font-semibold ${tab === key ? 'border-[var(--color-primary)] text-[var(--color-text-main)]' : 'border-transparent text-[var(--color-text-secondary)]'}`}
 >
 {label}
 </button>
 ))}
 </div>
 {tab === 'aliados' ? <PartnerList /> : <ContactList />}
 </div>
 );
}
