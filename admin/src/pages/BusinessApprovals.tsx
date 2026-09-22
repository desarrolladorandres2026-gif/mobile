import { useEffect, useState } from 'react';
import {
  AlertCircle, CheckCircle, X, Store, FileText, ExternalLink, ShieldCheck,
} from 'lucide-react';
import api from '../services/api';
import { apiMessage } from '../lib/apiError';

type DocumentType =
  | 'rut'
  | 'chamber_of_commerce'
  | 'legal_rep_id'
  | 'bank_certificate'
  | 'health_permit';

interface BusinessDoc {
  _id: string;
  type: DocumentType;
  reference: string;
  expiresAt?: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  rejectionReason?: string;
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

export default function BusinessApprovals() {
  const [pending, setPending] = useState<PendingBusiness[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [working, setWorking] = useState<string | null>(null);

  const fetchPending = async () => {
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
  };

  useEffect(() => { fetchPending(); }, []);

  const reviewDocument = async (documentId: string, status: 'approved' | 'rejected') => {
    try {
      setError('');
      setWorking(documentId);
      await api.patch(`/businesses/documents/${documentId}/review`, { status });
      // Se recarga entero: aprobar un documento cambia la lista de faltantes
      // del negocio, y esa regla la calcula el servidor.
      await fetchPending();
    } catch (err) {
      setError(apiMessage(err, 'No se pudo verificar el documento.'));
    } finally {
      setWorking(null);
    }
  };

  const approveBusiness = async (businessId: string) => {
    try {
      setError('');
      setWorking(businessId);
      await api.patch(`/businesses/${businessId}/approve`);
      await fetchPending();
    } catch (err) {
      // El servidor rechaza la aprobación si faltan papeles, y su mensaje
      // dice cuáles: se muestra tal cual en vez de uno genérico.
      setError(apiMessage(err, 'No se pudo aprobar el comercio.'));
    } finally {
      setWorking(null);
    }
  };

  const isLink = (reference: string) => /^https?:\/\//i.test(reference);

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="page-title">Verificación de Comercios</h1>
          <p className="page-subtitle">
            Aprobar un comercio fija los términos con los que se le va a pagar. Revisa sus papeles antes
          </p>
        </div>

        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] text-xs font-bold text-[var(--color-text-main)] shadow-xs">
          <span className="w-2 h-2 rounded-full bg-[var(--color-warning)] animate-pulse" />
          <span>{pending.length} por revisar</span>
        </div>
      </div>

      {error && (
        <div className="text-[var(--color-danger)] text-xs flex items-start gap-3">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <p className="flex-1 font-semibold">{error}</p>
        </div>
      )}

      {loading ? (
        <div className="table-container p-16 text-center text-[var(--color-text-secondary)] text-xs font-semibold">
          Cargando comercios...
        </div>
      ) : pending.length === 0 ? (
        <div className="table-container p-16 text-center space-y-2">
          <CheckCircle className="w-8 h-8 text-[var(--color-success)] mx-auto" />
          <p className="text-sm font-bold text-[var(--color-text-main)]">No hay comercios esperando</p>
          <p className="text-xs text-[var(--color-text-secondary)] font-medium">
            Todos los negocios registrados están aprobados.
          </p>
        </div>
      ) : (
        <div className="grid gap-4">
          {pending.map((business) => {
            const ready = business.missingDocuments.length === 0;

            return (
              <div key={business._id} className="zipp-card p-5 space-y-4">
                <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
                  <div className="flex items-start gap-4 min-w-0">
                    <div className="w-12 h-12 rounded-xl bg-[var(--color-sidebar-hover)] flex items-center justify-center flex-shrink-0">
                      <Store className="w-5 h-5 text-white" />
                    </div>

                    <div className="min-w-0 space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2.5">
                        <h3 className="text-base font-bold text-[var(--color-text-main)]">{business.name}</h3>
                        <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md bg-[var(--color-bg-alt)] text-[var(--color-text-muted)] border border-[var(--color-border)]">
                          {business.category}
                        </span>
                      </div>

                      <p className="text-xs text-[var(--color-text-secondary)] font-medium">
                        {business.address} · {business.city}
                      </p>

                      <p className="text-xs text-[var(--color-text-secondary)] font-medium">
                        Propietario: <strong className="text-[var(--color-text-main)]">{business.ownerId?.name ?? 'Sin asignar'}</strong>
                        {business.ownerId?.phone ? ` · ${business.ownerId.phone}` : ''}
                      </p>
                    </div>
                  </div>

                  <button
                    onClick={() => approveBusiness(business._id)}
                    // Nunca deshabilitado: si faltan papeles, el servidor lo
                    // dice y su mensaje enseña cuáles. Un botón gris obliga a
                    // adivinar por qué no se puede.
                    className={`px-3.5 py-2 rounded-lg font-bold text-xs uppercase tracking-wider transition-all cursor-pointer shadow-xs flex items-center gap-1.5 shrink-0 ${
                      ready
                        ? 'bg-[var(--color-primary)] text-white hover:bg-[#8A5D08]'
                        : 'bg-[var(--color-bg)] text-[var(--color-text-secondary)] border border-[var(--color-border)]'
                    }`}
                  >
                    <ShieldCheck className="w-4 h-4" />
                    {working === business._id ? 'Aprobando…' : 'Aprobar comercio'}
                  </button>
                </div>

                {business.missingDocuments.length > 0 && (
                  <div className="text-[var(--color-warning)] text-xs font-semibold">
                    Faltan: {business.missingDocuments.map((d) => DOCUMENT_LABELS[d]).join(', ')}
                  </div>
                )}

                <div className="grid gap-2">
                  {business.documents.map((doc) => {
                    const style = STATUS_STYLES[doc.status];
                    return (
                      <div
                        key={doc._id}
                        className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)]"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <FileText className="w-4 h-4 text-[var(--color-text-muted)] shrink-0" />
                          <div className="min-w-0">
                            <p className="text-xs font-bold text-[var(--color-text-main)]">
                              {DOCUMENT_LABELS[doc.type]}
                            </p>
                            {isLink(doc.reference) ? (
                              <a
                                href={doc.reference}
                                target="_blank"
                                rel="noreferrer"
                                className="text-xs font-semibold text-[var(--color-primary)] hover:underline inline-flex items-center gap-1"
                              >
                                <ExternalLink className="w-3 h-3" />
                                Ver documento
                              </a>
                            ) : (
                              <p className="text-xs text-[var(--color-text-secondary)] font-mono">{doc.reference}</p>
                            )}
                          </div>
                        </div>

                        <div className="flex items-center gap-2">
                          <span className={`text-[10px] font-bold uppercase tracking-wider ${style.className}`}>
                            {style.label}
                          </span>

                          {doc.status !== 'approved' && (
                            <button
                              onClick={() => reviewDocument(doc._id, 'approved')}
                              className="p-1.5 rounded-lg bg-[var(--color-success-bg)] text-[#047857] hover:opacity-80 transition-all cursor-pointer"
                              title="Aprobar documento"
                            >
                              <CheckCircle className="w-4 h-4" />
                            </button>
                          )}

                          {doc.status !== 'rejected' && (
                            <button
                              onClick={() => reviewDocument(doc._id, 'rejected')}
                              className="p-1.5 rounded-lg bg-[var(--color-danger-bg)] text-[var(--color-danger)] hover:opacity-80 transition-all cursor-pointer"
                              title="Rechazar documento"
                            >
                              <X className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}

                  {business.documents.length === 0 && (
                    <p className="text-xs text-[var(--color-text-muted)] font-medium py-2">
                      El comercio todavía no ha enviado ningún documento.
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
