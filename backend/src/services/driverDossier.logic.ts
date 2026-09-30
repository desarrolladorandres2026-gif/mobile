import type { DriverDocumentType } from '../models/DriverDocument';

/**
 * Reglas puras del expediente del domiciliario: qué papeles pide ZIPP, en qué
 * estado está cada uno y si la persona está "al día". Sin base de datos ni
 * red, para poder probarlas con fechas fijas.
 */

const DAY_MS = 86_400_000;

/** Con cuántos días de antelación un documento vigente pasa a "próximo a vencer". Igual que la cola de revisión. */
export const EXPIRING_SOON_DAYS = 30;

/**
 * TODO(negocio): los antecedentes judiciales no traen vencimiento impreso.
 * Mientras ZIPP no fije una política, se consideran desactualizados a los 180
 * días de su fecha de expedición cuando el domiciliario no puso `expiresAt`.
 */
export const CRIMINAL_RECORD_MAX_AGE_DAYS = 180;

export type DossierGroup = 'personal' | 'vehicle';

export interface DossierDocumentSpec {
  type: DriverDocumentType;
  label: string;
  /** Nombre corto para los avisos ("Tecnomecánica vence en 12 días"). */
  short: string;
  group: DossierGroup;
}

/** Los siete papeles que pide ZIPP, en el orden en que se muestran. */
export const DOSSIER_DOCUMENTS: readonly DossierDocumentSpec[] = [
  { type: 'identity', label: 'Cédula de ciudadanía (frente)', short: 'Cédula (frente)', group: 'personal' },
  { type: 'identity_back', label: 'Cédula de ciudadanía (reverso)', short: 'Cédula (reverso)', group: 'personal' },
  { type: 'criminal_record', label: 'Antecedentes judiciales', short: 'Antecedentes', group: 'personal' },
  { type: 'license', label: 'Licencia de conducción', short: 'Licencia', group: 'vehicle' },
  { type: 'soat', label: 'SOAT', short: 'SOAT', group: 'vehicle' },
  { type: 'technical_review', label: 'Revisión técnico-mecánica', short: 'Tecnomecánica', group: 'vehicle' },
  { type: 'vehicle_registration', label: 'Tarjeta de propiedad', short: 'Tarjeta de propiedad', group: 'vehicle' },
];

export type DocumentIndicator =
  | 'valid'
  | 'expiring'
  | 'expired'
  | 'not_uploaded'
  | 'in_review'
  | 'rejected';

export interface DocumentFacts {
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  issuedAt?: Date | null;
  expiresAt?: Date | null;
}

/** Vencimiento efectivo: el escrito, o el que deriva de la política de antecedentes. */
export function effectiveExpiry(type: DriverDocumentType, doc: DocumentFacts): Date | null {
  if (doc.expiresAt) return doc.expiresAt;
  if (type === 'criminal_record' && doc.issuedAt) {
    return new Date(doc.issuedAt.getTime() + CRIMINAL_RECORD_MAX_AGE_DAYS * DAY_MS);
  }
  return null;
}

export function documentIndicator(
  type: DriverDocumentType,
  doc: DocumentFacts | null,
  now: Date
): DocumentIndicator {
  if (!doc) return 'not_uploaded';
  if (doc.status === 'rejected') return 'rejected';
  const expiry = effectiveExpiry(type, doc);
  if (doc.status === 'expired' || (expiry && expiry.getTime() < now.getTime())) return 'expired';
  if (doc.status === 'pending') return 'in_review';
  if (expiry && expiry.getTime() - now.getTime() <= EXPIRING_SOON_DAYS * DAY_MS) return 'expiring';
  return 'valid';
}

/** Días hasta el vencimiento; negativo si ya venció. Se cuenta por día calendario, redondeando hacia arriba. */
export function daysUntil(expiry: Date, now: Date): number {
  return Math.ceil((expiry.getTime() - now.getTime()) / DAY_MS);
}

/** La frase que el administrador lee: "Tecnomecánica vence en 12 días", "SOAT vencido"… */
export function documentMessage(
  spec: DossierDocumentSpec,
  indicator: DocumentIndicator,
  expiry: Date | null,
  now: Date
): string {
  switch (indicator) {
    case 'not_uploaded':
      return `${spec.short} sin cargar`;
    case 'in_review':
      return `${spec.short} en revisión`;
    case 'rejected':
      return `${spec.short} rechazado`;
    case 'expired':
      return spec.type === 'criminal_record' ? 'Antecedentes requieren actualización' : `${spec.short} vencido`;
    case 'expiring': {
      const days = expiry ? Math.max(0, daysUntil(expiry, now)) : 0;
      if (days === 0) return `${spec.short} vence hoy`;
      return `${spec.short} vence en ${days} ${days === 1 ? 'día' : 'días'}`;
    }
    default:
      return `${spec.short} vigente`;
  }
}

/** ¿Este indicador cuenta como "al día"? Un documento próximo a vencer sigue habilitando. */
export const isCurrent = (indicator: DocumentIndicator) => indicator === 'valid' || indicator === 'expiring';

export type DossierAccountStatus = 'active' | 'pending' | 'in_review' | 'suspended' | 'rejected';

/**
 * Estado de la relación con ZIPP, derivado. No hay un campo "rechazado" en
 * `Driver`: un domiciliario sin aprobar se lee por sus documentos (misma lógica
 * que el embudo de altas).
 */
export function accountStatus(
  driver: { isApproved: boolean; isActive: boolean },
  docs: Array<{ status: DocumentFacts['status'] }>
): DossierAccountStatus {
  if (driver.isApproved) return driver.isActive ? 'active' : 'suspended';
  if (docs.some((d) => d.status === 'pending')) return 'in_review';
  if (docs.some((d) => d.status === 'rejected' || d.status === 'expired')) return 'rejected';
  return 'pending';
}

export interface ComplianceSummary {
  /** Todos los papeles cargados, aprobados y sin vencer. */
  upToDate: boolean;
  counts: Record<DocumentIndicator, number>;
  /** Mensajes de lo que hay que atender, más urgente primero. */
  issues: string[];
}

const ISSUE_ORDER: DocumentIndicator[] = ['expired', 'rejected', 'not_uploaded', 'in_review', 'expiring'];

export function summarizeCompliance(
  rows: Array<{ spec: DossierDocumentSpec; indicator: DocumentIndicator; message: string }>
): ComplianceSummary {
  const counts: Record<DocumentIndicator, number> = {
    valid: 0, expiring: 0, expired: 0, not_uploaded: 0, in_review: 0, rejected: 0,
  };
  for (const r of rows) counts[r.indicator] += 1;
  const issues = ISSUE_ORDER.flatMap((ind) => rows.filter((r) => r.indicator === ind).map((r) => r.message));
  return { upToDate: rows.every((r) => isCurrent(r.indicator)), counts, issues };
}
