import mongoose, { Schema, Document } from 'mongoose';
import { BusinessCategory } from '../types';

/** Qué hace la app cuando el cliente toca la tarjeta. */
export enum BannerActionType {
  /** Decorativo: el toque no lleva a ninguna parte. */
  NONE = 'none',
  /** Abre una URL externa en el navegador del sistema. */
  URL = 'url',
  /** Navega dentro de la app al perfil de un negocio. */
  BUSINESS = 'business',
  /** Abre la búsqueda filtrada por una categoría de negocio. */
  CATEGORY = 'category',
  /**
   * Abre la búsqueda con un término ya escrito.
   *
   * Distinto de `SCREEN` con la clave `search`, que solo abre la pantalla
   * vacía. Es un tipo aparte y no un valor con sufijo dentro de la lista
   * blanca de pantallas porque esa lista es cerrada a propósito: mezclar
   * texto libre ahí la convertiría en un campo que ya no se puede validar
   * contra nada.
   */
  SEARCH = 'search',
  /** Abre una pantalla interna de la lista blanca de abajo. */
  SCREEN = 'screen',
}

/** Dónde puede aparecer el banner. */
export enum BannerPlacement {
  /** Únicamente en la pantalla inicial. */
  HOME = 'home',
  /** Únicamente en la pestaña de Descuentos. */
  OFFERS = 'offers',
  /** Cualquier superficie que pida banners. */
  ALL = 'all',
}

/**
 * Pantallas internas que un banner puede abrir.
 *
 * Es una lista blanca a propósito: el panel construye su desplegable
 * pidiendo estas claves al backend, y la app traduce clave → ruta. Un
 * administrador nunca escribe una ruta a mano, así que un error de dedo no
 * puede dejar un banner que navega a ninguna parte — ni convertir el campo
 * en un vector para empujar al usuario a una pantalla arbitraria.
 */
export const BANNER_SCREENS = [
  { key: 'search', label: 'Buscar negocios' },
  { key: 'rewards', label: 'Recompensas' },
  { key: 'favorites', label: 'Favoritos' },
  { key: 'orders', label: 'Mis pedidos' },
  { key: 'offers', label: 'Descuentos' },
  { key: 'help', label: 'Ayuda y soporte' },
] as const;

export type BannerScreenKey = (typeof BANNER_SCREENS)[number]['key'];

export const BANNER_SCREEN_KEYS: readonly string[] = BANNER_SCREENS.map((s) => s.key);

/** Cuánto puede quedarse una tarjeta en pantalla antes de pasar a la siguiente. */
export const BANNER_DURATION = { min: 2, max: 30, default: 5 } as const;

export interface IPromotionBanner extends Document {
  imageUrl: string;
  title: string;
  description: string;
  buttonText: string;
  actionType: BannerActionType;
  /** URL, id de negocio, clave de categoría o clave de pantalla, según `actionType`. */
  actionValue: string;
  /** Posición en el carrusel. Menor aparece primero. */
  displayOrder: number;
  /** Segundos que la tarjeta permanece al frente antes de rotar. */
  durationSeconds: number;
  startDate: Date;
  endDate: Date;
  isActive: boolean;
  /** Desempata cuando dos banners comparten `displayOrder`. Mayor primero. */
  priority: number;
  placement: BannerPlacement;
  createdAt: Date;
  updatedAt: Date;
}

const promotionBannerSchema = new Schema<IPromotionBanner>(
  {
    imageUrl: {
      type: String,
      required: [true, 'La imagen del banner es requerida'],
      trim: true,
    },
    title: {
      type: String,
      default: '',
      trim: true,
      maxlength: [60, 'El título no puede exceder 60 caracteres'],
    },
    description: {
      type: String,
      default: '',
      trim: true,
      maxlength: [140, 'La descripción no puede exceder 140 caracteres'],
    },
    buttonText: {
      type: String,
      default: '',
      trim: true,
      maxlength: [24, 'El texto del botón no puede exceder 24 caracteres'],
    },
    actionType: {
      type: String,
      enum: Object.values(BannerActionType),
      default: BannerActionType.NONE,
    },
    actionValue: {
      type: String,
      default: '',
      trim: true,
      maxlength: [2048, 'El destino es demasiado largo'],
      validate: {
        validator(this: IPromotionBanner, v: string) {
          switch (this.actionType) {
            case BannerActionType.URL:
              return /^https?:\/\/.+/i.test(v);
            case BannerActionType.BUSINESS:
              return mongoose.Types.ObjectId.isValid(v);
            case BannerActionType.CATEGORY:
              return (Object.values(BusinessCategory) as string[]).includes(v);
            case BannerActionType.SCREEN:
              return BANNER_SCREEN_KEYS.includes(v);
            // Texto libre, pero acotado: un término de búsqueda es lo que
            // cabe en la caja, no un párrafo.
            case BannerActionType.SEARCH:
              return v.trim().length >= 2 && v.trim().length <= 60;
            default:
              return true;
          }
        },
        message: 'El destino no corresponde al tipo de acción elegido',
      },
    },
    displayOrder: { type: Number, default: 0, min: 0, max: 999 },
    durationSeconds: {
      type: Number,
      default: BANNER_DURATION.default,
      min: BANNER_DURATION.min,
      max: BANNER_DURATION.max,
    },
    startDate: {
      type: Date,
      required: [true, 'La fecha de inicio es requerida'],
    },
    endDate: {
      type: Date,
      required: [true, 'La fecha de finalización es requerida'],
      validate: {
        validator(this: IPromotionBanner, v: Date) {
          return !this.startDate || v > this.startDate;
        },
        message: 'La fecha de finalización debe ser posterior a la de inicio',
      },
    },
    isActive: { type: Boolean, default: true },
    priority: { type: Number, default: 0, min: 0, max: 100 },
    placement: {
      type: String,
      enum: Object.values(BannerPlacement),
      default: BannerPlacement.HOME,
    },
  },
  { timestamps: true }
);

/**
 * Coherencia entre fechas en cada guardado.
 *
 * El validador de `endDate` solo corre cuando ese campo se modifica, así
 * que un PATCH que mueve únicamente `startDate` más allá del final se
 * colaría. Este gancho mira siempre el documento completo.
 */
promotionBannerSchema.pre('validate', function (next) {
  if (this.startDate && this.endDate && this.endDate <= this.startDate) {
    this.invalidate('endDate', 'La fecha de finalización debe ser posterior a la de inicio');
  }
  // Un banner sin acción no debe conservar un destino viejo: guardarlo
  // dejaría una URL colgando que nadie ve pero que sigue en la base.
  if (this.actionType === BannerActionType.NONE) this.actionValue = '';
  next();
});

// La consulta que hace la app en cada arranque: activo, dentro de rango,
// del placement pedido, y ya ordenado como se va a pintar.
promotionBannerSchema.index({
  isActive: 1,
  startDate: 1,
  endDate: 1,
  placement: 1,
  displayOrder: 1,
  priority: -1,
});

export const PromotionBanner = mongoose.model<IPromotionBanner>(
  'PromotionBanner',
  promotionBannerSchema
);
