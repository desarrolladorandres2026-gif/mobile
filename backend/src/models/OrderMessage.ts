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
 * Solo hay dos interlocutores: cliente y domiciliario. Por eso `readAt`
 * es un único campo y no una lista de lectores: el destinatario de un
 * mensaje siempre es "el otro". Un administrador que consulta la
 * conversación por soporte no marca nada como leído; su lectura queda en
 * la auditoría, no en el hilo.
 */
export interface IOrderMessage extends Document {
  orderId: Types.ObjectId;
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
    // Solo cliente y domiciliario escriben en el hilo. El enum lo deja
    // dicho en el esquema en vez de confiar en que ningún servicio futuro
    // se cuele con otro rol.
    senderRole: {
      type: String,
      enum: [UserRole.CLIENT, UserRole.DRIVER],
      required: true,
    },
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
