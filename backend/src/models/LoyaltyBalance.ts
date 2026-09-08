import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * Saldo de puntos de un cliente, para poder debitarlo de forma atómica.
 *
 * El libro de verdad sigue siendo `LoyaltyMovement`: es el que explica de
 * dónde sale cada punto y el que se audita. Este documento es un derivado,
 * y existe por una razón muy concreta.
 *
 * Sumar los movimientos para decidir si alcanza, y después escribir el
 * canje, son dos pasos — y entre ellos cabe otro canje. Dos peticiones
 * simultáneas leerían el mismo saldo, las dos pasarían la comprobación y
 * el cliente se llevaría dos cupones habiendo pagado una vez. Es
 * exactamente la carrera que ya apareció cinco veces en este proyecto con
 * el fondo del domiciliario y con el reclamo de pedidos.
 *
 * Con un saldo materializado la condición viaja dentro de la escritura:
 * `findOneAndUpdate({ balance: { $gte: puntos } }, { $inc: { balance: -puntos } })`
 * o descuenta, o no encuentra nada. No hay hueco entre medias.
 */
export interface ILoyaltyBalance extends Document {
  userId: Types.ObjectId;
  balance: number;
  updatedAt: Date;
}

const loyaltyBalanceSchema = new Schema<ILoyaltyBalance>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    // Nunca puede quedar negativo: si una escritura lo intentara, es que la
    // condición del filtro falló y hay un error de programación detrás.
    balance: { type: Number, default: 0, min: 0 },
  },
  { timestamps: { createdAt: false, updatedAt: true } }
);

export const LoyaltyBalance = mongoose.model<ILoyaltyBalance>(
  'LoyaltyBalance',
  loyaltyBalanceSchema
);
