import mongoose, { Schema, Document, Types } from 'mongoose';
import { OrderCallStatus, UserRole } from '../types';

/**
 * Registro de una llamada entre el cliente y el domiciliario de un pedido.
 *
 * ZIPP no revela teléfonos. La llamada es de voz dentro de la app: el
 * servidor solo autoriza a las dos partes de un pedido activo, les abre un
 * canal de señalización y anota cuándo empezó y cuándo terminó. Nunca hay
 * un número de por medio, así que tampoco hay nada que filtrar cuando el
 * pedido termina — que es justo lo que pasa cuando dos desconocidos se
 * llaman al móvil personal para coordinar una entrega.
 *
 * No se almacena audio. Grabar una conversación privada exige base legal,
 * aviso a ambas partes y una política de retención; nada de eso existe
 * hoy, así que el modelo ni siquiera tiene dónde guardarla.
 */
export interface IOrderCall extends Document {
  orderId: Types.ObjectId;
  callerId: Types.ObjectId;
  callerRole: UserRole;
  receiverId: Types.ObjectId;
  receiverRole: UserRole;
  status: OrderCallStatus;
  startedAt: Date;
  answeredAt: Date | null;
  endedAt: Date | null;
  endedBy: Types.ObjectId | null;
  /** Segundos de conversación efectiva (desde `answeredAt`). */
  durationSeconds: number;
  endReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const orderCallSchema = new Schema<IOrderCall>(
  {
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
    callerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    callerRole: { type: String, enum: [UserRole.CLIENT, UserRole.DRIVER], required: true },
    receiverId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    receiverRole: { type: String, enum: [UserRole.CLIENT, UserRole.DRIVER], required: true },
    status: {
      type: String,
      enum: Object.values(OrderCallStatus),
      default: OrderCallStatus.RINGING,
      index: true,
    },
    startedAt: { type: Date, default: Date.now },
    answeredAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },
    endedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    durationSeconds: { type: Number, default: 0, min: 0 },
    endReason: { type: String, default: null },
  },
  { timestamps: true }
);

orderCallSchema.index({ orderId: 1, startedAt: -1 });

export const OrderCall = mongoose.model<IOrderCall>('OrderCall', orderCallSchema);
