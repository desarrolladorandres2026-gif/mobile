import mongoose, { Schema, Document, Types } from 'mongoose';
import { BusinessCategory, GeoPoint, WeekSchedule } from '../types';
import { normalize } from '../utils/text';
import { BUSINESS_BRAND_COLORS } from '../utils/businessBrand';

export interface IBusiness extends Document {
  ownerId: Types.ObjectId;
  name: string;
  slug: string;
  /**
   * `name` sin tildes ni mayúsculas, para buscar por prefijo.
   *
   * Derivado, nunca escrito a mano: lo mantienen los hooks del esquema.
   */
  searchName: string;
  description: string;
  logo?: string;
  coverImage?: string;
  /**
   * Color del encabezado cuando el comercio no subió portada.
   *
   * Sale de una lista cerrada (`BUSINESS_BRAND_COLORS`) y no de un selector
   * libre: el cliente ve decenas de fichas seguidas, y un solo color mal
   * elegido vuelve ilegible el nombre del negocio sobre él. Vacío significa
   * "el que Zipp le asigne", que es un color derivado de su id.
   */
  brandColor?: string | null;
  /**
   * Si la ficha muestra la franja de promoción del encabezado.
   *
   * El texto de esa franja lo arma Zipp con datos reales —envío gratis
   * desde X, cupón vigente—, así que el comercio no puede escribir en ella;
   * lo único que decide es si quiere darle ese protagonismo en su ficha.
   * Sin nada que anunciar, la franja no aparece aunque esto esté en `true`.
   */
  showPromoBanner: boolean;
  category: BusinessCategory;
  address: string;
  location: GeoPoint;
  phone: string;
  rating: number;
  totalReviews: number;
  /**
   * Puntaje interno 0-100, nunca mostrado al usuario.
   *
   * A diferencia de `rating` (promedio simple, público), este pondera la
   * reseña reciente por encima de la histórica y descuenta por
   * cancelaciones/incidencias. Sirve para vigilancia interna (admin), no
   * para castigar automáticamente a nadie por una sola mala calificación.
   * Ver `reputation.service.ts`.
   */
  reputationScore: number;
  reputationUpdatedAt?: Date;
  deliveryTime: number; // minutes
  minOrder: number;
  /** @deprecated Legacy decimal rate. Mirrors `commissionRateBps`. */
  commissionRate: number;
  /**
   * Per-business commission override in basis points. -1 means "no
   * override": fall back to the category rate, then the global rate.
   * Admin-only — a merchant setting its own commission to zero was a
   * revenue hole, so this is stripped from any merchant-facing payload.
   */
  commissionRateBps: number;
  isActive: boolean;
  /** Requires admin approval; a merchant cannot switch itself live. */
  /**
   * Compra mínima a partir de la cual el negocio regala el domicilio.
   *
   * Cero significa desactivado. Lo paga el comercio de su liquidación,
   * igual que un cupón suyo: el domiciliario cobra lo mismo y la plataforma
   * conserva su margen. Subirlo es una decisión comercial del negocio, no
   * un gasto de ZIPP.
   */
  freeDeliveryThreshold: number;
  isApproved: boolean;
  approvedAt?: Date | null;
  approvedBy?: Types.ObjectId | null;
  isFeatured: boolean;
  schedule: WeekSchedule;
  city: string;
  createdAt: Date;
  updatedAt: Date;
}

const dayScheduleSchema = new Schema(
  {
    open: { type: String, default: '08:00' },
    close: { type: String, default: '22:00' },
    isOpen: { type: Boolean, default: true },
  },
  { _id: false }
);

const defaultSchedule = () => ({
  monday: { open: '08:00', close: '22:00', isOpen: true },
  tuesday: { open: '08:00', close: '22:00', isOpen: true },
  wednesday: { open: '08:00', close: '22:00', isOpen: true },
  thursday: { open: '08:00', close: '22:00', isOpen: true },
  friday: { open: '08:00', close: '22:00', isOpen: true },
  saturday: { open: '08:00', close: '22:00', isOpen: true },
  sunday: { open: '09:00', close: '20:00', isOpen: true },
});

const businessSchema = new Schema<IBusiness>(
  {
    ownerId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    name: {
      type: String,
      required: [true, 'El nombre del negocio es requerido'],
      trim: true,
      maxlength: [100, 'El nombre no puede exceder 100 caracteres'],
    },
    slug: {
      type: String,
      unique: true,
      lowercase: true,
      trim: true,
    },
    // `select: false` porque es maquinaria de búsqueda: no se pinta en
    // ninguna pantalla y no tiene por qué viajar en cada listado.
    searchName: {
      type: String,
      default: '',
      select: false,
    },
    description: {
      type: String,
      default: '',
      maxlength: [500, 'La descripción no puede exceder 500 caracteres'],
    },
    logo: {
      type: String,
      default: null,
    },
    coverImage: {
      type: String,
      default: null,
    },
    brandColor: {
      type: String,
      default: null,
      // El enum vive en `utils/businessBrand` para que el validador, el
      // panel y el modelo no mantengan tres listas que se desincronizan.
      enum: [...BUSINESS_BRAND_COLORS, null],
    },
    showPromoBanner: {
      type: Boolean,
      default: true,
    },
    category: {
      type: String,
      enum: Object.values(BusinessCategory),
      required: [true, 'La categoría es requerida'],
    },
    address: {
      type: String,
      required: [true, 'La dirección es requerida'],
    },
    location: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point',
      },
      coordinates: {
        type: [Number],
        required: true,
      },
    },
    phone: {
      type: String,
      required: [true, 'El teléfono es requerido'],
    },
    rating: {
      type: Number,
      default: 0,
      min: 0,
      max: 5,
    },
    totalReviews: {
      type: Number,
      default: 0,
    },
    // `select: false`: nunca sale en una consulta normal, ni siquiera por
    // accidente en un endpoint público que devuelve el documento entero.
    // Quien de verdad lo necesite (el panel de Admin) lo pide a propósito
    // con `.select('+reputationScore')`.
    reputationScore: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
      select: false,
    },
    reputationUpdatedAt: { type: Date, select: false },
    deliveryTime: {
      type: Number,
      default: 30,
    },
    minOrder: {
      type: Number,
      default: 0,
    },
    commissionRate: {
      type: Number,
      default: 0.10,
      min: 0,
      max: 1,
    },
    commissionRateBps: {
      type: Number,
      default: -1,
      min: -1,
      max: 10_000,
      validate: {
        validator: Number.isInteger,
        message: 'La comisión debe expresarse en basis points enteros',
      },
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    freeDeliveryThreshold: { type: Number, default: 0, min: 0 },
    isApproved: {
      type: Boolean,
      default: false,
    },
    approvedAt: { type: Date, default: null },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    isFeatured: {
      type: Boolean,
      default: false,
    },
    schedule: {
      monday: { type: dayScheduleSchema, default: () => defaultSchedule().monday },
      tuesday: { type: dayScheduleSchema, default: () => defaultSchedule().tuesday },
      wednesday: { type: dayScheduleSchema, default: () => defaultSchedule().wednesday },
      thursday: { type: dayScheduleSchema, default: () => defaultSchedule().thursday },
      friday: { type: dayScheduleSchema, default: () => defaultSchedule().friday },
      saturday: { type: dayScheduleSchema, default: () => defaultSchedule().saturday },
      sunday: { type: dayScheduleSchema, default: () => defaultSchedule().sunday },
    },
    city: {
      type: String,
      default: 'Garzón',
      trim: true,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

/**
 * Keeps the legacy decimal `commissionRate` in step with `commissionRateBps`.
 *
 * The bps field is authoritative. The decimal one survives only so existing
 * admin screens and API consumers keep rendering; it is derived, never read
 * by the pricing engine.
 */
businessSchema.pre('save', function (next) {
  if (this.isModified('commissionRateBps') && this.commissionRateBps >= 0) {
    this.commissionRate = this.commissionRateBps / 10_000;
  } else if (this.isModified('commissionRate') && !this.isModified('commissionRateBps')) {
    this.commissionRateBps = Math.round(this.commissionRate * 10_000);
  }
  next();
});

// Auto-generate slug from name
businessSchema.pre('save', function (next) {
  if (this.isModified('name')) {
    const clean = normalize(this.name);
    this.searchName = clean;
    this.slug = clean.replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  }
  next();
});

/**
 * El mismo `searchName`, por el camino que no carga el documento.
 *
 * El panel actualiza con `findOneAndUpdate`, que no dispara el hook de
 * arriba. Sin esto, un negocio renombrado se queda con el nombre viejo en
 * el \u00edndice de b\u00fasqueda y deja de aparecer por el nuevo \u2014 y como la ficha
 * se ve perfecta, nadie relaciona una cosa con la otra.
 *
 * El `slug` se deja quieto a prop\u00f3sito: es \u00fanico y va en enlaces ya
 * repartidos, as\u00ed que regenerarlo en cada edici\u00f3n podr\u00eda chocar contra otro
 * negocio o romper una direcci\u00f3n que alguien ten\u00eda guardada.
 */
businessSchema.pre('findOneAndUpdate', function (next) {
  const update = this.getUpdate() as Record<string, any> | null;
  if (!update) return next();

  const name = update.name ?? update.$set?.name;
  if (typeof name === 'string') this.set('searchName', normalize(name));
  next();
});

// Geospatial index
businessSchema.index({ location: '2dsphere' });
businessSchema.index({ category: 1, isActive: 1 });
businessSchema.index({ city: 1, isActive: 1 });
businessSchema.index({ isApproved: 1, isActive: 1 });
// `slug` already declares `unique: true` on the path, which creates the index.
businessSchema.index({ isFeatured: 1 });
// Anclado (`^termino`) es la única forma de `$regex` que aprovecha un
// índice; sin él cada pulsación recorrería la colección entera.
businessSchema.index({ searchName: 1 });

/**
 * Mismo criterio que en productos: nombre por encima de todo, en español.
 *
 * `description` entró después (migración 005) porque quedó fuera la primera
 * vez y es justo donde un negocio dice qué vende cuando su carta usa nombres
 * de autor: "Carbón & Pan" no se llama "Hamburguesas" ni tiene un plato que
 * se llame así, pero su descripción sí dice "Hamburguesas de carne madurada
 * a la parrilla…". Sin indexarla, buscar "hamburguesa" no encontraba ese
 * negocio aunque fuera exactamente lo que el cliente buscaba.
 */
businessSchema.index(
  { name: 'text', description: 'text', category: 'text' },
  { weights: { name: 10, category: 2, description: 1 }, default_language: 'spanish', name: 'business_search' }
);

// Virtual: products
businessSchema.virtual('products', {
  ref: 'Product',
  localField: '_id',
  foreignField: 'businessId',
});

export const Business = mongoose.model<IBusiness>('Business', businessSchema);
