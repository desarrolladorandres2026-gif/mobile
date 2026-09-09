import mongoose, { Schema, Document, Types } from 'mongoose';
import { GeoPoint } from '../types';

export interface IAddress extends Document {
  userId: Types.ObjectId;
  label: string;
  address: string;
  /**
   * Piso, apartamento, torre, interior.
   *
   * Separado de `address` porque es el único dato del domicilio que ningún
   * mapa puede saber: la coordenada llega al portal, no a la puerta. Antes
   * vivía mezclado en "cómo llegar" junto a las referencias, y ahí se
   * perdía — el repartidor lee esa nota entera con el moto encendido.
   */
  apartment?: string;
  /** Barrio o vereda. Lo rellena el geocodificador, no el usuario. */
  neighborhood?: string;
  /** Municipio. Lo rellena el geocodificador, no el usuario. */
  city?: string;
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
    apartment: { type: String, default: '', trim: true },
    neighborhood: { type: String, default: '', trim: true },
    city: { type: String, default: '', trim: true },
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
