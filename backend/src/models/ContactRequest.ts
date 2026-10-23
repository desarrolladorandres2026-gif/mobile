import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * Mensaje del formulario de contacto del sitio público.
 *
 * Sin cuenta ni sesión: quien escribe es anónimo, así que lo único que se
 * guarda de la conexión es un HMAC de la IP (`ipHash`), nunca la IP.
 * No es una PQRS: no tiene plazo legal ni dueño. Si el caso lo amerita,
 * soporte pide a la persona que lo abra desde la app.
 */
export const CONTACT_TYPES = ['question', 'complaint', 'claim', 'suggestion', 'other'] as const;
export const CONTACT_STATUSES = ['new', 'in_progress', 'resolved'] as const;
export type ContactType = (typeof CONTACT_TYPES)[number];
export type ContactStatus = (typeof CONTACT_STATUSES)[number];

export interface IContactRequest extends Document {
  name: string;
  /** Celular de 10 dígitos o correo en minúsculas. */
  contact: string;
  type: ContactType;
  subject?: string;
  detail: string;
  status: ContactStatus;
  ipHash: string;
  handledBy?: Types.ObjectId;
  response?: string;
  handledAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const contactRequestSchema = new Schema<IContactRequest>(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    contact: { type: String, required: true, trim: true, maxlength: 120 },
    type: { type: String, enum: CONTACT_TYPES, required: true },
    subject: { type: String, trim: true, maxlength: 120 },
    detail: { type: String, required: true, trim: true, maxlength: 2000 },
    status: { type: String, enum: CONTACT_STATUSES, default: 'new' },
    ipHash: { type: String, required: true },
    handledBy: { type: Schema.Types.ObjectId, ref: 'User' },
    response: { type: String, trim: true, maxlength: 2000 },
    handledAt: { type: Date },
  },
  { timestamps: true }
);

contactRequestSchema.index({ status: 1, createdAt: -1 });
// Tope de mensajes abiertos por contacto en 24 h.
contactRequestSchema.index({ contact: 1, createdAt: -1 });

export const ContactRequest = mongoose.model<IContactRequest>('ContactRequest', contactRequestSchema);
