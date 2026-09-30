import { Request, Response, NextFunction } from 'express';
import { driverService } from '../services/driver.service';
import { sendResponse, param, query, clampLimit } from '../utils';
import { DriverStatus } from '../types';
import { AuditAction, AuditSeverity, logAudit } from '../security';
import { Driver, User, DRIVER_DOCUMENT_TYPES } from '../models';
import { vehicleBody } from './driverDossier.controller';
import type { ListDriversQuery } from '../validators/driver.validator';
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
  type: z.enum(DRIVER_DOCUMENT_TYPES),
  reference: z.string().trim().min(3, 'El número del documento parece muy corto').max(500),
  // El móvil manda `''` cuando el campo queda vacío: sin esto `z.coerce.date()` lo tomaría por una fecha inválida.
  issuedAt: z.preprocess(
    (v) => (v === '' || v === null ? undefined : v),
    z.coerce.date().max(new Date(), 'La fecha de expedición no puede ser futura').optional()
  ),
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

        // S16: la respuesta lleva la URL firmada, no el `imageKey` crudo.
        const view = { ...document.toObject(), imageUrl: driverService.documentImageUrl(document) };
        delete (view as any).imageKey;
        sendResponse(res, 201, 'Documento recibido para verificación', view);
      } catch (error) { next(error); }
    });
  }
  /** El domiciliario completa marca, modelo, color y placa de su moto. */
  async updateOwnVehicle(req: Request, res: Response, next: NextFunction) {
    try {
      // La placa la corrige solo el equipo: aparece en el tracking del cliente y en el traspaso.
      const parsed = vehicleBody.omit({ licensePlate: true }).safeParse(req.body);
      if (!parsed.success) throw new AppError(parsed.error.issues[0]?.message ?? 'Revisa los datos del vehículo', 400);
      const driver = await driverService.updateOwnVehicle(req.user!._id.toString(), parsed.data);
      sendResponse(res, 200, 'Vehículo actualizado', { vehicle: driver.vehicle, licensePlate: driver.licensePlate });
    } catch (error) { next(error); }
  }
  async getDocuments(req: Request, res: Response, next: NextFunction) { try { res.setHeader('Cache-Control', 'no-store'); const driver = await driverService.getByUserId(req.user!._id.toString()); sendResponse(res, 200, 'Documentos', await driverService.listDocuments(driver._id.toString())); } catch (error) { next(error); } }
  async reviewDocument(req: Request, res: Response, next: NextFunction) { try { const document = await driverService.reviewDocument(param(req, 'documentId'), req.user!._id.toString(), req.body.status, req.body.rejectionReason, req.body.revision); void logAudit(req, { action: AuditAction.DOCUMENT_REVIEWED, entity: 'driver_document', entityId: document._id.toString(), description: 'Documento de domiciliario verificado', metadata: { status: document.status, type: document.type, rejectionReason: document.rejectionReason } }); const view = { ...document.toObject(), imageUrl: driverService.documentImageUrl(document) }; delete (view as any).imageKey; sendResponse(res, 200, 'Documento verificado', view); } catch (error) { next(error); } }
  async listDriverDocuments(req: Request, res: Response, next: NextFunction) { try { res.setHeader('Cache-Control', 'no-store'); void logAudit(req, { action: AuditAction.DRIVER_DOCUMENT_VIEWED, entity: 'driver', entityId: param(req, 'id'), description: 'Documentos de domiciliario listados (incluye enlaces a fotos)' }); sendResponse(res, 200, 'Documentos del domiciliario', await driverService.listDocuments(param(req, 'id'))); } catch (error) { next(error); } }
  async documentQueue(req: Request, res: Response, next: NextFunction) { try { res.setHeader('Cache-Control', 'no-store'); void logAudit(req, { action: AuditAction.DRIVER_DOCUMENT_VIEWED, entity: 'driver_document', entityId: 'queue', description: 'Cola de verificación de documentos consultada (incluye enlaces a fotos)' }); sendResponse(res, 200, 'Cola de verificación', await driverService.reviewQueue(Number(query(req, 'expiringInDays')) || 30)); } catch (error) { next(error); } }

  /** Guarda a quién avisar si algo va mal. */
  async setEmergencyContact(req: Request, res: Response, next: NextFunction) {
    try {
      const driver = await driverService.getByUserId(req.user!._id.toString());
      const { Driver } = await import('../models');
      await Driver.updateOne({ _id: driver._id }, { $set: { emergencyContact: { ...req.body, updatedAt: new Date() } } });
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
  /**
   * O5: la cola traía el documento crudo (`imageUrl`, `type`, `status`…)
   * sin nada de la persona detrás — quien revisaba no tenía con qué
   * comparar la selfie contra una cara conocida. Se enriquece con el
   * `Driver` y el `User`, y con la foto de la cédula ya aprobada si existe,
   * para que la revisión sea comparar dos fotos, no adivinar.
   */
  async verificationQueue(req: Request, res: Response, next: NextFunction) {
    try {
      const { DriverVerification, VerificationStatus, driverSecurityService } = await import('../security');
      const { DriverDocument } = await import('../models');
      const items = await DriverVerification.find({ status: { $in: [VerificationStatus.PENDING, VerificationStatus.REQUESTED] } })
        .sort({ createdAt: 1 })
        .lean();

      if (items.length === 0) return sendResponse(res, 200, 'Cola de verificaciones', []);

      const driverIds = Array.from(new Set(items.map((i) => i.driverId)));
      const userIds = Array.from(new Set(items.map((i) => i.userId)));
      const [drivers, users, identityDocs] = await Promise.all([
        Driver.find({ _id: { $in: driverIds } }).select('licensePlate vehicleType isApproved isActive').lean(),
        User.find({ _id: { $in: userIds } }).select('name phone avatar').lean(),
        // M4: solo la cédula ya aprobada sirve de referencia para comparar
        // caras. Sin el filtro de `status`, una cédula rechazada o todavía
        // pendiente (de cualquiera, incluida una falsa) se mostraba igual
        // como "la foto de identidad de este domiciliario".
        DriverDocument.find({ driverId: { $in: driverIds }, type: 'identity', status: 'approved' })
          .select('driverId imageUrl imageKey isPrivate')
          .lean(),
      ]);
      const driverById = new Map(drivers.map((d) => [d._id.toString(), d]));
      const userById = new Map(users.map((u) => [u._id.toString(), u]));
      const identityByDriver = new Map(
        identityDocs.map((d) => [d.driverId.toString(), driverService.documentImageUrl(d)])
      );

      const enriched = items.map((item) => {
        const driver = driverById.get(item.driverId);
        const user = userById.get(item.userId);
        return {
          _id: item._id,
          type: item.type,
          status: item.status,
          imageUrl: driverSecurityService.signedImageUrl(item),
          dueAt: item.dueAt,
          createdAt: item.createdAt,
          rejectionReason: item.rejectionReason,
          driver: driver
            ? { _id: driver._id, licensePlate: (driver as any).licensePlate, vehicleType: driver.vehicleType, isApproved: driver.isApproved, isActive: driver.isActive }
            : null,
          user: user ? { _id: user._id, name: user.name, phone: user.phone, avatar: (user as any).avatar } : null,
          identityDocumentUrl: identityByDriver.get(item.driverId),
          identityDocumentStatus: identityByDriver.has(item.driverId) ? 'approved' : 'none',
        };
      });

      sendResponse(res, 200, 'Cola de verificaciones', enriched);
    } catch (error) { next(error); }
  }

  async reviewVerification(req: Request, res: Response, next: NextFunction) {
    try {
      const { driverSecurityService } = await import('../security');
      const result = await driverSecurityService.reviewVerification(
        param(req, 'verificationId'),
        req.user!._id.toString(),
        req.body.status === 'approved',
        req.body.rejectionReason
      );
      if (!result) throw new AppError('Verificación no encontrada', 404);

      // S14: quién aprobó o rechazó una selfie de identidad queda auditado.
      void logAudit(req, {
        action: AuditAction.DOCUMENT_REVIEWED,
        entity: 'driver_verification',
        entityId: result._id.toString(),
        severity: AuditSeverity.MEDIUM,
        description: `Verificación de identidad ${result.status === 'approved' ? 'aprobada' : 'rechazada'}`,
        metadata: { status: result.status, type: result.type, rejectionReason: result.rejectionReason },
      });

      sendResponse(res, 200, 'Verificación revisada', result);
    } catch (error) { next(error); }
  }

  // Admin endpoints
  async getAll(req: Request, res: Response, next: NextFunction) {
    try {
      // `validate(listDriversQuerySchema)` ya dejó la consulta tipada en `req.query`.
      const q = req.query as unknown as ListDriversQuery;
      const result = await driverService.list({ ...q, page: q.page ?? 1, limit: clampLimit(q.limit) });
      sendResponse(res, 200, 'Domiciliarios obtenidos', result.drivers, result.meta);
    } catch (error) { next(error); }
  }

  async getById(req: Request, res: Response, next: NextFunction) {
    try {
      sendResponse(res, 200, 'Domiciliario obtenido', await driverService.getDetail(param(req, 'id')));
    } catch (error) { next(error); }
  }

  async approve(req: Request, res: Response, next: NextFunction) {
    try {
      const driver = await driverService.approve(param(req, 'id'));
      void logAudit(req, {
        action: AuditAction.DRIVER_APPROVED,
        entity: 'driver',
        entityId: driver._id.toString(),
        severity: AuditSeverity.MEDIUM,
        description: 'Domiciliario aprobado',
      });
      sendResponse(res, 200, 'Domiciliario aprobado', driver);
    } catch (error) { next(error); }
  }

  async updateBaseFund(req: Request, res: Response, next: NextFunction) {
    try {
      const before = await driverService.getDetail(param(req, 'id'));
      const previousBaseFund = before.baseFund;
      const driver = await driverService.updateBaseFund(param(req, 'id'), req.body.baseFund);
      void logAudit(req, {
        action: AuditAction.PROFILE_UPDATED,
        entity: 'driver',
        entityId: driver._id.toString(),
        severity: AuditSeverity.HIGH,
        description:
          `Fondo rotatorio cambiado de $${previousBaseFund} a $${driver.baseFund}. ` +
          `Motivo: ${req.body.reason}`,
      });
      sendResponse(res, 200, 'Fondo base actualizado', driver);
    } catch (error) { next(error); }
  }
}

export const driverController = new DriverController();
