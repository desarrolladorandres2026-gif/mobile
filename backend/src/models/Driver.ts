import mongoose, { Schema, Document, Types } from 'mongoose';
import { DriverStatus, VehicleType, GeoPoint } from '../types';

export interface IDriver extends Document {
  userId: Types.ObjectId;
  vehicleType: VehicleType;
  licensePlate?: string;
  status: DriverStatus;
  currentLocation: GeoPoint;
  /**
   * Cuándo se recibió la última posición.
   *
   * Sin esta marca, `currentLocation` es una coordenada sin fecha: el panel
   * admin no puede distinguir a un repartidor parado en un semáforo de uno
   * que perdió señal hace media hora, y ambos se verían igual de vivos en
   * el mapa. Es la diferencia entre un mapa y un mapa en el que se puede
   * confiar.
   */
  lastLocationAt?: Date;
  /** Rumbo en grados del último fix. Orienta el icono en el mapa. */
  heading?: number;
  /** Velocidad en m/s del último fix. */
  speed?: number;
  /** Precisión en metros del último fix. */
  locationAccuracy?: number;
  /** Batería del dispositivo 0-100, reportada con la ubicación. */
  batteryLevel?: number;
  baseFund: number;
  currentFund: number;
  rating: number;
  totalDeliveries: number;
  totalEarnings: number;
  isActive: boolean;
  isApproved: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const driverSchema = new Schema<IDriver>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },
    vehicleType: {
      type: String,
      enum: Object.values(VehicleType),
      default: VehicleType.MOTORCYCLE,
    },
    licensePlate: {
      type: String,
      trim: true,
      uppercase: true,
    },
    status: {
      type: String,
      enum: Object.values(DriverStatus),
      default: DriverStatus.OFFLINE,
    },
    currentLocation: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point',
      },
      coordinates: {
        type: [Number],
        default: [0, 0],
      },
    },
    lastLocationAt: { type: Date },
    heading: { type: Number, min: 0, max: 360 },
    speed: { type: Number, min: 0 },
    locationAccuracy: { type: Number, min: 0 },
    batteryLevel: { type: Number, min: 0, max: 100 },
    baseFund: {
      type: Number,
      default: 50000,
      min: 0,
    },
    currentFund: {
      type: Number,
      default: 50000,
      min: 0,
    },
    rating: {
      type: Number,
      default: 5,
      min: 0,
      max: 5,
    },
    totalDeliveries: {
      type: Number,
      default: 0,
    },
    totalEarnings: {
      type: Number,
      default: 0,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    isApproved: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

driverSchema.index({ currentLocation: '2dsphere' });
driverSchema.index({ status: 1, isActive: 1, isApproved: 1 });
// `userId` already declares `unique: true` on the path, which creates the index.

export const Driver = mongoose.model<IDriver>('Driver', driverSchema);
