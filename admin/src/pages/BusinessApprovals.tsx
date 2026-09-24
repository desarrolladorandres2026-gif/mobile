import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle, FileText, ExternalLink, ShieldCheck, RotateCw, ChevronDown, ChevronRight } from 'lucide-react';
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

      {loading ? (
        <p className="py-16 text-center text-xs font-semibold text-[var(--color-text-secondary)]">Cargando comercios...</p>
      ) : pending.length === 0 ? (
        <div className="space-y-2 py-16 text-center">
          <CheckCircle className="w-8 h-8 text-[var(--color-success)] mx-auto" />
          <p className="text-sm font-bold text-[var(--color-text-main)]">No hay comercios esperando</p>
          <p className="text-xs text-[var(--color-text-secondary)] font-medium">Todos los negocios registrados están aprobados.</p>
        </div>
      ) : (
        <ul>
          {pending.map((business) => {
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
              <li key={business._id} className="border-t border-[var(--color-border-light)] py-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <button onClick={() => openBusiness(business._id)} className="flex min-w-0 cursor-pointer items-start gap-2 text-left">
                    {open ? <ChevronDown className="mt-1 h-4 w-4 shrink-0" /> : <ChevronRight className="mt-1 h-4 w-4 shrink-0" />}
                    <div className="min-w-0">
                      <h3 className="text-base font-bold text-[var(--color-text-main)]">{business.name}</h3>
                      <p className="text-xs font-medium text-[var(--color-text-secondary)]">
                        {business.category} · {business.address} · {business.city}
                      </p>
                      <p className="text-xs font-medium text-[var(--color-text-secondary)]">
                        Propietario: <strong className="text-[var(--color-text-main)]">{business.ownerId?.name ?? 'Sin asignar'}</strong>
                        {business.ownerId?.phone ? ` · ${business.ownerId.phone}` : ''}
                      </p>
                    </div>
                  </button>

                  {/* Nunca deshabilitado: si algo falta, el servidor lo dice y enseña qué. */}
                  <button
                    onClick={() => approveBusiness(business._id)}
                    className={`flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-bold uppercase tracking-wider ${
                      blockers.length === 0
                        ? 'bg-[var(--color-primary)] text-white'
                        : 'border border-[var(--color-border)] text-[var(--color-text-secondary)]'
                    }`}
                  >
                    <ShieldCheck className="w-4 h-4" />
                    {working === business._id ? 'Aprobando…' : 'Aprobar comercio'}
                  </button>
                </div>

                {blockers.length > 0 && (
                  <p className="pl-6 pt-1.5 text-xs font-semibold text-[var(--color-warning)]">{blockers.join(' · ')}</p>
                )}

                {open && (
                  <div className="space-y-6 pl-6 pt-5">
                    <section className="space-y-2">
                      <h4 className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Datos fiscales</h4>
                      {l ? (
                        <p className="text-xs text-[var(--color-text-secondary)]">
                          <strong className="text-[var(--color-text-main)]">{l.legalName}</strong> · {l.documentType} {l.documentNumber}
                          {l.dv ? `-${l.dv}` : ''}
                          {l.legalRepName ? ` · representante ${l.legalRepName}` : ''}
                          {l.taxRegime ? ` · régimen ${l.taxRegime}` : ''}
                          {l.billingEmail ? ` · ${l.billingEmail}` : ''}
                        </p>
                      ) : (
                        <p className="text-xs text-[var(--color-text-muted)]">El comercio aún no registró sus datos fiscales.</p>
                      )}
                    </section>

                    <section className="space-y-2">
                      <h4 className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Cuenta de pago</h4>
                      {p ? (
                        <div className="space-y-2 text-xs text-[var(--color-text-secondary)]">
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
                        <p className="text-xs text-[var(--color-text-muted)]">El comercio aún no registró su cuenta de pago.</p>
                      )}
                    </section>

                    <section className="space-y-1">
                      <h4 className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Documentos</h4>
                      {business.documents.length === 0 && (
                        <p className="py-2 text-xs font-medium text-[var(--color-text-muted)]">El comercio todavía no ha enviado ningún documento.</p>
                      )}
                      {business.documents.map((doc) => {
                        const style = STATUS_STYLES[doc.status];
                        return (
                          <div key={doc._id} className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--color-border-light)] py-3">
                            <div className="flex min-w-0 items-center gap-3">
                              {isImage(doc) ? (
                                <a href={doc.fileUrl} target="_blank" rel="noreferrer" title="Abrir en tamaño completo" className="shrink-0">
                                  <img src={doc.fileUrl} alt={DOCUMENT_LABELS[doc.type]} loading="lazy" className="h-16 w-16 object-cover" />
                                </a>
                              ) : doc.hasFile && doc.fileUrl ? (
                                <a href={doc.fileUrl} target="_blank" rel="noreferrer" className="flex h-16 w-16 shrink-0 flex-col items-center justify-center gap-1 border border-[var(--color-border)] text-[var(--color-primary)]">
                                  <FileText className="h-5 w-5" />
                                  <span className="text-[9px] font-bold uppercase">PDF</span>
                                </a>
                              ) : (
                                <div className="flex h-16 w-16 shrink-0 items-center justify-center border border-dashed border-[var(--color-border)] text-[9px] font-bold uppercase text-[var(--color-text-muted)]">
                                  Sin archivo
                                </div>
                              )}
                              <div className="min-w-0">
                                <p className="text-xs font-bold text-[var(--color-text-main)]">{DOCUMENT_LABELS[doc.type]}</p>
                                <p className="font-mono text-xs text-[var(--color-text-secondary)]">{doc.reference}</p>
                                <p className="text-[11px] text-[var(--color-text-muted)]">
                                  {doc.submittedAt ? `Enviado ${day(doc.submittedAt)}` : ''}
                                  {doc.expiresAt ? ` · vence ${day(doc.expiresAt)}` : ''}
                                  {doc.history?.length ? ` · ${doc.history.length} versión(es) anterior(es)` : ''}
                                </p>
                                {doc.status === 'rejected' && doc.rejectionReason && (
                                  <p className="text-[11px] font-semibold text-[var(--color-danger)]">Motivo: {doc.rejectionReason}</p>
                                )}
                              </div>
                            </div>

                            <div className="flex items-center gap-2">
                              <span className={`text-[10px] font-bold uppercase tracking-wider ${style.className}`}>{style.label}</span>
                              {doc.status !== 'approved' && (
                                <button
                                  onClick={() => reviewDocument(doc, 'approved')}
                                  className="cursor-pointer rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-[11px] font-bold text-[#047857]"
                                >
                                  {working === doc._id ? '…' : 'Aprobar'}
                                </button>
                              )}
                              {doc.status !== 'rejected' && (
                                <button
                                  onClick={() => setRejecting(doc)}
                                  className="cursor-pointer rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-[11px] font-semibold text-[var(--color-danger)]"
                                >
                                  Rechazar
                                </button>
                              )}
                              {!doc.hasFile && /^https?:\/\//i.test(doc.reference) && (
                                <a href={doc.reference} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-[var(--color-primary)]">
                                  <ExternalLink className="h-3 w-3" /> Enlace
                                </a>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </section>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
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
