import { IDataRequest, DataRequest } from '../models';
import { AppError } from '../middlewares/errorHandler';
import { pushService } from './push.service';
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

/**
 * Prórroga permitida por tipo (Ley 1581, art. 14 — confirmar con asesor
 * legal): la consulta admite 5 días hábiles más; el reclamo (rectificar,
 * actualizar, suprimir, revocar) admite hasta 8.
 */
export const DATA_REQUEST_EXTENSION_BUSINESS_DAYS: Record<IDataRequest['type'], number> = {
  access: 5,
  rectify: 8,
  update: 8,
  delete: 8,
  revoke: 8,
};

/**
 * Prorroga el plazo una sola vez y solo si aún no venció: la ley exige avisar
 * al titular ANTES del vencimiento y con el motivo, así que una prórroga
 * tardía no arregla nada. Atómica: el filtro lleva `extendedAt: null` y el
 * plazo leído, así que dos personas pulsando a la vez no suman dos prórrogas.
 */
export async function extendDataRequest(id: string, reason: string, now: Date = new Date()) {
  const current = await DataRequest.findById(id);
  if (!current) throw new AppError('Solicitud no encontrada', 404);
  if (current.status === 'resolved' || current.status === 'rejected') throw new AppError('La solicitud ya está cerrada', 422);
  if (current.extendedAt) throw new AppError('Esta solicitud ya tuvo su prórroga', 422);
  if (!current.legalDueAt || current.legalDueAt.getTime() < now.getTime()) {
    throw new AppError('El plazo ya venció: la prórroga debe avisarse antes del vencimiento', 422);
  }

  const newDue = addBusinessDays(current.legalDueAt, DATA_REQUEST_EXTENSION_BUSINESS_DAYS[current.type]);
  const updated = await DataRequest.findOneAndUpdate(
    { _id: id, extendedAt: null, legalDueAt: current.legalDueAt, status: { $in: ['received', 'in_review'] } },
    { $set: { legalDueAt: newDue, extendedAt: now, extensionReason: reason } },
    { new: true },
  );
  if (!updated) throw new AppError('La solicitud cambió mientras se prorrogaba; vuelve a abrirla', 409);

  void pushService.sendToUser(updated.userId.toString(), {
    title: 'Ampliamos el plazo de tu solicitud de datos',
    body: reason,
    data: { dataRequestId: updated._id.toString() },
  });
  return updated;
}
