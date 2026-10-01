import { realtimeInvalidatePlugin } from '../realtime/invalidate';
import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * Una emergencia declarada por un domiciliario.
 *
 * El botón de pánico existe porque repartir de noche en moto tiene riesgos
 * reales, y porque la app ya sabe dónde está esa persona: el seguimiento
 * está montado, las salas de socket existen, el mapa de flota funciona. Lo
 * que faltaba era una forma de decir "esto no es un pedido, esto es una
 * emergencia" y que el sistema tratara los mismos datos con otra urgencia.
 *
 * Se guarda como documento y no como un simple evento porque una emergencia
 * tiene ciclo de vida: alguien tiene que atenderla y alguien tiene que
 * cerrarla diciendo qué pasó. Un aviso que se emite y se pierde no sirve
 * para revisar después si la respuesta fue buena.
 */
export enum SosStatus {
  /** Recién declarada. Nadie la ha atendido todavía. */
  ACTIVE = 'active',
  /** Un administrador la vio y está en ello. */
  ACKNOWLEDGED = 'acknowledged',
  /** Terminó. El desenlace queda en `resolution`. */
  RESOLVED = 'resolved',
  /** Se activó por error. Se conserva igual: los falsos también informan. */
  FALSE_ALARM = 'false_alarm',
}

export interface ISosAlert extends Document {
  driverId: Types.ObjectId;
  userId: Types.ObjectId;
  /** El pedido que llevaba, si llevaba alguno. */
  orderId?: Types.ObjectId | null;
  status: SosStatus;
  /** Dónde estaba al pulsar. Es el dato que más importa de todos. */
  location: { type: 'Point'; coordinates: [number, number] };
  /** Lo que el domiciliario alcanzó a escribir, si escribió algo. */
  note?: string;
  /** Copia del contacto en ese momento: si lo cambia después, este no cambia. */
  emergencyContact?: { name: string; phone: string; relationship?: string };
  acknowledgedBy?: Types.ObjectId | null;
  acknowledgedAt?: Date | null;
  resolvedBy?: Types.ObjectId | null;
  resolvedAt?: Date | null;
  resolution?: string;
  createdAt: Date;
  updatedAt: Date;
}

const sosAlertSchema = new Schema<ISosAlert>(
  {
    driverId: { type: Schema.Types.ObjectId, ref: 'Driver', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', default: null },
    status: { type: String, enum: Object.values(SosStatus), default: SosStatus.ACTIVE },
    location: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], required: true },
    },
    note: { type: String, maxlength: 300 },
    emergencyContact: {
      type: new Schema(
        {
          name: String,
          phone: String,
          relationship: String,
        },
        { _id: false }
      ),
      default: undefined,
    },
    acknowledgedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    acknowledgedAt: { type: Date, default: null },
    resolvedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    resolvedAt: { type: Date, default: null },
    resolution: { type: String, maxlength: 500 },
  },
  { timestamps: true }
);

// La consulta que importa es "¿hay algo abierto ahora mismo?", y tiene que
// ser instantánea aunque la colección crezca durante años.
sosAlertSchema.index({ status: 1, createdAt: -1 });
sosAlertSchema.index({ driverId: 1, createdAt: -1 });
sosAlertSchema.index({ location: '2dsphere' });

sosAlertSchema.plugin(realtimeInvalidatePlugin, { resource: 'support' });
export const SosAlert = mongoose.model<ISosAlert>('SosAlert', sosAlertSchema);
