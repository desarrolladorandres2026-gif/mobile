import mongoose, { Schema, Document, Types } from 'mongoose';
import { GeoPoint } from '../types';

export interface IAddress extends Document {
  userId: Types.ObjectId;
  label: string;
  address: string;
  details?: string;
  location: GeoPoint;
  isDefault: boolean;
  createdAt: Date;
}

const addressSchema = new Schema<IAddress>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    label: { type: String, required: true, trim: true },
    address: { type: String, required: true, trim: true },
    details: { type: String, default: '' },
    location: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], required: true },
    },
    isDefault: { type: Boolean, default: false },
  },
  { timestamps: true }
);

addressSchema.index({ userId: 1 });

export const Address = mongoose.model<IAddress>('Address', addressSchema);
