import { Request, Response, NextFunction } from 'express';
import { CuratedHomeBlock, CURATED_HOME_BLOCK_KINDS, Product, Business } from '../models';
import { sendResponse, param, query } from '../utils';
import { AppError } from '../middlewares';
import { AuditAction, AuditSeverity, logAudit } from '../security';

/** Admin-only: alta, edición y borrado de los bloques curados del inicio
 * (`productBanner`, `businessBanner`, `businessCollection`). No tiene ruta
 * pública propia — `homeSections.service.ts` los consulta directamente y
 * los fusiona en `/home-sections`, que es lo único que ve la app. */
export class CuratedHomeBlockController {
  async options(_req: Request, res: Response, next: NextFunction) {
    try {
      sendResponse(res, 200, 'Opciones de bloques curados', {
        kinds: CURATED_HOME_BLOCK_KINDS,
      });
    } catch (error) { next(error); }
  }

  async list(req: Request, res: Response, next: NextFunction) {
    try {
      const page = Number(query(req, 'page')) || 1;
      const limit = Math.min(Number(query(req, 'limit')) || 50, 100);
      const skip = (page - 1) * limit;

      const filter: Record<string, unknown> = {};
      const kind = query(req, 'kind');
      if (kind) filter.kind = kind;
      const search = query(req, 'search');
      if (search) filter.title = { $regex: search, $options: 'i' };

      const [blocks, total] = await Promise.all([
        CuratedHomeBlock.find(filter).sort({ order: 1, createdAt: -1 }).skip(skip).limit(limit),
        CuratedHomeBlock.countDocuments(filter),
      ]);

      sendResponse(res, 200, 'Bloques curados', blocks, {
        page, limit, total, totalPages: Math.ceil(total / limit),
      });
    } catch (error) { next(error); }
  }

  async get(req: Request, res: Response, next: NextFunction) {
    try {
      const block = await CuratedHomeBlock.findById(param(req, 'id'));
      if (!block) throw new AppError('Bloque no encontrado', 404);
      sendResponse(res, 200, 'Bloque', block);
    } catch (error) { next(error); }
  }

  /** El destino de cada item tiene que existir: un producto o negocio
   * borrado no puede quedar colgado en un bloque publicado. */
  private async assertItemsExist(kind: string, items: string[]): Promise<void> {
    const Model = kind === 'productBanner' ? Product : Business;
    const count = await Model.countDocuments({ _id: { $in: items } });
    if (count !== items.length) {
      throw new AppError('Alguno de los elementos seleccionados ya no existe', 400);
    }
  }

  async create(req: Request, res: Response, next: NextFunction) {
    try {
      await this.assertItemsExist(req.body.kind, req.body.items);

      const block = await CuratedHomeBlock.create(req.body);

      void logAudit(req, {
        action: AuditAction.CURATED_HOME_BLOCK_CREATED,
        entity: 'curatedHomeBlock',
        entityId: block._id.toString(),
        severity: AuditSeverity.MEDIUM,
        description: 'Bloque curado del inicio creado',
        metadata: { kind: block.kind, title: block.title, order: block.order },
      });

      sendResponse(res, 201, 'Bloque creado', block);
    } catch (error) { next(error); }
  }

  async update(req: Request, res: Response, next: NextFunction) {
    try {
      const block = await CuratedHomeBlock.findById(param(req, 'id'));
      if (!block) throw new AppError('Bloque no encontrado', 404);

      const kind = req.body.kind ?? block.kind;
      const items = req.body.items ?? block.items.map((i) => i.toString());
      await this.assertItemsExist(kind, items);

      Object.assign(block, req.body);
      await block.save();

      void logAudit(req, {
        action: AuditAction.CURATED_HOME_BLOCK_UPDATED,
        entity: 'curatedHomeBlock',
        entityId: block._id.toString(),
        severity: AuditSeverity.MEDIUM,
        description: 'Bloque curado del inicio actualizado',
        metadata: { kind: block.kind, title: block.title, changes: Object.keys(req.body) },
      });

      sendResponse(res, 200, 'Bloque actualizado', block);
    } catch (error) { next(error); }
  }

  async toggle(req: Request, res: Response, next: NextFunction) {
    try {
      const block = await CuratedHomeBlock.findById(param(req, 'id'));
      if (!block) throw new AppError('Bloque no encontrado', 404);

      block.isActive = !block.isActive;
      await block.save();

      void logAudit(req, {
        action: AuditAction.CURATED_HOME_BLOCK_UPDATED,
        entity: 'curatedHomeBlock',
        entityId: block._id.toString(),
        severity: AuditSeverity.MEDIUM,
        description: block.isActive ? 'Bloque activado' : 'Bloque desactivado',
        metadata: { title: block.title },
      });

      sendResponse(res, 200, block.isActive ? 'Bloque activado' : 'Bloque desactivado', block);
    } catch (error) { next(error); }
  }

  async remove(req: Request, res: Response, next: NextFunction) {
    try {
      const block = await CuratedHomeBlock.findById(param(req, 'id'));
      if (!block) throw new AppError('Bloque no encontrado', 404);

      await block.deleteOne();

      void logAudit(req, {
        action: AuditAction.CURATED_HOME_BLOCK_DELETED,
        entity: 'curatedHomeBlock',
        entityId: block._id.toString(),
        severity: AuditSeverity.HIGH,
        description: 'Bloque curado del inicio eliminado',
        metadata: { kind: block.kind, title: block.title },
      });

      sendResponse(res, 200, 'Bloque eliminado');
    } catch (error) { next(error); }
  }
}

export const curatedHomeBlockController = new CuratedHomeBlockController();
