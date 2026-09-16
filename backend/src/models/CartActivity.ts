import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * Foto del carrito de un cliente, mandada desde el teléfono.
 *
 * No es el carrito en sí —ese sigue viviendo solo en el celular, como
 * siempre— sino lo mínimo para poder avisarle si lo dejó lleno y sin
 * comprar: qué negocio, cuántos productos, cuánto suma, y cuándo lo tocó
 * por última vez. Un documento por usuario; se borra en cuanto vacía la
 * bolsa o confirma el pedido.
 */
export interface ICartActivity extends Document {
  userId: Types.ObjectId;
  businessId: Types.ObjectId;
  businessName: string;
  itemCount: number;
  subtotal: number;
  /** Se resetea cada vez que el carrito cambia; el barrido solo mira esto. */
  remindedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const cartActivitySchema = new Schema<ICartActivity>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true },
    businessName: { type: String, required: true },
    itemCount: { type: Number, required: true, min: 1 },
    subtotal: { type: Number, required: true, min: 0 },
    remindedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// El barrido busca carritos viejos sin recordatorio todavía.
cartActivitySchema.index({ remindedAt: 1, updatedAt: 1 });

export const CartActivity = mongoose.model<ICartActivity>('CartActivity', cartActivitySchema);
