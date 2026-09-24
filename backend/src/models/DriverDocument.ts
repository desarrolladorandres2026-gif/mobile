import mongoose, { Schema, Document, Types } from 'mongoose';
export type DriverDocumentType = 'identity' | 'license' | 'soat' | 'technical_review' | 'vehicle_registration';
export interface IDriverDocument extends Document {
  driverId: Types.ObjectId;
  type: DriverDocumentType;
  /** El número del documento, tal como lo escribe el domiciliario. */
  reference: string;
  /**
   * La foto del documento.
   *
   * Sin ella, dar de alta a un domiciliario consistía en escribir un
   * número: nadie podía comprobar que la cédula fuera de quien la teclea,
   * ni que el SOAT existiera. Un número es un dato; una foto es una
   * prueba, y esto es lo único que separa una revisión de un trámite.
   *
   * Opcional en el esquema por los registros anteriores a este campo, que
   * ya estaban aprobados y operando. Para los envíos nuevos la exige el
   * controlador.
   */
  imageUrl?: string;
  /**
   * S16: el `public_id` de Cloudinary cuando la foto se subió (o se migró)
   * a entrega `authenticated`. Con esto presente, `imageUrl` no se sirve
   * tal cual: se firma al leer (ver `driver.service.ts#documentImageUrl`).
   */
  imageKey?: string;
  isPrivate?: boolean;
  expiresAt?: Date;
  status: 'pending'|'approved'|'rejected'|'expired';
  reviewedBy?: Types.ObjectId;
  reviewedAt?: Date;
  /**
   * Por qué se rechazó (O6). Sin esto, el domiciliario reintentaba a
   * ciegas: no había forma de decirle qué corregir del documento.
   */
  rejectionReason?: string;
  createdAt: Date;
  updatedAt: Date;
}
const schema = new Schema<IDriverDocument>({ driverId: { type: Schema.Types.ObjectId, ref: 'Driver', required: true }, type: { type: String, enum: ['identity','license','soat','technical_review','vehicle_registration'], required: true }, reference: { type: String, required: true, trim: true, maxlength: 500 }, imageUrl: { type: String, trim: true }, imageKey: { type: String, trim: true }, isPrivate: { type: Boolean, default: false }, expiresAt: Date, status: { type: String, enum: ['pending','approved','rejected','expired'], default: 'pending' }, reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' }, reviewedAt: Date, rejectionReason: { type: String, trim: true, maxlength: 300 } }, { timestamps: true });
schema.index({ driverId: 1, type: 1 }, { unique: true }); schema.index({ expiresAt: 1, status: 1 });
export const DriverDocument = mongoose.model<IDriverDocument>('DriverDocument', schema);
