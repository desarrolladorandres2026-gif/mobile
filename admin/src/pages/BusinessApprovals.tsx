import { Fragment, useCallback, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle, RotateCw, ChevronDown, ChevronRight } from 'lucide-react';
import api from '../services/api';
import ConfirmDialog from '../components/ConfirmDialog';
import { apiMessage } from '../lib/apiError';
import { useAuthStore } from '../stores/authStore';
import { Permission } from '../lib/permissions';
import { day } from '../lib/drivers';

type DocumentType =
 | 'rut'
 | 'chamber_of_commerce'
 | 'legal_rep_id'
 | 'bank_certificate'
 | 'health_permit';

interface HistoryEntry {
 status: string;
 rejectionReason?: string;
 reviewedAt?: string;
 submittedAt?: string;
 hasFile?: boolean;
 fileUrl?: string;
}

interface BusinessDoc {
 _id: string;
 type: DocumentType;
 reference: string;
 expiresAt?: string;
 status: 'pending' | 'approved' | 'rejected' | 'expired';
 rejectionReason?: string;
 updatedAt?: string;
 submittedAt?: string;
 fileFormat?: string;
 hasFile?: boolean;
 /** URL firmada calculada al leer: no se guarda ni se comparte. */
 fileUrl?: string;
 history?: HistoryEntry[];
}

interface PendingBusiness {
 _id: string;
 name: string;
 category: string;
 address: string;
 city: string;
 createdAt: string;
 ownerId?: { _id: string; name?: string; phone?: string; email?: string };
 missingDocuments: DocumentType[];
 documents: BusinessDoc[];
 fiscal?: { legalComplete: boolean; payoutAccountStatus: 'none' | 'pendingVerification' | 'verified' };
}

interface LegalView {
 documentType: string;
 documentNumber: string;
 dv?: string;
 legalName: string;
 legalRepName?: string;
 taxRegime?: string;
 billingEmail?: string;
 complete: boolean;
}

interface PayoutView {
 method: string;
 bankName?: string;
 accountType?: string;
 accountMasked: string;
 holderName: string;
 holderDocumentMasked?: string;
 holderMatchesLegal: boolean | null;
 verificationStatus: 'pendingVerification' | 'verified';
 version: number;
 accountNumber?: string;
 holderDocument?: string;
}

const DOCUMENT_LABELS: Record<DocumentType, string> = {
 rut: 'RUT',
 chamber_of_commerce: 'Cámara de Comercio',
 legal_rep_id: 'Cédula del representante',
 bank_certificate: 'Certificación bancaria',
 health_permit: 'Concepto sanitario',
};

const STATUS_STYLES: Record<BusinessDoc['status'], { label: string; className: string }> = {
 approved: { label: 'Aprobado', className: 'text-[#047857]' },
 pending: { label: 'Por revisar', className: 'text-[var(--color-warning)]' },
 rejected: { label: 'Rechazado', className: 'text-[var(--color-danger)]' },
 expired: { label: 'Vencido', className: 'text-[var(--color-danger)]' },
};

const METHOD_LABELS: Record<string, string> = { bank: 'Banco', nequi: 'Nequi', daviplata: 'DaviPlata' };

const isImage = (doc: BusinessDoc) => doc.hasFile && doc.fileFormat !== 'pdf' && !!doc.fileUrl;

export default function BusinessApprovals() {
 const canProcessPayouts = useAuthStore((s) => s.hasPermission(Permission.PAYOUTS_PROCESS));
 const canRevealAccount = useAuthStore((s) => s.hasPermission(Permission.PAYOUTS_REVEAL_ACCOUNT));
 const [pending, setPending] = useState<PendingBusiness[]>([]);
 const [search, setSearch] = useState('');
 const [order, setOrder] = useState<'oldest' | 'newest' | 'missing'>('oldest');
 const [loading, setLoading] = useState(true);
 const [error, setError] = useState('');
 const [working, setWorking] = useState<string | null>(null);
 const [openId, setOpenId] = useState<string | null>(null);
 const [rejecting, setRejecting] = useState<BusinessDoc | null>(null);
 const [legal, setLegal] = useState<Record<string, LegalView | null>>({});
 const [payout, setPayout] = useState<Record<string, PayoutView | null>>({});

 const fetchPending = useCallback(async () => {
 try {
 setLoading(true);
 setError('');
 const { data } = await api.get('/businesses/pending');
 setPending(data.data);
 } catch (err) {
 setError(apiMessage(err, 'No se pudo obtener la cola de comercios.'));
 } finally {
 setLoading(false);
 }
 }, []);

 useEffect(() => { fetchPending(); }, [fetchPending]);

 // Los datos fiscales y la cuenta no viajan en la cola: se piden al abrir el
 // comercio, y cada lectura queda auditada en el servidor.
 const openBusiness = async (id: string) => {
 if (openId === id) return setOpenId(null);
 setOpenId(id);
 try {
 const [l, p] = await Promise.all([
 api.get(`/businesses/${id}/legal`),
 api.get(`/businesses/${id}/payout-account`),
 ]);
 setLegal((prev) => ({ ...prev, [id]: l.data.data ?? null }));
 setPayout((prev) => ({ ...prev, [id]: p.data.data ?? null }));
 } catch (err) {
 setError(apiMessage(err, 'No se pudieron cargar los datos fiscales de este comercio.'));
 }
 };

 const reviewDocument = async (doc: BusinessDoc, status: 'approved' | 'rejected', rejectionReason?: string) => {
 try {
 setError('');
 setWorking(doc._id);
 await api.patch(`/businesses/documents/${doc._id}/review`, {
 status,
 rejectionReason,
 // Si el comercio reemplazó el archivo mientras se revisaba, el servidor lo rechaza.
 revision: doc.updatedAt ? Date.parse(doc.updatedAt) : undefined,
 });
 await fetchPending();
 } catch (err) {
 setError(apiMessage(err, 'No se pudo verificar el documento.'));
 } finally {
 setWorking(null);
 }
 };

 const verifyAccount = async (businessId: string) => {
 const view = payout[businessId];
 if (!view) return;
 try {
 setError('');
 setWorking(businessId);
 await api.patch(`/businesses/${businessId}/payout-account/verify`, { version: view.version });
 await fetchPending();
 const p = await api.get(`/businesses/${businessId}/payout-account`);
 setPayout((prev) => ({ ...prev, [businessId]: p.data.data ?? null }));
 } catch (err) {
 setError(apiMessage(err, 'No se pudo verificar la cuenta de pago.'));
 } finally {
 setWorking(null);
 }
 };

 // Para cotejar con la certificación bancaria. Queda auditado y no se guarda.
 const revealAccount = async (businessId: string) => {
 try {
 setError('');
 const { data } = await api.get(`/businesses/${businessId}/payout-account/reveal`);
 setPayout((prev) => ({ ...prev, [businessId]: data.data }));
 } catch (err) {
 setError(apiMessage(err, 'No se pudo mostrar la cuenta completa.'));
 }
 };

 const approveBusiness = async (businessId: string) => {
 try {
 setError('');
 setWorking(businessId);
 await api.patch(`/businesses/${businessId}/approve`);
 await fetchPending();
 } catch (err) {
 // El servidor dice qué falta (documentos, datos legales o cuenta sin verificar).
 setError(apiMessage(err, 'No se pudo aprobar el comercio.'));
 } finally {
 setWorking(null);
 }
 };

 const term = search.trim().toLowerCase();
 const visible = pending
 .filter((b) => !term || [b.name, b.city, b.ownerId?.name].some((v) => v?.toLowerCase().includes(term)))
 .sort((a, b) =>
 order === 'newest'
 ? new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
 : order === 'missing'
 ? b.missingDocuments.length - a.missingDocuments.length
 : new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
 );

 return (
 <div className="space-y-3">
 <div className="flex flex-col md:flex-row md:items-center justify-between gap-2.5">
 <div>
 <h1 className="page-title">Verificar comercios</h1>
 <p className="page-subtitle">
 {pending.length} por revisar. Aprobar fija los términos con los que se le paga: documentos, datos fiscales y cuenta de pago verificada.
 </p>
 </div>
 <button
 onClick={fetchPending}
 className="flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--color-border)] px-4 py-2 text-xs font-semibold text-[var(--color-text-main)]"
 >
 <RotateCw className="h-4 w-4 text-[var(--color-primary)]" /> Actualizar
 </button>
 </div>

 {error && (
 <p className="flex items-start gap-2 text-xs font-semibold text-[var(--color-danger)]">
 <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /> {error}
 </p>
 )}

 {!loading && pending.length > 0 && (
 <div className="flex flex-wrap items-center gap-3">
 <input
 value={search}
 onChange={(e) => setSearch(e.target.value)}
 placeholder="Buscar por comercio, ciudad o dueño"
 className="w-64 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-xs text-[var(--color-text-main)]"
 />
 <select
 value={order}
 onChange={(e) => setOrder(e.target.value as typeof order)}
 className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-xs text-[var(--color-text-main)]"
 >
 <option value="oldest">Los que más esperan primero</option>
 <option value="newest">Los más recientes primero</option>
 <option value="missing">Los que más documentos les faltan</option>
 </select>
 </div>
 )}

 {loading ? (
 <p className="py-16 text-center text-xs font-semibold text-[var(--color-text-main)]">Cargando comercios...</p>
 ) : pending.length === 0 ? (
 <div className="space-y-2 py-16 text-center">
 <CheckCircle className="w-8 h-8 text-[var(--color-success)] mx-auto" />
 <p className="text-sm font-bold text-[var(--color-text-main)]">No hay comercios esperando</p>
 <p className="text-xs text-[var(--color-text-main)] font-medium">Todos los negocios registrados están aprobados.</p>
 </div>
 ) : (
<div className="table-container">
 <div className="overflow-x-auto">
 <table className="data-grid">
 <thead>
 <tr className="text-left">
 <th className="table-header-cell">Comercio</th>
 <th className="table-header-cell">Categoría</th>
 <th className="table-header-cell">Dirección</th>
 <th className="table-header-cell">Ciudad</th>
 <th className="table-header-cell">Propietario</th>
 <th className="table-header-cell">Pendiente</th>
 <th className="table-header-cell">Acción</th>
 </tr>
 </thead>
 <tbody>
 {visible.map((business) => {
 const open = openId === business._id;
 const fiscal = business.fiscal;
 const l = legal[business._id];
 const p = payout[business._id];
 const blockers = [
 ...(business.missingDocuments.length
 ? [`Faltan: ${business.missingDocuments.map((d) => DOCUMENT_LABELS[d]).join(', ')}`]
 : []),
 ...(fiscal && !fiscal.legalComplete ? ['Datos fiscales incompletos'] : []),
 ...(fiscal && fiscal.payoutAccountStatus !== 'verified'
 ? [fiscal.payoutAccountStatus === 'none' ? 'Sin cuenta de pago' : 'Cuenta de pago sin verificar']
 : []),
 ];

 return (
 <Fragment key={business._id}>
 <tr>
 <td className="table-body-cell">
 <button onClick={() => openBusiness(business._id)} className="flex cursor-pointer items-center gap-1 text-left text-[var(--color-primary)]">
 {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
 {business.name}
 </button>
 </td>
 <td className="table-body-cell text-[var(--color-text-main)]">{business.category}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{business.address}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{business.city}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">
 {business.ownerId?.name ?? 'Sin asignar'}
 {business.ownerId?.phone ? ` · ${business.ownerId.phone}` : ''}
 </td>
 <td className="table-body-cell wrap text-[var(--color-warning)]">{blockers.length ? blockers.join(' · ') : '—'}</td>
 <td className="table-body-cell">
 {/* Nunca deshabilitado: si algo falta, el servidor lo dice y enseña qué. */}
 <button
 onClick={() => approveBusiness(business._id)}
 className={blockers.length === 0 ? 'cursor-pointer text-[var(--color-primary)]' : 'cursor-pointer text-[var(--color-text-main)]'}
 >
 {working === business._id ? 'Aprobando…' : 'Aprobar comercio'}
 </button>
 </td>
 </tr>
 {open && (
 <tr>
 <td colSpan={7} className="table-body-cell wrap">
 <div className="space-y-6 py-2">
 <section className="space-y-2">
 <h4 className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-main)]">Datos fiscales</h4>
 {l ? (
 <p className="text-xs text-[var(--color-text-main)]">
 <strong className="text-[var(--color-text-main)]">{l.legalName}</strong> · {l.documentType} {l.documentNumber}
 {l.dv ? `-${l.dv}` : ''}
 {l.legalRepName ? ` · representante ${l.legalRepName}` : ''}
 {l.taxRegime ? ` · régimen ${l.taxRegime}` : ''}
 {l.billingEmail ? ` · ${l.billingEmail}` : ''}
 </p>
 ) : (
 <p className="text-xs text-[var(--color-text-main)]">El comercio aún no registró sus datos fiscales.</p>
 )}
 </section>

 <section className="space-y-2">
 <h4 className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-main)]">Cuenta de pago</h4>
 {p ? (
 <div className="space-y-2 text-xs text-[var(--color-text-main)]">
 <p>
 <strong className="text-[var(--color-text-main)]">{METHOD_LABELS[p.method] ?? p.method}</strong>
 {p.bankName ? ` · ${p.bankName}` : ''}
 {p.accountType ? ` · ${p.accountType}` : ''} ·{' '}
 <span className="font-mono text-[var(--color-text-main)]">{p.accountNumber ?? p.accountMasked}</span> · titular {p.holderName}
 {p.holderDocument ? ` (${p.holderDocument})` : p.holderDocumentMasked ? ` (${p.holderDocumentMasked})` : ''}
 </p>
 {p.holderMatchesLegal === false && (
 <p className="font-semibold text-[var(--color-warning)]">El titular no coincide con el documento fiscal del comercio.</p>
 )}
 <p className={p.verificationStatus === 'verified' ? 'font-bold text-[#047857]' : 'font-bold text-[var(--color-warning)]'}>
 {p.verificationStatus === 'verified' ? 'Verificada por finanzas' : 'Pendiente de verificación'}
 </p>
 {(canProcessPayouts || canRevealAccount) && (
 <div className="flex flex-wrap gap-2">
 {canRevealAccount && !p.accountNumber && (
 <button
 onClick={() => revealAccount(business._id)}
 className="cursor-pointer rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-[11px] font-semibold text-[var(--color-text-main)]"
 >
 Ver cuenta completa (queda auditado)
 </button>
 )}
 {canProcessPayouts && p.verificationStatus !== 'verified' && (
 <button
 onClick={() => verifyAccount(business._id)}
 className="cursor-pointer rounded-lg bg-[var(--color-primary)] px-3 py-1.5 text-[11px] font-bold text-white"
 >
 {working === business._id ? 'Verificando…' : 'Verificar cuenta'}
 </button>
 )}
 </div>
 )}
 </div>
 ) : (
 <p className="text-xs text-[var(--color-text-main)]">El comercio aún no registró su cuenta de pago.</p>
 )}
 </section>

 <section className="space-y-1">
 <h4 className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-main)]">Documentos</h4>
 {business.documents.length === 0 ? (
 <p className="py-2 text-xs font-medium text-[var(--color-text-main)]">El comercio todavía no ha enviado ningún documento.</p>
 ) : (
 <div className="overflow-x-auto">
 <table className="data-grid">
 <thead>
 <tr className="text-left">
 <th className="table-header-cell">Archivo</th>
 <th className="table-header-cell">Documento</th>
 <th className="table-header-cell">Referencia</th>
 <th className="table-header-cell">Enviado</th>
 <th className="table-header-cell">Vence</th>
 <th className="table-header-cell">Versiones</th>
 <th className="table-header-cell">Estado</th>
 <th className="table-header-cell">Acción</th>
 </tr>
 </thead>
 <tbody>
 {business.documents.map((doc) => {
 const style = STATUS_STYLES[doc.status];
 return (
 <tr key={doc._id}>
 <td className="table-body-cell">
 {isImage(doc) ? (
 <a href={doc.fileUrl} target="_blank" rel="noreferrer" title="Abrir en tamaño completo">
 <img src={doc.fileUrl} alt={DOCUMENT_LABELS[doc.type]} loading="lazy" className="h-12 w-12 object-cover" />
 </a>
 ) : doc.hasFile && doc.fileUrl ? (
 <a href={doc.fileUrl} target="_blank" rel="noreferrer" className="text-[var(--color-primary)]">PDF</a>
 ) : (
 <span className="text-[var(--color-text-main)]">Sin archivo</span>
 )}
 </td>
 <td className="table-body-cell text-[var(--color-text-main)]">{DOCUMENT_LABELS[doc.type]}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{doc.reference}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{doc.submittedAt ? day(doc.submittedAt) : '—'}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{doc.expiresAt ? day(doc.expiresAt) : '—'}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{doc.history?.length ?? 0}</td>
 <td className={`table-body-cell wrap ${style.className}`}>
 {style.label}
 {doc.status === 'rejected' && doc.rejectionReason ? ` · ${doc.rejectionReason}` : ''}
 </td>
 <td className="table-body-cell">
 <div className="flex items-center gap-3">
 {doc.status !== 'approved' && (
 <button onClick={() => reviewDocument(doc, 'approved')} className="cursor-pointer text-[#047857]">
 {working === doc._id ? '…' : 'Aprobar'}
 </button>
 )}
 {doc.status !== 'rejected' && (
 <button onClick={() => setRejecting(doc)} className="cursor-pointer text-[var(--color-danger)]">
 Rechazar
 </button>
 )}
 {!doc.hasFile && /^https?:\/\//i.test(doc.reference) && (
 <a href={doc.reference} target="_blank" rel="noreferrer" className="text-[var(--color-primary)]">Enlace</a>
 )}
 </div>
 </td>
 </tr>
 );
 })}
 </tbody>
 </table>
 </div>
 )}
 </section>
 </div>
 </td>
 </tr>
 )}
 </Fragment>
 );
 })}
 </tbody>
 </table>
 </div>
 </div>
 )}

 {rejecting && (
 <ConfirmDialog
 title={`Rechazar ${DOCUMENT_LABELS[rejecting.type]}`}
 message="El comercio ve el motivo en su panel y puede volver a enviar el documento."
 confirmLabel="Rechazar"
 variant="danger"
 reason={{ label: 'Motivo (lo ve el comercio)', placeholder: 'Ej. la foto está borrosa, no se lee el NIT' }}
 onConfirm={(reason) => {
 const doc = rejecting;
 setRejecting(null);
 void reviewDocument(doc, 'rejected', reason);
 }}
 onCancel={() => setRejecting(null)}
 />
 )}
 </div>
 );
}
