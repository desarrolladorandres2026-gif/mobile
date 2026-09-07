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

export interface IAdvertisement extends Document {
  campaignName: string;
  advertiserName: string;
  flyerUrl: string;
  startDate: Date;
  endDate: Date;
  isActive: boolean;
  /** Higher runs first when several campaigns are eligible at once. */
  priority: number;
  actionType: AdActionType;
  /** Required when actionType = BUSINESS. */
  businessId?: Types.ObjectId | null;
  /** Impressions this campaign may serve in total. 0 = unlimited. */
  maxImpressions: number;
  impressionCount: number;
  clickCount: number;
  /** Seconds the flyer stays on screen before the app moves on by itself. */
  durationSeconds: number;
  /** What ZIPP charged the advertiser. Never leaves the admin panel. */
  pricePaid: number;
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
    impressionCount: { type: Number, default: 0, min: 0 },
    clickCount: { type: Number, default: 0, min: 0 },
    durationSeconds: {
      type: Number,
      default: AD_DURATION.default,
      min: AD_DURATION.min,
      max: AD_DURATION.max,
    },
    pricePaid: { type: Number, default: 0, min: 0 },
    internalNotes: { type: String, default: '', trim: true, maxlength: 500 },
    cancelledAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Powers the "active campaign for the app" lookup: active flag, in-range
// dates, best priority first.
advertisementSchema.index({ isActive: 1, startDate: 1, endDate: 1, priority: -1 });

export const Advertisement = mongoose.model<IAdvertisement>('Advertisement', advertisementSchema);
