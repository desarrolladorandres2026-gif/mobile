import { Advertisement, IAdvertisement, AdEvent, AdEventType } from '../models';
import { AppError } from '../middlewares';
import { cloudinary, config } from '../config';
import { readImageHeader } from './productImage.service';

export type AdStatus = 'scheduled' | 'active' | 'paused' | 'finished' | 'cancelled';

/** Public-safe shape served to the app: no internal counters, no admin-only fields. */
export interface PublicAd {
  id: string;
  campaignName: string;
  flyerUrl: string;
  actionType: string;
  businessId: string | null;
  /** Segundos que la app debe mantener el flyer antes de continuar sola. */
  durationSeconds: number;
}

export interface AdStats {
  totalImpressions: number;
  totalClicks: number;
  todayImpressions: number;
  todayClicks: number;
}

const AD_UPLOAD_ERROR = {
  INVALID_FILE: 'AD_FLYER_INVALID_FILE',
  TOO_LARGE: 'AD_FLYER_TOO_LARGE',
  TOO_SMALL: 'AD_FLYER_TOO_SMALL',
  STORAGE: 'AD_FLYER_STORAGE_FAILED',
} as const;

export class AdvertisementService {
  /**
   * Etiqueta del ciclo de vida — nunca persistida, siempre derivada de
   * `now`. `cancelledAt` es un estado terminal que gana sobre cualquier
   * fecha; después vienen las fechas (una campaña vencida lo sigue estando
   * aunque alguien la reactive); solo al final se mira `isActive`, que es
   * lo único que "Pausar"/"Reactivar" tocan.
   */
  status(
    ad: Pick<IAdvertisement, 'isActive' | 'startDate' | 'endDate' | 'cancelledAt'>,
    now: Date = new Date()
  ): AdStatus {
    if (ad.cancelledAt) return 'cancelled';
    if (now > ad.endDate) return 'finished';
    if (!ad.isActive) return 'paused';
    if (now < ad.startDate) return 'scheduled';
    return 'active';
  }

  /**
   * The one campaign the app should show on open, if any: active, inside
   * its date range, not cancelled, with a flyer, under its impression cap,
   * highest priority first. Never trusts the client — every condition is
   * re-checked here regardless of what the admin panel last showed.
   *
   * Selección por prioridad únicamente por ahora. El punto de extensión
   * para rotación/frecuencia entre varias campañas empatadas en prioridad
   * es este mismo método: hoy `sort` desempata por `createdAt` desc, que es
   * determinista pero no reparte impresiones — cuando haga falta repartir,
   * es aquí donde se cambiaría el criterio de desempate.
   */
  async getActiveForApp(): Promise<PublicAd | null> {
    const now = new Date();
    const candidates = await Advertisement.find({
      isActive: true,
      cancelledAt: null,
      startDate: { $lte: now },
      endDate: { $gte: now },
      flyerUrl: { $ne: '' },
    }).sort({ priority: -1, createdAt: -1 });

    const eligible = candidates.find(
      (ad) => ad.maxImpressions === 0 || ad.impressionCount < ad.maxImpressions
    );
    if (!eligible) return null;

    return {
      id: eligible._id.toString(),
      campaignName: eligible.campaignName,
      flyerUrl: eligible.flyerUrl,
      actionType: eligible.actionType,
      businessId: eligible.businessId ? eligible.businessId.toString() : null,
      durationSeconds: eligible.durationSeconds,
    };
  }

  /**
   * Counted only when the app confirms the flyer actually rendered — the
   * app never pre-fetches then reports; it reports after paint.
   */
  async registerImpression(campaignId: string, deviceId: string, userId?: string): Promise<void> {
    const ad = await Advertisement.findOneAndUpdate(
      {
        _id: campaignId,
        isActive: true,
        $or: [{ maxImpressions: 0 }, { $expr: { $lt: ['$impressionCount', '$maxImpressions'] } }],
      },
      { $inc: { impressionCount: 1 } },
      { new: true }
    );
    if (!ad) throw new AppError('Campaña no disponible', 404);

    await AdEvent.create({
      campaignId: ad._id,
      campaignName: ad.campaignName,
      eventType: AdEventType.IMPRESSION,
      deviceId,
      userId: userId || null,
    });
  }

  async registerClick(campaignId: string, deviceId: string, userId?: string): Promise<void> {
    const ad = await Advertisement.findByIdAndUpdate(
      campaignId,
      { $inc: { clickCount: 1 } },
      { new: true }
    );
    if (!ad) throw new AppError('Campaña no encontrada', 404);

    await AdEvent.create({
      campaignId: ad._id,
      campaignName: ad.campaignName,
      eventType: AdEventType.CLICK,
      deviceId,
      userId: userId || null,
    });
  }

  /**
   * Cancela una campaña: estado terminal, distinto de pausarla. No borra
   * nada — las estadísticas y el flyer siguen existiendo para auditar una
   * campaña ya cerrada — pero deja de poder reactivarse.
   */
  async cancel(campaignId: string): Promise<IAdvertisement> {
    const ad = await Advertisement.findById(campaignId);
    if (!ad) throw new AppError('Campaña no encontrada', 404);
    if (ad.cancelledAt) throw new AppError('La campaña ya está cancelada', 409);

    ad.cancelledAt = new Date();
    ad.isActive = false;
    await ad.save();
    return ad;
  }

  /** Impresiones/clics de una campaña: total acumulado y los de hoy. */
  async stats(campaignId: string): Promise<AdStats> {
    const ad = await Advertisement.findById(campaignId);
    if (!ad) throw new AppError('Campaña no encontrada', 404);

    const today = await this.countEventsToday({ campaignId: ad._id });
    return {
      totalImpressions: ad.impressionCount,
      totalClicks: ad.clickCount,
      todayImpressions: today.impression,
      todayClicks: today.click,
    };
  }

  /** Mismo desglose que `stats`, pero sumado sobre todas las campañas. */
  async globalStats(): Promise<AdStats> {
    const [totals] = await Advertisement.aggregate([
      {
        $group: {
          _id: null,
          impressions: { $sum: '$impressionCount' },
          clicks: { $sum: '$clickCount' },
        },
      },
    ]);

    const today = await this.countEventsToday({});
    return {
      totalImpressions: totals?.impressions ?? 0,
      totalClicks: totals?.clicks ?? 0,
      todayImpressions: today.impression,
      todayClicks: today.click,
    };
  }

  /**
   * Cuenta eventos desde el inicio del día de hoy, en la zona horaria del
   * negocio — mismo criterio que `payout.service.ts` para las semanas de
   * liquidación: agrupar en UTC movería la frontera del día varias horas.
   * `$$NOW` es la hora del servidor de Mongo, no la del proceso Node, así
   * que dos instancias de la API nunca calculan "hoy" de forma distinta.
   */
  private async countEventsToday(
    match: Record<string, unknown>
  ): Promise<{ impression: number; click: number }> {
    const { timezone } = config.settlement;
    const rows = await AdEvent.aggregate([
      {
        $match: {
          ...match,
          $expr: {
            $gte: ['$timestamp', { $dateTrunc: { date: '$$NOW', unit: 'day', timezone } }],
          },
        },
      },
      { $group: { _id: '$eventType', count: { $sum: 1 } } },
    ]);

    const result = { impression: 0, click: 0 };
    for (const row of rows) {
      if (row._id === AdEventType.IMPRESSION) result.impression = row.count;
      if (row._id === AdEventType.CLICK) result.click = row.count;
    }
    return result;
  }

  /**
   * Sube el flyer de una campaña. Las dimensiones se comprueban sobre la
   * cabecera del binario, antes de subir nada — mismo criterio que las
   * imágenes de producto, reutilizando su lector de cabeceras en vez de
   * duplicarlo.
   *
   * Regla de flyers: la app siempre los pinta a pantalla completa en 9:16
   * con `cover` (recorte proporcional de bordes, nunca deformación), así
   * que aquí solo se valida que sea una imagen real, de un tamaño razonable
   * y no demasiado pequeña — la relación de aspecto recomendada (1080×1920)
   * se advierte en el panel al elegir el archivo, no se fuerza aquí: un
   * admin puede seguir usando una imagen fuera de 9:16 a sabiendas de que
   * se recortará en el dispositivo.
   */
  async uploadFlyer(buffer: Buffer, declaredMime: string): Promise<string> {
    this.inspectFlyer(buffer, declaredMime);
    const uploaded = await this.store(buffer);
    return uploaded.url;
  }

  /**
   * Reemplaza el flyer de una campaña ya guardada, tolerante a fallos: si
   * el archivo anterior no se puede borrar de Cloudinary, la campaña se
   * queda igual de bien guardada — lo único que sobra es un archivo
   * huérfano, y eso es preferible a devolver un error por algo que a quien
   * edita la campaña ya le salió bien.
   */
  async destroyFlyer(url: string): Promise<void> {
    const publicId = this.extractPublicId(url);
    if (!publicId) return;
    await this.destroy(publicId);
  }

  private inspectFlyer(buffer: Buffer, declaredMime: string): void {
    if (!buffer?.length) {
      throw new AppError('La imagen llegó vacía', 400, AD_UPLOAD_ERROR.INVALID_FILE);
    }

    const { maxBytes, minDimension } = config.advertisements;
    if (buffer.length > maxBytes) {
      const mb = (maxBytes / (1024 * 1024)).toFixed(0);
      throw new AppError(
        `La imagen pesa más de ${mb} MB. Redúcela antes de subirla.`,
        413,
        AD_UPLOAD_ERROR.TOO_LARGE
      );
    }

    const probed = readImageHeader(buffer);
    if (!probed) {
      throw new AppError(
        'El archivo no es una imagen válida o está dañado. Usa JPG, PNG o WEBP.',
        400,
        AD_UPLOAD_ERROR.INVALID_FILE
      );
    }

    const declared = (declaredMime || '').toLowerCase();
    const expected = probed.format === 'jpg' ? 'image/jpeg' : `image/${probed.format}`;
    if (declared && declared !== expected) {
      throw new AppError(
        'El archivo no coincide con su tipo declarado',
        400,
        AD_UPLOAD_ERROR.INVALID_FILE
      );
    }

    if (probed.width < minDimension || probed.height < minDimension) {
      throw new AppError(
        `La imagen es demasiado pequeña (${probed.width}×${probed.height}). ` +
          `Necesitamos al menos ${minDimension}px de lado para que se vea nítida a pantalla completa.`,
        400,
        AD_UPLOAD_ERROR.TOO_SMALL
      );
    }
  }

  /** El público que corresponde a un flyer que ya no existe en ningún lado. */
  private extractPublicId(url: string): string | null {
    const match = url.match(/\/upload\/(?:[^/]+\/)*?(?:v\d+\/)?(.+)\.[a-zA-Z0-9]+(?:\?.*)?$/);
    return match ? match[1] : null;
  }

  /** Aislado para poder sustituirlo en pruebas sin tocar la red. */
  private store(buffer: Buffer): Promise<{ url: string }> {
    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: config.advertisements.folder, resource_type: 'image' },
        (error, result) => {
          if (error || !result) {
            reject(
              new AppError('No pudimos guardar la imagen. Inténtalo de nuevo.', 502, AD_UPLOAD_ERROR.STORAGE)
            );
            return;
          }
          resolve({ url: result.secure_url });
        }
      );
      stream.end(buffer);
    });
  }

  /** Borrado tolerante a fallos: nunca tumba la operación que lo llamó. */
  private async destroy(publicId: string): Promise<void> {
    try {
      await cloudinary.uploader.destroy(publicId, { resource_type: 'image', invalidate: true });
    } catch (error) {
      console.error('[AD_FLYER] No se pudo borrar el flyer anterior', {
        publicId,
        error: (error as Error).message,
      });
    }
  }
}

export const advertisementService = new AdvertisementService();
