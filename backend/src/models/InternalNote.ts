import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * Nota interna del equipo sobre un pedido, comercio, domiciliario, cliente o
 * PQRS. Solo la lee el panel admin (`/admin/notes`); ningún serializador
 * público la puebla ni entra en exportes.
 *
 * Vive en su propia colección y no en `AuditLog` porque ese es *capped* y
 * rota: una nota tiene que durar lo que dure el caso.
 *
 * No se edita: una corrección es otra nota. El borrado es lógico.
 */
export const NOTE_ENTITY_TYPES = ['order', 'business', 'driver', 'user', 'pqrs'] as const;
export type NoteEntityType = (typeof NOTE_ENTITY_TYPES)[number];

export const NOTE_MAX_LENGTH = 2000;

export interface IInternalNote extends Document {
  entityType: NoteEntityType;
  entityId: Types.ObjectId;
  authorId: Types.ObjectId;
  /** Foto del nombre al escribir: no cambia si la persona se renombra. */
  authorName: string;
  body: string;
  deletedAt: Date | null;
  deletedBy: Types.ObjectId | null;
  deleteReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

const internalNoteSchema = new Schema<IInternalNote>(
  {
    entityType: { type: String, enum: NOTE_ENTITY_TYPES, required: true },
    entityId: { type: Schema.Types.ObjectId, required: true },
    authorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    authorName: { type: String, default: '' },
    body: { type: String, required: true, trim: true, minlength: 1, maxlength: NOTE_MAX_LENGTH },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    deleteReason: { type: String, maxlength: 300 },
  },
  { timestamps: true }
);

// Lista de una ficha, de la más reciente a la más antigua.
internalNoteSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });
// Tope de notas por minuto y por persona; y "lo que escribió X".
internalNoteSchema.index({ authorId: 1, createdAt: -1 });

export const InternalNote = mongoose.model<IInternalNote>('InternalNote', internalNoteSchema);
