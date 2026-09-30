import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { driverDossierService } from '../services/driverDossier.service';
import { sendResponse, param, query } from '../utils';
import { AuditAction, AuditSeverity, logAudit } from '../security';
import { AppError } from '../middlewares/errorHandler';
import { uploadBusinessDocumentFile } from '../middlewares/upload';
import { DRIVER_CONTRACT_STATUSES } from '../models';

/**
 * Expediente digital del domiciliario (panel admin).
 *
 * Todas las rutas exigen `drivers:approve`: el expediente contiene la cédula,
 * los antecedentes y los papeles del vehículo, es decir, lo mismo que ya ve
 * quien revisa documentos. Cada lectura de un archivo, cada exportación y cada
 * cambio deja una fila de auditoría propia.
 */

const optionalDate = z.preprocess(
  (v) => (v === '' || v === null ? undefined : v),
  z.coerce.date().optional()
);

export const requestUpdateBody = z.object({ reason: z.string().trim().min(5, 'Explica qué debe actualizar (mínimo 5 caracteres)').max(300) });
export const observationBody = z.object({ note: z.string().trim().min(3, 'Escribe la observación').max(500) });
export const vehicleBody = z
  .object({
    brand: z.string().trim().min(1).max(40).optional(),
    model: z.string().trim().min(1).max(40).optional(),
    color: z.string().trim().min(1).max(30).optional(),
    year: z.number().int().min(1980).max(new Date().getFullYear() + 1).optional(),
    engineCc: z.number().int().min(50, 'Cilindraje entre 50 y 2500 cc').max(2500, 'Cilindraje entre 50 y 2500 cc').optional(),
    ownerName: z.string().trim().min(2).max(80).optional(),
    licenseCategory: z.enum(['A1', 'A2', 'B1', 'B2', 'B3', 'C1', 'C2', 'C3']).optional(),
    licensePlate: z
      .string()
      .trim()
      .toUpperCase()
      // Placas colombianas de moto: ABC12D (nueva) y ABC123 (carro/antigua). Sin espacios ni guiones.
      .regex(/^[A-Z]{3}\d{2}[A-Z\d]$/, 'La placa debe tener 3 letras, 2 números y una letra o número (ej. ABC12D)')
      .optional(),
  })
  .strict();
export const contractBody = z
  .object({
    status: z.enum(DRIVER_CONTRACT_STATUSES),
    startDate: optionalDate,
    endDate: optionalDate,
    note: z.string().trim().max(500).optional(),
  })
  .strict();

const extraNameBody = z.object({ name: z.string().trim().min(2, 'Ponle un nombre al documento').max(80) });

/** Nombre de archivo apto para la cabecera: sin comillas, saltos ni acentos raros. */
const headerName = (name: string) => name.normalize('NFD').replace(/[^\w.\-]+/g, '_').slice(0, 80) || 'documento';

function sendFile(res: Response, file: { buffer: Buffer; contentType: string; format: string }, baseName: string, disposition: 'inline' | 'attachment') {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', 'sandbox');
  res.setHeader('Content-Type', file.contentType);
  res.setHeader('Content-Disposition', `${disposition}; filename="${headerName(baseName)}.${file.format}"`);
  res.send(file.buffer);
}

function parseDisposition(req: Request): 'inline' | 'attachment' {
  const value = query(req, 'disposition') ?? 'inline';
  if (value !== 'inline' && value !== 'attachment') throw new AppError('Parámetro "disposition" inválido', 400);
  return value;
}

export class DriverDossierController {
  async get(req: Request, res: Response, next: NextFunction) {
    try {
      const driverId = param(req, 'id');
      const dossier = await driverDossierService.build(driverId);
      res.setHeader('Cache-Control', 'no-store');
      void logAudit(req, {
        action: AuditAction.DRIVER_DOSSIER_VIEWED,
        entity: 'driver',
        entityId: driverId,
        severity: AuditSeverity.LOW,
        description: 'Expediente de domiciliario consultado',
      });
      sendResponse(res, 200, 'Expediente del domiciliario', dossier);
    } catch (error) { next(error); }
  }

  /** Ver o descargar la foto de un documento. El archivo pasa por aquí: no se entrega ninguna URL del almacén. */
  async documentFile(req: Request, res: Response, next: NextFunction) {
    try {
      const driverId = param(req, 'id');
      const documentId = param(req, 'documentId');
      const disposition = parseDisposition(req);
      const { file, label, type } = await driverDossierService.readDocumentFile(driverId, documentId);
      void logAudit(req, {
        action: disposition === 'attachment' ? AuditAction.DRIVER_DOCUMENT_DOWNLOADED : AuditAction.DRIVER_DOCUMENT_VIEWED,
        entity: 'driver_document',
        entityId: documentId,
        severity: AuditSeverity.MEDIUM,
        description: `${disposition === 'attachment' ? 'Descarga' : 'Visualización'} de documento de domiciliario: ${label}`,
        metadata: { driverId, documentType: type },
      });
      sendFile(res, file, label, disposition);
    } catch (error) { next(error); }
  }

  async contractFile(req: Request, res: Response, next: NextFunction) {
    try {
      const driverId = param(req, 'id');
      const which = param(req, 'fileId');
      const disposition = parseDisposition(req);
      const { file, label } = await driverDossierService.readContractAsset(driverId, which);
      void logAudit(req, {
        action: disposition === 'attachment' ? AuditAction.DRIVER_DOCUMENT_DOWNLOADED : AuditAction.DRIVER_DOCUMENT_VIEWED,
        entity: 'driver_contract',
        entityId: driverId,
        severity: AuditSeverity.MEDIUM,
        description: `${disposition === 'attachment' ? 'Descarga' : 'Visualización'} de documento contractual: ${label}`,
        metadata: { driverId, fileId: which },
      });
      sendFile(res, file, label, disposition);
    } catch (error) { next(error); }
  }

  async exportPdf(req: Request, res: Response, next: NextFunction) {
    try {
      const driverId = param(req, 'id');
      const { pdf, fileName, annexes, skipped } = await driverDossierService.exportPdf(
        driverId,
        req.user?.name ?? 'Administrador'
      );
      void logAudit(req, {
        action: AuditAction.DRIVER_DOSSIER_EXPORTED,
        entity: 'driver',
        entityId: driverId,
        severity: AuditSeverity.MEDIUM,
        description: 'Expediente completo de domiciliario exportado a PDF',
        metadata: { annexes, skipped },
      });
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${headerName(fileName.replace(/\.pdf$/, ''))}.pdf"`);
      res.send(pdf);
    } catch (error) { next(error); }
  }

  async requestUpdate(req: Request, res: Response, next: NextFunction) {
    try {
      const driverId = param(req, 'id');
      const documentId = param(req, 'documentId');
      const { type } = await driverDossierService.requestUpdate(driverId, documentId, req.user!._id.toString(), req.body.reason);
      void logAudit(req, {
        action: AuditAction.DRIVER_DOCUMENT_UPDATE_REQUESTED,
        entity: 'driver_document',
        entityId: documentId,
        severity: AuditSeverity.LOW,
        description: 'Actualización de documento solicitada al domiciliario',
        metadata: { driverId, documentType: type, reason: req.body.reason },
      });
      sendResponse(res, 200, 'Solicitud enviada al domiciliario', { type });
    } catch (error) { next(error); }
  }

  async addObservation(req: Request, res: Response, next: NextFunction) {
    try {
      const driverId = param(req, 'id');
      const documentId = param(req, 'documentId');
      const { type } = await driverDossierService.addObservation(driverId, documentId, req.user!._id.toString(), req.body.note);
      void logAudit(req, {
        action: AuditAction.DRIVER_DOCUMENT_OBSERVATION,
        entity: 'driver_document',
        entityId: documentId,
        severity: AuditSeverity.LOW,
        description: 'Observación interna registrada en documento de domiciliario',
        metadata: { driverId, documentType: type, note: req.body.note },
      });
      sendResponse(res, 201, 'Observación registrada', { type });
    } catch (error) { next(error); }
  }

  async updateVehicle(req: Request, res: Response, next: NextFunction) {
    try {
      const driverId = param(req, 'id');
      const driver = await driverDossierService.updateVehicle(driverId, req.body);
      void logAudit(req, {
        action: AuditAction.DRIVER_VEHICLE_UPDATED,
        entity: 'driver',
        entityId: driverId,
        severity: AuditSeverity.LOW,
        description: 'Datos del vehículo del domiciliario actualizados',
        metadata: { fields: Object.keys(req.body) },
      });
      sendResponse(res, 200, 'Vehículo actualizado', { vehicle: driver.vehicle, licensePlate: driver.licensePlate });
    } catch (error) { next(error); }
  }

  async upsertContract(req: Request, res: Response, next: NextFunction) {
    try {
      const driverId = param(req, 'id');
      const contract = await driverDossierService.upsertContract(driverId, req.user!._id.toString(), req.body);
      void logAudit(req, {
        action: AuditAction.DRIVER_CONTRACT_UPDATED,
        entity: 'driver_contract',
        entityId: driverId,
        severity: AuditSeverity.MEDIUM,
        description: 'Contrato del domiciliario registrado o modificado',
        metadata: { status: contract?.status, startDate: contract?.startDate, endDate: contract?.endDate },
      });
      sendResponse(res, 200, 'Contrato guardado', { status: contract?.status });
    } catch (error) { next(error); }
  }

  /**
   * Contrato firmado (`/contract/file`) o anexo (`/contract/extras`, con `name`).
   * Sin `validate()` en la ruta por la misma razón que las demás subidas: Zod
   * vaciaría el cuerpo antes de que multer lo lea.
   */
  attachFile(kind: 'contract' | 'extra') {
    return (req: Request, res: Response, next: NextFunction) => {
      uploadBusinessDocumentFile(req, res, async (err: unknown) => {
        try {
          if (err) throw new AppError(err instanceof Error ? err.message : 'No se pudo procesar el archivo', 400);
          if (!req.file) throw new AppError('Adjunta un archivo (imagen o PDF)', 400);

          let name: string | undefined;
          if (kind === 'extra') {
            const parsed = extraNameBody.safeParse(req.body);
            if (!parsed.success) throw new AppError(parsed.error.issues[0]?.message ?? 'Revisa el nombre', 400);
            name = parsed.data.name;
          }

          const driverId = param(req, 'id');
          await driverDossierService.attachContractFile(driverId, req.user!._id.toString(), req.file.buffer, name);
          void logAudit(req, {
            action: AuditAction.DRIVER_CONTRACT_UPDATED,
            entity: 'driver_contract',
            entityId: driverId,
            severity: AuditSeverity.MEDIUM,
            description: kind === 'contract' ? 'Contrato firmado adjuntado' : 'Documento adicional adjuntado al contrato',
            metadata: { name },
          });
          sendResponse(res, 201, 'Archivo guardado', {});
        } catch (error) { next(error); }
      });
    };
  }

  async removeExtra(req: Request, res: Response, next: NextFunction) {
    try {
      const driverId = param(req, 'id');
      await driverDossierService.removeContractExtra(driverId, req.user!._id.toString(), param(req, 'fileId'));
      void logAudit(req, {
        action: AuditAction.DRIVER_CONTRACT_UPDATED,
        entity: 'driver_contract',
        entityId: driverId,
        severity: AuditSeverity.MEDIUM,
        description: 'Documento adicional retirado del contrato',
        metadata: { fileId: param(req, 'fileId') },
      });
      sendResponse(res, 200, 'Anexo retirado', {});
    } catch (error) { next(error); }
  }
}

export const driverDossierController = new DriverDossierController();
