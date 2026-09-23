import { Types } from 'mongoose';
import {
  Advertisement, IAdvertisement, AdEvent, AdEventType,
  AdInvoice, IAdInvoice, AdPricingModel, AdApprovalStatus, AdPlacement, Business,
} from '../models';
import { AppError } from '../middlewares';
import { cloudinary, config } from '../config';
import { readImageHeader } from '../utils/imageHeader';

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

/** Quién está mirando. Todo opcional: un visitante sin sesión también ve. */
export interface AdViewer {
  city?: string;
  role?: string;
  /** Id de dispositivo o de usuario, para el límite por persona. */
  deviceId?: string;
}

export class AdvertisementService {
  /**
   * La primera campaña que esta persona no ha visto demasiadas veces.
   *
   * Sin este filtro, el anunciante paga por impresiones que no amplían su
   * alcance: quince impresiones al mismo usuario son quince cobros por un
   * alcance de uno, y para el usuario son quince veces el mismo cartel.
   *
   * Solo se consulta cuando la campaña declara un tope por persona, así que
   * el caso normal no paga ninguna lectura extra.
   */
  private async firstUnseen(
    candidates: IAdvertisement[],
    viewer: AdViewer
  ): Promise<IAdvertisement | undefined> {
    for (const ad of candidates) {
      if (!ad.maxImpressionsPerUser || !viewer.deviceId) return ad;

      const seen = await AdEvent.countDocuments({
        campaignId: ad._id,
        deviceId: viewer.deviceId,
        eventType: 'impression',
      });

      if (seen < ad.maxImpressionsPerUser) return ad;
    }

    return undefined;
  }

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
   *
   * `placement` filtra la superficie. Para `SPLASH` también acepta los
   * documentos que todavía no tienen el campo escrito en Atlas (nacieron
   * antes de que existiera `placement`): sin ese respaldo, desplegar este
   * cambio antes de correr la migración 009 haría desaparecer de golpe
   * todas las campañas de siempre. `EXPLORE` no lo necesita — ninguna
   * campaña nace con esa superficie hasta que este cambio existe.
   */
  async getActiveForApp(
    viewer: AdViewer = {},
    placement: AdPlacement = AdPlacement.SPLASH
  ): Promise<PublicAd | null> {
    const now = new Date();

    // El segmento viaja dentro de la consulta y no se filtra después: una
    // lista vacía significa "a todos", así que cada condición acepta tanto
    // la coincidencia como la ausencia de restricción.
    const targeting: Record<string, unknown>[] = [];
    if (viewer.city) {
      targeting.push({ $or: [{ targetCities: { $size: 0 } }, { targetCities: viewer.city }] });
    }
    if (viewer.role) {
      targeting.push({ $or: [{ targetRoles: { $size: 0 } }, { targetRoles: viewer.role }] });
    }

    const placementFilter = placement === AdPlacement.SPLASH
      ? { $or: [{ placement: AdPlacement.SPLASH }, { placement: { $exists: false } }] }
      : { placement };

    const candidates = await Advertisement.find({
      isActive: true,
      cancelledAt: null,
      // Una campaña que compró un comercio y nadie ha mirado todavía no
      // sale en la app. Las que crea un admin nacen aprobadas, así que
      // esto no cambia nada para ellas.
      approvalStatus: AdApprovalStatus.APPROVED,
      startDate: { $lte: now },
      endDate: { $gte: now },
      flyerUrl: { $ne: '' },
      ...placementFilter,
      ...(targeting.length ? { $and: targeting } : {}),
    }).sort({ priority: -1, impressionCount: 1, createdAt: -1 });

    // ── Reparto entre empatados ──
    //
    // El desempate ya no es por fecha sino por impresiones servidas: con
    // dos campañas de la misma prioridad, la de menos impresiones va
    // primero. Antes la más nueva se llevaba todo el tráfico hasta agotar
    // su tope, y la otra no se veía hasta entonces — que es exactamente lo
    // que un anunciante no espera al pagar por el mismo espacio.
    const withinGlobalCap = candidates.filter(
      (ad) => ad.maxImpressions === 0 || ad.impressionCount < ad.maxImpressions
    );

    const eligible = await this.firstUnseen(withinGlobalCap, viewer);
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
    // El tope viaja dentro de la escritura, igual que en las impresiones.
    // Antes esto era un `findByIdAndUpdate` sin condición ninguna: una
    // campaña con el tope de impresiones agotado seguía cobrando clics sin
    // límite, y con CPC eso es gasto puro por encima del presupuesto.
    const ad = await Advertisement.findOneAndUpdate(
      {
        _id: campaignId,
        $or: [{ maxClicks: 0 }, { $expr: { $lt: ['$clickCount', '$maxClicks'] } }],
      },
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
  // ── Compra self-service y facturación ─────────────────────────────

  /**
   * Lo que lleva gastado una campaña.
   *
   * Se **calcula**, no se acumula. Sumar `cpmRate / 1000` en cada impresión
   * redondearía mil veces y el error crecería con el éxito de la campaña.
   * Con los mismos contadores y las mismas tarifas, esto siempre da lo
   * mismo — que es lo que hace falta cuando un anunciante discute la
   * factura tres meses después.
   */
  spendOf(ad: Pick<IAdvertisement, 'pricingModel' | 'cpmRate' | 'cpcRate' | 'impressionCount' | 'clickCount' | 'pricePaid'>): number {
    if (ad.pricingModel === AdPricingModel.CPM) {
      return Math.round((ad.impressionCount * ad.cpmRate) / 1000);
    }
    if (ad.pricingModel === AdPricingModel.CPC) {
      return ad.clickCount * ad.cpcRate;
    }
    return ad.pricePaid;
  }

  /**
   * Convierte el presupuesto en un tope de eventos.
   *
   * Es la pieza que hace que el presupuesto se respete **sin una carrera
   * nueva**: en vez de comprobar el gasto después de cada impresión —y
   * pasarse mientras dos peticiones simultáneas leen el mismo contador—,
   * el dinero se traduce una sola vez a "cuántas impresiones caben" y el
   * tope atómico que ya existía hace el resto.
   */
  private capsFor(input: {
    pricingModel: AdPricingModel;
    cpmRate: number;
    cpcRate: number;
    budget: number;
  }): { maxImpressions: number; maxClicks: number } {
    if (!input.budget) return { maxImpressions: 0, maxClicks: 0 };

    if (input.pricingModel === AdPricingModel.CPM && input.cpmRate > 0) {
      return {
        maxImpressions: Math.floor((input.budget * 1000) / input.cpmRate),
        maxClicks: 0,
      };
    }
    if (input.pricingModel === AdPricingModel.CPC && input.cpcRate > 0) {
      return { maxImpressions: 0, maxClicks: Math.floor(input.budget / input.cpcRate) };
    }
    return { maxImpressions: 0, maxClicks: 0 };
  }

  /**
   * Un comercio compra publicidad desde su propio panel.
   *
   * Nace **pendiente de revisión**: un comercio no puede publicar en la app
   * de ZIPP sin que alguien mire lo que va a salir. Y nace apuntando a sí
   * mismo — dejar que eligiera el destino del toque permitiría pagar por
   * mandar tráfico a un tercero, o a ninguna parte.
   */
  async requestFromBusiness(input: {
    ownerId: string;
    businessId: string;
    campaignName: string;
    flyerUrl: string;
    startDate: Date;
    endDate: Date;
    pricingModel: AdPricingModel.CPM | AdPricingModel.CPC;
    cpmRate: number;
    cpcRate: number;
    budget: number;
    targetCities?: string[];
  }): Promise<IAdvertisement> {
    const business = await Business.findById(input.businessId).select('name ownerId city');
    if (!business) throw new AppError('Negocio no encontrado', 404);
    if (business.ownerId.toString() !== input.ownerId) {
      throw new AppError('No puedes comprar publicidad para otro negocio', 403);
    }

    if (!input.budget) {
      throw new AppError(
        'Ponle un tope de gasto: sin él estarías firmando un gasto abierto contra tu liquidación',
        400
      );
    }
    if (input.endDate <= input.startDate) {
      throw new AppError('La campaña tiene que terminar después de empezar', 400);
    }

    const caps = this.capsFor(input);
    if (!caps.maxImpressions && !caps.maxClicks) {
      throw new AppError('Con esa tarifa el presupuesto no alcanza para nada', 400);
    }

    return Advertisement.create({
      campaignName: input.campaignName,
      advertiserName: business.name,
      flyerUrl: input.flyerUrl,
      startDate: input.startDate,
      endDate: input.endDate,
      // Apagada hasta que se apruebe. Un `approvalStatus` pendiente ya la
      // deja fuera del servicio, pero dejarla además encendida haría que
      // aprobarla fuera lo único que la separa de la app: dos puertas para
      // un mismo permiso son una puerta que alguien va a olvidar cerrar.
      isActive: false,
      approvalStatus: AdApprovalStatus.PENDING,
      actionType: 'business',
      businessId: input.businessId,
      billedToBusinessId: input.businessId,
      pricingModel: input.pricingModel,
      cpmRate: input.cpmRate,
      cpcRate: input.cpcRate,
      budget: input.budget,
      maxImpressions: caps.maxImpressions,
      maxClicks: caps.maxClicks,
      targetCities: input.targetCities ?? [],
    });
  }

  /** Un admin mira el flyer y la deja salir. */
  async approve(campaignId: string): Promise<IAdvertisement> {
    const ad = await Advertisement.findById(campaignId);
    if (!ad) throw new AppError('Campaña no encontrada', 404);
    if (ad.cancelledAt) throw new AppError('La campaña está cancelada', 409);

    ad.approvalStatus = AdApprovalStatus.APPROVED;
    ad.rejectionReason = '';
    ad.isActive = true;
    await ad.save();
    return ad;
  }

  /**
   * Se rechaza con motivo, siempre.
   *
   * Un rechazo sin explicación obliga al comercio a adivinar qué cambiar, y
   * lo normal es que reenvíe lo mismo. El motivo es lo que convierte un "no"
   * en algo que se puede corregir.
   */
  async reject(campaignId: string, reason: string): Promise<IAdvertisement> {
    if (!reason?.trim()) throw new AppError('Dile por qué, o va a reenviar lo mismo', 400);

    const ad = await Advertisement.findById(campaignId);
    if (!ad) throw new AppError('Campaña no encontrada', 404);

    ad.approvalStatus = AdApprovalStatus.REJECTED;
    ad.rejectionReason = reason.trim();
    ad.isActive = false;
    await ad.save();
    return ad;
  }

  /**
   * Cierra la campaña y emite su factura.
   *
   * Los contadores se congelan aquí: la factura guarda impresiones, clics y
   * tarifas del momento del cierre, así que sigue siendo reproducible
   * aunque mañana cambien las tarifas o alguien reactive la campaña.
   *
   * El índice único por campaña hace la operación idempotente sin una
   * comprobación que alguien pueda olvidar reproducir en otro sitio.
   */
  async closeAndInvoice(campaignId: string): Promise<IAdInvoice> {
    const ad = await Advertisement.findById(campaignId);
    if (!ad) throw new AppError('Campaña no encontrada', 404);

    const existing = await AdInvoice.findOne({ campaignId: ad._id });
    if (existing) return existing;

    ad.isActive = false;
    await ad.save();

    try {
      return await AdInvoice.create({
        campaignId: ad._id,
        campaignName: ad.campaignName,
        businessId: ad.billedToBusinessId ?? null,
        advertiserName: ad.advertiserName,
        pricingModel: ad.pricingModel,
        cpmRate: ad.cpmRate,
        cpcRate: ad.cpcRate,
        impressions: ad.impressionCount,
        clicks: ad.clickCount,
        amount: this.spendOf(ad),
        periodStart: ad.startDate,
        periodEnd: new Date(),
        // Solo lo que compró un comercio se descuenta de su liquidación.
        // Lo que vendió el equipo comercial se cobra por fuera y aquí solo
        // queda constancia.
        settledAgainstPayout: Boolean(ad.billedToBusinessId),
      });
    } catch (error: any) {
      // Otro cierre simultáneo ganó la carrera: su factura es tan válida
      // como la que este proceso iba a escribir.
      if (error?.code === 11000) {
        const raced = await AdInvoice.findOne({ campaignId: ad._id });
        if (raced) return raced;
      }
      throw error;
    }
  }

  /** Lo que un comercio debe por publicidad y todavía no se le ha descontado. */
  async outstandingForBusiness(businessId: string): Promise<number> {
    const rows = await AdInvoice.aggregate([
      {
        $match: {
          businessId: new Types.ObjectId(businessId),
          settledAgainstPayout: true,
          settledAt: null,
        },
      },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);
    return rows[0]?.total ?? 0;
  }

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
