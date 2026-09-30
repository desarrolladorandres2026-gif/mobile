import mongoose, { Schema, Document, Types } from 'mongoose';
export const DRIVER_DOCUMENT_TYPES = ['identity', 'identity_back', 'criminal_record', 'license', 'soat', 'technical_review', 'vehicle_registration'] as const;
export type DriverDocumentType = (typeof DRIVER_DOCUMENT_TYPES)[number];

/** Qué le pasó a un documento. `observation` es una nota interna: el domiciliario nunca la ve. */
export type DriverDocumentEvent = 'submitted' | 'approved' | 'rejected' | 'update_requested' | 'observation';
export const MAX_DRIVER_DOCUMENT_HISTORY = 50;

export interface IDriverDocumentHistoryEntry {
  action: DriverDocumentEvent;
  at: Date;
  /** Quién actuó (admin). Ausente cuando fue el propio domiciliario quien envió. */
  byUserId?: Types.ObjectId;
  /** Copia del nombre en ese momento: el historial no debe cambiar si el admin cambia de nombre. */
  byName?: string;
  note?: string;
}
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
  /** Fecha de expedición impresa en el documento (opcional). */
  issuedAt?: Date;
  expiresAt?: Date;
  /** Cuándo el domiciliario lo envió por última vez (`createdAt` es solo el primer envío). */
  submittedAt?: Date;
  status: 'pending'|'approved'|'rejected'|'expired';
  reviewedBy?: Types.ObjectId;
  reviewedAt?: Date;
  /**
   * Por qué se rechazó (O6). Sin esto, el domiciliario reintentaba a
   * ciegas: no había forma de decirle qué corregir del documento.
   */
  rejectionReason?: string;
  /** Avisos de vencimiento ya enviados, `<expiresAt ISO>:<etapa>` (ver `documentExpiry.service`). */
  expiryRemindersSent?: string[];
  /**
   * Un administrador pidió una versión nueva. No cambia `status`: un documento
   * vigente sigue habilitando al domiciliario hasta que venza. Se borra al reenviar.
   */
  updateRequest?: { reason: string; requestedAt: Date; requestedBy?: Types.ObjectId };
  /** Auditoría del documento. `select: false`: incluye observaciones internas y no debe llegar a la app. */
  history?: IDriverDocumentHistoryEntry[];
  createdAt: Date;
  updatedAt: Date;
}
const schema = new Schema<IDriverDocument>({ driverId: { type: Schema.Types.ObjectId, ref: 'Driver', required: true }, type: { type: String, enum: [...DRIVER_DOCUMENT_TYPES], required: true }, reference: { type: String, required: true, trim: true, maxlength: 500 }, imageUrl: { type: String, trim: true }, imageKey: { type: String, trim: true }, isPrivate: { type: Boolean, default: false }, issuedAt: Date, expiresAt: Date, submittedAt: Date, status: { type: String, enum: ['pending','approved','rejected','expired'], default: 'pending' }, reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' }, reviewedAt: Date, rejectionReason: { type: String, trim: true, maxlength: 300 }, expiryRemindersSent: { type: [String], default: undefined, select: false }, updateRequest: { type: new Schema({ reason: { type: String, required: true, trim: true, maxlength: 300 }, requestedAt: { type: Date, required: true }, requestedBy: { type: Schema.Types.ObjectId, ref: 'User' } }, { _id: false }), default: undefined }, history: { type: [new Schema({ action: { type: String, enum: ['submitted', 'approved', 'rejected', 'update_requested', 'observation'], required: true }, at: { type: Date, required: true }, byUserId: { type: Schema.Types.ObjectId, ref: 'User' }, byName: { type: String, trim: true, maxlength: 120 }, note: { type: String, trim: true, maxlength: 500 } }, { _id: false })], default: undefined, select: false } }, { timestamps: true });
schema.index({ driverId: 1, type: 1 }, { unique: true }); schema.index({ expiresAt: 1, status: 1 });
export const DriverDocument = mongoose.model<IDriverDocument>('DriverDocument', schema);
