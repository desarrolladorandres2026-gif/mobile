import { Request, Response, NextFunction } from 'express';
import { adminService } from '../services/admin.service';
import { businessProfile360Service } from '../services/businessProfile360.service';
import { noteActorFromRequest } from '../services/internalNote.service';
import { adminThrottleService } from '../services/adminThrottle.service';
import { notificationService } from '../services/notification.service';
import { Business } from '../models';
import { AuditAction, AuditSeverity, logAudit } from '../security';
import { AppError } from '../middlewares';
import { sendResponse, param } from '../utils';

/** Una petición de documentos por hora y comercio, con contador atómico en Mongo (AdminThrottle), no en memoria. */
const REQUEST_DOCUMENTS_WINDOW_MS = 60 * 60 * 1000;

const DOCUMENT_LABELS: Record<string, string> = {
  rut: 'RUT',
  chamber_of_commerce: 'Cámara de Comercio',
  legal_rep_id: 'Cédula del representante',
  bank_certificate: 'Certificación bancaria',
  health_permit: 'Concepto sanitario',
};

export const adminBusinessesController = {
  async profile360(req: Request, res: Response, next: NextFunction) {
    try {
      const id = param(req, 'id');
      const actor = await noteActorFromRequest(req);
      const data = await businessProfile360Service.businessProfile360(id, actor);
      void logAudit(req, {
        action: AuditAction.PROFILE_VIEWED,
        entity: 'business',
        entityId: id,
        severity: AuditSeverity.LOW,
        description: 'Ficha 360 de comercio consultada',
      });
      res.setHeader('Cache-Control', 'no-store');
      sendResponse(res, 200, 'Ficha del comercio', data);
    } catch (error) { next(error); }
  },

  async setSuspension(req: Request, res: Response, next: NextFunction) {
    try {
      const { business, changed } = await adminService.setBusinessSuspension(
        param(req, 'id'),
        req.body.suspended,
        req.body.reason,
        req
      );
      sendResponse(res, 200, changed ? (business.isSuspended ? 'Negocio suspendido' : 'Negocio reactivado') : 'Sin cambios: el negocio ya estaba en ese estado', {
        _id: String(business._id),
        isSuspended: !!business.isSuspended,
        suspensionReason: business.suspensionReason ?? null,
        suspendedAt: business.suspendedAt ?? null,
        changed,
      });
    } catch (error) { next(error); }
  },

  async requestDocuments(req: Request, res: Response, next: NextFunction) {
    try {
      const id = param(req, 'id');
      const types: string[] = [...new Set<string>(req.body.types)];
      const message: string | undefined = req.body.message?.trim() || undefined;

      const business = await Business.findById(id).select('name ownerId').lean();
      if (!business) throw new AppError('Negocio no encontrado', 404);

      // Atómico: el primero de la hora pasa y el resto recibe 429, aunque lleguen a la vez.
      if ((await adminThrottleService.hit(`reqdocs:${id}`, REQUEST_DOCUMENTS_WINDOW_MS)) > 1) {
        throw new AppError('Ya se le pidieron documentos a este comercio hace menos de una hora', 429);
      }

      const labels = types.map((t) => DOCUMENT_LABELS[t] ?? t).join(', ');
      await logAudit(req, {
        action: AuditAction.BUSINESS_DOCUMENTS_REQUESTED,
        entity: 'business',
        entityId: id,
        severity: AuditSeverity.LOW,
        description: `Se pidieron documentos a ${business.name}: ${labels}`,
        metadata: { types, hasMessage: !!message },
      });
      await notificationService.notifySystem(
        String(business.ownerId),
        'Documentos pendientes de tu negocio',
        `Necesitamos que cargues o actualices: ${labels}.${message ? ` ${message}` : ''}`,
        { event: 'business_documents_requested', businessId: id, types }
      );

      sendResponse(res, 200, 'Documentos solicitados', { requested: types });
    } catch (error) { next(error); }
  },
};
