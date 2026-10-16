import mongoose, { Schema, Document, Types } from 'mongoose';
import { UserRole } from '../types';

/**
 * Un mensaje del chat de un pedido.
 *
 * La conversación no es una entidad propia: *es* el pedido. No hay
 * "chats" que crear, unirse o abandonar, y por tanto no hay forma de que
 * alguien acabe dentro de una conversación a la que no pertenece — el
 * único identificador que existe es `orderId`, y quién puede leerlo se
 * deriva del propio pedido en cada petición.
 *
 * Hay dos hilos por pedido y en cada uno solo dos interlocutores: el domiciliario
 * habla con el cliente (`client_driver`) y, aparte, con el comercio
 * (`business_driver`). El cliente nunca ve el hilo del comercio ni el comercio
 * el del cliente: el primero puede estar contando dónde vive (auditoría
 * 2026-10-01, MEDIO 5), y el segundo no tiene por qué saberlo. Por eso `readAt`
 * es un único campo y no una lista de lectores: el destinatario de un mensaje
 * siempre es "el otro" de su hilo. Un administrador que consulta la
 * conversación por soporte no marca nada como leído; su lectura queda en la
 * auditoría, no en el hilo.
 */

export const CHAT_CHANNELS = ['client_driver', 'business_driver'] as const;
export type ChatChannel = (typeof CHAT_CHANNELS)[number];
export interface IOrderMessage extends Document {
  orderId: Types.ObjectId;
  /** Hilo al que pertenece. Los mensajes anteriores a esta columna no la tienen: son `client_driver`. */
  channel?: ChatChannel;
  senderId: Types.ObjectId;
  senderRole: UserRole;
  message: string;
  readAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const orderMessageSchema = new Schema<IOrderMessage>(
  {
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
    senderId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    // Solo cliente, domiciliario y comercio escriben. El enum lo deja
    // dicho en el esquema en vez de confiar en que ningún servicio futuro
    // se cuele con otro rol.
    senderRole: {
      type: String,
      enum: [UserRole.CLIENT, UserRole.DRIVER, UserRole.BUSINESS],
      required: true,
    },
    channel: { type: String, enum: CHAT_CHANNELS, default: 'client_driver' },
    message: { type: String, required: true, trim: true, maxlength: 2000 },
    readAt: { type: Date, default: null },
  },
  { timestamps: true }
);

orderMessageSchema.index({ orderId: 1, createdAt: 1 });
// Contador de no leídos por pedido: el filtro exacto que usa la app.
orderMessageSchema.index({ orderId: 1, senderId: 1, readAt: 1 });

export const OrderMessage = mongoose.model<IOrderMessage>(
  'OrderMessage',
  orderMessageSchema
);
