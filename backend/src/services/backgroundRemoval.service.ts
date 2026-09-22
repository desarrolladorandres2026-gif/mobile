import crypto from 'crypto';
import { Types } from 'mongoose';
import { cloudinary, config } from '../config';
import { AppError } from '../middlewares';
import {
  Business,
  IBackgroundRemovalState,
  IProduct,
  IProductImage,
  IProductImageCutout,
  ImageProcessingEvent,
  ImageProcessingOutcome,
  Product,
} from '../models';
import { PRODUCT_IMAGE_VARIANTS, productImageUrl } from '../utils/productImageUrls';
import { readImageHeader } from '../utils/imageHeader';
import { productImageService } from './productImage.service';
import {
  BackgroundRemovalError,
  BackgroundRemovalErrorCode,
  getBackgroundRemovalProvider,
} from './imageProcessing';

/**
 * Quitar el fondo de la foto principal de un producto, fuera de la
 * petición que la sube.
 *
 * El comercio sube la foto y el panel responde enseguida con la original;
 * el recorte llega unos segundos después. El estado vive en el propio
 * producto (`imageAsset.backgroundRemoval`) y no en memoria del proceso —
 * mismo criterio que el reparto en cascada—, así que un reinicio a mitad
 * no pierde nada: el barrido encuentra el trabajo donde quedó.
 *
 * Dos garantías sostienen el resto, y las dos van dentro del filtro de la
 * escritura, nunca como "leer, comprobar y guardar":
 *
 * - **Una sola ejecución por foto.** Reservarla es un `findOneAndUpdate`
 *   que solo gana quien la encuentra pendiente. Dos procesos, o el barrido
 *   y la subida a la vez, no pagan dos veces al proveedor.
 * - **Un recorte tardío no pisa una foto nueva.** El cierre exige el mismo
 *   checksum y la misma reserva; si el comercio cambió la foto mientras
 *   tanto, el recorte viejo se descarta y se borra.
 *
 * Nada de esto toca el original: si todo falla, el producto sigue con su
 * foto de siempre.
 */

/** Intentos automáticos por foto antes de darla por fallida. */
export const MAX_ATTEMPTS = 3;
/**
 * Cuánto dura una reserva. Tiene que cubrir la descarga del original, la
 * llamada al proveedor (30 s de tope) y la subida del resultado; pasado
 * esto, el barrido asume que el proceso murió y la retoma.
 */
export const CLAIM_LEASE_MS = 3 * 60_000;
/** Tope para bajar el original de Cloudinary. */
const DOWNLOAD_TIMEOUT_MS = 15_000;
/** Cuántas fotos atiende el barrido por pasada: cada una es una llamada que se paga. */
const SWEEP_BATCH = 5;

/** Colombia no tiene horario de verano: el día empieza siempre a las 05:00 UTC. */
const BOGOTA_OFFSET_MS = 5 * 60 * 60_000;

export function startOfBogotaDay(now = new Date()): Date {
  const local = new Date(now.getTime() - BOGOTA_OFFSET_MS);
  return new Date(
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) + BOGOTA_OFFSET_MS
  );
}

/**
 * Cuánto esperar antes del siguiente intento automático.
 *
 * Aquí se decide el equilibrio entre créditos y paciencia. Un fallo del
 * proveedor casi nunca se arregla en un segundo, y cada reintento que
 * llega a responder se paga; esperar de más, en cambio, deja al comercio
 * mirando "Mejorando imagen…".
 *
 * - Si el proveedor dijo cuánto esperar (`Retry-After` en un 429), manda
 *   él, con un techo de 5 min para no dejar la foto colgada.
 * - Si no, 30 s y luego 2 min: dos oportunidades dentro de lo que alguien
 *   tarda en terminar de editar el producto.
 */
export function retryDelayMs(attempt: number, error: BackgroundRemovalError): number {
  const CEILING_MS = 5 * 60_000;
  if (error.retryAfterMs !== null) return Math.min(Math.max(error.retryAfterMs, 1_000), CEILING_MS);
  return attempt <= 1 ? 30_000 : 2 * 60_000;
}

type RequestSource = 'upload' | 'retry';

interface DownloadedOriginal {
  buffer: Buffer;
  mimetype: string;
}

export class BackgroundRemovalService {
  /**
   * Si una petición dispara el trabajo en el acto. En pruebas no: cada
   * caso llama a `run` cuando le toca, y un disparo suelto en segundo
   * plano competiría con él por la misma reserva.
   */
  autoRun = !config.isTest;

  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  get isAvailable(): boolean {
    return productImageService.backgroundRemovalAvailable;
  }

  /**
   * Tras subir una foto con la casilla marcada: la encola si todavía no
   * tiene recorte en curso ni terminado. Volver a subir la misma foto no
   * vuelve a cobrarse.
   */
  async requestIfNeeded(product: IProduct): Promise<IProduct> {
    const status = product.imageAsset?.backgroundRemoval?.status ?? 'none';
    if (status !== 'none' && status !== 'failed') return product;
    if (!this.isAvailable) return product;
    return this.request(product, 'upload');
  }

  /**
   * Encola el recorte de la foto principal.
   *
   * Desde "Reintentar" o "Quitar el fondo" se permite siempre, incluso si
   * ya hay un recorte terminado: es una petición explícita del comercio.
   * Si ya hay uno en curso, no se encola otro.
   */
  async request(product: IProduct, source: RequestSource = 'retry'): Promise<IProduct> {
    const asset = product.imageAsset;
    if (!asset) {
      throw new AppError('Este producto no tiene imagen', 404, 'PRODUCT_IMAGE_MISSING');
    }
    const provider = getBackgroundRemovalProvider();
    if (!provider || !this.isAvailable) {
      throw new AppError(
        'Quitar el fondo no está disponible en este momento',
        503,
        'BACKGROUND_REMOVAL_NOT_CONFIGURED'
      );
    }

    const status = asset.backgroundRemoval?.status;
    if (status === 'pending' || status === 'processing') return product;

    const now = new Date();
    const businessId = product.businessId;

    // El tope se mira antes de encolar y no al ejecutar: pasado el tope la
    // foto no llega a ponerse en cola, y el panel lo sabe en la misma
    // respuesta. Cuenta lo ya cobrado hoy **y lo que está en cola**: si no,
    // treinta subidas seguidas quedarían todas pendientes y pasarían el
    // tope juntas antes de que se cobrara la primera. Sigue siendo un tope
    // blando —dos peticiones en el mismo milisegundo pueden pasar las dos—,
    // acotado por el limitador de subidas.
    const [billedToday, inFlight] = await Promise.all([
      ImageProcessingEvent.countDocuments({
        businessId,
        billable: true,
        createdAt: { $gte: startOfBogotaDay(now) },
      }),
      Product.countDocuments({
        businessId,
        'imageAsset.backgroundRemoval.status': { $in: ['pending', 'processing'] },
      }),
    ]);
    const overLimit = billedToday + inFlight >= config.backgroundRemoval.dailyLimitPerBusiness;

    const state: IBackgroundRemovalState = overLimit
      ? {
          status: 'failed',
          provider: provider.name,
          attempts: 0,
          errorCode: 'DAILY_LIMIT',
          claimId: null,
          requestedAt: now,
          startedAt: null,
          finishedAt: now,
          nextAttemptAt: null,
          durationMs: null,
        }
      : {
          status: 'pending',
          provider: provider.name,
          attempts: 0,
          errorCode: null,
          claimId: null,
          requestedAt: now,
          startedAt: null,
          finishedAt: null,
          nextAttemptAt: now,
          durationMs: null,
        };

    const updated = await Product.findOneAndUpdate(
      {
        _id: product._id,
        'imageAsset.checksum': asset.checksum,
        'imageAsset.backgroundRemoval.status': { $nin: ['pending', 'processing'] },
      },
      {
        $set: {
          'imageAsset.backgroundRemoval': state,
          // Pedirlo de nuevo es pedir verlo: si el comercio había vuelto a
          // la original, el recorte nuevo se muestra al terminar.
          ...(source === 'retry' && !overLimit ? { 'imageAsset.useOriginal': false } : {}),
        },
      },
      { new: true }
    );

    if (!updated) {
      // Otro proceso lo encoló o la foto cambió entre medias: lo que haya
      // ahora es la verdad.
      return (await Product.findById(product._id)) ?? product;
    }

    if (overLimit) {
      await this.record(updated, provider.name, 'limited', { errorCode: 'DAILY_LIMIT' });
    } else {
      this.kick(updated._id.toString());
    }
    return updated;
  }

  /** Arranca el trabajo sin esperar por él; los errores se registran y ya. */
  kick(productId: string): void {
    if (!this.autoRun) return;
    setImmediate(() => {
      this.run(productId).catch((error) =>
        console.error('[IMAGE_BG] Falló un recorte en segundo plano', {
          productId,
          error: error instanceof Error ? error.message : String(error),
        })
      );
    });
  }

  /**
   * Ejecuta el recorte de un producto si le toca.
   *
   * Reserva, baja el original, llama al proveedor, guarda el resultado y
   * cierra. Cualquier paso puede fallar sin dejar al producto a medias:
   * la foto que se ve es la original hasta que el cierre la cambia.
   */
  async run(productId: string): Promise<void> {
    const provider = getBackgroundRemovalProvider();
    const now = new Date();
    const claimId = crypto.randomUUID();

    const claimed = await Product.findOneAndUpdate(
      {
        _id: productId,
        'imageAsset.backgroundRemoval.status': { $in: ['pending', 'processing'] },
        'imageAsset.backgroundRemoval.nextAttemptAt': { $lte: now },
      },
      {
        $set: {
          'imageAsset.backgroundRemoval.status': 'processing',
          'imageAsset.backgroundRemoval.claimId': claimId,
          'imageAsset.backgroundRemoval.startedAt': now,
          'imageAsset.backgroundRemoval.nextAttemptAt': new Date(now.getTime() + CLAIM_LEASE_MS),
          ...(provider ? { 'imageAsset.backgroundRemoval.provider': provider.name } : {}),
        },
        $inc: { 'imageAsset.backgroundRemoval.attempts': 1 },
      },
      { new: true }
    );

    const asset = claimed?.imageAsset;
    const state = asset?.backgroundRemoval;
    if (!claimed || !asset || !state) return;

    const providerName = provider?.name ?? state.provider ?? 'unknown';

    if (!provider || !provider.isConfigured() || !productImageService.isConfigured) {
      await this.fail(claimed, claimId, providerName, new BackgroundRemovalError('NOT_CONFIGURED'), 0);
      return;
    }
    // Una reserva que caducó demasiadas veces: el proceso murió a mitad una
    // y otra vez. Se deja de insistir.
    if (state.attempts > MAX_ATTEMPTS) {
      await this.fail(
        claimed,
        claimId,
        providerName,
        new BackgroundRemovalError('PROVIDER_ERROR', { message: 'INTERRUPTED' }),
        0,
        'INTERRUPTED'
      );
      return;
    }

    const started = Date.now();
    let original: DownloadedOriginal;
    try {
      original = await this.downloadOriginal(asset);
    } catch (error) {
      await this.fail(claimed, claimId, providerName, this.wrap('SOURCE_UNAVAILABLE', error, false), Date.now() - started);
      return;
    }

    let output: Awaited<ReturnType<typeof provider.removeBackground>>;
    try {
      output = await provider.removeBackground(original);
    } catch (error) {
      const removalError =
        error instanceof BackgroundRemovalError ? error : this.wrap('PROVIDER_ERROR', error, false);
      await this.fail(claimed, claimId, providerName, removalError, Date.now() - started);
      return;
    }

    let cutout: IProductImageCutout;
    try {
      cutout = await productImageService.storeCutout({
        buffer: output.buffer,
        businessId: claimed.businessId.toString(),
        productId,
        checksum: asset.checksum,
        provider: provider.name,
      });
    } catch (error) {
      // El proveedor ya cobró: el reintento costará otro crédito, pero sin
      // guardar el resultado no hay recorte que enseñar.
      await this.fail(claimed, claimId, providerName, this.wrap('STORAGE_FAILED', error, true), Date.now() - started);
      return;
    }

    const durationMs = Date.now() - started;
    const finished = await this.finalize(productId, asset.checksum, claimId, cutout, durationMs);

    if (!finished) {
      // La foto cambió mientras se recortaba: este recorte ya no es de nadie.
      await productImageService.release(productId, [cutout.publicId]);
      await this.record(claimed, providerName, 'superseded', { durationMs, billable: true, attempt: state.attempts });
      return;
    }

    await this.record(claimed, providerName, 'completed', { durationMs, billable: true, attempt: state.attempts });
  }

  /**
   * Apunta el producto al recorte, solo si sigue siendo la misma foto y la
   * misma reserva.
   *
   * `image` (la URL que leen las apps viejas) depende de "Mejorar" y de
   * "Usar imagen original", así que esos dos también van en el filtro: si
   * el comercio los cambió en este instante, se vuelve a calcular.
   */
  private async finalize(
    productId: string,
    checksum: string,
    claimId: string,
    cutout: IProductImageCutout,
    durationMs: number
  ): Promise<IProduct | null> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await Product.findOne({
        _id: productId,
        'imageAsset.checksum': checksum,
        'imageAsset.backgroundRemoval.claimId': claimId,
      }).lean();
      const asset = current?.imageAsset;
      if (!asset?.backgroundRemoval) return null;

      const finishedAt = new Date();
      const nextAsset = {
        ...asset,
        cutout,
        backgroundRemoval: { ...asset.backgroundRemoval, status: 'completed' as const },
      };

      const updated = await Product.findOneAndUpdate(
        {
          _id: productId,
          'imageAsset.checksum': checksum,
          'imageAsset.backgroundRemoval.claimId': claimId,
          'imageAsset.enhanced': asset.enhanced,
          'imageAsset.useOriginal': asset.useOriginal ? true : { $ne: true },
        },
        {
          $set: {
            'imageAsset.cutout': cutout,
            'imageAsset.backgroundRemoval.status': 'completed',
            'imageAsset.backgroundRemoval.errorCode': null,
            'imageAsset.backgroundRemoval.claimId': null,
            'imageAsset.backgroundRemoval.finishedAt': finishedAt,
            'imageAsset.backgroundRemoval.nextAttemptAt': null,
            'imageAsset.backgroundRemoval.durationMs': durationMs,
            image: productImageUrl(nextAsset, PRODUCT_IMAGE_VARIANTS.catalog),
          },
        },
        { new: true }
      );
      if (updated) return updated;
    }
    return null;
  }

  /**
   * Registra un fallo y decide si se reintenta.
   *
   * Reintentable y con intentos de sobra: vuelve a `pending` con fecha
   * para el barrido. Si no, `failed`, y la foto que se ve sigue siendo la
   * original — que es lo que el panel le dice al comercio.
   */
  private async fail(
    product: IProduct,
    claimId: string,
    providerName: string,
    error: BackgroundRemovalError,
    durationMs: number,
    errorCode: string = error.code
  ): Promise<void> {
    const attempt = product.imageAsset?.backgroundRemoval?.attempts ?? 1;
    const retry = error.retryable && attempt < MAX_ATTEMPTS;
    const now = new Date();

    const set: Record<string, unknown> = retry
      ? {
          'imageAsset.backgroundRemoval.status': 'pending',
          'imageAsset.backgroundRemoval.nextAttemptAt': new Date(now.getTime() + retryDelayMs(attempt, error)),
        }
      : {
          'imageAsset.backgroundRemoval.status': 'failed',
          'imageAsset.backgroundRemoval.nextAttemptAt': null,
          'imageAsset.backgroundRemoval.finishedAt': now,
        };

    await Product.updateOne(
      {
        _id: product._id,
        'imageAsset.checksum': product.imageAsset?.checksum,
        'imageAsset.backgroundRemoval.claimId': claimId,
      },
      {
        $set: {
          ...set,
          'imageAsset.backgroundRemoval.errorCode': errorCode,
          'imageAsset.backgroundRemoval.claimId': null,
          'imageAsset.backgroundRemoval.durationMs': durationMs || null,
        },
      }
    );

    await this.record(product, providerName, retry ? 'retry_scheduled' : 'failed', {
      errorCode,
      durationMs: durationMs || null,
      billable: error.billable,
      attempt,
    });
  }

  /** Un error ajeno al proveedor (descarga, Cloudinary): se reintenta. */
  private wrap(code: BackgroundRemovalErrorCode, error: unknown, billable: boolean): BackgroundRemovalError {
    console.error(`[IMAGE_BG] ${code}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return new BackgroundRemovalError(code, { retryable: true, billable });
  }

  /**
   * El original tal como quedó guardado en Cloudinary.
   *
   * Se baja de allí y no se guarda en memoria desde la subida: así un
   * reintento, o un proceso que arrancó después de un reinicio, parte del
   * mismo archivo que se está mostrando.
   */
  async downloadOriginal(asset: IProductImage): Promise<DownloadedOriginal> {
    const url = cloudinary.url(asset.publicId, {
      secure: true,
      resource_type: 'image',
      format: asset.format,
    });
    const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`SOURCE_UNAVAILABLE (HTTP ${res.status})`);

    const buffer = Buffer.from(await res.arrayBuffer());
    if (!buffer.length || buffer.length > config.productImages.maxBytes) {
      throw new Error('SOURCE_UNAVAILABLE (tamaño)');
    }
    const header = readImageHeader(buffer);
    if (!header) throw new Error('SOURCE_UNAVAILABLE (no es una imagen)');
    const mimetype = header.format === 'jpg' ? 'image/jpeg' : `image/${header.format}`;
    return { buffer, mimetype };
  }

  /** Nunca lanza: una métrica que no se guarda no puede tumbar el recorte. */
  private async record(
    product: IProduct,
    provider: string,
    outcome: ImageProcessingOutcome,
    details: { errorCode?: string | null; durationMs?: number | null; billable?: boolean; attempt?: number } = {}
  ): Promise<void> {
    try {
      await ImageProcessingEvent.create({
        businessId: product.businessId,
        productId: product._id,
        provider,
        outcome,
        errorCode: details.errorCode ?? null,
        durationMs: details.durationMs ?? null,
        attempt: details.attempt ?? product.imageAsset?.backgroundRemoval?.attempts ?? 0,
        billable: details.billable ?? false,
      });
    } catch (error) {
      console.error('[IMAGE_BG] No se pudo registrar la métrica', {
        outcome,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ── Barrido ──────────────────────────────────────────────────────────

  /**
   * Retoma lo que quedó a medias: reintentos que ya vencieron y reservas
   * de procesos que murieron. `run` vuelve a reservar cada una, así que el
   * barrido y un disparo directo nunca procesan dos veces la misma foto.
   */
  async sweep(now = new Date()): Promise<number> {
    const due = await Product.find({
      'imageAsset.backgroundRemoval.nextAttemptAt': { $type: 'date', $lte: now },
      'imageAsset.backgroundRemoval.status': { $in: ['pending', 'processing'] },
    })
      .select('_id')
      .sort({ 'imageAsset.backgroundRemoval.nextAttemptAt': 1 })
      .limit(SWEEP_BATCH)
      .lean();

    for (const row of due) {
      try {
        await this.run(String(row._id));
      } catch (error) {
        console.error('[IMAGE_BG] El barrido no pudo procesar una foto', {
          productId: String(row._id),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return due.length;
  }

  startSweeper(intervalMs = 30_000): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      this.sweep().catch((error) =>
        console.error('[IMAGE_BG] Falló el barrido de recortes:', error)
      );
    }, intervalMs);
    // Que un temporizador de fondo no impida cerrar el proceso.
    this.sweepTimer.unref?.();
  }

  stopSweeper(): void {
    if (!this.sweepTimer) return;
    clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  // ── Métricas ─────────────────────────────────────────────────────────

  /**
   * Cuántas fotos se procesaron, cómo salieron y cuánto tardaron.
   *
   * `billable` es lo que hay que cuadrar contra la factura del proveedor:
   * cada recorte terminado, descartado o inválido se pagó.
   */
  async stats(range: { from: Date; to: Date }) {
    const match = { createdAt: { $gte: range.from, $lt: range.to } };

    const [byOutcome, byProvider, durations, byBusiness] = await Promise.all([
      ImageProcessingEvent.aggregate<{ _id: ImageProcessingOutcome; count: number }>([
        { $match: match },
        { $group: { _id: '$outcome', count: { $sum: 1 } } },
      ]),
      ImageProcessingEvent.aggregate<{
        _id: string;
        completed: number;
        failed: number;
        billable: number;
      }>([
        { $match: match },
        {
          $group: {
            _id: '$provider',
            completed: { $sum: { $cond: [{ $eq: ['$outcome', 'completed'] }, 1, 0] } },
            failed: { $sum: { $cond: [{ $eq: ['$outcome', 'failed'] }, 1, 0] } },
            billable: { $sum: { $cond: ['$billable', 1, 0] } },
          },
        },
        { $sort: { billable: -1 } },
      ]),
      ImageProcessingEvent.find({ ...match, outcome: 'completed', durationMs: { $ne: null } })
        .select('durationMs')
        .sort({ durationMs: 1 })
        .limit(20_000)
        .lean(),
      ImageProcessingEvent.aggregate<{
        _id: Types.ObjectId;
        completed: number;
        failed: number;
        billable: number;
      }>([
        { $match: match },
        {
          $group: {
            _id: '$businessId',
            completed: { $sum: { $cond: [{ $eq: ['$outcome', 'completed'] }, 1, 0] } },
            failed: { $sum: { $cond: [{ $eq: ['$outcome', 'failed'] }, 1, 0] } },
            billable: { $sum: { $cond: ['$billable', 1, 0] } },
          },
        },
        { $sort: { billable: -1 } },
        { $limit: 10 },
      ]),
    ]);

    const outcomes = Object.fromEntries(byOutcome.map((row) => [row._id, row.count])) as Partial<
      Record<ImageProcessingOutcome, number>
    >;
    const values = durations.map((row) => row.durationMs as number);
    const average = values.length
      ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
      : null;
    const p95 = values.length ? values[Math.min(values.length - 1, Math.ceil(values.length * 0.95) - 1)] : null;

    const names = await Business.find({ _id: { $in: byBusiness.map((row) => row._id) } })
      .select('name')
      .lean();
    const nameOf = new Map(names.map((business) => [String(business._id), business.name]));

    return {
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      totals: {
        completed: outcomes.completed ?? 0,
        failed: outcomes.failed ?? 0,
        retriesScheduled: outcomes.retry_scheduled ?? 0,
        superseded: outcomes.superseded ?? 0,
        limited: outcomes.limited ?? 0,
        billable: byProvider.reduce((sum, row) => sum + row.billable, 0),
      },
      durationMs: { average, p95 },
      byProvider: byProvider.map((row) => ({
        provider: row._id,
        completed: row.completed,
        failed: row.failed,
        billable: row.billable,
      })),
      topBusinesses: byBusiness.map((row) => ({
        businessId: String(row._id),
        name: nameOf.get(String(row._id)) ?? null,
        completed: row.completed,
        failed: row.failed,
        billable: row.billable,
      })),
    };
  }
}

export const backgroundRemovalService = new BackgroundRemovalService();

export function startBackgroundRemovalSweeper(): void {
  backgroundRemovalService.startSweeper();
}

export function stopBackgroundRemovalSweeper(): void {
  backgroundRemovalService.stopSweeper();
}
