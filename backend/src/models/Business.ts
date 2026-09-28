import mongoose, { Schema, Document, Types } from 'mongoose';
import { BusinessCategory, GeoPoint, WeekSchedule } from '../types';
import { normalize } from '../utils/text';
import { BUSINESS_BRAND_COLORS } from '../utils/businessBrand';
import { cacheInvalidationPlugin, CachePrefix, fieldFrom } from '../cache';

// ── Datos fiscales y cuenta de pago (Fase 0) ─────────────────────────

export const LEGAL_DOCUMENT_TYPES = ['NIT', 'CC', 'CE'] as const;
export type LegalDocumentType = (typeof LEGAL_DOCUMENT_TYPES)[number];

export const TAX_REGIMES = ['simple', 'ordinario', 'no_responsable_iva', 'otro'] as const;
export type TaxRegime = (typeof TAX_REGIMES)[number];

export const PAYOUT_METHODS = ['bank', 'nequi', 'daviplata'] as const;
export type PayoutMethod = (typeof PAYOUT_METHODS)[number];

export const PAYOUT_ACCOUNT_TYPES = ['ahorros', 'corriente'] as const;
export type PayoutAccountType = (typeof PAYOUT_ACCOUNT_TYPES)[number];

/**
 * Identidad tributaria del comercio. Estructurada desde ya aunque ZIPP aún
 * no tenga NIT propio (decisión del 2026-09-23): la facturación y las
 * liquidaciones la necesitarán, y hoy solo existe como un PDF subido.
 */
export interface IBusinessLegal {
  documentType: LegalDocumentType;
  /**
   * Solo dígitos. Para un NIT, sin el dígito de verificación. Se guarda
   * **cifrado** (AAD = businessId); las filas anteriores a la migración 018
   * pueden estar en claro y se siguen leyendo (`decrypt` las deja pasar).
   */
  documentNumber: string;
  /** DV calculado por el servidor (módulo 11 de la DIAN). Solo NIT. */
  dv?: string | null;
  legalName: string;
  legalRepName?: string | null;
  taxRegime?: TaxRegime | null;
  billingEmail?: string | null;
  updatedAt?: Date;
  updatedBy?: Types.ObjectId | null;
}

/** Una cuenta sin verificar nunca recibe una liquidación. */
export type PayoutAccountStatus = 'pendingVerification' | 'verified';

/**
 * A dónde se le paga al comercio.
 *
 * El número de cuenta es sensible: se guarda **cifrado** (`accountNumberEnc`,
 * AES-256-GCM como los secretos TOTP) y solo sus 4 últimos dígitos en claro
 * (`accountLast4`) para mostrarlos enmascarados. El completo solo lo lee
 * finanzas, por un endpoint propio y auditado.
 */
export interface IBusinessPayoutAccount {
  method: PayoutMethod;
  /** Solo `bank`. */
  bankName?: string | null;
  /** Solo `bank`. */
  accountType?: PayoutAccountType | null;
  /** Cifrado. Nunca sale en una respuesta. */
  accountNumberEnc: string;
  accountLast4: string;
  /**
   * HMAC determinista del número de cuenta (`hashForSearch`): el cifrado usa
   * sal e IV aleatorios y no sirve para comparar, y esto sí deja detectar la
   * misma cuenta en varios comercios sin descifrar nada. Nunca sale.
   */
  accountNumberHash?: string | null;
  /** Últimos 4 de la cuenta anterior, para el aviso al dueño y la cola de finanzas. */
  previousLast4?: string | null;
  holderName: string;
  /** Cifrado con AAD = businessId (v3); las filas anteriores pueden estar en claro. */
  holderDocument: string;
  verificationStatus: PayoutAccountStatus;
  verifiedAt?: Date | null;
  verifiedBy?: Types.ObjectId | null;
  /**
   * Se incrementa en cada cambio de la cuenta. Quien verifica manda la que
   * vio: si el comercio la cambió entre tanto, la verificación se rechaza y
   * nadie aprueba a ciegas una cuenta distinta de la que revisó.
   */
  version: number;
  updatedAt?: Date;
  updatedBy?: Types.ObjectId | null;
}

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
  /**
   * Vigencia del envío gratis. Por defecto cubre todo el tiempo (desde el
   * pasado remoto hasta un futuro lejano), así que un negocio sin fechas
   * configuradas se comporta exactamente como antes de que estos campos
   * existieran. Se resuelve con `couponAvailability()` —la misma función
   * que ya decide la franja de un cupón— construyendo un `CouponTiming`
   * sintético desde estos cinco campos (ver `freeDeliveryWindow.ts`).
   */
  freeDeliveryValidFrom: Date;
  freeDeliveryValidUntil: Date;
  freeDeliveryValidDays: number[];
  freeDeliveryValidFromTime?: string;
  freeDeliveryValidUntilTime?: string;
  isApproved: boolean;
  approvedAt?: Date | null;
  approvedBy?: Types.ObjectId | null;
  isFeatured: boolean;
  schedule: WeekSchedule;
  city: string;
  /**
   * Borrado suave. Un comercio nunca se borra de verdad (S11): archivarlo
   * lo saca de la app y del catálogo público —igual que `isApproved: false`
   * o `isActive: false`— pero conserva su historial (pedidos, liquidaciones,
   * reseñas) y es reversible con `restore()`.
   */
  isArchived: boolean;
  archivedAt?: Date | null;
  archivedBy?: Types.ObjectId | null;
  archiveReason?: string | null;
  /**
   * Suspensión por ZIPP, distinta del `isActive` del dueño.
   *
   * `isActive` es el interruptor "abierto/cerrado" del comercio; un dueño
   * suspendido no puede quitarse esto solo con PUT — solo soporte/admin.
   */
  isSuspended: boolean;
  suspendedAt?: Date | null;
  suspendedBy?: Types.ObjectId | null;
  suspensionReason?: string | null;
  /**
   * Datos tributarios. `select: false`: no viajan en ninguna consulta
   * normal (ni en la ficha que recibe un empleado); quien los necesita los
   * pide a propósito (`+legal`) desde su endpoint propio.
   */
  legal?: IBusinessLegal;
  /** Igual que `legal`, y además con el número de cuenta cifrado. */
  payoutAccount?: IBusinessPayoutAccount;
  createdAt: Date;
  updatedAt: Date;
}

const legalSchema = new Schema<IBusinessLegal>(
  {
    documentType: { type: String, enum: LEGAL_DOCUMENT_TYPES, required: true },
    documentNumber: { type: String, required: true, trim: true, maxlength: 300 },
    dv: { type: String, default: null, maxlength: 1 },
    legalName: { type: String, required: true, trim: true, maxlength: 150 },
    legalRepName: { type: String, trim: true, maxlength: 120, default: null },
    taxRegime: { type: String, enum: [...TAX_REGIMES, null], default: null },
    billingEmail: { type: String, trim: true, lowercase: true, maxlength: 254, default: null },
    updatedAt: { type: Date },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { _id: false }
);

const payoutAccountSchema = new Schema<IBusinessPayoutAccount>(
  {
    method: { type: String, enum: PAYOUT_METHODS, required: true },
    bankName: { type: String, trim: true, maxlength: 80, default: null },
    accountType: { type: String, enum: [...PAYOUT_ACCOUNT_TYPES, null], default: null },
    accountNumberEnc: { type: String, required: true },
    accountLast4: { type: String, required: true, maxlength: 4 },
    accountNumberHash: { type: String, default: null },
    previousLast4: { type: String, maxlength: 4, default: null },
    holderName: { type: String, required: true, trim: true, maxlength: 120 },
    holderDocument: { type: String, required: true, trim: true, maxlength: 300 },
    verificationStatus: {
      type: String,
      enum: ['pendingVerification', 'verified'],
      default: 'pendingVerification',
    },
    verifiedAt: { type: Date, default: null },
    verifiedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    version: { type: Number, default: 1, min: 1 },
    updatedAt: { type: Date },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { _id: false }
);

// Segunda barrera: si alguien carga la cuenta con `+payoutAccount` y
// serializa el documento, el texto cifrado tampoco sale.
payoutAccountSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete (ret as unknown as Record<string, unknown>).accountNumberEnc;
    delete (ret as unknown as Record<string, unknown>).accountNumberHash;
    delete (ret as unknown as Record<string, unknown>).holderDocument;
    return ret;
  },
});

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
    freeDeliveryValidFrom: { type: Date, default: () => new Date(0) },
    freeDeliveryValidUntil: { type: Date, default: () => new Date('2999-12-31') },
    freeDeliveryValidDays: {
      type: [Number],
      default: [],
      validate: {
        validator: (v: number[]) => v.every((d) => Number.isInteger(d) && d >= 0 && d <= 6),
        message: 'Días de envío gratis inválidos',
      },
    },
    freeDeliveryValidFromTime: { type: String, default: '' },
    freeDeliveryValidUntilTime: { type: String, default: '' },
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
    isArchived: {
      type: Boolean,
      default: false,
    },
    archivedAt: { type: Date, default: null },
    archivedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    archiveReason: { type: String, default: null, maxlength: 500 },
    isSuspended: {
      type: Boolean,
      default: false,
    },
    suspendedAt: { type: Date, default: null },
    suspendedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    suspensionReason: { type: String, default: null, maxlength: 500 },
    legal: { type: legalSchema, select: false, default: undefined },
    payoutAccount: { type: payoutAccountSchema, select: false, default: undefined },
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
businessSchema.index({ isArchived: 1 });
// Cola de cuentas de pago pendientes y detección de la misma cuenta en varios
// comercios (migración 018 los crea en producción).
businessSchema.index({ 'payoutAccount.verificationStatus': 1 }, { sparse: true });
businessSchema.index({ 'payoutAccount.accountNumberHash': 1 }, { sparse: true });
// `slug` already declares `unique: true` on the path, which creates the index.
businessSchema.index({ isFeatured: 1 });
// "Mis negocios", la sala de socket del dueño y cada comprobación de
// propiedad preguntan por `ownerId`; sin índice, cada una recorre la
// colección entera.
businessSchema.index({ ownerId: 1, createdAt: -1 });
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

// Cada escritura limpia lo que la caché de lecturas tenga de este modelo.
businessSchema.plugin(cacheInvalidationPlugin, {
  prefixesFor: (ctx) => {
    const id = fieldFrom(ctx, '_id');
    return [
      id ? CachePrefix.business(id) : CachePrefix.BUSINESS_ALL,
      CachePrefix.BUSINESS_SLUG,
      CachePrefix.HOME,
      CachePrefix.EXPLORE,
      CachePrefix.OFFERS,
    ];
  },
});

export const Business = mongoose.model<IBusiness>('Business', businessSchema);
