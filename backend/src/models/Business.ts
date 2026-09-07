import mongoose, { Schema, Document, Types } from 'mongoose';
import { BusinessCategory, GeoPoint, WeekSchedule } from '../types';

export interface IBusiness extends Document {
  ownerId: Types.ObjectId;
  name: string;
  slug: string;
  description: string;
  logo?: string;
  coverImage?: string;
  category: BusinessCategory;
  address: string;
  location: GeoPoint;
  phone: string;
  rating: number;
  totalReviews: number;
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
    this.slug = this.name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
  }
  next();
});

// Geospatial index
businessSchema.index({ location: '2dsphere' });
businessSchema.index({ category: 1, isActive: 1 });
businessSchema.index({ city: 1, isActive: 1 });
businessSchema.index({ isApproved: 1, isActive: 1 });
// `slug` already declares `unique: true` on the path, which creates the index.
businessSchema.index({ isFeatured: 1 });

// Virtual: products
businessSchema.virtual('products', {
  ref: 'Product',
  localField: '_id',
  foreignField: 'businessId',
});

export const Business = mongoose.model<IBusiness>('Business', businessSchema);
