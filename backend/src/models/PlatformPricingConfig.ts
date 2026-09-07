import mongoose, { Schema, Document, Types } from 'mongoose';
import { BusinessCategory } from '../types';

/**
 * The platform's monetisation parameters.
 *
 * This collection is **append-only**. Editing pricing never mutates a row:
 * it inserts a new document with `version = previous + 1` and flips
 * `isCurrent`. Every order persists the `version` it was priced with, so a
 * rate change can never retroactively alter historical money — which is a
 * hard requirement, not a nicety, because those numbers are what we owe
 * merchants and drivers.
 *
 * All rates are basis points (1000 = 10%). All amounts are whole COP.
 * All distances are whole metres. Nothing here is a float.
 */
export interface IPlatformPricingConfig extends Document {
  version: number;
  isCurrent: boolean;

  // ── Merchant commission ──
  /** Applied when neither the business nor its category overrides it. */
  merchantCommissionBps: number;
  /** Per-category override, e.g. lower for supermarkets. */
  categoryCommissionBps: Map<string, number>;
  /**
   * When true, commission is charged on the subtotal *after* a
   * merchant-funded discount. Platform-funded discounts never reduce it.
   */
  commissionAfterMerchantDiscount: boolean;

  // ── What the driver is guaranteed ──
  driverBaseFee: number;
  driverPerKm: number;
  driverMinFee: number;
  /** Distance included in the base fee before per-km billing starts. */
  freeRadiusMeters: number;

  // ── The platform's cut of delivery ──
  /** Flat margin added on top of the driver's fee. */
  deliveryMarginFixed: number;
  /** Proportional margin on the driver's fee. */
  deliveryMarginBps: number;

  // ── Customer-facing delivery fee bounds ──
  deliveryMinFee: number;
  deliveryMaxFee: number;
  deliveryRoundingStep: number;

  // ── Service fee charged to the customer ──
  serviceFeeFixed: number;
  serviceFeeBps: number;
  serviceFeeMin: number;
  serviceFeeMax: number;

  // ── Limits ──
  maxTipBps: number;
  maxRadiusMeters: number;
  taxBps: number;

  // ── Promotions ──
  /** Ceiling on what the platform will subsidise on a single order. */
  couponSubsidyLimit: number;
  /** Total approved budget across all platform-funded campaigns. */
  campaignBudgetTotal: number;
  /**
   * A platform coupon is refused when it would push the order's
   * contribution margin below this, unless the campaign has budget.
   */
  defaultMinimumContributionMargin: number;

  // ── Cash on delivery ──
  /** Off by default: cash requires a working reconciliation process. */
  cashOnDeliveryEnabled: boolean;
  cashOnDeliveryMaxAmount: number;
  /**
   * Cuánto efectivo de ZIPP puede tener sin rendir un domiciliario antes
   * de dejar de poder tomar pedidos en efectivo.
   *
   * `cashOnDeliveryMaxAmount` limita *un* pedido; esto limita la
   * acumulación. Sin el segundo, diez pedidos por debajo del tope suman
   * lo mismo que uno enorme y nadie lo nota hasta que hay que cobrarlo.
   * En 0 significa sin límite, para poder desactivarlo sin tocar código.
   */
  maxDriverCashDebt: number;

  // ── Provenance ──
  createdBy?: Types.ObjectId | null;
  changeReason: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Shape used by the pricing engine — a plain, frozen snapshot. */
export type PricingConfigSnapshot = Omit<
  IPlatformPricingConfig,
  keyof Document | 'categoryCommissionBps'
> & {
  categoryCommissionBps: Record<string, number>;
};

const money = { type: Number, required: true, min: 0, validate: Number.isInteger };
const bps = { type: Number, required: true, min: 0, max: 10_000, validate: Number.isInteger };

const platformPricingConfigSchema = new Schema<IPlatformPricingConfig>(
  {
    version: { type: Number, required: true, unique: true, min: 1 },
    isCurrent: { type: Boolean, default: true },

    merchantCommissionBps: { ...bps, default: 1000 },
    categoryCommissionBps: {
      type: Map,
      of: { type: Number, min: 0, max: 10_000 },
      default: () => new Map<string, number>(),
    },
    commissionAfterMerchantDiscount: { type: Boolean, default: true },

    driverBaseFee: { ...money, default: 4000 },
    driverPerKm: { ...money, default: 900 },
    driverMinFee: { ...money, default: 3000 },
    freeRadiusMeters: { ...money, default: 1000 },

    deliveryMarginFixed: { ...money, default: 0 },
    deliveryMarginBps: { ...bps, default: 0 },

    deliveryMinFee: { ...money, default: 3000 },
    deliveryMaxFee: { ...money, default: 20000 },
    deliveryRoundingStep: { ...money, default: 100 },

    serviceFeeFixed: { ...money, default: 0 },
    serviceFeeBps: { ...bps, default: 0 },
    serviceFeeMin: { ...money, default: 0 },
    serviceFeeMax: { ...money, default: 10000 },

    maxTipBps: { ...bps, default: 10_000 },
    maxRadiusMeters: { ...money, default: 12000 },
    taxBps: { ...bps, default: 0 },

    couponSubsidyLimit: { ...money, default: 20000 },
    campaignBudgetTotal: { ...money, default: 0 },
    defaultMinimumContributionMargin: { ...money, default: 0 },

    cashOnDeliveryEnabled: { type: Boolean, default: false },
    cashOnDeliveryMaxAmount: { ...money, default: 150000 },
    maxDriverCashDebt: { ...money, default: 50000 },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    changeReason: { type: String, default: 'Configuración inicial', maxlength: 300 },
  },
  { timestamps: true }
);

platformPricingConfigSchema.index({ isCurrent: 1 });

/** Guards that make an incoherent configuration impossible to save. */
platformPricingConfigSchema.pre('validate', function (next) {
  if (this.deliveryMinFee > this.deliveryMaxFee) {
    return next(new Error('La tarifa mínima de domicilio no puede superar la máxima'));
  }
  if (this.serviceFeeMin > this.serviceFeeMax) {
    return next(new Error('El fee de servicio mínimo no puede superar el máximo'));
  }
  // Note: `driverMinFee > deliveryMaxFee` is deliberately allowed. It means
  // every delivery is sold below cost, which is a real promotional strategy
  // — and a safe one, because the shortfall lands on `deliveryMargin` as a
  // platform loss and never touches the courier's guaranteed fee.
  if (this.freeRadiusMeters > this.maxRadiusMeters) {
    return next(new Error('El radio incluido no puede superar el radio de cobertura'));
  }
  next();
});

export const PlatformPricingConfig = mongoose.model<IPlatformPricingConfig>(
  'PlatformPricingConfig',
  platformPricingConfigSchema
);

// ── Audit trail ──────────────────────────────────────────────────────

export interface IPricingConfigAudit extends Document {
  fromVersion: number | null;
  toVersion: number;
  changedBy: Types.ObjectId;
  changedByName: string;
  reason: string;
  /** Only the fields that actually changed: { field: { before, after } }. */
  changes: Record<string, { before: unknown; after: unknown }>;
  ip?: string;
  createdAt: Date;
}

const pricingConfigAuditSchema = new Schema<IPricingConfigAudit>(
  {
    fromVersion: { type: Number, default: null },
    toVersion: { type: Number, required: true },
    changedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    changedByName: { type: String, default: '' },
    reason: { type: String, required: true, maxlength: 300 },
    changes: { type: Schema.Types.Mixed, default: {} },
    ip: { type: String, default: '' },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

pricingConfigAuditSchema.index({ createdAt: -1 });
pricingConfigAuditSchema.index({ toVersion: 1 });

export const PricingConfigAudit = mongoose.model<IPricingConfigAudit>(
  'PricingConfigAudit',
  pricingConfigAuditSchema
);

/** Categories admins may set a commission override for. */
export const COMMISSION_CATEGORIES = Object.values(BusinessCategory);
