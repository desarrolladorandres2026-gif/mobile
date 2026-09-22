import { useEffect, useState } from 'react';
import {
  AlertCircle, CheckCircle, X, FileText, ExternalLink, Clock, ShieldAlert,
} from 'lucide-react';
import api from '../services/api';
import { apiMessage } from '../lib/apiError';

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
  /** La foto que subió el domiciliario. Ausente en los registros que se
   *  crearon cuando esto solo pedía el número. */
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

const DOCUMENT_LABELS: Record<DriverDocumentType['type'], string> = {
  identity: 'Documento de identidad',
  license: 'Licencia de conducción',
  soat: 'SOAT',
  technical_review: 'Revisión técnico-mecánica',
  vehicle_registration: 'Tarjeta de propiedad',
};

/**
 * Los tres que el servidor exige para dejar trabajar a alguien.
 *
 * Espejo de la lista de `assertDocumentsCurrent` en el backend: si uno de
 * estos falta o vence, el domiciliario no puede ponerse disponible ni
 * recibir un pedido. Se marcan aquí porque no es lo mismo tener pendiente
 * una tarjeta de propiedad que un SOAT: lo segundo es una persona parada.
 */
const BLOCKING_TYPES = new Set<DriverDocumentType['type']>(['identity', 'license', 'soat']);

function daysUntil(date: string): number {
  return Math.ceil((new Date(date).getTime() - Date.now()) / 86_400_000);
}

export default function DriverDocuments() {
  const [queue, setQueue] = useState<Queue>({ pending: [], expired: [], expiringSoon: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [working, setWorking] = useState<string | null>(null);

  const fetchQueue = async () => {
    try {
      setLoading(true);
      setError('');
      const { data } = await api.get('/drivers/documents/queue');
      setQueue(data.data);
    } catch (err) {
      setError(apiMessage(err, 'No se pudo obtener la cola de verificación.'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchQueue(); }, []);

  const review = async (documentId: string, status: 'approved' | 'rejected') => {
    try {
      setError('');
      setWorking(documentId);
      await api.patch(`/drivers/documents/${documentId}/review`, { status });
      // Se recarga la cola entera en vez de quitar la fila: aprobar un
      // documento puede cambiar de grupo a otros del mismo domiciliario, y
      // adivinar ese efecto en el cliente es adivinar la regla del servidor.
      await fetchQueue();
    } catch (err) {
      setError(apiMessage(err, 'No se pudo verificar el documento.'));
    } finally {
      setWorking(null);
    }
  };

  const isLink = (reference: string) => /^https?:\/\//i.test(reference);

  const renderCard = (doc: DriverDocumentType, tone: 'pending' | 'expired' | 'soon') => {
    const driver = doc.driverId;
    const blocking = BLOCKING_TYPES.has(doc.type);
    const days = doc.expiresAt ? daysUntil(doc.expiresAt) : null;

    return (
      <div key={doc._id} className="zipp-card p-5 flex flex-col md:flex-row md:items-center justify-between gap-5">
        <div className="flex items-start gap-4 min-w-0">
          {/*
            La foto, donde antes había un icono decorativo.
            Aprobar un documento que no se puede ver es firmar a ciegas: el
            único trabajo de esta pantalla es mirar, y hasta ahora lo único
            que mostraba del documento era su número.
          */}
          {doc.imageUrl ? (
            <a
              href={doc.imageUrl}
              target="_blank"
              rel="noreferrer"
              title="Abrir la foto en tamaño completo"
              className="w-20 h-20 rounded-xl overflow-hidden flex-shrink-0 border border-[var(--color-border)] hover:border-[var(--color-primary)] transition-colors"
            >
              <img
                src={doc.imageUrl}
                alt={`${DOCUMENT_LABELS[doc.type]} de ${driver?.userId?.name ?? 'domiciliario'}`}
                className="w-full h-full object-cover"
                loading="lazy"
              />
            </a>
          ) : (
            <div
              title="Este documento se envió antes de que se pidieran fotos"
              className="w-20 h-20 rounded-xl bg-[var(--color-sidebar-hover)] flex flex-col items-center justify-center gap-1 flex-shrink-0"
            >
              <FileText className="w-5 h-5 text-white" />
              <span className="text-[9px] font-bold uppercase tracking-wider text-[var(--color-warning)]">
                Sin foto
              </span>
            </div>
          )}

          <div className="min-w-0 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2.5">
              <h3 className="text-base font-bold text-[var(--color-text-main)]">
                {DOCUMENT_LABELS[doc.type]}
              </h3>

              {blocking && (
                <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-danger)]">
                  Obligatorio
                </span>
              )}

              {tone === 'expired' && (
                <span className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-[var(--color-danger)]">
                  <ShieldAlert className="w-3 h-3" />
                  Vencido
                </span>
              )}

              {tone === 'soon' && days !== null && (
                <span className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-[var(--color-warning)]">
                  <Clock className="w-3 h-3" />
                  {days <= 0 ? 'Vence hoy' : `Vence en ${days} día${days === 1 ? '' : 's'}`}
                </span>
              )}
            </div>

            <p className="text-xs text-[var(--color-text-secondary)] font-medium">
              <strong className="text-[var(--color-text-main)]">{driver?.userId?.name || 'Domiciliario'}</strong>
              {driver?.userId?.phone ? ` • ${driver.userId.phone}` : ''}
              {driver?.licensePlate ? (
                <> • Placa <strong className="text-[var(--color-primary)] font-mono">{driver.licensePlate}</strong></>
              ) : null}
            </p>

            <div className="flex flex-wrap items-center gap-3 text-xs text-[var(--color-text-secondary)]">
              {isLink(doc.reference) ? (
                <a
                  href={doc.reference}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 font-semibold text-[var(--color-primary)] hover:underline"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  Ver documento
                </a>
              ) : (
                <span className="px-2.5 py-0.5 rounded-md bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text-main)] font-mono text-xs font-semibold">
                  {doc.reference}
                </span>
              )}

              {doc.expiresAt && (
                <span>Vence el {new Date(doc.expiresAt).toLocaleDateString('es-CO')}</span>
              )}

              <span>Enviado el {new Date(doc.createdAt).toLocaleDateString('es-CO')}</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2.5 border-t border-[var(--color-border-light)] md:border-0 pt-3 md:pt-0 justify-end flex-wrap">
          <button
            onClick={() => review(doc._id, 'approved')}
            className="px-3.5 py-2 rounded-lg bg-[var(--color-primary)] text-white font-bold text-xs uppercase tracking-wider hover:bg-[#8A5D08] transition-all cursor-pointer shadow-xs flex items-center gap-1.5"
          >
            <CheckCircle className="w-4 h-4" />
            {working === doc._id ? 'Guardando…' : 'Aprobar'}
          </button>

          <button
            onClick={() => review(doc._id, 'rejected')}
            className="px-3.5 py-2 rounded-lg bg-[var(--color-bg)] hover:bg-[var(--color-danger-bg)] border border-[var(--color-border)] text-xs font-semibold text-[var(--color-danger)] transition-all cursor-pointer flex items-center gap-1.5"
          >
            <X className="w-4 h-4" />
            Rechazar
          </button>
        </div>
      </div>
    );
  };

  const section = (
    title: string,
    hint: string,
    docs: DriverDocumentType[],
    tone: 'pending' | 'expired' | 'soon'
  ) => {
    if (!docs.length) return null;
    return (
      <div className="space-y-4">
        <div>
          <h2 className="text-sm font-bold uppercase tracking-wider text-[var(--color-text-main)]">
            {title} <span className="text-[var(--color-text-muted)]">({docs.length})</span>
          </h2>
          <p className="text-xs text-[var(--color-text-secondary)] font-medium mt-0.5">{hint}</p>
        </div>
        <div className="grid gap-4">{docs.map((doc) => renderCard(doc, tone))}</div>
      </div>
    );
  };

  const total = queue.pending.length + queue.expired.length + queue.expiringSoon.length;

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="page-title">Verificación de Documentos</h1>
          <p className="page-subtitle">
            Identidad, licencia y SOAT de los domiciliarios. Sin ellos aprobados y vigentes, nadie puede recibir pedidos
          </p>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] text-xs font-bold text-[var(--color-text-main)] shadow-xs">
            <span className="w-2 h-2 rounded-full bg-[var(--color-warning)] animate-pulse" />
            <span>{queue.pending.length} por revisar</span>
          </div>
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-xs font-semibold text-[var(--color-text-secondary)]">
            <span className="w-2 h-2 rounded-full bg-[var(--color-danger)]" />
            <span>{queue.expired.length} vencidos</span>
          </div>
        </div>
      </div>

      {error && (
        <div className="text-[var(--color-danger)] text-xs flex items-start gap-3">
          <AlertCircle className="w-4 h-4 text-[var(--color-danger)] shrink-0 mt-0.5" />
          <p className="flex-1 font-semibold">{error}</p>
        </div>
      )}

      {loading ? (
        <div className="table-container p-16 text-center text-[var(--color-text-secondary)] text-xs font-semibold">
          Cargando documentos...
        </div>
      ) : total === 0 ? (
        <div className="table-container p-16 text-center space-y-2">
          <CheckCircle className="w-8 h-8 text-[var(--color-success)] mx-auto" />
          <p className="text-sm font-bold text-[var(--color-text-main)]">No hay nada pendiente</p>
          <p className="text-xs text-[var(--color-text-secondary)] font-medium">
            Ningún documento espera revisión ni vence en los próximos 30 días.
          </p>
        </div>
      ) : (
        <div className="space-y-8">
          {section(
            'Vencidos',
            'Estos domiciliarios ya no pueden trabajar. Van primero porque cada uno es una persona parada.',
            queue.expired,
            'expired'
          )}
          {section(
            'Por revisar',
            'Enviados por el domiciliario y todavía sin verificar.',
            queue.pending,
            'pending'
          )}
          {section(
            'Por vencer',
            'Siguen vigentes, pero caducan pronto. Avisar ahora evita la baja sorpresa.',
            queue.expiringSoon,
            'soon'
          )}
        </div>
      )}
    </div>
  );
}
