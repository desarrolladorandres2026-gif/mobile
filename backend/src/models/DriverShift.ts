import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * Un turno: el tramo entre que el domiciliario se conecta y se desconecta.
 *
 * Antes no se guardaba nada de esto: `Driver.status` solo dice cómo está
 * ahora. Sin turnos no hay "tiempo conectado" — y no se puede reconstruir
 * hacia atrás, así que la cifra empieza a existir desde que se despliega esto.
 */
export interface IDriverShift extends Document {
  driverId: Types.ObjectId;
  startedAt: Date;
  /** Ausente mientras el turno sigue abierto. */
  endedAt?: Date;
  /** `true` mientras el turno sigue abierto. Existe para el índice único parcial: Mongo no admite `$exists: false` ahí. */
  open: boolean;
}

const schema = new Schema<IDriverShift>(
  {
    driverId: { type: Schema.Types.ObjectId, ref: 'Driver', required: true },
    startedAt: { type: Date, required: true },
    endedAt: Date,
    open: { type: Boolean, default: true },
  },
  { timestamps: false }
);

schema.index({ driverId: 1, startedAt: -1 });
// Un solo turno abierto por domiciliario: dos conexiones seguidas no deben duplicarlo.
schema.index({ driverId: 1 }, { unique: true, partialFilterExpression: { open: true } });

export const DriverShift = mongoose.model<IDriverShift>('DriverShift', schema);
