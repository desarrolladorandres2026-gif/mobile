import { Request, Response, NextFunction } from 'express';
import { driverService } from '../services/driver.service';
import { sendResponse, param, query } from '../utils';
import { DriverStatus } from '../types';
import { AuditAction, logAudit } from '../security';

export class DriverController {
  async register(req: Request, res: Response, next: NextFunction) {
    try {
      const driver = await driverService.create({ ...req.body, userId: req.user!._id.toString() });
      sendResponse(res, 201, 'Perfil de domiciliario creado', driver);
    } catch (error) { next(error); }
  }

  async getProfile(req: Request, res: Response, next: NextFunction) {
    try {
      const driver = await driverService.getByUserId(req.user!._id.toString());
      sendResponse(res, 200, 'Perfil obtenido', driver);
    } catch (error) { next(error); }
  }

  async updateStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const driver = await driverService.updateStatus(req.user!._id.toString(), req.body.status as DriverStatus);
      sendResponse(res, 200, 'Estado actualizado', driver);
    } catch (error) { next(error); }
  }

  async updateLocation(req: Request, res: Response, next: NextFunction) {
    try {
      const driver = await driverService.updateLocation(req.user!._id.toString(), req.body.lat, req.body.lng);
      sendResponse(res, 200, 'Ubicación actualizada', driver);
    } catch (error) { next(error); }
  }

  async getEarnings(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await driverService.getDailyEarnings(req.user!._id.toString(), query(req, 'date'));
      sendResponse(res, 200, 'Ganancias obtenidas', result);
    } catch (error) { next(error); }
  }

  async getDebts(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await driverService.getPendingDebts(req.user!._id.toString());
      sendResponse(res, 200, 'Efectivo pendiente por rendir', result);
    } catch (error) { next(error); }
  }

  /**
   * A driver declares they remitted collected cash.
   *
   * Replaces the old self-service "pay debts". The response says so
   * explicitly, because the driver's app used to tell them the balance was
   * cleared when no money had moved.
   */
  async reportCash(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await driverService.reportCashRemittance(
        req.user!._id.toString(),
        req.body.ids || [],
        req.body.reference
      );
      sendResponse(
        res,
        200,
        'Reporte registrado. Queda pendiente de verificación por ZIPP.',
        result
      );
    } catch (error) { next(error); }
  }
  async submitDocument(req: Request, res: Response, next: NextFunction) { try { const document = await driverService.submitDocument(req.user!._id.toString(), req.body); sendResponse(res, 201, 'Documento recibido para verificación', document); } catch (error) { next(error); } }
  async getDocuments(req: Request, res: Response, next: NextFunction) { try { const driver = await driverService.getByUserId(req.user!._id.toString()); sendResponse(res, 200, 'Documentos', await driverService.listDocuments(driver._id.toString())); } catch (error) { next(error); } }
  async reviewDocument(req: Request, res: Response, next: NextFunction) { try { const document = await driverService.reviewDocument(param(req, 'documentId'), req.user!._id.toString(), req.body.status); void logAudit(req, { action: AuditAction.DOCUMENT_REVIEWED, entity: 'driver_document', entityId: document._id.toString(), description: 'Documento de domiciliario verificado', metadata: { status: document.status, type: document.type } }); sendResponse(res, 200, 'Documento verificado', document); } catch (error) { next(error); } }

  // Admin endpoints
  async getAll(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await driverService.getAll(Number(query(req, 'page')) || 1, Number(query(req, 'limit')) || 20);
      sendResponse(res, 200, 'Domiciliarios obtenidos', result.drivers, result.meta);
    } catch (error) { next(error); }
  }

  async approve(req: Request, res: Response, next: NextFunction) {
    try {
      const driver = await driverService.approve(param(req, 'id'));
      sendResponse(res, 200, 'Domiciliario aprobado', driver);
    } catch (error) { next(error); }
  }

  async updateBaseFund(req: Request, res: Response, next: NextFunction) {
    try {
      const driver = await driverService.updateBaseFund(param(req, 'id'), req.body.baseFund);
      sendResponse(res, 200, 'Fondo base actualizado', driver);
    } catch (error) { next(error); }
  }
}

export const driverController = new DriverController();
