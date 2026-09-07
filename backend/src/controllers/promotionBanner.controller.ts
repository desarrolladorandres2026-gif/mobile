import { Request, Response, NextFunction } from 'express';
import { promotionBannerService } from '../services';
import {
  PromotionBanner,
  BannerPlacement,
  BannerActionType,
  BANNER_SCREENS,
  BANNER_DURATION,
} from '../models';
import { BusinessCategory } from '../types';
import { sendResponse, param, query } from '../utils';
import { AppError } from '../middlewares';
import { uploadBannerImage } from '../middlewares/upload';
import { AuditAction, AuditSeverity, logAudit } from '../security';

export class PromotionBannerController {
  // ── Público: lo consume la app en la pantalla inicial ───────────────

  /**
   * Solo los banners vigentes de la superficie pedida, ya ordenados.
   *
   * Devuelve un arreglo vacío en lugar de 404 cuando no hay ninguno: para
   * la app "no hay promociones" es un estado normal, no un error, y así el
   * carrusel simplemente no se dibuja.
   */
  async getForApp(req: Request, res: Response, next: NextFunction) {
    try {
      const raw = query(req, 'placement');
      const placement =
        raw && (Object.values(BannerPlacement) as string[]).includes(raw)
          ? (raw as BannerPlacement)
          : BannerPlacement.HOME;

      const banners = await promotionBannerService.listForApp(placement);
      sendResponse(res, 200, banners.length ? 'Banners activos' : 'Sin banners activos', banners);
    } catch (error) { next(error); }
  }

  // ── Admin ──────────────────────────────────────────────────────────

  /**
   * Las listas cerradas que el formulario del panel necesita.
   *
   * Se sirven desde aquí para que el panel no tenga que repetir —y mantener
   * sincronizadas— las categorías, las pantallas navegables ni los topes de
   * duración que el backend ya valida.
   */
  async options(_req: Request, res: Response, next: NextFunction) {
    try {
      sendResponse(res, 200, 'Opciones de banners', {
        actionTypes: [
          { key: BannerActionType.NONE, label: 'Sin acción' },
          { key: BannerActionType.URL, label: 'Abrir enlace externo' },
          { key: BannerActionType.BUSINESS, label: 'Ir a un negocio' },
          { key: BannerActionType.CATEGORY, label: 'Ir a una categoría' },
          { key: BannerActionType.SCREEN, label: 'Ir a una pantalla' },
        ],
        placements: [
          { key: BannerPlacement.HOME, label: 'Solo pantalla inicial' },
          { key: BannerPlacement.ALL, label: 'Toda la app' },
        ],
        screens: BANNER_SCREENS,
        categories: Object.values(BusinessCategory),
        duration: BANNER_DURATION,
      });
    } catch (error) { next(error); }
  }

  async upload(req: Request, res: Response, next: NextFunction) {
    uploadBannerImage(req, res, async (err: unknown) => {
      try {
        if (err) throw new AppError(err instanceof Error ? err.message : 'No se pudo procesar la imagen', 400);
        if (!req.file) throw new AppError('Selecciona una imagen para el banner', 400);

        const url = await promotionBannerService.uploadBannerImage(req.file.buffer);
        sendResponse(res, 200, 'Imagen subida', { url });
      } catch (error) { next(error); }
    });
  }

  async list(req: Request, res: Response, next: NextFunction) {
    try {
      const page = Number(query(req, 'page')) || 1;
      const limit = Math.min(Number(query(req, 'limit')) || 50, 100);
      const skip = (page - 1) * limit;

      const filter: Record<string, unknown> = {};
      const search = query(req, 'search');
      if (search) {
        filter.$or = [
          { title: { $regex: search, $options: 'i' } },
          { description: { $regex: search, $options: 'i' } },
        ];
      }

      const [banners, total] = await Promise.all([
        PromotionBanner.find(filter)
          .sort({ displayOrder: 1, priority: -1, createdAt: -1 })
          .skip(skip)
          .limit(limit),
        PromotionBanner.countDocuments(filter),
      ]);

      const now = new Date();
      const statusFilter = query(req, 'status');
      let withStatus = banners.map((b) => ({
        ...b.toObject(),
        status: promotionBannerService.status(b, now),
      }));
      if (statusFilter) withStatus = withStatus.filter((b) => b.status === statusFilter);

      sendResponse(res, 200, 'Banners', withStatus, {
        page, limit, total, totalPages: Math.ceil(total / limit),
      });
    } catch (error) { next(error); }
  }

  async get(req: Request, res: Response, next: NextFunction) {
    try {
      const banner = await PromotionBanner.findById(param(req, 'id'));
      if (!banner) throw new AppError('Banner no encontrado', 404);
      sendResponse(res, 200, 'Banner', {
        ...banner.toObject(),
        status: promotionBannerService.status(banner),
      });
    } catch (error) { next(error); }
  }

  async create(req: Request, res: Response, next: NextFunction) {
    try {
      const actionType = (req.body.actionType ?? BannerActionType.NONE) as BannerActionType;
      await promotionBannerService.assertActionTarget(actionType, req.body.actionValue ?? '');

      const banner = await PromotionBanner.create({
        ...req.body,
        // Sin posición explícita, el banner nuevo va al final: nunca
        // desplaza al que el administrador ya puso de primero.
        displayOrder: req.body.displayOrder ?? (await promotionBannerService.nextDisplayOrder()),
      });

      void logAudit(req, {
        action: AuditAction.PROMO_BANNER_CREATED,
        entity: 'promotionBanner',
        entityId: banner._id.toString(),
        severity: AuditSeverity.MEDIUM,
        description: 'Banner promocional creado',
        metadata: { title: banner.title, placement: banner.placement },
      });

      sendResponse(res, 201, 'Banner creado', {
        ...banner.toObject(),
        status: promotionBannerService.status(banner),
      });
    } catch (error) { next(error); }
  }

  async update(req: Request, res: Response, next: NextFunction) {
    try {
      const banner = await PromotionBanner.findById(param(req, 'id'));
      if (!banner) throw new AppError('Banner no encontrado', 404);

      // El destino se comprueba contra el estado resultante, no contra lo
      // que trae el PATCH: cambiar solo el tipo de acción también tiene que
      // validarse contra el `actionValue` que ya estaba guardado.
      const actionType = (req.body.actionType ?? banner.actionType) as BannerActionType;
      const actionValue = req.body.actionValue ?? banner.actionValue;
      await promotionBannerService.assertActionTarget(actionType, actionValue);

      Object.assign(banner, req.body);
      await banner.save();

      void logAudit(req, {
        action: AuditAction.PROMO_BANNER_UPDATED,
        entity: 'promotionBanner',
        entityId: banner._id.toString(),
        severity: AuditSeverity.MEDIUM,
        description: 'Banner promocional actualizado',
        metadata: { title: banner.title, changes: Object.keys(req.body) },
      });

      sendResponse(res, 200, 'Banner actualizado', {
        ...banner.toObject(),
        status: promotionBannerService.status(banner),
      });
    } catch (error) { next(error); }
  }

  async toggle(req: Request, res: Response, next: NextFunction) {
    try {
      const banner = await PromotionBanner.findById(param(req, 'id'));
      if (!banner) throw new AppError('Banner no encontrado', 404);

      banner.isActive = !banner.isActive;
      await banner.save();

      void logAudit(req, {
        action: AuditAction.PROMO_BANNER_UPDATED,
        entity: 'promotionBanner',
        entityId: banner._id.toString(),
        severity: AuditSeverity.MEDIUM,
        description: banner.isActive ? 'Banner activado' : 'Banner desactivado',
        metadata: { title: banner.title },
      });

      sendResponse(res, 200, banner.isActive ? 'Banner activado' : 'Banner desactivado', {
        ...banner.toObject(),
        status: promotionBannerService.status(banner),
      });
    } catch (error) { next(error); }
  }

  async reorder(req: Request, res: Response, next: NextFunction) {
    try {
      const count = await promotionBannerService.reorder(req.body.ids);

      void logAudit(req, {
        action: AuditAction.PROMO_BANNER_REORDERED,
        entity: 'promotionBanner',
        severity: AuditSeverity.LOW,
        description: 'Orden de los banners actualizado',
        metadata: { count },
      });

      const banners = await PromotionBanner.find().sort({ displayOrder: 1, priority: -1, createdAt: -1 });
      const now = new Date();
      sendResponse(
        res,
        200,
        'Orden actualizado',
        banners.map((b) => ({ ...b.toObject(), status: promotionBannerService.status(b, now) }))
      );
    } catch (error) { next(error); }
  }

  async remove(req: Request, res: Response, next: NextFunction) {
    try {
      const banner = await PromotionBanner.findById(param(req, 'id'));
      if (!banner) throw new AppError('Banner no encontrado', 404);

      await banner.deleteOne();

      void logAudit(req, {
        action: AuditAction.PROMO_BANNER_DELETED,
        entity: 'promotionBanner',
        entityId: banner._id.toString(),
        severity: AuditSeverity.HIGH,
        description: 'Banner promocional eliminado',
        metadata: { title: banner.title },
      });

      sendResponse(res, 200, 'Banner eliminado');
    } catch (error) { next(error); }
  }
}

export const promotionBannerController = new PromotionBannerController();
