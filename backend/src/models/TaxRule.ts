import { realtimeInvalidatePlugin } from '../realtime/invalidate';
import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * Regla tributaria por concepto comercial (M-014).
 *
 * ── Por qué existe ──
 *
 * Hasta ahora había UNA tasa global (`PlatformPricingConfig.taxBps`) que se le
 * aplicaba por igual a los productos del comercio, al domicilio y a la tarifa de
 * servicio. Eso presume que los tres tienen el mismo tratamiento tributario, y
 * no hay nada en el repositorio que lo respalde. Esta colección guarda, por
 * concepto, lo que el responsable contable y tributario de ZIPP decida —tarifa,
 * base, tratamiento, condiciones y vigencia— con su respaldo, y es lo único que
 * el motor de precios, los comprobantes y los informes consultan.
 *
 * ── Qué NO hace ──
 *
 * No trae ninguna tarifa: no hay una por defecto, y una regla sin validar no se
 * usa para nada definitivo. ZIPP no sabe qué grava en Colombia cada uno de estos
 * conceptos; lo sabe quien firma la validación (`validationRef`).
 *
 * ── Vigencia ──
 *
 * Una regla validada es inmutable. Cambiar una tarifa es publicar otra regla con
 * su propia fecha de inicio (nunca en el pasado): la anterior queda cerrada el
 * mismo instante. Así un pedido de septiembre se explica con la regla de
 * septiembre aunque hoy mande otra.
 */

export enum TaxConcept {
  /** Lo que el comercio vende. Hoy el pedido le aplica la tasa global. */
  PRODUCTS = 'products',
  /** El domicilio que paga el cliente. */
  DELIVERY = 'delivery',
  /** La tarifa de servicio que ZIPP le cobra al cliente. */
  SERVICE_FEE = 'service_fee',
  /** La comisión que ZIPP le cobra al comercio. */
  COMMISSION = 'commission',
  /** La publicidad que compra un comercio. */
  ADVERTISING = 'advertising',
  /** La cuota de la membresía Zipp Pro. */
  PRO_SUBSCRIPTION = 'pro_subscription',
  /** Cualquier otro servicio comercial, existente o futuro. */
  OTHER = 'other',
}

/** Los conceptos que el checkout suma al total del cliente. */
export const CHECKOUT_TAX_CONCEPTS: readonly TaxConcept[] = [TaxConcept.PRODUCTS, TaxConcept.DELIVERY, TaxConcept.SERVICE_FEE];

export const ALL_TAX_CONCEPTS: readonly TaxConcept[] = Object.values(TaxConcept);

export enum TaxTreatment {
  /** Gravado: lleva `rateBps`. */
  TAXED = 'taxed',
  /** Exento: la ley lo declara y se factura con tarifa 0. */
  EXEMPT = 'exempt',
  /** Excluido: no es objeto del impuesto. */
  EXCLUDED = 'excluded',
  /** No aplica a este concepto en ZIPP. */
  NOT_APPLICABLE = 'not_applicable',
}

export type TaxType = 'iva' | 'consumption' | 'other';

/** Sobre qué importe se calcula: lo que el cliente paga tras descuentos, o el bruto. */
export type TaxBase = 'net_of_discounts' | 'gross';

export type TaxRuleStatus = 'draft' | 'validated' | 'superseded';

export interface ITaxRule extends Document {
  concept: TaxConcept;
  /** Solo para `other`: de qué servicio se trata. */
  label: string;
  treatment: TaxTreatment;
  taxType: TaxType;
  /** Puntos básicos (1900 = 19 %). Solo con tratamiento `taxed`; `null` en los demás. */
  rateBps: number | null;
  base: TaxBase;
  /**
   * El impuesto ya viene DENTRO del precio (se extrae) o se suma ENCIMA.
   * Checkout: siempre encima. Los demás conceptos: siempre incluido, porque hoy
   * esos cobros no tienen una línea donde sumarlo (ver `taxRule.service`).
   */
  priceIncludesTax: boolean;
  /** Condiciones de aplicación, en palabras del contador («solo si el comercio es responsable de IVA»). */
  conditions: string;
  validFrom: Date;
  /** Exclusivo. `null` = sin fin. Lo cierra la regla que la reemplaza. */
  validTo: Date | null;
  status: TaxRuleStatus;
  validatedBy?: Types.ObjectId | null;
  validatedAt?: Date | null;
  /** Documento que respalda la regla (concepto del contador, circular, radicado). Obligatorio al validar. */
  validationRef: string;
  validationNote: string;
  createdBy: Types.ObjectId;
  changeReason: string;
  createdAt: Date;
  updatedAt: Date;
}

const taxRuleSchema = new Schema<ITaxRule>(
  {
    concept: { type: String, enum: ALL_TAX_CONCEPTS, required: true },
    label: { type: String, default: '', trim: true, maxlength: 80 },
    treatment: { type: String, enum: Object.values(TaxTreatment), required: true },
    taxType: { type: String, enum: ['iva', 'consumption', 'other'], default: 'iva' },
    rateBps: {
      type: Number,
      default: null,
      min: 0,
      max: 10_000,
      validate: { validator: (v: number | null) => v == null || Number.isInteger(v), message: 'La tarifa debe estar en puntos básicos enteros' },
    },
    base: { type: String, enum: ['net_of_discounts', 'gross'], default: 'net_of_discounts' },
    priceIncludesTax: { type: Boolean, default: false },
    conditions: { type: String, default: '', trim: true, maxlength: 500 },
    validFrom: { type: Date, required: true },
    validTo: { type: Date, default: null },
    status: { type: String, enum: ['draft', 'validated', 'superseded'], default: 'draft' },
    validatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    validatedAt: { type: Date, default: null },
    validationRef: { type: String, default: '', trim: true, maxlength: 300 },
    validationNote: { type: String, default: '', trim: true, maxlength: 500 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    changeReason: { type: String, default: '', trim: true, maxlength: 300 },
  },
  { timestamps: true }
);

/** Coherencia que ninguna ruta puede saltarse: una tarifa solo existe en un tratamiento gravado. */
taxRuleSchema.pre('validate', function (next) {
  if (this.treatment === TaxTreatment.TAXED) {
    if (this.rateBps == null) return next(new Error('Un concepto gravado necesita su tarifa'));
  } else if (this.rateBps != null && this.rateBps !== 0) {
    return next(new Error('Solo un concepto gravado lleva tarifa'));
  }
  if (this.validTo && this.validTo <= this.validFrom) {
    return next(new Error('La vigencia debe terminar después de empezar'));
  }
  if (this.concept === TaxConcept.OTHER && !this.label) {
    return next(new Error('Indica de qué servicio se trata'));
  }
  next();
});

taxRuleSchema.index({ concept: 1, status: 1, validFrom: -1 });

taxRuleSchema.plugin(realtimeInvalidatePlugin, { resource: 'finance' });
export const TaxRule = mongoose.model<ITaxRule>('TaxRule', taxRuleSchema);
