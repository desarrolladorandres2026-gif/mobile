import mongoose, { Schema, Document, Types } from 'mongoose';

/** What happens when the user taps the flyer. */
export enum AdActionType {
  /** Navigates in-app to a business page. */
  BUSINESS = 'business',
  /** The flyer is purely informational; tapping it just closes it. */
  NONE = 'none',
}

/** How long the app holds the flyer on screen before it continues on its own. */
export const AD_DURATION = { min: 3, max: 15, default: 5 } as const;

/**
 * Cómo se le cobra al anunciante.
 *
 * `flat` es lo que había: un precio cerrado que el equipo comercial pacta
 * por fuera y un admin anota. Los otros dos son lo que hace falta para que
 * un comercio pueda comprar solo, sin que nadie negocie nada.
 */
export enum AdPricingModel {
  /** Precio cerrado por la campaña entera. */
  FLAT = 'flat',
  /** Por cada mil impresiones servidas. */
  CPM = 'cpm',
  /** Por cada clic. */
  CPC = 'cpc',
}

/**
 * Dónde se le enseña la campaña a la app.
 *
 * `SPLASH` es lo que había: el flyer a pantalla completa al abrir la app.
 * `EXPLORE` la intercala entre las colecciones de Explorar, mezclada con los
 * banners gratuitos de `PromotionBanner`. Fija por campaña — nunca cambia
 * una vez que registró impresiones o clics (`advertisement.controller.ts`),
 * porque los contadores son un total único por documento: si una campaña
 * pudiera repartirse entre dos superficies, `spendOf` ya no podría explicar
 * en cuál se gastó cada peso.
 */
export enum AdPlacement {
  SPLASH = 'splash',
  EXPLORE = 'explore',
}

/**
 * En qué punto de la revisión está una campaña.
 *
 * Solo importa en las que compra un comercio por su cuenta: las que crea un
 * admin nacen aprobadas, porque el propio hecho de que las cree un admin es
 * la aprobación. Un comercio no puede publicar en la app de ZIPP sin que
 * alguien mire lo que va a salir.
 */
export enum AdApprovalStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
}

export interface IAdvertisement extends Document {
  campaignName: string;
  advertiserName: string;
  flyerUrl: string;
  startDate: Date;
  endDate: Date;
  isActive: boolean;
  /** Higher runs first when several campaigns are eligible at once. */
  priority: number;
  placement: AdPlacement;

  /**
   * A quién se le enseña.
   *
   * Listas vacías significan "a todos", que es lo que había antes y sigue
   * siendo el caso normal. Mandarle a todo Garzón la promoción de una
   * pizzería es tolerable; mandársela a alguien de otro municipio es
   * quemar impresiones que el anunciante paga.
   */
  targetCities: string[];
  targetCategories: string[];
  targetRoles: string[];

  /**
   * Cuántas veces puede ver esto la misma persona.
   *
   * Cero: sin límite. El anunciante paga por impresiones, así que
   * enseñarle el mismo anuncio quince veces al mismo usuario le cobra
   * quince veces por un alcance de uno.
   */
  maxImpressionsPerUser: number;
  actionType: AdActionType;
  /** Required when actionType = BUSINESS. */
  businessId?: Types.ObjectId | null;
  /** Impressions this campaign may serve in total. 0 = unlimited. */
  maxImpressions: number;
  /**
   * Clics que puede llegar a pagar. Cero = sin tope.
   *
   * Existe por la misma razón que `maxImpressions` y llegó mucho después:
   * `registerClick` no comprobaba nada, así que una campaña con el tope de
   * impresiones agotado seguía cobrando clics sin límite.
   */
  maxClicks: number;
  impressionCount: number;
  clickCount: number;
  /** Seconds the flyer stays on screen before the app moves on by itself. */
  durationSeconds: number;
  /** What ZIPP charged the advertiser. Never leaves the admin panel. */
  pricePaid: number;

  // ── Facturación ──

  pricingModel: AdPricingModel;
  /** Pesos por cada mil impresiones. Solo con `cpm`. */
  cpmRate: number;
  /** Pesos por clic. Solo con `cpc`. */
  cpcRate: number;
  /**
   * Tope de gasto. Cero significa sin tope.
   *
   * Obligatorio en las campañas que compra un comercio: sin él está
   * firmando un gasto abierto contra una liquidación que todavía no ha
   * cobrado, y el primer disgusto se lo lleva cuando le llegue.
   */
  budget: number;
  /** A quién se le cobra. Nulo en las campañas que vende ZIPP por fuera. */
  billedToBusinessId?: Types.ObjectId | null;
  approvalStatus: AdApprovalStatus;
  /** Por qué se rechazó, para que el comercio pueda corregir y reenviar. */
  rejectionReason: string;
  /** Notas internas del equipo comercial. Nunca sale del panel. */
  internalNotes: string;
  /**
   * Momento en que un admin la canceló. Distinto de pausarla: una campaña
   * cancelada es un estado terminal — no se puede reactivar, a diferencia
   * de `isActive: false`, que sí se revierte con "Reactivar".
   */
  cancelledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const advertisementSchema = new Schema<IAdvertisement>(
  {
    campaignName: {
      type: String,
      required: [true, 'El nombre de la campaña es requerido'],
      trim: true,
      maxlength: [100, 'El nombre de la campaña no puede exceder 100 caracteres'],
    },
    advertiserName: {
      type: String,
      required: [true, 'El nombre del anunciante es requerido'],
      trim: true,
      maxlength: [100, 'El nombre del anunciante no puede exceder 100 caracteres'],
    },
    flyerUrl: {
      type: String,
      required: [true, 'El flyer es requerido'],
      trim: true,
    },
    startDate: {
      type: Date,
      required: [true, 'La fecha de inicio es requerida'],
    },
    endDate: {
      type: Date,
      required: [true, 'La fecha de finalización es requerida'],
      validate: {
        validator(this: IAdvertisement, v: Date) {
          return !this.startDate || v > this.startDate;
        },
        message: 'La fecha de finalización debe ser posterior a la de inicio',
      },
    },
    isActive: { type: Boolean, default: true },
    priority: { type: Number, default: 0, min: 0, max: 100 },
    placement: {
      type: String,
      enum: Object.values(AdPlacement),
      default: AdPlacement.SPLASH,
    },
    targetCities: { type: [String], default: [] },
    targetCategories: { type: [String], default: [] },
    targetRoles: { type: [String], default: [] },
    maxImpressionsPerUser: { type: Number, default: 0, min: 0 },
    actionType: {
      type: String,
      enum: Object.values(AdActionType),
      default: AdActionType.NONE,
    },
    businessId: {
      type: Schema.Types.ObjectId,
      ref: 'Business',
      default: null,
      validate: {
        validator(this: IAdvertisement, v: Types.ObjectId | null) {
          if (this.actionType !== AdActionType.BUSINESS) return true;
          return !!v;
        },
        message: 'La campaña requiere un negocio para su acción',
      },
    },
    maxImpressions: { type: Number, default: 0, min: 0 },
    maxClicks: { type: Number, default: 0, min: 0 },
    impressionCount: { type: Number, default: 0, min: 0 },
    clickCount: { type: Number, default: 0, min: 0 },
    durationSeconds: {
      type: Number,
      default: AD_DURATION.default,
      min: AD_DURATION.min,
      max: AD_DURATION.max,
    },
    pricePaid: { type: Number, default: 0, min: 0 },

    pricingModel: {
      type: String,
      enum: Object.values(AdPricingModel),
      default: AdPricingModel.FLAT,
    },
    cpmRate: { type: Number, default: 0, min: 0 },
    cpcRate: { type: Number, default: 0, min: 0 },
    budget: { type: Number, default: 0, min: 0 },
    billedToBusinessId: { type: Schema.Types.ObjectId, ref: 'Business', default: null },
    approvalStatus: {
      type: String,
      enum: Object.values(AdApprovalStatus),
      // Las campañas de siempre las crea un admin y salen aprobadas: no
      // tendría sentido que el admin tuviera que aprobarse a sí mismo, y
      // este default deja intactas las que ya existen en la base.
      default: AdApprovalStatus.APPROVED,
    },
    rejectionReason: { type: String, default: '', trim: true, maxlength: 300 },

    internalNotes: { type: String, default: '', trim: true, maxlength: 500 },
    cancelledAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Powers the "active campaign for the app" lookup: superficie primero
// (`getActiveForApp` siempre filtra por `placement`), luego el mismo criterio
// de antes — activa, dentro de fecha, mejor prioridad primero.
advertisementSchema.index({ placement: 1, isActive: 1, startDate: 1, endDate: 1, priority: -1 });

export const Advertisement = mongoose.model<IAdvertisement>('Advertisement', advertisementSchema);
