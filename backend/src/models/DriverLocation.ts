import mongoose, { Schema, Document, Types } from 'mongoose';
import { GeoPoint } from '../types';
import { config } from '../config';

/**
 * Un punto del rastro de un repartidor.
 *
 * `Driver.currentLocation` guarda *dónde está* y se sobrescribe en cada
 * ping. Esto guarda *por dónde pasó*, que es otra cosa y sirve para lo que
 * el último punto no puede resolver:
 *
 * - Dibujar el avance real en la pantalla del cliente en vez de un salto
 *   entre dos posiciones.
 * - Defender una entrega disputada: "el repartidor sí estuvo en la puerta
 *   a las 19:42" es una afirmación que necesita historial.
 * - Detectar desvíos comparando el rastro con la ruta propuesta.
 *
 * OJO con el nombre: `Position` en este proyecto es el *Cargo* del sistema
 * de permisos (Usuario → Cargo → Rol → Permiso), nada que ver con GPS.
 *
 * Los documentos se borran solos pasado `TRACKING_HISTORY_DAYS`. Un rastro
 * es dato personal de alta resolución —dice dónde vive y dónde almuerza una
 * persona— así que conservarlo indefinidamente no es prudencia, es riesgo
 * acumulado.
 */
export interface IDriverLocation extends Document {
  _id: Types.ObjectId;
  driverId: Types.ObjectId;
  /** El `User` del repartidor. Es la clave de las salas de socket. */
  userId: Types.ObjectId;
  /** Pedido que se estaba entregando, si lo había. */
  orderId?: Types.ObjectId | null;
  location: GeoPoint;
  /** Radio de incertidumbre en metros, tal como lo reporta el dispositivo. */
  accuracy?: number;
  /** Rumbo en grados (0 = norte). Orienta el icono en el mapa. */
  heading?: number;
  /** Velocidad en m/s. Alimenta el muestreo adaptativo del cliente. */
  speed?: number;
  /** Batería 0-100. Un repartidor al 8% no debería estar mandando a 5 s. */
  batteryLevel?: number;
  /** Si el sistema operativo lo reportó como simulado. Señal antifraude. */
  isMocked?: boolean;
  recordedAt: Date;
  createdAt: Date;
}

const driverLocationSchema = new Schema<IDriverLocation>(
  {
    driverId: { type: Schema.Types.ObjectId, ref: 'Driver', required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', default: null },
    location: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], required: true },
    },
    accuracy: { type: Number, min: 0 },
    heading: { type: Number, min: 0, max: 360 },
    speed: { type: Number, min: 0 },
    batteryLevel: { type: Number, min: 0, max: 100 },
    isMocked: { type: Boolean, default: false },
    recordedAt: { type: Date, required: true, default: Date.now },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Reproducir el recorrido de un pedido en orden es *la* consulta de esta
// colección: la pantalla de seguimiento y la auditoría de una entrega
// piden exactamente esto.
driverLocationSchema.index({ orderId: 1, recordedAt: 1 });

// El turno de un repartidor, para el panel admin y para la conciliación.
driverLocationSchema.index({ driverId: 1, recordedAt: -1 });

driverLocationSchema.index({ location: '2dsphere' });

// Borrado automático: MongoDB elimina el documento pasado el plazo sin que
// nadie tenga que acordarse de una tarea de limpieza.
driverLocationSchema.index(
  { recordedAt: 1 },
  { expireAfterSeconds: config.tracking.historyRetentionDays * 24 * 60 * 60 }
);

export const DriverLocation = mongoose.model<IDriverLocation>(
  'DriverLocation',
  driverLocationSchema
);
