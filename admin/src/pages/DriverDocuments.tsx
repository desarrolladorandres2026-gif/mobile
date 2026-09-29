import { useCallback, useEffect, useState } from 'react';
import {
 AlertCircle, CheckCircle, X, FileText, RotateCw,
} from 'lucide-react';
import api from '../services/api';
import { apiMessage } from '../lib/apiError';
import { PermissionGate } from '../components/PermissionGate';
import { Permission } from '../lib/permissions';

interface DriverRef {
 _id: string;
 isApproved: boolean;
 isActive: boolean;
 vehicleType: string;
 licensePlate?: string;
 userId?: { _id: string; name: string; phone: string };
}

interface DriverDocumentType {
 _id: string;
 driverId?: DriverRef;
 type: 'identity' | 'license' | 'soat' | 'technical_review' | 'vehicle_registration';
 reference: string;
 /** Ausente en los registros que se crearon cuando esto solo pedía el número. */
 imageUrl?: string;
 expiresAt?: string;
 status: 'pending' | 'approved' | 'rejected' | 'expired';
 createdAt: string;
}

interface Queue {
 pending: DriverDocumentType[];
 expired: DriverDocumentType[];
 expiringSoon: DriverDocumentType[];
}

interface IdentityCheck {
 _id: string;
 type: 'document_id' | 'selfie' | 'profile_photo' | 'biometric' | 'random_selfie';
 status: 'requested' | 'pending';
 imageUrl?: string;
 dueAt?: string;
 createdAt: string;
 driver?: { _id: string; licensePlate?: string; vehicleType?: string };
 user?: { _id: string; name: string; phone?: string; avatar?: string };
 identityDocumentUrl?: string;
}

const DOCUMENT_LABELS: Record<DriverDocumentType['type'], string> = {
 identity: 'Documento de identidad',
 license: 'Licencia de conducción',
 soat: 'SOAT',
 technical_review: 'Revisión técnico-mecánica',
 vehicle_registration: 'Tarjeta de propiedad',
};

const CHECK_LABELS: Record<IdentityCheck['type'], string> = {
 document_id: 'Documento',
 selfie: 'Selfie de alta',
 profile_photo: 'Foto de perfil',
 biometric: 'Biometría',
 random_selfie: 'Selfie aleatoria en turno',
};

/**
 * Los tres que el servidor exige para dejar trabajar a alguien.
 * Espejo de `assertDocumentsCurrent` en el backend.
 */
const BLOCKING_TYPES = new Set<DriverDocumentType['type']>(['identity', 'license', 'soat']);

function daysUntil(date: string): number {
 return Math.ceil((new Date(date).getTime() - Date.now()) / 86_400_000);
}

const isLink = (reference: string) => /^https?:\/\//i.test(reference);

function Thumb({ url, label }: { url?: string; label: string }) {
 if (!url) {
 return (
 <div className="flex h-16 w-16 shrink-0 flex-col items-center justify-center gap-1 border border-dashed border-[var(--color-border)] text-[var(--color-text-main)]">
 <FileText className="h-5 w-5" />
 <span className="text-[9px] font-bold uppercase tracking-wider">Sin foto</span>
 </div>
 );
 }
 return (
 <a href={url} target="_blank" rel="noreferrer" title={`Abrir ${label} en tamaño completo`} className="shrink-0">
 <img src={url} alt={label} loading="lazy" className="h-16 w-16 object-cover" />
 <span className="mt-1 block text-center text-[9px] font-bold uppercase tracking-wider text-[var(--color-text-main)]">
 {label}
 </span>
 </a>
 );
}

/** Rechazar siempre dice por qué: el domiciliario lo lee en su app y corrige. */
function RejectForm({
 busy,
 onCancel,
 onConfirm,
}: {
 busy: boolean;
 onCancel: () => void;
 onConfirm: (reason: string) => void;
}) {
 const [reason, setReason] = useState('');
 const [tried, setTried] = useState(false);
 const valid = reason.trim().length >= 5;
 return (
 <div className="flex w-full flex-col gap-2 md:w-80">
 <input
 autoFocus
 value={reason}
 onChange={(e) => setReason(e.target.value)}
 maxLength={300}
 placeholder="Motivo que verá el domiciliario (p. ej. foto borrosa)"
 className="h-9 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-xs text-[var(--color-text-main)] outline-none focus:border-[var(--color-danger)]"
 />
 {tried && !valid && (
 <p className="text-[11px] font-semibold text-[var(--color-danger)]">Escribe el motivo (mínimo 5 caracteres).</p>
 )}
 <div className="flex justify-end gap-2">
 <button onClick={onCancel} className="cursor-pointer px-3 py-1.5 text-xs font-semibold text-[var(--color-text-main)]">
 Cancelar
 </button>
 <button
 onClick={() => (valid && !busy ? onConfirm(reason.trim()) : setTried(true))}
 className="cursor-pointer rounded-lg bg-[var(--color-danger)] px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-white"
 >
 {busy ? 'Guardando…' : 'Confirmar rechazo'}
 </button>
 </div>
 </div>
 );
}

export default function DriverDocuments() {
 const [queue, setQueue] = useState<Queue>({ pending: [], expired: [], expiringSoon: [] });
 const [search, setSearch] = useState('');
 const [checks, setChecks] = useState<IdentityCheck[]>([]);
 const [loading, setLoading] = useState(true);
 const [error, setError] = useState('');
 const [working, setWorking] = useState<string | null>(null);
 const [rejecting, setRejecting] = useState<string | null>(null);

 const fetchAll = useCallback(async () => {
 try {
 setLoading(true);
 setError('');
 const [docs, identity] = await Promise.all([
 api.get('/drivers/documents/queue'),
 api.get('/drivers/verifications/queue'),
 ]);
 setQueue(docs.data.data);
 setChecks(identity.data.data ?? []);
 } catch (err) {
 setError(apiMessage(err, 'No se pudo obtener la cola de verificación.'));
 } finally {
 setLoading(false);
 }
 }, []);

 useEffect(() => { fetchAll(); }, [fetchAll]);

 const run = async (id: string, action: () => Promise<unknown>, fallback: string) => {
 try {
 setError('');
 setWorking(id);
 await action();
 setRejecting(null);
 // Se recarga todo: aprobar un documento puede mover a otros del mismo
 // domiciliario de grupo, y adivinarlo aquí sería adivinar la regla del servidor.
 await fetchAll();
 } catch (err) {
 setError(apiMessage(err, fallback));
 } finally {
 setWorking(null);
 }
 };

 const reviewDocument = (id: string, status: 'approved' | 'rejected', rejectionReason?: string) =>
 run(id, () => api.patch(`/drivers/documents/${id}/review`, { status, rejectionReason }), 'No se pudo verificar el documento.');

 const reviewCheck = (id: string, status: 'approved' | 'rejected', rejectionReason?: string) =>
 run(id, () => api.patch(`/drivers/verifications/${id}/review`, { status, rejectionReason }), 'No se pudo revisar la verificación.');

 const actions = (id: string, onApprove: () => void, onReject: (reason: string) => void) =>
 rejecting === id ? (
 <RejectForm busy={working === id} onCancel={() => setRejecting(null)} onConfirm={onReject} />
 ) : (
 <PermissionGate permission={Permission.DRIVERS_APPROVE}>
 <div className="flex items-center gap-2">
 <button
 onClick={onApprove}
 className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-[var(--color-primary)] px-3.5 py-2 text-xs font-bold uppercase tracking-wider text-white"
 >
 <CheckCircle className="h-4 w-4" />
 {working === id ? 'Guardando…' : 'Aprobar'}
 </button>
 <button
 onClick={() => setRejecting(id)}
 className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3.5 py-2 text-xs font-semibold text-[var(--color-danger)]"
 >
 <X className="h-4 w-4" /> Rechazar
 </button>
 </div>
 </PermissionGate>
 );

 const renderDocument = (doc: DriverDocumentType, tone: 'pending' | 'expired' | 'soon') => {
  const driver = doc.driverId;
  const blocking = BLOCKING_TYPES.has(doc.type);
  const days = doc.expiresAt ? daysUntil(doc.expiresAt) : null;
  const state =
   tone === 'expired'
    ? { text: 'Vencido', className: 'text-[var(--color-danger)]' }
    : tone === 'soon' && days !== null
     ? { text: days <= 0 ? 'Vence hoy' : `Vence en ${days} día${days === 1 ? '' : 's'}`, className: 'text-[var(--color-warning)]' }
     : { text: 'Por revisar', className: 'text-[var(--color-text-main)]' };

  return (
   <tr key={doc._id}>
    <td className="table-body-cell"><Thumb url={doc.imageUrl} label={DOCUMENT_LABELS[doc.type]} /></td>
    <td className="table-body-cell text-[var(--color-text-main)]">{DOCUMENT_LABELS[doc.type]}</td>
    <td className={`table-body-cell ${blocking ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-main)]'}`}>{blocking ? 'Sí' : 'No'}</td>
    <td className="table-body-cell text-[var(--color-text-main)]">
     {driver?.userId?.name || 'Domiciliario'}
     {driver?.userId?.phone ? ` · ${driver.userId.phone}` : ''}
    </td>
    <td className="table-body-cell text-[var(--color-primary)]">{driver?.licensePlate ?? '—'}</td>
    <td className="table-body-cell">
     {isLink(doc.reference) ? (
      <a href={doc.reference} target="_blank" rel="noreferrer" className="text-[var(--color-primary)] hover:underline">
       Ver documento
      </a>
     ) : (
      <span className="text-[var(--color-text-main)]">{doc.reference}</span>
     )}
    </td>
    <td className="table-body-cell text-[var(--color-text-main)]">{doc.expiresAt ? new Date(doc.expiresAt).toLocaleDateString('es-CO') : '—'}</td>
    <td className="table-body-cell text-[var(--color-text-main)]">{new Date(doc.createdAt).toLocaleDateString('es-CO')}</td>
    <td className={`table-body-cell ${state.className}`}>{state.text}</td>
    <td className="table-body-cell wrap">
     {actions(
      doc._id,
      () => reviewDocument(doc._id, 'approved'),
      (reason) => reviewDocument(doc._id, 'rejected', reason)
     )}
    </td>
   </tr>
  );
 };

 const renderCheck = (check: IdentityCheck) => {
  const waiting = check.status === 'requested';
  const overdue = waiting && check.dueAt ? new Date(check.dueAt).getTime() < Date.now() : false;
  const when = (d: string) => new Date(d).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' });
  return (
   <tr key={check._id}>
    <td className="table-body-cell">
     <div className="flex gap-2">
      <Thumb url={check.imageUrl} label={CHECK_LABELS[check.type] ?? 'Selfie'} />
      <Thumb url={check.identityDocumentUrl} label="Cédula" />
      {check.user?.avatar ? <Thumb url={check.user.avatar} label="Perfil" /> : null}
     </div>
    </td>
    <td className="table-body-cell text-[var(--color-text-main)]">{CHECK_LABELS[check.type] ?? check.type}</td>
    <td className="table-body-cell text-[var(--color-text-main)]">
     {check.user?.name ?? 'Domiciliario'}
     {check.user?.phone ? ` · ${check.user.phone}` : ''}
    </td>
    <td className="table-body-cell text-[var(--color-primary)]">{check.driver?.licensePlate ?? '—'}</td>
    <td className={`table-body-cell ${overdue ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-main)]'}`}>
     {waiting
      ? `Solicitada, sin respuesta${check.dueAt ? ` · plazo ${when(check.dueAt)}` : ''}`
      : `Enviada ${when(check.createdAt)}`}
    </td>
    <td className="table-body-cell wrap">
     {waiting ? (
      <span className="text-[var(--color-text-main)]">Esperando la foto</span>
     ) : (
      actions(
       check._id,
       () => reviewCheck(check._id, 'approved'),
       (reason) => reviewCheck(check._id, 'rejected', reason)
      )
     )}
    </td>
   </tr>
  );
 };

 const DOC_HEADERS = ['Foto', 'Documento', 'Obligatorio', 'Domiciliario', 'Placa', 'Referencia', 'Vence', 'Enviado', 'Estado', 'Acción'];
 const CHECK_HEADERS = ['Fotos', 'Tipo', 'Domiciliario', 'Placa', 'Estado', 'Acción'];

 const section = (title: string, hint: string, rows: React.ReactNode[], headers: string[]) =>
  rows.length ? (
   <section className="space-y-1">
    <h2 className="text-sm font-bold uppercase tracking-wider text-[var(--color-text-main)]">
     {title} <span className="text-[var(--color-text-main)]">({rows.length})</span>
    </h2>
    <p className="pb-2 text-xs font-medium text-[var(--color-text-main)]">{hint}</p>
    <div className="table-container">
     <div className="overflow-x-auto">
      <table className="data-grid">
       <thead>
        <tr className="text-left">
         {headers.map((h) => <th key={h} className="table-header-cell">{h}</th>)}
        </tr>
       </thead>
       <tbody>{rows}</tbody>
      </table>
     </div>
    </div>
   </section>
  ) : null;

 const pendingChecks = checks.filter((c) => c.status === 'pending');
 const requestedChecks = checks.filter((c) => c.status === 'requested');
 const total = queue.pending.length + queue.expired.length + queue.expiringSoon.length + checks.length;
 const term = search.trim().toLowerCase();
 const matches = (d: DriverDocumentType) =>
 !term || [d.driverId?.userId?.name, d.driverId?.licensePlate].some((v) => v?.toLowerCase().includes(term));

 return (
 <div className="space-y-3">
 <div className="flex flex-col justify-between gap-2.5 md:flex-row md:items-center">
 <div>
 <h1 className="page-title">Verificación de domiciliarios</h1>
 <p className="page-subtitle">
 {queue.expired.length} vencidos · {queue.pending.length} documentos por revisar · {pendingChecks.length} verificaciones de identidad
 </p>
 </div>
 <button
 onClick={fetchAll}
 className="flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--color-border)] px-4 py-2 text-xs font-semibold text-[var(--color-text-main)]"
 >
 <RotateCw className="h-4 w-4 text-[var(--color-primary)]" /> Actualizar
 </button>
 </div>

 <input
 value={search}
 onChange={(e) => setSearch(e.target.value)}
 placeholder="Buscar por domiciliario o placa"
 className="w-64 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-xs text-[var(--color-text-main)]"
 />

 {error && (
 <p className="flex items-start gap-2 text-xs font-semibold text-[var(--color-danger)]">
 <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
 </p>
 )}

 {loading ? (
 <p className="py-16 text-center text-xs font-semibold text-[var(--color-text-main)]">Cargando verificaciones...</p>
 ) : total === 0 ? (
 <div className="space-y-2 py-16 text-center">
 <CheckCircle className="mx-auto h-8 w-8 text-[var(--color-success)]" />
 <p className="text-sm font-bold text-[var(--color-text-main)]">No hay nada pendiente</p>
 <p className="text-xs font-medium text-[var(--color-text-main)]">
 Ningún documento ni verificación espera revisión, y nada vence en los próximos 30 días.
 </p>
 </div>
 ) : (
 <div className="space-y-10 pt-2">
 {section(
 'Documentos vencidos',
 'Estos domiciliarios ya no pueden trabajar. Van primero porque cada uno es una persona parada.',
 queue.expired.filter(matches).map((d) => renderDocument(d, 'expired')),
        DOC_HEADERS
 )}
 {section(
 'Verificaciones de identidad',
 'Compara la selfie con la cédula y la foto de perfil. Si no es la misma persona, rechaza y di por qué.',
 pendingChecks.map(renderCheck),
        CHECK_HEADERS
 )}
 {section(
 'Documentos por revisar',
 'Enviados por el domiciliario y todavía sin verificar.',
 queue.pending.filter(matches).map((d) => renderDocument(d, 'pending')),
        DOC_HEADERS
 )}
 {section(
 'Documentos por vencer',
 'Siguen vigentes, pero caducan pronto. Avisar ahora evita la baja sorpresa.',
 queue.expiringSoon.filter(matches).map((d) => renderDocument(d, 'soon')),
        DOC_HEADERS
 )}
 {section(
 'Verificaciones solicitadas sin respuesta',
 'ZIPP pidió una selfie y el domiciliario aún no la envía.',
 requestedChecks.map(renderCheck),
        CHECK_HEADERS
 )}
 </div>
 )}
 </div>
 );
}
