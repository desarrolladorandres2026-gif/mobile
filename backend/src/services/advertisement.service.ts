import crypto from 'crypto';
import { Types } from 'mongoose';
import {
  Advertisement, IAdvertisement, AdEvent, AdEventType,
  AdInvoice, IAdInvoice, AdPricingModel, AdApprovalStatus, AdPlacement, Business,
  AdClick, AdClickRejection, AdClickSignal, HARD_CLICK_SIGNALS, AdNetworkQuota, IPlatformPricingConfig,
} from '../models';
import { AppError } from '../middlewares';
import { cloudinary, config } from '../config';
import { readImageHeader } from '../utils/imageHeader';
import { pricingConfigService } from './pricingConfig.service';
import { taxRuleService } from './taxRule.service';
import { TaxConcept } from '../models/TaxRule';

const DAY_MS = 86_400_000;

/** Una persona no lee, decide y toca un anuncio en menos de esto: es la firma de un script. */
export const MIN_HUMAN_CLICK_DELAY_MS = 500;
/** Ráfaga de red: este número de dispositivos distintos, desde la misma red, en esta ventana. */
const NETWORK_BURST_DEVICES = 5;
const NETWORK_BURST_WINDOW_MS = 10 * 60_000;
/** Herramientas de automatización que se anuncian como tales. No es una lista de bloqueo de navegadores. */
const AUTOMATION_AGENT = /(curl|wget|python-requests|python-urllib|aiohttp|httpx|go-http-client|java\/|libwww|scrapy|headless|phantomjs|puppeteer|playwright|selenium|\bbot\b|crawler|spider)/i;

/** Desfase de la zona horaria de liquidación (Colombia: sin horario de verano) respecto a UTC, en ms. */
function zoneOffsetMs(at: Date): number {
  const tz = config.settlement.timezone;
  const local = new Date(at.toLocaleString('en-US', { timeZone: tz }));
  const utc = new Date(at.toLocaleString('en-US', { timeZone: 'UTC' }));
  return local.getTime() - utc.getTime();
}

/** AAAA-MM-DD del día de `at` en la zona horaria de liquidación. */
function dayKey(at: Date): string {
  return new Date(at.getTime() + zoneOffsetMs(at)).toISOString().slice(0, 10);
}

// ── La oferta de publicidad (2026-10-17) ─────────────────────────────
//
// Qué puede comprar hoy un comercio, leído de `PlatformPricingConfig`. Es la
// única lectura de los campos `ad*`: la usan la compra, la aprobación, el
// panel del comercio (`GET /advertisements/business/:id/offer`) y el cobro de
// clics, así que una regla nueva se escribe una vez.

export interface AdModelOffer { enabled: boolean; minRate: number; maxRate: number }

export interface AdOffer {
  available: boolean;
  /** Por qué no se puede comprar, en frases para el comercio. Vacío si se puede. */
  reasons: string[];
  billingEnabled: boolean;
  models: { cpc: AdModelOffer; cpm: AdModelOffer };
  budget: { min: number; max: number };
  durationDays: { min: number; max: number };
  placements: AdPlacement[];
  /** No existe en el lanzamiento. */
  autoRenew: false;
  configVersion: number;
}

const rangeOk = (min: number, max: number) => min > 0 && max >= min;

export function adOffer(cfg: Pick<IPlatformPricingConfig,
  'version' | 'adSelfServiceEnabled' | 'adBillingEnabled' | 'adCpcEnabled' | 'adCpcMinRate' | 'adCpcMaxRate'
  | 'adCpmMinRate' | 'adCpmMaxRate' | 'adMinBudget' | 'adMaxBudget' | 'adMinDurationDays' | 'adMaxDurationDays' | 'adPlacements'>): AdOffer {
  const cpcOk = !!cfg.adCpcEnabled && rangeOk(cfg.adCpcMinRate ?? 0, cfg.adCpcMaxRate ?? 0);
  const budgetOk = rangeOk(cfg.adMinBudget ?? 0, cfg.adMaxBudget ?? 0);
  const durationOk = rangeOk(cfg.adMinDurationDays ?? 0, cfg.adMaxDurationDays ?? 0);
  const placements = (cfg.adPlacements ?? []).filter((p): p is AdPlacement =>
    (Object.values(AdPlacement) as string[]).includes(p));

  const reasons: string[] = [];
  if (!cfg.adSelfServiceEnabled) reasons.push('ZIPP todavía no ha abierto la compra de publicidad desde el panel.');
  if (!cfg.adBillingEnabled) reasons.push('La facturación de publicidad todavía no está habilitada.');
  if (!cpcOk) reasons.push('Falta que ZIPP configure la tarifa por clic.');
  if (!budgetOk) reasons.push('Falta que ZIPP configure el presupuesto mínimo y máximo por campaña.');
  if (!durationOk) reasons.push('Falta que ZIPP configure cuántos días puede durar una campaña.');
  if (placements.length === 0) reasons.push('Falta que ZIPP elija dónde puede salir la publicidad.');

  return {
    available: reasons.length === 0,
    reasons,
    billingEnabled: !!cfg.adBillingEnabled,
    models: {
      cpc: { enabled: cpcOk, minRate: cfg.adCpcMinRate ?? 0, maxRate: cfg.adCpcMaxRate ?? 0 },
      // CPM preparado y cerrado: ver `adCpmEnabled` en PlatformPricingConfig.
      cpm: { enabled: false, minRate: cfg.adCpmMinRate ?? 0, maxRate: cfg.adCpmMaxRate ?? 0 },
    },
    budget: { min: cfg.adMinBudget ?? 0, max: cfg.adMaxBudget ?? 0 },
    durationDays: { min: cfg.adMinDurationDays ?? 0, max: cfg.adMaxDurationDays ?? 0 },
    placements,
    autoRenew: false,
    configVersion: cfg.version,
  };
}

/** Días calendario que cubre la campaña (un rango de 7 días exactos son 7). */
export const campaignDays = (start: Date, end: Date) => Math.ceil((end.getTime() - start.getTime()) / DAY_MS);

/**
 * Lo que una campaña concreta incumple de la oferta. Se usa al comprar y otra
 * vez al aprobar: la oferta pudo cambiar en medio, y lo que se aprueba es lo
 * que se cobra.
 */
export function campaignProblems(
  offer: AdOffer,
  c: { pricingModel: string; cpcRate: number; cpmRate: number; budget: number; startDate: Date; endDate: Date; placement?: string | null }
): string[] {
  const problems: string[] = [];
  const model = c.pricingModel === AdPricingModel.CPC ? offer.models.cpc
    : c.pricingModel === AdPricingModel.CPM ? offer.models.cpm
      : null;
  if (!model?.enabled) {
    problems.push('Esa forma de cobro no está disponible.');
  } else {
    const rate = c.pricingModel === AdPricingModel.CPC ? c.cpcRate : c.cpmRate;
    if (rate < model.minRate || rate > model.maxRate) {
      problems.push(`La tarifa tiene que estar entre $${model.minRate.toLocaleString('es-CO')} y $${model.maxRate.toLocaleString('es-CO')}.`);
    }
  }
  if (c.budget < offer.budget.min || c.budget > offer.budget.max) {
    problems.push(`El tope tiene que estar entre $${offer.budget.min.toLocaleString('es-CO')} y $${offer.budget.max.toLocaleString('es-CO')}.`);
  }
  const days = campaignDays(c.startDate, c.endDate);
  if (days < offer.durationDays.min || days > offer.durationDays.max) {
    problems.push(`La campaña tiene que durar entre ${offer.durationDays.min} y ${offer.durationDays.max} días.`);
  }
  if (!c.placement || !offer.placements.includes(c.placement as AdPlacement)) {
    problems.push('Esa ubicación no está disponible para compra.');
  }
  return problems;
}

/**
 * Una campaña que puede servirse y contar eventos AHORA. Va dentro del filtro
 * de cada escritura: antes un clic sobre una campaña cancelada, pausada o
 * vencida seguía sumando y se facturaba al cerrar (auditoría 2026-10-17).
 */
function liveFilter(now: Date): Record<string, unknown> {
  return {
    isActive: true,
    cancelledAt: null,
    approvalStatus: AdApprovalStatus.APPROVED,
    startDate: { $lte: now },
    endDate: { $gte: now },
  };
}

/** HMAC de la IP con el secreto del servidor, igual que la aceptación legal: sirve para contar, no para identificar. */
const hashIp = (ip: string) =>
  crypto.createHmac('sha256', config.security.encryptionKey).update(`ad-click-ip:${ip}`).digest('hex').slice(0, 32);

export interface ClickResult {
  /** Se cobró este clic. */
  billable: boolean;
  rejection?: AdClickRejection;
  /** El mismo `clickId` ya había llegado: no se volvió a contar. */
  replay?: boolean;
}

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

    // Con la facturación de publicidad apagada, lo que compró un comercio no
    // sale: servirla sería regalarla o cobrar algo que ZIPP no ha habilitado.
    const cfg = await pricingConfigService.getCurrent();
    const billingFilter = cfg.adBillingEnabled ? {} : { billedToBusinessId: null };

    const candidates = await Advertisement.find({
      ...billingFilter,
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
    if (!Types.ObjectId.isValid(campaignId)) throw new AppError('Campaña no disponible', 404);
    const ad = await Advertisement.findOneAndUpdate(
      {
        _id: campaignId,
        ...liveFilter(new Date()),
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

  /**
   * Un toque sobre una campaña.
   *
   * Precio cerrado y CPM: solo analítica, con el tope atómico de siempre.
   * CPC: el clic es dinero, así que pasa por `registerBillableClick`.
   * En los dos casos la campaña tiene que estar viva (`liveFilter`).
   */
  async registerClick(
    campaignId: string,
    deviceId: string,
    opts: { userId?: string; clickId?: string; ip?: string; userAgent?: string } = {}
  ): Promise<ClickResult> {
    if (!Types.ObjectId.isValid(campaignId)) throw new AppError('Campaña no disponible', 404);
    const now = new Date();
    const ad = await Advertisement.findOne({ _id: campaignId, ...liveFilter(now) })
      .select('pricingModel cpcRate campaignName billedToBusinessId');
    if (!ad) throw new AppError('Campaña no disponible', 404);

    if (ad.pricingModel === AdPricingModel.CPC) {
      return this.registerBillableClick(ad, deviceId, opts, now);
    }

    const counted = await Advertisement.findOneAndUpdate(
      {
        _id: ad._id,
        ...liveFilter(now),
        $or: [{ maxClicks: 0 }, { $expr: { $lt: ['$clickCount', '$maxClicks'] } }],
      },
      { $inc: { clickCount: 1 } }
    );
    if (!counted) throw new AppError('Campaña no disponible', 404);
    await this.recordClickEvent(ad, deviceId, opts.userId);
    return { billable: false };
  }

  /**
   * El clic que se cobra. Cada uno deja su fila en `AdClick`, se cobre o no,
   * con el motivo de la decisión, las señales observadas y la versión de la
   * configuración con la que se decidió.
   *
   * Orden de las defensas, de la más barata a la más cara:
   *  1. `(campaignId, clickId)` único: el doble toque y el reintento no cuentan.
   *  2. `dedupeKey` único mientras es cobrable: un clic por dispositivo y
   *     ventana, atómico aunque lleguen dos a la vez. `userDedupeKey` hace lo
   *     mismo por cuenta, para que cambiar de dispositivo no abra otro clic.
   *  3. Facturación encendida (campañas de comercio).
   *  4. El dispositivo vio la campaña hace poco: un clic sin impresión es un script.
   *  5. Señales duras (clic más rápido que una persona, agente de automatización):
   *     no se cobra y queda en la cola de revisión. Las blandas solo se anotan.
   *  6. Cupo por red y día, **reservado** de forma atómica (`AdNetworkQuota`):
   *     dos clics simultáneos no pueden pasar los dos con un solo cupo.
   *  7. El tope de clics del presupuesto, dentro del `$inc`: ningún clic pasa
   *     de lo que el comercio autorizó, aunque lleguen en paralelo.
   * Si el `$inc` gana pero marcar la fila falla, la factura (que cobra por las
   * filas) cobra de menos y lo señala; nunca de más.
   *
   * La red nunca es la identidad: solo limita cuántos clics *cobrables* caben
   * desde ella. Una oficina o una antena móvil compartida sigue pudiendo ver el
   * anuncio, tocarlo y navegar; lo que no se le cobra al anunciante es el
   * exceso de ese día.
   */
  private async registerBillableClick(
    ad: Pick<IAdvertisement, '_id' | 'cpcRate' | 'campaignName' | 'billedToBusinessId'>,
    deviceId: string,
    opts: { userId?: string; clickId?: string; ip?: string; userAgent?: string },
    now: Date
  ): Promise<ClickResult> {
    // Los índices únicos de `AdClick` son el control de dinero: en un arranque
    // en frío se espera a que existan antes del primer clic (después es gratis).
    await Promise.all([AdClick.init(), AdNetworkQuota.init()]);
    const cfg = await pricingConfigService.getCurrent();
    const clickId = (opts.clickId?.trim() || crypto.randomUUID()).slice(0, 64);
    const windowMs = Math.max(1, cfg.adClickDedupeWindowMinutes ?? 1440) * 60_000;
    // La ventana se alinea al día de Colombia, no al UTC: «un clic por día» no
    // debe reiniciarse a las 7 p. m. hora local.
    const bucket = Math.floor((now.getTime() + zoneOffsetMs(now)) / windowMs);
    const dedupeKey = `${ad._id}:${deviceId}:${bucket}`;
    const userDedupeKey = opts.userId ? `${ad._id}:u:${opts.userId}:${bucket}` : undefined;
    // Sin IP conocida no hay red que contar: agrupar todo lo desconocido en un solo cupo castigaría a cualquiera.
    const ipHash = opts.ip && opts.ip !== 'unknown' ? hashIp(opts.ip) : null;
    const userAgent = (opts.userAgent ?? '').trim().slice(0, 120) || null;
    const base = {
      campaignId: ad._id,
      clickId,
      deviceId,
      userId: opts.userId || null,
      ipHash,
      rate: ad.cpcRate,
      userAgent,
      configVersion: cfg.version ?? null,
    };

    let clickRowId: Types.ObjectId;
    try {
      clickRowId = (await AdClick.create({ ...base, dedupeKey, userDedupeKey }))._id as Types.ObjectId;
    } catch (error: any) {
      if (error?.code !== 11000) throw error;
      if (error?.keyPattern?.clickId) {
        const previous = await AdClick.findOne({ campaignId: ad._id, clickId }).select('billable rejection').lean();
        return { billable: !!previous?.billable, rejection: previous?.rejection ?? undefined, replay: true };
      }
      // Ya hay un clic cobrable de este dispositivo —o de esta cuenta— en la ventana.
      const rejection = error?.keyPattern?.userDedupeKey && !error?.keyPattern?.dedupeKey
        ? AdClickRejection.DUPLICATE_USER
        : AdClickRejection.DUPLICATE_DEVICE;
      try {
        await AdClick.create({ ...base, rejection });
      } catch (again: any) {
        if (again?.code !== 11000) throw again;
        return { billable: false, rejection, replay: true };
      }
      await this.recordClickEvent(ad, deviceId, opts.userId);
      return { billable: false, rejection };
    }

    const reject = async (
      rejection: AdClickRejection,
      extra: Record<string, unknown> = {}
    ): Promise<ClickResult> => {
      // Suelta las claves: un clic rechazado no gasta la ventana del dispositivo ni de la cuenta.
      await AdClick.updateOne(
        { _id: clickRowId },
        { $set: { rejection, ...extra }, $unset: { dedupeKey: 1, userDedupeKey: 1 } }
      );
      await this.recordClickEvent(ad, deviceId, opts.userId);
      return { billable: false, rejection };
    };

    if (ad.billedToBusinessId && !cfg.adBillingEnabled) return reject(AdClickRejection.BILLING_DISABLED);

    const impressionWindowMs = Math.max(1, cfg.adClickImpressionWindowMinutes ?? 30) * 60_000;
    const lastImpression = await AdEvent.findOne({
      campaignId: ad._id,
      deviceId,
      eventType: AdEventType.IMPRESSION,
      timestamp: { $gte: new Date(now.getTime() - impressionWindowMs) },
    }).sort({ timestamp: -1 }).select('timestamp').lean();
    if (!lastImpression) return reject(AdClickRejection.NO_IMPRESSION);
    const msSinceImpression = Math.max(0, now.getTime() - new Date(lastImpression.timestamp).getTime());

    const signals = await this.clickSignals({ campaignId: ad._id, ipHash, userAgent, msSinceImpression, now, deviceId });
    const evidence = { signals, msSinceImpression };
    if (signals.some((s) => HARD_CLICK_SIGNALS.includes(s))) {
      return reject(AdClickRejection.SUSPICIOUS, { ...evidence, review: true });
    }

    const perNetwork = cfg.adMaxBillableClicksPerIpPerDay ?? 0;
    const quotaKey = ipHash ? `${ad._id}:${ipHash}:${dayKey(now)}` : null;
    if (perNetwork > 0 && quotaKey) {
      const reserved = await this.reserveNetworkSlot(ad._id, quotaKey, perNetwork, now);
      if (!reserved) return reject(AdClickRejection.IP_LIMIT, evidence);
    }
    const releaseSlot = async () => {
      if (perNetwork > 0 && quotaKey) await AdNetworkQuota.updateOne({ key: quotaKey, count: { $gt: 0 } }, { $inc: { count: -1 } });
    };

    const counted = await Advertisement.findOneAndUpdate(
      {
        _id: ad._id,
        ...liveFilter(now),
        $or: [{ maxClicks: 0 }, { $expr: { $lt: ['$clickCount', '$maxClicks'] } }],
      },
      { $inc: { clickCount: 1 } }
    );
    if (!counted) {
      await releaseSlot();
      const stillLive = await Advertisement.exists({ _id: ad._id, ...liveFilter(now) });
      return reject(stillLive ? AdClickRejection.BUDGET_EXHAUSTED : AdClickRejection.NOT_LIVE, evidence);
    }

    await AdClick.updateOne({ _id: clickRowId }, { $set: { billable: true, amount: ad.cpcRate, ...evidence } });
    await this.recordClickEvent(ad, deviceId, opts.userId);
    return { billable: true };
  }

  /**
   * Reserva un cupo de la red para hoy. `true` si había; `false` si ya estaba
   * lleno. Una sola operación condicionada: el índice único sobre `key` es lo
   * que rechaza el upsert cuando la fila existe pero `count` ya llegó al límite.
   */
  private async reserveNetworkSlot(campaignId: Types.ObjectId, key: string, limit: number, now: Date): Promise<boolean> {
    try {
      await AdNetworkQuota.findOneAndUpdate(
        { key, count: { $lt: limit } },
        {
          $inc: { count: 1 },
          $setOnInsert: { campaignId, expiresAt: new Date(now.getTime() + 3 * DAY_MS) },
        },
        { upsert: true }
      );
      return true;
    } catch (error: any) {
      if (error?.code === 11000) return false;
      throw error;
    }
  }

  /**
   * Lo que se ve de un clic más allá de las reglas de cobro. Ninguna señal usa la
   * IP como identidad de una persona: la ráfaga de red solo anota que varios
   * dispositivos distintos llegaron juntos, que es normal en una oficina y
   * sospechoso cuando son muchos en minutos.
   */
  private async clickSignals(input: {
    campaignId: Types.ObjectId;
    ipHash: string | null;
    userAgent: string | null;
    msSinceImpression: number;
    now: Date;
    deviceId: string;
  }): Promise<AdClickSignal[]> {
    const signals: AdClickSignal[] = [];
    if (input.msSinceImpression < MIN_HUMAN_CLICK_DELAY_MS) signals.push(AdClickSignal.TOO_FAST);
    if (!input.userAgent) signals.push(AdClickSignal.NO_AGENT);
    else if (AUTOMATION_AGENT.test(input.userAgent)) signals.push(AdClickSignal.AUTOMATION_AGENT);
    if (input.ipHash) {
      const devices = await AdClick.distinct('deviceId', {
        campaignId: input.campaignId,
        ipHash: input.ipHash,
        createdAt: { $gte: new Date(input.now.getTime() - NETWORK_BURST_WINDOW_MS) },
      });
      const others = devices.filter((d) => d !== input.deviceId).length;
      if (others + 1 >= NETWORK_BURST_DEVICES) signals.push(AdClickSignal.NETWORK_BURST);
    }
    return signals;
  }

  /** La traza de analítica (capped). La evidencia de cobro es `AdClick`. */
  private async recordClickEvent(ad: Pick<IAdvertisement, '_id' | 'campaignName'>, deviceId: string, userId?: string) {
    await AdEvent.create({
      campaignId: ad._id,
      campaignName: ad.campaignName,
      eventType: AdEventType.CLICK,
      deviceId,
      userId: userId || null,
    });
  }

  /**
   * Los clics de una campaña con su veredicto, para investigar.
   *
   * `verdict`: `billable` (cobrado), `rejected` (rechazado por una regla, con
   * su motivo), `review` (señal dura: espera a una persona). Sin filtro, todos.
   * El resumen cuenta por veredicto y por motivo de rechazo sobre TODA la
   * campaña, no solo la página.
   */
  async listClicks(
    campaignId: string,
    opts: { verdict?: 'billable' | 'rejected' | 'review'; page: number; limit: number }
  ) {
    if (!Types.ObjectId.isValid(campaignId)) throw new AppError('Campaña no encontrada', 404);
    const id = new Types.ObjectId(campaignId);
    const filter: Record<string, unknown> = { campaignId: id };
    if (opts.verdict === 'billable') filter.billable = true;
    if (opts.verdict === 'review') filter.review = true;
    if (opts.verdict === 'rejected') filter.rejection = { $ne: null };

    const [clicks, total, byReason] = await Promise.all([
      AdClick.find(filter)
        .sort({ createdAt: -1 })
        .skip((opts.page - 1) * opts.limit)
        .limit(opts.limit)
        .select('-dedupeKey -userDedupeKey')
        .lean(),
      AdClick.countDocuments(filter),
      AdClick.aggregate([
        { $match: { campaignId: id } },
        {
          $group: {
            _id: { billable: '$billable', rejection: '$rejection' },
            clicks: { $sum: 1 },
            amount: { $sum: '$amount' },
          },
        },
      ]),
    ]);

    const summary = { billable: 0, billedAmount: 0, rejected: 0, review: 0, byRejection: {} as Record<string, number> };
    for (const row of byReason) {
      if (row._id.billable) {
        summary.billable += row.clicks;
        summary.billedAmount += row.amount;
      } else {
        summary.rejected += row.clicks;
        const reason = row._id.rejection ?? 'unknown';
        summary.byRejection[reason] = (summary.byRejection[reason] ?? 0) + row.clicks;
      }
    }
    summary.review = await AdClick.countDocuments({ campaignId: id, review: true });
    return { clicks, total, summary };
  }

  /** Lo que ZIPP ofrece hoy a los comercios. */
  async currentOffer(): Promise<AdOffer> {
    return adOffer(await pricingConfigService.getCurrent());
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
    /** Dónde sale. Sin indicar, la primera que ofrece ZIPP. */
    placement?: AdPlacement;
    scope?: import('./businessStaff.service').SessionScope;
  }): Promise<IAdvertisement> {
    const business = await Business.findById(input.businessId).select('name city isSuspended isArchived');
    if (!business) throw new AppError('Negocio no encontrado', 404);
    const { businessStaffService } = await import('./businessStaff.service');
    const { BusinessPermission } = await import('../models');
    await businessStaffService.assertCan(
      input.ownerId,
      input.businessId,
      BusinessPermission.ADVERTISING_MANAGE,
      'Sin permisos para gestionar publicidad.',
      input.scope
    );

    if (!input.budget) {
      throw new AppError(
        'Ponle un tope de gasto: sin él estarías firmando un gasto abierto contra tu liquidación',
        400
      );
    }
    if (input.endDate <= input.startDate) {
      throw new AppError('La campaña tiene que terminar después de empezar', 400);
    }
    if (business.isSuspended || business.isArchived) {
      throw new AppError('Un negocio suspendido o archivado no puede comprar publicidad', 403);
    }

    // Las reglas de hoy, leídas de la configuración de ZIPP. Sin oferta
    // completa no se compra: no hay tarifa por defecto que adivinar.
    const cfg = await pricingConfigService.getCurrent();
    const offer = adOffer(cfg);
    if (!offer.available) throw new AppError(offer.reasons.join(' '), 409, 'AD_OFFER_UNAVAILABLE');
    const placement = input.placement ?? offer.placements[0];
    const problems = campaignProblems(offer, { ...input, placement });
    if (problems.length) throw new AppError(problems.join(' '), 422, 'AD_OUT_OF_OFFER');

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
      placement,
      adConfigVersion: cfg.version,
    });
  }

  /** Un admin mira el flyer y la deja salir. */
  async approve(campaignId: string): Promise<IAdvertisement> {
    const ad = await Advertisement.findById(campaignId);
    if (!ad) throw new AppError('Campaña no encontrada', 404);
    if (ad.cancelledAt) throw new AppError('La campaña está cancelada', 409);

    // Lo que compró un comercio se vuelve a medir contra la oferta VIGENTE:
    // aprobar es encender un cobro, y no se enciende uno que ZIPP no ofrece
    // hoy (tarifa fuera de rango, facturación apagada, ubicación cerrada).
    if (ad.billedToBusinessId) {
      if (ad.endDate.getTime() < Date.now()) throw new AppError('La campaña ya terminó: no hay nada que aprobar', 409);
      const offer = await this.currentOffer();
      if (!offer.available) {
        throw new AppError(`No se puede aprobar: ${offer.reasons.join(' ')}`, 409, 'AD_OFFER_UNAVAILABLE');
      }
      const problems = campaignProblems(offer, ad);
      if (problems.length) {
        throw new AppError(`No se puede aprobar: ${problems.join(' ')} Recházala con ese motivo para que el comercio la corrija.`, 409, 'AD_OUT_OF_OFFER');
      }
    }

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

    // CPC: se cobra por las filas de `AdClick`, que son la evidencia de cada
    // clic. Las campañas compradas con la oferta (`adConfigVersion`) se
    // facturan por evidencia y nunca por encima del presupuesto; las
    // anteriores siguen con sus contadores. Una diferencia entre contador y
    // evidencia queda marcada, no escondida.
    let amount = this.spendOf(ad);
    let verifiedClicks: number | null = null;
    let evidenceMismatch = false;
    if (ad.pricingModel === AdPricingModel.CPC) {
      const [evidence] = await AdClick.aggregate([
        { $match: { campaignId: ad._id, billable: true } },
        { $group: { _id: null, clicks: { $sum: 1 }, amount: { $sum: '$amount' } } },
      ]);
      verifiedClicks = evidence?.clicks ?? 0;
      evidenceMismatch = verifiedClicks !== ad.clickCount;
      if (ad.adConfigVersion != null) {
        amount = Math.min(evidence?.amount ?? 0, ad.budget || Number.MAX_SAFE_INTEGER);
      }
    }

    // M-014: qué dicen las reglas tributarias de la publicidad. Informativo: no
    // cambia lo que se cobra, y sin regla validada queda «pendiente».
    const assessment = await taxRuleService.assess(TaxConcept.ADVERTISING, amount);
    const taxAssessment = {
      status: assessment.status,
      ruleId: assessment.ruleId,
      treatment: assessment.treatment,
      rateBps: assessment.rateBps,
      taxIncluded: assessment.status === 'definitive' && assessment.priceIncludesTax ? assessment.taxAmount : 0,
      assessedAt: new Date(),
    };

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
        amount,
        taxAssessment,
        verifiedClicks,
        evidenceMismatch,
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
