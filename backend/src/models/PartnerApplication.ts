import mongoose, { Schema, Document, Types } from 'mongoose';
import { phoneSetter } from '../utils/phone';

/**
 * Solicitud de un aliado (comercio o repartidor) desde el sitio público.
 *
 * El celular llega verificado por OTP, pero eso no crea ni modifica ninguna
 * cuenta: aprobar es una decisión de un administrador (ver
 * `partner.service.approve`). `userId` solo se rellena al aprobar, cuando
 * existe un `User` con ese celular.
 */
export const PARTNER_TYPES = ['business', 'driver'] as const;
export const PARTNER_STATUSES = ['new', 'contacted', 'approved', 'rejected'] as const;
export const PARTNER_VEHICLES = ['moto', 'bicicleta', 'carro', 'a_pie'] as const;
export type PartnerType = (typeof PARTNER_TYPES)[number];
export type PartnerStatus = (typeof PARTNER_STATUSES)[number];

export interface IPartnerApplication extends Document {
  type: PartnerType;
  name: string;
  phone: string;
  email?: string;
  city: string;
  businessName?: string;
  category?: string;
  address?: string;
  vehicleType?: (typeof PARTNER_VEHICLES)[number];
  experience?: string;
  notes?: string;
  status: PartnerStatus;
  assignedTo?: Types.ObjectId;
  adminNote?: string;
  userId?: Types.ObjectId;
  createdUserRole?: 'business' | 'driver';
  /** Negocio en borrador creado al aprobar (solo `type: 'business'`). */
  businessId?: Types.ObjectId;
  ipHash: string;
  createdAt: Date;
  updatedAt: Date;
}

const partnerApplicationSchema = new Schema<IPartnerApplication>(
  {
    type: { type: String, enum: PARTNER_TYPES, required: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    phone: { type: String, required: true, set: phoneSetter },
    email: { type: String, trim: true, lowercase: true, maxlength: 120 },
    city: { type: String, required: true, trim: true, maxlength: 80 },
    businessName: { type: String, trim: true, maxlength: 100 },
    category: { type: String, trim: true, maxlength: 60 },
    address: { type: String, trim: true, maxlength: 200 },
    vehicleType: { type: String, enum: PARTNER_VEHICLES },
    experience: { type: String, trim: true, maxlength: 1000 },
    notes: { type: String, trim: true, maxlength: 1000 },
    status: { type: String, enum: PARTNER_STATUSES, default: 'new' },
    assignedTo: { type: Schema.Types.ObjectId, ref: 'User' },
    adminNote: { type: String, trim: true, maxlength: 1000 },
    userId: { type: Schema.Types.ObjectId, ref: 'User' },
    createdUserRole: { type: String, enum: ['business', 'driver'] },
    businessId: { type: Schema.Types.ObjectId, ref: 'Business' },
    ipHash: { type: String, required: true },
  },
  { timestamps: true }
);

partnerApplicationSchema.index({ status: 1, createdAt: -1 });
partnerApplicationSchema.index({ phone: 1, type: 1 });
partnerApplicationSchema.index({ type: 1, status: 1, createdAt: -1 });

export const PartnerApplication = mongoose.model<IPartnerApplication>('PartnerApplication', partnerApplicationSchema);
