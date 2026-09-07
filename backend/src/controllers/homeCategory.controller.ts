import { Request, Response, NextFunction } from 'express';
import { homeCategoryService } from '../services';
import { sendResponse, param } from '../utils';
import { AppError } from '../middlewares';
import { uploadHomeCategoryImage } from '../middlewares/upload';
import { AuditAction, AuditSeverity, logAudit } from '../security';

export class HomeCategoryController {
  // ── Público: lo consume la app en la pantalla inicial ───────────────

  async getForApp(_req: Request, res: Response, next: NextFunction) {
    try {
      const categories = await homeCategoryService.listActive();
      sendResponse(res, 200, 'Categorías de inicio', categories);
    } catch (error) { next(error); }
  }

  // ── Admin ──────────────────────────────────────────────────────────

  async list(_req: Request, res: Response, next: NextFunction) {
    try {
      const categories = await homeCategoryService.list();
      sendResponse(res, 200, 'Categorías', categories);
    } catch (error) { next(error); }
  }

  async upload(req: Request, res: Response, next: NextFunction) {
    uploadHomeCategoryImage(req, res, async (err: unknown) => {
      try {
        if (err) throw new AppError(err instanceof Error ? err.message : 'No se pudo procesar la imagen', 400);
        if (!req.file) throw new AppError('Selecciona una imagen para la categoría', 400);

        const url = await homeCategoryService.uploadImage(req.file.buffer);
        sendResponse(res, 200, 'Imagen subida', { url });
      } catch (error) { next(error); }
    });
  }

  async create(req: Request, res: Response, next: NextFunction) {
    try {
      const { key, name, imageUrl, status } = req.body;
      if (!key || !name) throw new AppError('La clave y el nombre son requeridos', 400);

      const category = await homeCategoryService.create({
        key,
        name,
        imageUrl: imageUrl ?? '',
        status: status ?? 'active',
        order: req.body.order ?? (await homeCategoryService.nextOrder()),
      });

      void logAudit(req, {
        action: AuditAction.PROMO_BANNER_CREATED,
        entity: 'homeCategory',
        entityId: category._id.toString(),
        severity: AuditSeverity.MEDIUM,
        description: 'Categoría de inicio creada',
        metadata: { key: category.key, name: category.name },
      });

      sendResponse(res, 201, 'Categoría creada', category);
    } catch (error) { next(error); }
  }

  async update(req: Request, res: Response, next: NextFunction) {
    try {
      const category = await homeCategoryService.update(param(req, 'id'), {
        name: req.body.name,
        imageUrl: req.body.imageUrl,
        status: req.body.status,
        order: req.body.order,
      });

      void logAudit(req, {
        action: AuditAction.PROMO_BANNER_UPDATED,
        entity: 'homeCategory',
        entityId: category._id.toString(),
        severity: AuditSeverity.MEDIUM,
        description: 'Categoría de inicio actualizada',
        metadata: { key: category.key, changes: Object.keys(req.body) },
      });

      sendResponse(res, 200, 'Categoría actualizada', category);
    } catch (error) { next(error); }
  }

  async remove(req: Request, res: Response, next: NextFunction) {
    try {
      const category = await homeCategoryService.remove(param(req, 'id'));

      void logAudit(req, {
        action: AuditAction.PROMO_BANNER_DELETED,
        entity: 'homeCategory',
        entityId: category._id.toString(),
        severity: AuditSeverity.HIGH,
        description: 'Categoría de inicio eliminada',
        metadata: { key: category.key, name: category.name },
      });

      sendResponse(res, 200, 'Categoría eliminada');
    } catch (error) { next(error); }
  }
}

export const homeCategoryController = new HomeCategoryController();
