import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { DataRequest, LegalAcceptance, LegalDocument } from '../models';
import { anonymizeAccount } from '../services/accountDeletion.service';
import { AppError } from '../middlewares';
import { sendResponse, param } from '../utils';
import { AuditAction, logAudit } from '../security';

const hashIp = (ip: string) => crypto.createHash('sha256').update(ip).digest('hex').slice(0, 32);
export class LegalController {
  async active(_req: Request, res: Response, next: NextFunction) { try { sendResponse(res, 200, 'Documentos legales', await LegalDocument.find({ isActive: true }).select('kind version title content effectiveAt')); } catch (e) { next(e); } }
  async accept(req: Request, res: Response, next: NextFunction) { try { const doc = await LegalDocument.findOne({ _id: param(req, 'id'), isActive: true }); if (!doc) throw new AppError('Documento legal no encontrado', 404); const acceptance = await LegalAcceptance.findOneAndUpdate({ userId: req.user!._id, documentId: doc._id }, { version: doc.version, ipHash: hashIp(req.ip || ''), acceptedAt: new Date() }, { upsert: true, new: true, setDefaultsOnInsert: true }); sendResponse(res, 200, 'Aceptación registrada', acceptance); } catch (e) { next(e); } }
  async myAcceptances(req: Request, res: Response, next: NextFunction) { try { sendResponse(res, 200, 'Aceptaciones', await LegalAcceptance.find({ userId: req.user!._id }).populate('documentId', 'kind title')); } catch (e) { next(e); } }
  async createDataRequest(req: Request, res: Response, next: NextFunction) { try { const item = await DataRequest.create({ userId: req.user!._id, type: req.body.type, detail: req.body.detail }); sendResponse(res, 201, 'Solicitud de datos recibida', item); } catch (e) { next(e); } }
  async myDataRequests(req: Request, res: Response, next: NextFunction) { try { sendResponse(res, 200, 'Solicitudes de datos', await DataRequest.find({ userId: req.user!._id }).sort({ createdAt: -1 })); } catch (e) { next(e); } }
  async adminDataRequests(_req: Request, res: Response, next: NextFunction) { try { sendResponse(res, 200, 'Solicitudes de datos', await DataRequest.find().populate('userId', 'name email phone').sort({ createdAt: -1 })); } catch (e) { next(e); } }
  /**
   * Resuelve una solicitud de datos. Con `anonymize` aplica la supresión por
   * `accountDeletion.service`, el mismo camino que el borrado desde la app:
   * antes esto se hacía aquí en línea y dejaba vivos `googleId`, `appleId`,
   * la contraseña, los tokens de push y las sesiones.
   */
  async answerDataRequest(req: Request, res: Response, next: NextFunction) {
    try {
      const item = await DataRequest.findById(param(req, 'id'));
      if (!item) throw new AppError('Solicitud no encontrada', 404);

      if (req.body.anonymize) {
        if (item.type !== 'delete') throw new AppError('Solo una solicitud de supresión puede anonimizar datos', 422);
        await anonymizeAccount(item.userId);
      }

      item.status = req.body.status;
      item.response = req.body.response;
      item.handledBy = req.user!._id;
      await item.save();

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
}
export const legalController = new LegalController();
