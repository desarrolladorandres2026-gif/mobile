import { Request, Response, NextFunction } from 'express';
import { advertisementService } from '../services';
import { Advertisement } from '../models';
import { sendResponse, param, query, escapeRegex } from '../utils';
import { AppError } from '../middlewares';
import { uploadImage } from '../middlewares/upload';
import { AuditAction, AuditSeverity, logAudit } from '../security';

export class AdvertisementController {
  // ── Public: consumed by the app on open ─────────────────────────────

  /** Only what the app needs to render and act on the flyer — nothing else. */
  async getActive(req: Request, res: Response, next: NextFunction) {
    try {
      // El segmento sale de la sesión cuando la hay, y de la consulta
      // cuando no: un visitante sin registrarse también ve publicidad, y
      // su ciudad es lo único que se sabe de él.
      const user = (req as any).user;
      const ad = await advertisementService.getActiveForApp({
        city: user?.city ?? query(req, 'city') ?? undefined,
        role: user?.role,
        deviceId: query(req, 'deviceId') ?? user?._id?.toString(),
      });
      sendResponse(res, 200, ad ? 'Publicidad activa' : 'Sin publicidad activa', ad);
    } catch (error) { next(error); }
  }

  async registerImpression(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = (req as any).user?._id?.toString();
      await advertisementService.registerImpression(param(req, 'id'), req.body.deviceId, userId);
      sendResponse(res, 200, 'Impresión registrada');
    } catch (error) { next(error); }
  }

  async registerClick(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = (req as any).user?._id?.toString();
      await advertisementService.registerClick(param(req, 'id'), req.body.deviceId, userId);
      sendResponse(res, 200, 'Clic registrado');
    } catch (error) { next(error); }
  }

  // ── Admin ──────────────────────────────────────────────────────────

  async uploadFlyer(req: Request, res: Response, next: NextFunction) {
    uploadImage(req, res, async (err: unknown) => {
      try {
        if (err) throw new AppError(err instanceof Error ? err.message : 'No se pudo procesar la imagen', 400);
        if (!req.file) throw new AppError('Selecciona una imagen para el flyer', 400);

        const url = await advertisementService.uploadFlyer(req.file.buffer, req.file.mimetype);
        sendResponse(res, 200, 'Imagen subida', { url });
      } catch (error) { next(error); }
    });
  }

  async list(req: Request, res: Response, next: NextFunction) {
    try {
      const page = Number(query(req, 'page')) || 1;
      const limit = Math.min(Number(query(req, 'limit')) || 20, 100);
      const skip = (page - 1) * limit;

      const filter: Record<string, unknown> = {};
      const search = query(req, 'search');
      if (search) {
        filter.$or = [
          { campaignName: { $regex: escapeRegex(search), $options: 'i' } },
          { advertiserName: { $regex: escapeRegex(search), $options: 'i' } },
        ];
      }

      const [campaigns, total] = await Promise.all([
        Advertisement.find(filter).sort({ priority: -1, createdAt: -1 }).skip(skip).limit(limit),
        Advertisement.countDocuments(filter),
      ]);

      const now = new Date();
      const statusFilter = query(req, 'status');
      let withStatus = campaigns.map((c) => ({ ...c.toObject(), status: advertisementService.status(c, now) }));
      if (statusFilter) withStatus = withStatus.filter((c) => c.status === statusFilter);

      sendResponse(res, 200, 'Campañas', withStatus, {
        page, limit, total, totalPages: Math.ceil(total / limit),
      });
    } catch (error) { next(error); }
  }

  async get(req: Request, res: Response, next: NextFunction) {
    try {
      const campaign = await Advertisement.findById(param(req, 'id'));
      if (!campaign) throw new AppError('Campaña no encontrada', 404);
      sendResponse(res, 200, 'Campaña', { ...campaign.toObject(), status: advertisementService.status(campaign) });
    } catch (error) { next(error); }
  }

  async create(req: Request, res: Response, next: NextFunction) {
    try {
      const campaign = await Advertisement.create(req.body);
      void logAudit(req, {
        action: AuditAction.AD_CAMPAIGN_CREATED,
        entity: 'advertisement',
        entityId: campaign._id.toString(),
        severity: AuditSeverity.MEDIUM,
        description: 'Campaña publicitaria creada',
        metadata: { campaignName: campaign.campaignName, advertiserName: campaign.advertiserName },
      });
      sendResponse(res, 201, 'Campaña creada', campaign);
    } catch (error) { next(error); }
  }

  async update(req: Request, res: Response, next: NextFunction) {
    try {
      const campaign = await Advertisement.findById(param(req, 'id'));
      if (!campaign) throw new AppError('Campaña no encontrada', 404);

      const previousFlyerUrl = campaign.flyerUrl;
      Object.assign(campaign, req.body);
      await campaign.save();
      void logAudit(req, {
        action: AuditAction.AD_CAMPAIGN_UPDATED,
        entity: 'advertisement',
        entityId: campaign._id.toString(),
        severity: AuditSeverity.MEDIUM,
        description: 'Campaña publicitaria actualizada',
        metadata: { campaignName: campaign.campaignName, changes: Object.keys(req.body) },
      });

      // El flyer viejo ya no lo referencia nadie: se borra después de
      // guardar, nunca antes — si el guardado hubiera fallado, la campaña
      // seguiría apuntando a una imagen que todavía existe.
      if (req.body.flyerUrl && req.body.flyerUrl !== previousFlyerUrl) {
        void advertisementService.destroyFlyer(previousFlyerUrl);
      }

      sendResponse(res, 200, 'Campaña actualizada', { ...campaign.toObject(), status: advertisementService.status(campaign) });
    } catch (error) { next(error); }
  }

  async toggle(req: Request, res: Response, next: NextFunction) {
    try {
      const campaign = await Advertisement.findById(param(req, 'id'));
      if (!campaign) throw new AppError('Campaña no encontrada', 404);
      if (campaign.cancelledAt) throw new AppError('La campaña está cancelada y no puede reactivarse', 409);

      campaign.isActive = !campaign.isActive;
      await campaign.save();
      void logAudit(req, {
        action: AuditAction.AD_CAMPAIGN_UPDATED,
        entity: 'advertisement',
        entityId: campaign._id.toString(),
        severity: AuditSeverity.MEDIUM,
        description: campaign.isActive ? 'Campaña activada' : 'Campaña pausada',
        metadata: { campaignName: campaign.campaignName },
      });

      sendResponse(res, 200, campaign.isActive ? 'Campaña activada' : 'Campaña pausada', {
        ...campaign.toObject(),
        status: advertisementService.status(campaign),
      });
    } catch (error) { next(error); }
  }

  /** Estado terminal: distinto de pausar, no se puede deshacer. */
  async cancel(req: Request, res: Response, next: NextFunction) {
    try {
      const campaign = await advertisementService.cancel(param(req, 'id'));
      void logAudit(req, {
        action: AuditAction.AD_CAMPAIGN_CANCELLED,
        entity: 'advertisement',
        entityId: campaign._id.toString(),
        severity: AuditSeverity.MEDIUM,
        description: 'Campaña publicitaria cancelada',
        metadata: { campaignName: campaign.campaignName },
      });

      sendResponse(res, 200, 'Campaña cancelada', {
        ...campaign.toObject(),
        status: advertisementService.status(campaign),
      });
    } catch (error) { next(error); }
  }

  async remove(req: Request, res: Response, next: NextFunction) {
    try {
      const campaign = await Advertisement.findById(param(req, 'id'));
      if (!campaign) throw new AppError('Campaña no encontrada', 404);

      await campaign.deleteOne();
      void advertisementService.destroyFlyer(campaign.flyerUrl);
      void logAudit(req, {
        action: AuditAction.AD_CAMPAIGN_DELETED,
        entity: 'advertisement',
        entityId: campaign._id.toString(),
        severity: AuditSeverity.HIGH,
        description: 'Campaña publicitaria eliminada',
        metadata: { campaignName: campaign.campaignName },
      });

      sendResponse(res, 200, 'Campaña eliminada');
    } catch (error) { next(error); }
  }

  // ── Estadísticas ──────────────────────────────────────────────────────

  async getStats(req: Request, res: Response, next: NextFunction) {
    try {
      const stats = await advertisementService.stats(param(req, 'id'));
      sendResponse(res, 200, 'Estadísticas de la campaña', stats);
    } catch (error) { next(error); }
  }

  async getGlobalStats(req: Request, res: Response, next: NextFunction) {
    try {
      const stats = await advertisementService.globalStats();
      sendResponse(res, 200, 'Estadísticas de publicidad', stats);
    } catch (error) { next(error); }
  }
}

export const advertisementController = new AdvertisementController();
