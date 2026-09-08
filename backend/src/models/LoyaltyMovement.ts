import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * Cada movimiento de puntos de un cliente.
 *
 * Se guardan los movimientos y no un saldo, por la misma razón por la que el
 * dinero lleva un libro y no un número: un saldo suelto no se puede
 * auditar. Cuando un cliente pregunte por qué tiene 340 puntos, la respuesta
 * tiene que poder reconstruirse.
 *
 * Antes los puntos eran ficción del cliente: `useUsual.ts` los derivaba del
 * historial local del teléfono, así que cambiaban de dispositivo a
 * dispositivo y desaparecían al reinstalar.
 */
export enum LoyaltyMovementKind {
  /** Ganados por una compra entregada. */
  EARNED = 'earned',
  /** Cambiados por un cupón de descuento. */
  REDEEMED = 'redeemed',
  /** Caducados sin usarse. */
  EXPIRED = 'expired',
  /** Devueltos porque el pedido que los generó se reembolsó. */
  REVERSED = 'reversed',
  /** Ajuste manual de un administrador, siempre con motivo. */
  ADJUSTED = 'adjusted',
}

export interface ILoyaltyMovement extends Document {
  userId: Types.ObjectId;
  kind: LoyaltyMovementKind;
  /** Positivo suma, negativo resta. Nunca cero. */
  points: number;
  orderId?: Types.ObjectId | null;
  couponId?: Types.ObjectId | null;
  description: string;
  /** Cuándo caducan estos puntos. Solo en los ganados. */
  expiresAt?: Date | null;
  createdBy?: Types.ObjectId | null;
  createdAt: Date;
}

const loyaltyMovementSchema = new Schema<ILoyaltyMovement>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    kind: { type: String, enum: Object.values(LoyaltyMovementKind), required: true },
    points: {
      type: Number,
      required: true,
      validate: {
        validator: (v: number) => Number.isInteger(v) && v !== 0,
        message: 'Un movimiento de cero puntos no es un movimiento',
      },
    },
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', default: null },
    couponId: { type: Schema.Types.ObjectId, ref: 'Coupon', default: null },
    description: { type: String, required: true, maxlength: 200 },
    expiresAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Un pedido entregado otorga puntos una sola vez. El índice lo garantiza
// aunque el evento de entrega llegue dos veces, que es exactamente lo que
// pasa cuando una pasarela reintenta.
loyaltyMovementSchema.index(
  { orderId: 1, kind: 1 },
  { unique: true, partialFilterExpression: { orderId: { $type: 'objectId' }, kind: 'earned' } }
);
loyaltyMovementSchema.index({ userId: 1, createdAt: -1 });
loyaltyMovementSchema.index({ expiresAt: 1, kind: 1 });

export const LoyaltyMovement = mongoose.model<ILoyaltyMovement>(
  'LoyaltyMovement',
  loyaltyMovementSchema
);
