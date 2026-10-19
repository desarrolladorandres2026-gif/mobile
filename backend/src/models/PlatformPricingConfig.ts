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
  /**
   * M-014: calcular el impuesto del pedido con las reglas por concepto
   * (`TaxRule`) en vez de la tasa global `taxBps`. Apagado de fábrica: solo se
   * enciende cuando los tres conceptos del checkout tienen una regla validada y
   * vigente (`taxRuleService.assertCanEnableCheckoutRules`). Apagarlo vuelve a la
   * tasa global.
   */
  taxRulesEnabled: boolean;

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
  /**
   * M-013 — lo que el domiciliario conserva si el pedido se cancela ANTES de
   * entregarlo, como porcentaje (bps) de su tarifa de domicilio. 0 = nada, que es
   * la regla de siempre: las cifras las decide el negocio, no el código.
   *  · `Assigned`: con domiciliario asignado y el pedido todavía sin recoger.
   *  · `PickedUp`: el pedido ya está recogido o en camino.
   * No aplica si cancela el propio domiciliario. Lo asume ZIPP.
   */
  driverCancelPayAssignedBps: number;
  driverCancelPayPickedUpBps: number;

  // ── Comisión de la pasarela (Wompi) ──
  /**
   * Tarifa contratada por método, en bps sobre el cobro + un fijo en COP.
   * Todo en 0 significa "sin configurar": no se asienta gasto y el resultado
   * de la plataforma sigue marcado como incompleto. El dueño la llena con su
   * contrato; ninguna cifra viene inventada.
   */
  gatewayCardBps: number;
  gatewayCardFixed: number;
  gatewayPseBps: number;
  gatewayPseFixed: number;
  gatewayNequiBps: number;
  gatewayNequiFixed: number;
  gatewayOtherBps: number;
  gatewayOtherFixed: number;
  /** IVA que la pasarela le suma a su propia comisión. */
  gatewayFeeVatBps: number;
  /**
   * Sobre qué se calcula el IVA de la comisión: `total` = porcentaje + fijo
   * (comportamiento histórico), `fixed` = solo la tarifa fija. Se confirma
   * con el contrato de Wompi; mientras tanto conserva el comportamiento previo.
   */
  gatewayFeeVatBase: 'total' | 'fixed';
  /**
   * Qué parte de la comisión devuelve la pasarela al reembolsar, en bps:
   * 0 = no reembolsable, 10000 = toda, intermedio = parcial. `null` = sin
   * definir (no se asume nada). Desde M-005 SÍ altera el libro: al reembolsar,
   * la parte que la pasarela devuelve reduce el gasto de pasarela del pedido
   * (`refundService.recordGatewayFeeAdjustment`), proporcional a lo reembolsado.
   */
  gatewayFeeRefundBps: number | null;
  /**
   * Costo fijo, en COP y antes de IVA, que la pasarela cobra por cada reembolso
   * o anulación, y por cada contracargo. 0 = sin costo (o sin confirmar: ver
   * `gatewayFeeReadiness`). El IVA de `gatewayFeeVatBps` se les suma.
   */
  gatewayRefundFixed: number;
  gatewayChargebackFixed: number;
  /**
   * Documento que respalda las tarifas de arriba (contrato, anexo, fecha). Vacío
   * = tarifas sin verificar: los informes las muestran como estimación
   * provisional. Escribirlo es la atestación del responsable de ZIPP, no una
   * validación automática.
   */
  gatewayContractRef: string;

  // ── Publicidad por autoservicio (2026-10-17) ──
  //
  // Los interruptores nacen apagados. Los rangos nacen con los valores de
  // lanzamiento (`AD_LAUNCH_OFFER`); 0 significa «sin configurar» y bloquea la
  // compra, una aprobación y el cobro. ZIPP los ajusta en Tarifas y
  // Monetización. Quien interpreta estos campos es `adOffer`
  // (advertisement.service.ts).
  /** Interruptor de la compra por autoservicio en el panel de comercios. */
  adSelfServiceEnabled: boolean;
  /** Interruptor general de cobro: apagado, ninguna campaña de comercio se aprueba, se sirve ni suma clics cobrables. */
  adBillingEnabled: boolean;
  adCpcEnabled: boolean;
  /** COP por clic. */
  adCpcMinRate: number;
  adCpcMaxRate: number;
  /**
   * CPM queda preparado pero cerrado: el validador solo acepta `false` hasta
   * que existan sus reglas (verificación de impresiones, antifraude).
   */
  adCpmEnabled: boolean;
  adCpmMinRate: number;
  adCpmMaxRate: number;
  /** Tope de gasto por campaña, COP. */
  adMinBudget: number;
  adMaxBudget: number;
  adMinDurationDays: number;
  adMaxDurationDays: number;
  /** Dónde puede salir lo que compra un comercio; vacío = en ningún lado. */
  adPlacements: string[];
  /** Un clic cobrable por dispositivo y campaña dentro de esta ventana. */
  adClickDedupeWindowMinutes: number;
  /** El clic solo cobra si ese dispositivo vio la campaña en este lapso. */
  adClickImpressionWindowMinutes: number;
  /** Clics cobrables por IP, campaña y día; 0 = sin límite. */
  adMaxBillableClicksPerIpPerDay: number;
  /** Renovación automática: no existe en el lanzamiento; el validador solo acepta `false`. */
  adAutoRenewEnabled: boolean;

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

/**
 * Valores de lanzamiento de la oferta de publicidad, decididos por el dueño de
 * ZIPP el 2026-10-19. Son el punto de partida de una base nueva y lo que
 * aplica la migración 032 donde nadie había configurado nada: después se
 * ajustan desde Tarifas y Monetización, sin tocar código.
 *
 * Los interruptores (`adSelfServiceEnabled`, `adBillingEnabled`, `adCpcEnabled`)
 * siguen apagados: tener la oferta definida no abre la compra.
 *
 * Ubicaciones: solo existen dos superficies publicitarias implementadas
 * (`splash`, `explore`). «Resultados de búsqueda» y «listado de negocios» no
 * existen todavía y no pueden ofrecerse. El lanzamiento usa `explore`, el feed
 * de descubrimiento; `splash` (pantalla completa al abrir la app) se activa
 * a propósito desde el panel.
 */
export const AD_LAUNCH_OFFER = {
  adCpcMinRate: 100,
  adCpcMaxRate: 1_000,
  adMinBudget: 10_000,
  adMaxBudget: 500_000,
  adMinDurationDays: 1,
  adMaxDurationDays: 30,
  adPlacements: ['explore'] as string[],
} as const;

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
    taxRulesEnabled: { type: Boolean, default: false },

    couponSubsidyLimit: { ...money, default: 20000 },
    campaignBudgetTotal: { ...money, default: 0 },
    defaultMinimumContributionMargin: { ...money, default: 0 },

    cashOnDeliveryEnabled: { type: Boolean, default: false },
    cashOnDeliveryMaxAmount: { ...money, default: 150000 },
    maxDriverCashDebt: { ...money, default: 50000 },
    driverCancelPayAssignedBps: { ...bps, default: 0 },
    driverCancelPayPickedUpBps: { ...bps, default: 0 },

    gatewayCardBps: { ...bps, default: 0 },
    gatewayCardFixed: { ...money, default: 0 },
    gatewayPseBps: { ...bps, default: 0 },
    gatewayPseFixed: { ...money, default: 0 },
    gatewayNequiBps: { ...bps, default: 0 },
    gatewayNequiFixed: { ...money, default: 0 },
    gatewayOtherBps: { ...bps, default: 0 },
    gatewayOtherFixed: { ...money, default: 0 },
    gatewayFeeVatBps: { ...bps, default: 0 },
    gatewayFeeVatBase: { type: String, enum: ['total', 'fixed'], default: 'total' },
    gatewayFeeRefundBps: { type: Number, default: null, min: 0, max: 10000, validate: (v: number | null) => v == null || Number.isInteger(v) },
    gatewayRefundFixed: { ...money, default: 0 },
    gatewayChargebackFixed: { ...money, default: 0 },
    gatewayContractRef: { type: String, default: '', trim: true, maxlength: 200 },
    adSelfServiceEnabled: { type: Boolean, default: false },
    adBillingEnabled: { type: Boolean, default: false },
    adCpcEnabled: { type: Boolean, default: false },
    adCpcMinRate: { ...money, default: AD_LAUNCH_OFFER.adCpcMinRate },
    adCpcMaxRate: { ...money, default: AD_LAUNCH_OFFER.adCpcMaxRate },
    adCpmEnabled: { type: Boolean, default: false },
    adCpmMinRate: { ...money, default: 0 },
    adCpmMaxRate: { ...money, default: 0 },
    adMinBudget: { ...money, default: AD_LAUNCH_OFFER.adMinBudget },
    adMaxBudget: { ...money, default: AD_LAUNCH_OFFER.adMaxBudget },
    adMinDurationDays: { ...money, default: AD_LAUNCH_OFFER.adMinDurationDays },
    adMaxDurationDays: { ...money, default: AD_LAUNCH_OFFER.adMaxDurationDays },
    adPlacements: { type: [{ type: String, enum: ['splash', 'explore'] }], default: () => [...AD_LAUNCH_OFFER.adPlacements] },
    // Controles antifraude, no tarifas: un valor técnico de arranque que se
    // ajusta sin desplegar (un clic por dispositivo y día, impresión en los
    // últimos 30 min, 10 clics cobrables por red y día).
    adClickDedupeWindowMinutes: { ...money, default: 1440 },
    adClickImpressionWindowMinutes: { ...money, default: 30 },
    adMaxBillableClicksPerIpPerDay: { ...money, default: 10 },
    adAutoRenewEnabled: { type: Boolean, default: false },

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
  // Publicidad: un rango con el mínimo por encima del máximo no se guarda.
  // Un extremo en 0 sí: significa «sin configurar» y bloquea la compra.
  const ranges: Array<[number, number, string]> = [
    [this.adCpcMinRate, this.adCpcMaxRate, 'El CPC mínimo no puede superar el máximo'],
    [this.adCpmMinRate, this.adCpmMaxRate, 'El CPM mínimo no puede superar el máximo'],
    [this.adMinBudget, this.adMaxBudget, 'El presupuesto mínimo de publicidad no puede superar el máximo'],
    [this.adMinDurationDays, this.adMaxDurationDays, 'La duración mínima de una campaña no puede superar la máxima'],
  ];
  for (const [min, max, message] of ranges) {
    if ((min ?? 0) > 0 && (max ?? 0) > 0 && min > max) return next(new Error(message));
  }
  if (this.adCpmEnabled || this.adAutoRenewEnabled) {
    return next(new Error('CPM y la renovación automática todavía no están disponibles'));
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
