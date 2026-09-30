import mongoose, { Schema, Document, Types } from 'mongoose';
import { DriverStatus, VehicleType, GeoPoint } from '../types';

export interface IDriver extends Document {
  userId: Types.ObjectId;
  vehicleType: VehicleType;
  licensePlate?: string;
  /** Datos básicos de la moto, para el expediente. La placa vive en `licensePlate`. */
  vehicle?: { brand?: string; model?: string; color?: string; year?: number; engineCc?: number; ownerName?: string };
  /** Datos de la licencia que no viven en el documento: el número es la referencia de `DriverDocument` (`license`). */
  license?: { category?: string };
  /** Cuándo un administrador lo aprobó (vinculación). Los aprobados antes de este campo se leen de la auditoría. */
  approvedAt?: Date;

  /**
   * A quién avisar si algo va mal.
   *
   * Es el requisito previo del botón de pánico: una alerta que no tiene a
   * quién avisar es una alerta que solo ve un administrador, y de noche
   * puede no haber ninguno mirando. Aquí está el número de alguien a quien
   * le importa esta persona.
   */
  emergencyContact?: {
    name: string;
    phone: string;
    relationship?: string;
    /** Cuándo se guardó o cambió por última vez. */
    updatedAt?: Date;
  };
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
  /** Últimos tokens de devoluciones de fondo aplicadas (idempotencia de `unassignDriver`). No sale en respuestas. */
  fundReleaseTokens?: string[];
  rating: number;
  /** Cuántas reseñas de clientes alimentan `rating`. Antes no se contaba. */
  totalReviews: number;
  totalDeliveries: number;
  totalEarnings: number;
  isActive: boolean;
  isApproved: boolean;
  /**
   * Puntaje interno 0-100, nunca mostrado al domiciliario ni al cliente.
   * Ver el comentario equivalente en `Business.reputationScore` y
   * `reputation.service.ts`.
   */
  reputationScore: number;
  reputationUpdatedAt?: Date;
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
    emergencyContact: {
      type: new Schema(
        {
          name: { type: String, required: true, trim: true, maxlength: 80 },
          phone: { type: String, required: true, trim: true, maxlength: 20 },
          relationship: { type: String, trim: true, maxlength: 40 },
          updatedAt: { type: Date },
        },
        { _id: false }
      ),
      default: undefined,
    },
    licensePlate: {
      type: String,
      trim: true,
      uppercase: true,
    },
    vehicle: {
      type: new Schema(
        {
          brand: { type: String, trim: true, maxlength: 40 },
          model: { type: String, trim: true, maxlength: 40 },
          color: { type: String, trim: true, maxlength: 30 },
          year: { type: Number, min: 1980, max: 2100 },
          engineCc: { type: Number, min: 50, max: 2500 },
          ownerName: { type: String, trim: true, maxlength: 80 },
        },
        { _id: false }
      ),
      default: undefined,
    },
    license: {
      type: new Schema({ category: { type: String, trim: true, uppercase: true, enum: ['A1', 'A2', 'B1', 'B2', 'B3', 'C1', 'C2', 'C3'] } }, { _id: false }),
      default: undefined,
    },
    approvedAt: { type: Date },
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
    fundReleaseTokens: { type: [String], default: [], select: false },
    rating: {
      type: Number,
      default: 5,
      min: 0,
      max: 5,
    },
    totalReviews: {
      type: Number,
      default: 0,
    },
    // Igual que en Business: nunca sale de una consulta normal.
    reputationScore: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
      select: false,
    },
    reputationUpdatedAt: { type: Date, select: false },
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
