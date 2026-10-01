import { realtimeInvalidatePlugin } from '../realtime/invalidate';
import mongoose, { Schema, Document, Types } from 'mongoose';
import { CouponType, CouponFundedBy, CouponScope } from '../types';
import { cacheInvalidationPlugin, CachePrefix } from '../cache';

export interface ICoupon extends Document {
  code: string;
  title: string;
  description: string;
  type: CouponType;
  /** Percentage (0-100) for PERCENTAGE, COP amount for FIXED, ignored for FREE_DELIVERY. */
  value: number;
  /** Caps the discount for PERCENTAGE coupons. 0 = uncapped. */
  maxDiscount: number;

  // ── Funding ────────────────────────────────────────────────────────
  /**
   * Who pays for the promotion. This is explicit rather than inferred from
   * `businessId`, because the two are genuinely independent: a platform
   * campaign can be scoped to one merchant without that merchant paying
   * for it.
   */
  fundedBy: CouponFundedBy;
  /** Which line the discount applies to. */
  scope: CouponScope;
  /** Hard ceiling on one redemption's discount. 0 = fall back to config. */
  maxDiscountAmount: number;
  /** Total the campaign may spend. 0 = unlimited. */
  budgetLimit: number;
  /** Spent so far; incremented atomically on redemption. */
  budgetSpent: number;
  /**
   * A platform coupon is refused when the order's contribution margin
   * would fall below this. -1 = use the platform default from config.
   */
  minimumContributionMargin: number;
  /** Set by finance to let a campaign run below the minimum margin. */
  campaignApproved: boolean;

  minOrderAmount: number;
  validFrom: Date;
  validUntil: Date;
  /** Total redemptions allowed across all users. 0 = unlimited. */
  usageLimit: number;
  usedCount: number;
  /** Redemptions allowed per user. 0 = unlimited. */
  perUserLimit: number;
  /** Restricts the coupon to one business. null = valid platform-wide. */
  businessId?: Types.ObjectId | null;
  /** Restricts the coupon to a city. Empty = any city. */
  city: string;
  /** Only true for a user's very first delivered order. */
  firstOrderOnly: boolean;
  /**
   * Si está, el cupón es de una sola persona.
   *
   * Lo usan los canjes de puntos: un cupón nominal que circula por WhatsApp
   * deja de ser un canje y pasa a ser un agujero, porque quien lo usa no
   * gastó ningún punto.
   */
  restrictedToUserId?: Types.ObjectId | null;
  /** Optional targeting. Empty arrays mean every eligible customer. */
  zoneIds: Types.ObjectId[];
  eligibleRoles: string[];
  validDays: number[];
  validFromTime?: string;
  validUntilTime?: string;
  isActive: boolean;
  /** Public coupons are surfaced in the app's promotions carousel. */
  isPublic: boolean;
  /**
   * Productos cubiertos por una promoción automática (ver `autoApply`).
   * Vacío para un cupón de código normal, que no está atado a productos
   * concretos sino al subtotal del pedido entero.
   */
  productIds: Types.ObjectId[];
  /**
   * Sin código: se aplica sola cuando el carrito trae alguno de
   * `productIds`, igual que ya pasa hoy con `Product.discountPrice` pero
   * con vigencia y con todo el motor financiero de cupones detrás
   * (presupuesto, auditoría, reparto comercio/plataforma). El comercio
   * nunca escribe un código para este modo; `code` se genera solo y no se
   * expone, porque el campo sigue siendo único en la colección.
   */
  autoApply: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const couponSchema = new Schema<ICoupon>(
  {
    code: {
      type: String,
      // Una promoción automática no tiene código que el cliente escriba;
      // `createForBusiness` le genera uno interno solo para satisfacer la
      // unicidad del campo, y el panel nunca lo muestra.
      required: [function (this: ICoupon) { return !this.autoApply; }, 'El código es requerido'],
      unique: true,
      sparse: true,
      uppercase: true,
      trim: true,
      minlength: [3, 'El código debe tener al menos 3 caracteres'],
      maxlength: [24, 'El código no puede exceder 24 caracteres'],
      match: [/^[A-Z0-9_-]+$/, 'El código solo admite letras, números, guion y guion bajo'],
    },
    title: {
      type: String,
      required: [true, 'El título es requerido'],
      trim: true,
      maxlength: [80, 'El título no puede exceder 80 caracteres'],
    },
    description: {
      type: String,
      default: '',
      maxlength: [200, 'La descripción no puede exceder 200 caracteres'],
    },
    type: {
      type: String,
      enum: Object.values(CouponType),
      required: true,
    },
    value: {
      type: Number,
      required: true,
      min: [0, 'El valor no puede ser negativo'],
      validate: {
        validator(this: ICoupon, v: number) {
          if (this.type === CouponType.PERCENTAGE) return v > 0 && v <= 100;
          if (this.type === CouponType.FIXED) return v > 0;
          return true; // FREE_DELIVERY ignores value
        },
        message: 'Un cupón porcentual requiere un valor entre 1 y 100; uno fijo, un valor mayor a 0',
      },
    },
    maxDiscount: { type: Number, default: 0, min: 0 },

    fundedBy: {
      type: String,
      enum: Object.values(CouponFundedBy),
      default: CouponFundedBy.PLATFORM,
      required: true,
    },
    scope: {
      type: String,
      enum: Object.values(CouponScope),
      default: CouponScope.PRODUCT,
      required: true,
    },
    maxDiscountAmount: { type: Number, default: 0, min: 0 },
    budgetLimit: { type: Number, default: 0, min: 0 },
    budgetSpent: { type: Number, default: 0, min: 0 },
    minimumContributionMargin: { type: Number, default: -1 },
    campaignApproved: { type: Boolean, default: false },

    minOrderAmount: { type: Number, default: 0, min: 0 },
    validFrom: { type: Date, default: () => new Date() },
    validUntil: {
      type: Date,
      required: [true, 'La fecha de expiración es requerida'],
      validate: {
        validator(this: ICoupon, v: Date) {
          return !this.validFrom || v > this.validFrom;
        },
        message: 'La fecha de expiración debe ser posterior a la de inicio',
      },
    },
    usageLimit: { type: Number, default: 0, min: 0 },
    usedCount: { type: Number, default: 0, min: 0 },
    perUserLimit: { type: Number, default: 1, min: 0 },
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', default: null },
    city: { type: String, default: '', trim: true },
    firstOrderOnly: { type: Boolean, default: false },
    restrictedToUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    zoneIds: { type: [Schema.Types.ObjectId], ref: 'Zone', default: [] },
    eligibleRoles: { type: [String], default: ['client'] },
    validDays: { type: [Number], default: [], validate: { validator: (v: number[]) => v.every((d) => Number.isInteger(d) && d >= 0 && d <= 6), message: 'Días de promoción inválidos' } },
    validFromTime: { type: String, default: '' },
    validUntilTime: { type: String, default: '' },
    isActive: { type: Boolean, default: true },
    isPublic: { type: Boolean, default: false },
    productIds: { type: [Schema.Types.ObjectId], ref: 'Product', default: [] },
    autoApply: { type: Boolean, default: false },
  },
  { timestamps: true }
);

/**
 * Coherence guards.
 *
 * A merchant cannot fund a coupon that is not tied to their business, and
 * a merchant cannot be billed for a delivery discount: the delivery fee is
 * the platform's and the driver's money, never the merchant's.
 */
couponSchema.pre('validate', function (next) {
  if (this.fundedBy === CouponFundedBy.BUSINESS) {
    if (!this.businessId) {
      return next(new Error('Un cupón financiado por el comercio debe indicar el comercio'));
    }
    if (this.scope !== CouponScope.PRODUCT) {
      return next(
        new Error(
          'Un comercio solo puede financiar descuentos sobre sus productos, ' +
            'no sobre el domicilio ni el fee de servicio'
        )
      );
    }
  }

  if (this.type === CouponType.FREE_DELIVERY && this.scope !== CouponScope.DELIVERY) {
    return next(new Error('Un cupón de envío gratis debe tener alcance de domicilio'));
  }

  // Una promoción automática está atada a productos concretos y nunca a
  // "todo el pedido" ni a envío/fee: si mañana alguien quiere regalar el
  // domicilio sin código, ese mecanismo vive en `Business`, no aquí.
  if (this.autoApply) {
    if (!this.productIds || this.productIds.length === 0) {
      return next(new Error('Una promoción automática debe cubrir al menos un producto'));
    }
    if (this.productIds.length > 50) {
      return next(new Error('Una promoción no puede cubrir más de 50 productos'));
    }
    if (this.scope !== CouponScope.PRODUCT) {
      return next(new Error('Una promoción automática solo puede descontar sobre productos'));
    }
    if (this.type !== CouponType.PERCENTAGE && this.type !== CouponType.FIXED) {
      return next(new Error('Una promoción automática es porcentual o de valor fijo'));
    }
  } else if (this.productIds && this.productIds.length > 0) {
    // `productIds` sin `autoApply` es un estado ambiguo: ¿a qué producto se
    // le aplicaría un cupón de código que igual descuenta el subtotal
    // entero? Se rechaza en vez de ignorarlo en silencio.
    return next(new Error('Solo una promoción automática puede tener productos asociados'));
  }

  next();
});

// `code` already declares `unique: true` on the path, which creates the index.
couponSchema.index({ isActive: 1, isPublic: 1, validUntil: 1 });
couponSchema.index({ businessId: 1, isActive: 1 });
couponSchema.index({ fundedBy: 1, isActive: 1 });
// Listar las promociones automáticas de un negocio y comprobar solapamiento.
couponSchema.index({ businessId: 1, autoApply: 1, isActive: 1 });
// Resolver promociones automáticas activas entre negocios (/offers,
// búsqueda, home) sin escanear el resto de cupones: la inmensa mayoría
// tiene `autoApply: false`, así que el índice parcial los deja fuera.
couponSchema.index(
  { autoApply: 1, isActive: 1, validFrom: 1, validUntil: 1 },
  { partialFilterExpression: { autoApply: true } }
);

// Cada escritura limpia lo que la caché de lecturas tenga de este modelo.
couponSchema.plugin(cacheInvalidationPlugin, {
  prefixesFor: () => [CachePrefix.OFFERS],
});

couponSchema.plugin(realtimeInvalidatePlugin, { resource: 'coupons' });
export const Coupon = mongoose.model<ICoupon>('Coupon', couponSchema);

// ── Redemptions ──────────────────────────────────────────────────────
// Recorded only when an order is actually created, so a customer can
// preview a coupon in checkout as many times as they like without
// consuming it.

export interface ICouponRedemption extends Document {
  couponId: Types.ObjectId;
  userId: Types.ObjectId;
  orderId: Types.ObjectId;
  discountAmount: number;
  createdAt: Date;
}

const couponRedemptionSchema = new Schema<ICouponRedemption>(
  {
    couponId: { type: Schema.Types.ObjectId, ref: 'Coupon', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true },
    discountAmount: { type: Number, required: true, min: 0 },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

couponRedemptionSchema.index({ couponId: 1, userId: 1 });
// Ficha del cliente (panel admin): sus canjes recientes.
couponRedemptionSchema.index({ userId: 1, createdAt: -1 });
// Un pedido puede canjear varios cupones ahora: el de código, más una
// promoción automática por cada producto o grupo de productos distinto que
// cubra. Lo que sigue sin poder pasar es canjear el MISMO cupón dos veces
// en el mismo pedido (dobles envíos de la petición de crear orden).
couponRedemptionSchema.index({ orderId: 1, couponId: 1 }, { unique: true });
// `release()` necesita encontrar todas las filas de un pedido, no solo la
// primera; el índice compuesto de arriba no sirve para ese acceso.
couponRedemptionSchema.index({ orderId: 1 });

export const CouponRedemption = mongoose.model<ICouponRedemption>(
  'CouponRedemption',
  couponRedemptionSchema
);
