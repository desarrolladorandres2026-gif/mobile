import { IDataRequest } from '../models';
import { addBusinessDays, businessDaysUntil } from '../utils';
import { LEGAL_DUE_SOON_BUSINESS_DAYS } from './pqrs.service';

/**
 * Plazo legal de Habeas Data por tipo de solicitud, en días hábiles.
 *
 * Ley 1581 de 2012, art. 14, y Decreto 1377 de 2013 — confirmar con asesor
 * legal antes de publicar esto de cara al usuario. Consulta es informativa
 * (más rápida); rectificación, actualización y supresión modifican datos
 * reales, así que llevan el plazo mayor. Revocar la autorización se trata
 * igual que una supresión: ambas son "deja de tratar mis datos".
 */
export const DATA_REQUEST_LEGAL_BUSINESS_DAYS: Record<IDataRequest['type'], number> = {
  access: 10,
  rectify: 15,
  update: 15,
  delete: 15,
  revoke: 15,
};

export { LEGAL_DUE_SOON_BUSINESS_DAYS };

export function computeDataRequestLegalDueAt(type: IDataRequest['type'], createdAt: Date = new Date()): Date {
  return addBusinessDays(createdAt, DATA_REQUEST_LEGAL_BUSINESS_DAYS[type]);
}

export function legalOverdueFlags(legalDueAt: Date | null | undefined, now: Date = new Date()) {
  if (!legalDueAt) return { legalOverdue: false, legalDueSoon: false };
  const daysLeft = businessDaysUntil(legalDueAt, now);
  return {
    legalOverdue: daysLeft < 0,
    legalDueSoon: daysLeft >= 0 && daysLeft <= LEGAL_DUE_SOON_BUSINESS_DAYS,
  };
}
