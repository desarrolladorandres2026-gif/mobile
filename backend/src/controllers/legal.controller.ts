import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { DataRequest, LegalAcceptance, LegalDocument } from '../models';
import { anonymizeAccount } from '../services/accountDeletion.service';
import { AppError } from '../middlewares';
import { sendResponse, param } from '../utils';
import { AuditAction, logAudit, Permission } from '../security';
import { assertIsSuperAdmin } from '../services/authorization.service';
import { computeDataRequestLegalDueAt, legalOverdueFlags, extendDataRequest } from '../services/legal.service';
import { activeByKind, publishLegalDocument, listLegalDocuments, getLegalDocument, listAcceptances, pendingAcceptances } from '../services/legalDocument.service';
import { pushService } from '../services/push.service';
import { config } from '../config';

// HMAC con la clave del servidor y no un SHA-256 a secas: el espacio de IPv4
// cabe entero en una tabla, así que un hash sin clave se revierte en minutos
// y la "prueba" de aceptación pasaba a ser la IP en claro.
const hashIp = (ip: string) =>
  crypto.createHmac('sha256', config.security.encryptionKey).update(`legal-acceptance-ip:${ip}`).digest('hex').slice(0, 32);
export class LegalController {
  async active(_req: Request, res: Response, next: NextFunction) { try { sendResponse(res, 200, 'Documentos legales', activeByKind(await LegalDocument.find({ isActive: true }).select('kind version title content effectiveAt').lean())); } catch (e) { next(e); } }
  async accept(req: Request, res: Response, next: NextFunction) { try { const doc = await LegalDocument.findOne({ _id: param(req, 'id'), isActive: true }); if (!doc) throw new AppError('Documento legal no encontrado', 404); const acceptance = await LegalAcceptance.findOneAndUpdate({ userId: req.user!._id, documentId: doc._id }, { $setOnInsert: { version: doc.version, ipHash: hashIp(req.ip || ''), acceptedAt: new Date() } }, { upsert: true, new: true, setDefaultsOnInsert: true }); sendResponse(res, 200, 'Aceptación registrada', acceptance); } catch (e) { next(e); } }
  async pending(req: Request, res: Response, next: NextFunction) { try { sendResponse(res, 200, 'Documentos por aceptar', await pendingAcceptances(req.user!._id.toString())); } catch (e) { next(e); } }
  async myAcceptances(req: Request, res: Response, next: NextFunction) { try { sendResponse(res, 200, 'Aceptaciones', await LegalAcceptance.find({ userId: req.user!._id }).populate('documentId', 'kind title')); } catch (e) { next(e); } }
  async createDataRequest(req: Request, res: Response, next: NextFunction) { try { const createdAt = new Date(); const item = await DataRequest.create({ userId: req.user!._id, type: req.body.type, detail: req.body.detail, legalDueAt: computeDataRequestLegalDueAt(req.body.type, createdAt), createdAt }); sendResponse(res, 201, 'Solicitud de datos recibida', item); } catch (e) { next(e); } }
  async myDataRequests(req: Request, res: Response, next: NextFunction) { try { sendResponse(res, 200, 'Solicitudes de datos', await DataRequest.find({ userId: req.user!._id }).sort({ createdAt: -1 })); } catch (e) { next(e); } }
  async adminDataRequests(_req: Request, res: Response, next: NextFunction) {
    try {
      const rows = await DataRequest.find().populate('userId', 'name email phone').sort({ createdAt: -1 }).limit(500).lean();
      const withLegal = rows.map((r: any) => ({ ...r, ...legalOverdueFlags(r.legalDueAt) }));
      sendResponse(res, 200, 'Solicitudes de datos', withLegal);
    } catch (e) { next(e); }
  }
  /**
   * Resuelve una solicitud de datos. Con `anonymize` aplica la supresión por
   * `accountDeletion.service`, el mismo camino que el borrado desde la app:
   * antes esto se hacía aquí en línea y dejaba vivos `googleId`, `appleId`,
   * la contraseña, los tokens de push y las sesiones.
   */
  async answerDataRequest(req: Request, res: Response, next: NextFunction) {
    try {
      // Ley 1581: suprimir datos personales no es delegable (antes de tocar nada).
      if (req.body.anonymize) {
        await assertIsSuperAdmin(req.user!, 'Solo el Super Administrador puede anonimizar datos personales');
      }
      const item = await DataRequest.findById(param(req, 'id'));
      if (!item) throw new AppError('Solicitud no encontrada', 404);
      // Antes de anonimizar: una supresión ya rechazada no puede borrar la cuenta por la puerta de atrás.
      if (item.status === 'resolved' || item.status === 'rejected') throw new AppError('La solicitud ya está cerrada', 422);

      if (req.body.anonymize) {
        if (item.type !== 'delete') throw new AppError('Solo una solicitud de supresión puede anonimizar datos', 422);
        await anonymizeAccount(item.userId);
      }


      // Cierre condicionado al estado leído: dos personas respondiendo a la vez no se pisan.
      const closed = await DataRequest.findOneAndUpdate(
        { _id: item._id, status: { $in: ['received', 'in_review'] } },
        { $set: { status: req.body.status, response: req.body.response, handledBy: req.user!._id, resolvedAt: new Date() } },
        { new: true },
      );
      if (!closed) throw new AppError('La solicitud ya fue cerrada por otra persona', 409);
      Object.assign(item, closed.toObject());

      // El titular tiene derecho a la respuesta; la app puede estar cerrada.
      void pushService.sendToUser(item.userId.toString(), {
        title: closed.status === 'rejected' ? 'Respondimos tu solicitud de datos' : 'Resolvimos tu solicitud de datos',
        body: 'Abre Mis solicitudes para ver la respuesta.',
        data: { dataRequestId: item._id.toString() },
      });

      void logAudit(req, {
        action: AuditAction.DATA_REQUEST_RESOLVED,
        entity: 'data_request',
        entityId: item._id.toString(),
        description: 'Solicitud de datos resuelta',
        metadata: { type: item.type, status: item.status, anonymized: Boolean(req.body.anonymize) },
      });

      sendResponse(res, 200, req.body.anonymize ? 'Solicitud resuelta y datos anonimizados' : 'Solicitud actualizada', item);
    } catch (e) { next(e); }
  }

  /** Toma la solicitud: pasa a "en revisión" con nombre y apellido de quien la lleva. */
  async takeDataRequest(req: Request, res: Response, next: NextFunction) {
    try {
      const item = await DataRequest.findOneAndUpdate(
        { _id: param(req, 'id'), status: 'received' },
        { $set: { status: 'in_review', handledBy: req.user!._id } },
        { new: true },
      );
      if (!item) throw new AppError('La solicitud no existe o ya la tiene alguien', 409);
      void logAudit(req, { action: AuditAction.DATA_REQUEST_TAKEN, entity: 'data_request', entityId: item._id.toString(), description: 'Solicitud de datos tomada' });
      sendResponse(res, 200, 'Solicitud tomada', item);
    } catch (e) { next(e); }
  }

  async extendDataRequest(req: Request, res: Response, next: NextFunction) {
    try {
      const item = await extendDataRequest(param(req, 'id'), req.body.reason);
      void logAudit(req, { action: AuditAction.DATA_REQUEST_EXTENDED, entity: 'data_request', entityId: item._id.toString(), description: 'Prórroga del plazo de una solicitud de datos', metadata: { type: item.type } });
      sendResponse(res, 200, 'Plazo ampliado', item);
    } catch (e) { next(e); }
  }

  async adminDocuments(_req: Request, res: Response, next: NextFunction) { try { sendResponse(res, 200, 'Documentos legales', await listLegalDocuments()); } catch (e) { next(e); } }
  async adminDocument(req: Request, res: Response, next: NextFunction) { try { sendResponse(res, 200, 'Documento legal', await getLegalDocument(param(req, 'id'))); } catch (e) { next(e); } }
  async adminAcceptances(req: Request, res: Response, next: NextFunction) {
    try {
      // Quién aceptó es dato personal: el email completo solo con `users:view_sensitive`, y cada consulta se audita.
      const sensitive = (req.permissions || []).includes(Permission.USERS_VIEW_SENSITIVE);
      const result = await listAcceptances(param(req, 'id'), Number(req.query.page) || 1, Number(req.query.limit) || 25, sensitive);
      void logAudit(req, { action: AuditAction.LEGAL_ACCEPTANCES_VIEWED, entity: 'legal_document', entityId: param(req, 'id'), description: 'Consulta de quién aceptó un documento', metadata: { page: result.page, unmasked: sensitive } });
      sendResponse(res, 200, 'Aceptaciones', result);
    } catch (e) { next(e); }
  }
  async publishDocument(req: Request, res: Response, next: NextFunction) {
    try {
      const doc = await publishLegalDocument({ ...req.body, adminId: req.user!._id.toString() });
      void logAudit(req, { action: AuditAction.LEGAL_DOCUMENT_PUBLISHED, entity: 'legal_document', entityId: doc._id.toString(), description: 'Documento legal publicado', metadata: { kind: doc.kind, version: doc.version } });
      sendResponse(res, 201, 'Documento publicado', doc);
    } catch (e) { next(e); }
  }
}
export const legalController = new LegalController();
