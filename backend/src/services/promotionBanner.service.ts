import { PromotionBanner, IPromotionBanner, BannerActionType, BannerPlacement, Business } from '../models';
import { AppError } from '../middlewares';
import { cloudinary } from '../config';

export type BannerStatus = 'active' | 'scheduled' | 'expired' | 'inactive';

/**
 * Lo único que la app recibe.
 *
 * Sin fechas, sin prioridad, sin `isActive`: si un banner llegó hasta aquí
 * es porque el servidor ya decidió que se muestra, y el orden del arreglo
 * ya es el orden de aparición. La app no tiene con qué —ni por qué—
 * re-evaluar esa decisión.
 */
export interface PublicBanner {
  id: string;
  imageUrl: string;
  title: string;
  description: string;
  buttonText: string;
  actionType: BannerActionType;
  actionValue: string;
  durationSeconds: number;
}

export class PromotionBannerService {
  /** Etiqueta de ciclo de vida para el panel. Nunca se persiste: se deriva de `now`. */
  status(
    banner: Pick<IPromotionBanner, 'isActive' | 'startDate' | 'endDate'>,
    now: Date = new Date()
  ): BannerStatus {
    if (!banner.isActive) return 'inactive';
    if (now < banner.startDate) return 'scheduled';
    if (now > banner.endDate) return 'expired';
    return 'active';
  }

  /**
   * Los banners que la app debe pintar, ya ordenados.
   *
   * Cada condición se vuelve a comprobar aquí sin importar lo que el panel
   * mostró la última vez: un banner vencido hace un minuto deja de salir en
   * la siguiente consulta, aunque siga marcado como activo.
   */
  async listForApp(placement: BannerPlacement = BannerPlacement.HOME): Promise<PublicBanner[]> {
    const now = new Date();

    // `home` recibe los suyos y los de alcance general; una superficie
    // distinta nunca recibe los marcados "solo pantalla inicial".
    const placements =
      placement === BannerPlacement.HOME
        ? [BannerPlacement.HOME, BannerPlacement.ALL]
        : [BannerPlacement.ALL];

    const banners = await PromotionBanner.find({
      isActive: true,
      startDate: { $lte: now },
      endDate: { $gte: now },
      placement: { $in: placements },
      imageUrl: { $ne: '' },
    }).sort({ displayOrder: 1, priority: -1, createdAt: -1 });

    return banners.map((b) => ({
      id: b._id.toString(),
      imageUrl: b.imageUrl,
      title: b.title,
      description: b.description,
      buttonText: b.buttonText,
      actionType: b.actionType,
      actionValue: b.actionValue,
      durationSeconds: b.durationSeconds,
    }));
  }

  /**
   * Comprueba que el destino exista de verdad.
   *
   * El esquema valida la *forma* del `actionValue` (que sea un ObjectId,
   * que sea una clave conocida). Esto valida la *existencia*, que es lo que
   * evita publicar un banner que lleva a un negocio borrado.
   */
  async assertActionTarget(actionType: BannerActionType, actionValue: string): Promise<void> {
    if (actionType !== BannerActionType.BUSINESS) return;

    const business = await Business.findById(actionValue).select('_id');
    if (!business) throw new AppError('El negocio de destino no existe', 400);
  }

  /** Siguiente hueco al final del carrusel, para que un banner nuevo no se cuele al frente. */
  async nextDisplayOrder(): Promise<number> {
    const last = await PromotionBanner.findOne().sort({ displayOrder: -1 }).select('displayOrder');
    return last ? Math.min(last.displayOrder + 1, 999) : 0;
  }

  /**
   * Reordena en una sola escritura.
   *
   * El panel manda la lista completa en el orden que quedó tras arrastrar;
   * el índice del arreglo *es* el `displayOrder`. Así no hay estado
   * intermedio donde dos banners compartan posición.
   */
  async reorder(ids: string[]): Promise<number> {
    const found = await PromotionBanner.find({ _id: { $in: ids } }).select('_id');
    if (found.length !== ids.length) {
      throw new AppError('Alguno de los banners ya no existe', 400);
    }

    await PromotionBanner.bulkWrite(
      ids.map((id, index) => ({
        updateOne: { filter: { _id: id }, update: { $set: { displayOrder: index } } },
      }))
    );
    return ids.length;
  }

  /**
   * Sube la imagen a Cloudinary y devuelve la URL ya optimizada.
   *
   * La transformación es de entrada, no de entrega: el archivo guardado ya
   * viene acotado a 1080px y con formato/calidad automáticos, así que el
   * teléfono nunca descarga el original de la cámara ni depende de que
   * alguien recuerde añadir parámetros a la URL después.
   */
  uploadBannerImage(buffer: Buffer): Promise<string> {
    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: 'zipp/promotion-banners',
          resource_type: 'image',
          transformation: [{ width: 1080, crop: 'limit' }, { quality: 'auto', fetch_format: 'auto' }],
        },
        (error, result) => {
          if (error || !result) {
            reject(new AppError('No se pudo subir la imagen', 502));
            return;
          }
          resolve(result.secure_url);
        }
      );
      stream.end(buffer);
    });
  }
}

export const promotionBannerService = new PromotionBannerService();
