import api from '../services/api';
import { apiStatus } from './apiError';

/**
 * Tipos y utilidades del expediente digital del domiciliario.
 * Espejo de `DossierView` del backend (`driverDossier.service.ts`).
 */

export type DocumentIndicator = 'valid' | 'expiring' | 'expired' | 'not_uploaded' | 'in_review' | 'rejected';
export type AccountStatus = 'active' | 'pending' | 'in_review' | 'suspended' | 'rejected';
export type ContractStatus = 'draft' | 'active' | 'suspended' | 'terminated';

export interface HistoryEvent {
  action: string;
  at: string;
  byName?: string;
  note?: string;
}

export interface DossierDocument {
  type: string;
  label: string;
  group: 'personal' | 'vehicle';
  indicator: DocumentIndicator;
  message: string;
  documentId?: string;
  /** Se devuelve al aprobar/rechazar: si el domiciliario reenvió entretanto, el servidor responde 409. */
  revision?: number;
  status?: string;
  reference?: string;
  uploadedAt?: string;
  issuedAt?: string;
  expiresAt?: string;
  effectiveExpiresAt?: string;
  reviewedAt?: string;
  reviewedByName?: string;
  rejectionReason?: string;
  updateRequest?: { reason: string; requestedAt: string };
  hasFile: boolean;
  history: HistoryEvent[];
}

export interface ContractFile {
  id: string;
  name: string;
  format: string;
  bytes: number;
  uploadedAt: string;
}

export interface Dossier {
  driverId: string;
  person: {
    name: string;
    avatar?: string;
    documentType?: string;
    documentNumber?: string;
    phone?: string;
    email?: string;
    city?: string;
    address?: string;
    registeredAt?: string;
    linkedAt?: string;
    lastActivityAt?: string;
    status: AccountStatus;
    emergencyContact?: { name: string; phone: string; relationship?: string };
  };
  vehicle: { type: string; plate?: string; brand?: string; model?: string; color?: string; year?: number; engineCc?: number; ownerName?: string };
  licenseCategory?: string;
  documents: DossierDocument[];
  compliance: { upToDate: boolean; counts: Record<DocumentIndicator, number>; issues: string[] };
  contract: {
    status?: ContractStatus;
    startDate?: string;
    endDate?: string;
    file?: ContractFile;
    extraFiles: ContractFile[];
    history: HistoryEvent[];
  };
}

/** Punto de estado: relleno por color, anillo para "no cargado". El texto siempre acompaña: el color solo no basta. */
export const indicatorStyles: Record<DocumentIndicator, { label: string; dot: string; text: string }> = {
  valid: { label: 'Vigente', dot: 'bg-[var(--color-success)]', text: 'text-[var(--color-text-main)]' },
  expiring: { label: 'Próximo a vencer', dot: 'bg-[var(--color-warning)]', text: 'text-[var(--color-text-main)]' },
  expired: { label: 'Vencido', dot: 'bg-[var(--color-danger)]', text: 'text-[var(--color-danger)]' },
  not_uploaded: {
    label: 'No cargado',
    dot: 'border border-[var(--color-text-secondary)] bg-transparent',
    text: 'text-[var(--color-text-secondary)]',
  },
  in_review: { label: 'En revisión', dot: 'bg-[#2563EB]', text: 'text-[var(--color-text-main)]' },
  rejected: { label: 'Rechazado', dot: 'bg-[var(--color-text-main)]', text: 'text-[var(--color-text-main)]' },
};

export const accountStatusLabels: Record<AccountStatus, string> = {
  active: 'Activo',
  pending: 'Pendiente',
  in_review: 'En revisión',
  suspended: 'Suspendido',
  rejected: 'Rechazado',
};

export const contractStatusLabels: Record<ContractStatus, string> = {
  draft: 'Borrador',
  active: 'Vigente',
  suspended: 'Suspendido',
  terminated: 'Terminado',
};

export const eventLabels: Record<string, string> = {
  submitted: 'Enviado por el domiciliario',
  approved: 'Aprobado',
  rejected: 'Rechazado',
  update_requested: 'Actualización solicitada',
  observation: 'Observación interna',
  created: 'Contrato creado',
  updated: 'Contrato modificado',
  file_uploaded: 'Contrato cargado',
  extra_uploaded: 'Anexo cargado',
  extra_removed: 'Anexo retirado',
};

/** Fecha sin hora, en la zona de Colombia (una fecha de vencimiento no debe correrse un día por la zona del navegador). */
export const dossierDay = (iso?: string) =>
  iso ? new Date(iso).toLocaleDateString('es-CO', { timeZone: 'America/Bogota', day: '2-digit', month: 'short', year: 'numeric' }) : '—';

export const dossierDateTime = (iso?: string) =>
  iso
    ? new Date(iso).toLocaleString('es-CO', { timeZone: 'America/Bogota', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '—';

/** `YYYY-MM-DD` para un `<input type="date">` a partir de una fecha ISO (en hora de Colombia). */
export const toDateInput = (iso?: string) =>
  iso ? new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Bogota' }) : '';

/** Mensajes de las fallas al abrir un archivo. La respuesta es un blob, así que no se lee el cuerpo. */
function fileErrorMessage(err: unknown): string {
  const status = apiStatus(err);
  if (status === 429) return 'Demasiadas consultas seguidas. Espera unos minutos.';
  if (status === 403) return 'No tienes permiso para abrir este documento.';
  if (status === 404) return 'El archivo ya no está disponible.';
  return 'No se pudo abrir el documento. Intenta de nuevo.';
}

function saveBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Ver o descargar un archivo del expediente.
 *
 * El archivo viene del backend con el token del administrador (no hay enlace
 * que copiar) y se abre desde una URL local del navegador. La pestaña se abre
 * *antes* de pedir el archivo: si se abriera después, el navegador la tomaría
 * por una ventana emergente no solicitada y la bloquearía.
 */
export async function openDossierFile(path: string, disposition: 'inline' | 'attachment', fileName: string): Promise<void> {
  const tab = disposition === 'inline' ? window.open('', '_blank') : null;
  try {
    const res = await api.get(path, { params: { disposition }, responseType: 'blob', timeout: 60_000 });
    const blob = res.data as Blob;
    if (disposition === 'inline' && tab) {
      const url = URL.createObjectURL(blob);
      tab.location.href = url;
      setTimeout(() => URL.revokeObjectURL(url), 5 * 60_000);
    } else {
      saveBlob(blob, fileName);
    }
  } catch (err) {
    tab?.close();
    throw new Error(fileErrorMessage(err), { cause: err });
  }
}

export async function downloadDossierPdf(driverId: string, fileName: string): Promise<void> {
  try {
    const res = await api.get(`/drivers/${driverId}/dossier/pdf`, { responseType: 'blob', timeout: 180_000 });
    saveBlob(res.data as Blob, fileName);
  } catch (err) {
    throw new Error(fileErrorMessage(err).replace('abrir el documento', 'generar el expediente'), { cause: err });
  }
}
