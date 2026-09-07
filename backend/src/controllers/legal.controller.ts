import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { DataRequest, LegalAcceptance, LegalDocument, Order, User } from '../models';
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
  async answerDataRequest(req: Request, res: Response, next: NextFunction) { try { const item = await DataRequest.findById(param(req, 'id')); if (!item) throw new AppError('Solicitud no encontrada', 404); if (req.body.anonymize) { if (item.type !== 'delete') throw new AppError('Solo una solicitud de supresión puede anonimizar datos', 422); const active = await Order.exists({ clientId: item.userId, status: { $in: ['pending','accepted','preparing','ready','picked_up','on_way'] } }); if (active) throw new AppError('No se puede anonimizar mientras existan pedidos activos', 422); const token = crypto.createHash('sha256').update(item.userId.toString()).digest('hex').slice(0, 12); await User.findByIdAndUpdate(item.userId, { name: 'Titular anonimizado', phone: `9${token.slice(0, 9)}`, $unset: { email: 1, avatar: 1, refreshToken: 1 }, $set: { isActive: false, marketingConsent: false, marketingChannels: [] } }); }
    item.status = req.body.status; item.response = req.body.response; item.handledBy = req.user!._id; await item.save(); void logAudit(req, { action: AuditAction.DATA_REQUEST_RESOLVED, entity: 'data_request', entityId: item._id.toString(), description: 'Solicitud de datos resuelta', metadata: { type: item.type, status: item.status, anonymized: Boolean(req.body.anonymize) } }); sendResponse(res, 200, req.body.anonymize ? 'Solicitud resuelta y datos anonimizados' : 'Solicitud actualizada', item); } catch (e) { next(e); } }
}
export const legalController = new LegalController();
