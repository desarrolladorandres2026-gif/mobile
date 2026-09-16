import { Request, Response, NextFunction } from 'express';
import { driverService } from '../services/driver.service';
import { sendResponse, param, query, clampLimit } from '../utils';
import { DriverStatus } from '../types';
import { AuditAction, logAudit } from '../security';
import { AppError } from '../middlewares/errorHandler';
import { emitToUser } from '../sockets/emitter';
import { uploadVerificationSelfie, uploadDriverDocumentImage } from '../middlewares/upload';
import { z } from 'zod';

/**
 * Los campos de texto que acompañan a la foto.
 *
 * Vive aquí y no en la ruta porque en multipart todo llega como cadena:
 * `expiresAt` viaja como texto ISO y hay que convertirlo, y el esquema
 * tiene que correr *después* de multer. Los mismos límites que tenía la
 * ruta, en el único sitio donde ahora pueden aplicarse.
 */
const driverDocumentBody = z.object({
  type: z.enum(['identity', 'license', 'soat', 'technical_review', 'vehicle_registration']),
  reference: z.string().trim().min(3, 'El número del documento parece muy corto').max(500),
  expiresAt: z.coerce.date().optional(),
});

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

  /**
   * Ganancias de varios días.
   *
   * Por defecto la última semana: es el tramo que un domiciliario tiene en
   * la cabeza cuando se pregunta si le compensa el trabajo, y pedirle que
   * elija dos fechas antes de enseñarle nada sería cobrarle una decisión
   * por una respuesta que casi siempre es la misma.
   */
  async getEarningsRange(req: Request, res: Response, next: NextFunction) {
    try {
      const to = query(req, 'to') ? new Date(query(req, 'to')!) : new Date();
      const from = query(req, 'from')
        ? new Date(query(req, 'from')!)
        : new Date(to.getTime() - 6 * 86_400_000);

      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
        throw new AppError('Las fechas no son válidas', 400);
      }

      const result = await driverService.getEarningsRange(req.user!._id.toString(), from, to);
      sendResponse(res, 200, 'Ganancias del periodo', result);
    } catch (error) { next(error); }
  }

  /**
   * Cómo le está yendo. Informativo: no cambia el orden del reparto.
   */
  async getPerformance(req: Request, res: Response, next: NextFunction) {
    try {
      const days = Math.min(90, Math.max(7, Number(query(req, 'days')) || 30));
      const result = await driverService.getPerformance(req.user!._id.toString(), days);
      sendResponse(res, 200, 'Tu desempeño', result);
    } catch (error) { next(error); }
  }

  /** Para operaciones: si la mitad son `low_pay`, el problema es la tarifa. */
  async declineReasons(req: Request, res: Response, next: NextFunction) {
    try {
      const days = Math.min(90, Math.max(7, Number(query(req, 'days')) || 30));
      sendResponse(res, 200, 'Motivos de rechazo', await driverService.declineReasons(days));
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
  /**
   * Un documento para revisar, con su foto.
   *
   * Sin `validate` en la ruta, igual que las verificaciones y por la misma
   * razón: la foto llega como multipart y el esquema Zod se ejecutaría
   * antes de que multer hubiera poblado el cuerpo, así que rechazaría
   * cualquier envío por vacío. La validación vive aquí, después de leer el
   * archivo.
   */
  async submitDocument(req: Request, res: Response, next: NextFunction) {
    uploadDriverDocumentImage(req, res, async (err: unknown) => {
      try {
        if (err) {
          throw new AppError(
            err instanceof Error ? err.message : 'No se pudo procesar la imagen',
            400
          );
        }

        const parsed = driverDocumentBody.safeParse(req.body);
        if (!parsed.success) {
          throw new AppError(
            parsed.error.issues[0]?.message ?? 'Revisa los datos del documento',
            400
          );
        }

        const document = await driverService.submitDocument(req.user!._id.toString(), {
          ...parsed.data,
          image: req.file?.buffer,
        });

        sendResponse(res, 201, 'Documento recibido para verificación', document);
      } catch (error) { next(error); }
    });
  }
  async getDocuments(req: Request, res: Response, next: NextFunction) { try { const driver = await driverService.getByUserId(req.user!._id.toString()); sendResponse(res, 200, 'Documentos', await driverService.listDocuments(driver._id.toString())); } catch (error) { next(error); } }
  async reviewDocument(req: Request, res: Response, next: NextFunction) { try { const document = await driverService.reviewDocument(param(req, 'documentId'), req.user!._id.toString(), req.body.status); void logAudit(req, { action: AuditAction.DOCUMENT_REVIEWED, entity: 'driver_document', entityId: document._id.toString(), description: 'Documento de domiciliario verificado', metadata: { status: document.status, type: document.type } }); sendResponse(res, 200, 'Documento verificado', document); } catch (error) { next(error); } }
  async listDriverDocuments(req: Request, res: Response, next: NextFunction) { try { sendResponse(res, 200, 'Documentos del domiciliario', await driverService.listDocuments(param(req, 'id'))); } catch (error) { next(error); } }
  async documentQueue(req: Request, res: Response, next: NextFunction) { try { sendResponse(res, 200, 'Cola de verificación', await driverService.reviewQueue(Number(query(req, 'expiringInDays')) || 30)); } catch (error) { next(error); } }

  /** Guarda a quién avisar si algo va mal. */
  async setEmergencyContact(req: Request, res: Response, next: NextFunction) {
    try {
      const driver = await driverService.getByUserId(req.user!._id.toString());
      const { Driver } = await import('../models');
      await Driver.updateOne({ _id: driver._id }, { $set: { emergencyContact: req.body } });
      sendResponse(res, 200, 'Contacto de emergencia guardado', req.body);
    } catch (error) { next(error); }
  }

  // ── Verificación de identidad en turno ──
  /**
   * El domiciliario responde con la selfie que se le pidió.
   *
   * Recibe la foto, no una URL: el teléfono no tiene dónde alojarla, y
   * pedirle una dirección sería obligarle a subirla dos veces o abrir un
   * hueco para mandar la foto de cualquier otro.
   */
  async submitVerification(req: Request, res: Response, next: NextFunction) {
    uploadVerificationSelfie(req, res, async (err: unknown) => {
      try {
        if (err) throw new AppError(err instanceof Error ? err.message : 'No se pudo procesar la imagen', 400);
        if (!req.file) throw new AppError('Necesitamos la selfie para verificar tu identidad', 400);

        const driver = await driverService.getByUserId(req.user!._id.toString());
        const { driverSecurityService, VerificationType } = await import('../security');

        const type = (req.body?.type as string) || VerificationType.RANDOM_SELFIE;
        const result = await driverSecurityService.fulfillWithImage(
          driver._id.toString(),
          type as any,
          req.file.buffer
        );

        if (!result) throw new AppError('No tienes ninguna verificación pendiente de ese tipo', 404);
        sendResponse(res, 200, 'Verificación enviada para revisión', result);
      } catch (error) { next(error); }
    });
  }
  async myVerifications(req: Request, res: Response, next: NextFunction) { try { const driver = await driverService.getByUserId(req.user!._id.toString()); const { driverSecurityService } = await import('../security'); sendResponse(res, 200, 'Verificaciones', await driverSecurityService.getVerificationStatus(driver._id.toString())); } catch (error) { next(error); } }
  async requestVerification(req: Request, res: Response, next: NextFunction) { try { const driver = await driverService.getById(param(req, 'id')); const { driverSecurityService, VerificationType } = await import('../security'); const created = await driverSecurityService.requestVerification(driver._id.toString(), driver.userId.toString(), req.body?.type ?? VerificationType.RANDOM_SELFIE, req.body?.windowMinutes ?? 15); if (!created) throw new AppError('Ese domiciliario ya tiene una verificación en curso', 409); emitToUser(driver.userId.toString(), 'driver:verification:requested', { verificationId: created._id.toString(), type: created.type, dueAt: created.dueAt }); void logAudit(req, { action: AuditAction.DOCUMENT_REVIEWED, entity: 'driver', entityId: driver._id.toString(), description: 'Verificación de identidad solicitada en turno', metadata: { type: created.type, dueAt: created.dueAt } }); sendResponse(res, 201, 'Verificación solicitada', created); } catch (error) { next(error); } }
  async verificationQueue(req: Request, res: Response, next: NextFunction) { try { const { DriverVerification, VerificationStatus } = await import('../security'); const items = await DriverVerification.find({ status: { $in: [VerificationStatus.PENDING, VerificationStatus.REQUESTED] } }).sort({ createdAt: 1 }).lean(); sendResponse(res, 200, 'Cola de verificaciones', items); } catch (error) { next(error); } }
  async reviewVerification(req: Request, res: Response, next: NextFunction) { try { const { driverSecurityService } = await import('../security'); const result = await driverSecurityService.reviewVerification(param(req, 'verificationId'), req.user!._id.toString(), req.body.status === 'approved', req.body.rejectionReason); if (!result) throw new AppError('Verificación no encontrada', 404); sendResponse(res, 200, 'Verificación revisada', result); } catch (error) { next(error); } }

  // Admin endpoints
  async getAll(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await driverService.getAll(Number(query(req, 'page')) || 1, clampLimit(query(req, 'limit')));
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
