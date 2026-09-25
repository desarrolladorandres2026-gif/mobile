import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * Respuesta predefinida de soporte.
 *
 * El texto admite `{{cliente}}`, `{{pedido}}` y `{{agente}}`; el panel los
 * sustituye al insertarla y la persona puede editar el resultado antes de
 * enviarlo. Nada se envía solo: una macro es un borrador, no una respuesta.
 */
export interface ISupportMacro extends Document {
  title: string;
  body: string;
  /** Tipos de PQRS a los que aplica; vacío = a todos. */
  appliesTo: Array<'petition' | 'complaint' | 'claim' | 'suggestion'>;
  isActive: boolean;
  createdBy: Types.ObjectId;
  updatedBy?: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const supportMacroSchema = new Schema<ISupportMacro>({
  title: { type: String, required: true, trim: true, maxlength: 80 },
  body: { type: String, required: true, trim: true, maxlength: 2000 },
  appliesTo: { type: [String], enum: ['petition', 'complaint', 'claim', 'suggestion'], default: [] },
  isActive: { type: Boolean, default: true },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });
supportMacroSchema.index({ isActive: 1, title: 1 });

export const SupportMacro = mongoose.model<ISupportMacro>('SupportMacro', supportMacroSchema);
