import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * `habeas_data` es la autorización de tratamiento de datos personales que exige
 * la Ley 1581 de 2012. Va aparte de `privacy`: la política dice qué hacemos con
 * los datos, la autorización es lo que el titular otorga.
 */
export type LegalDocumentKind = 'terms' | 'privacy' | 'habeas_data' | 'promotions' | 'cancellations' | 'payments' | 'delivery' | 'provider';

export interface ILegalDocument extends Document {
  kind: LegalDocumentKind; version: string; title: string; content: string; effectiveAt: Date; isActive: boolean; changeNote?: string; publishedBy?: Types.ObjectId | null; createdAt: Date; updatedAt: Date;
}
const legalDocumentSchema = new Schema<ILegalDocument>({
  kind: { type: String, enum: ['terms', 'privacy', 'habeas_data', 'promotions', 'cancellations', 'payments', 'delivery', 'provider'], required: true },
  version: { type: String, required: true, trim: true, maxlength: 30 },
  title: { type: String, required: true, trim: true, maxlength: 160 },
  content: { type: String, required: true, maxlength: 50000 },
  effectiveAt: { type: Date, required: true, default: () => new Date() },
  isActive: { type: Boolean, default: true },
  /** Qué cambió respecto a la versión anterior. Obligatoria desde la segunda versión. */
  changeNote: { type: String, trim: true, maxlength: 500 },
  publishedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });
legalDocumentSchema.index({ kind: 1, version: 1 }, { unique: true });
legalDocumentSchema.index({ kind: 1, isActive: 1 });
export const LegalDocument = mongoose.model<ILegalDocument>('LegalDocument', legalDocumentSchema);

export interface ILegalAcceptance extends Document { userId: Types.ObjectId; documentId: Types.ObjectId; version: string; ipHash: string; acceptedAt: Date; }
const legalAcceptanceSchema = new Schema<ILegalAcceptance>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true }, documentId: { type: Schema.Types.ObjectId, ref: 'LegalDocument', required: true }, version: { type: String, required: true }, ipHash: { type: String, default: '' }, acceptedAt: { type: Date, default: () => new Date() },
}, { timestamps: false });
legalAcceptanceSchema.index({ userId: 1, documentId: 1 }, { unique: true });
export const LegalAcceptance = mongoose.model<ILegalAcceptance>('LegalAcceptance', legalAcceptanceSchema);

export interface IDataRequest extends Document { userId: Types.ObjectId; type: 'access'|'rectify'|'update'|'delete'|'revoke'; detail: string; status: 'received'|'in_review'|'resolved'|'rejected'; response?: string; handledBy?: Types.ObjectId;
  /**
   * Plazo legal de Habeas Data (Ley 1581 de 2012, art. 14 / Decreto 1377 de
   * 2013 — confirmar con asesor legal). Se calcula al crear según `type`.
   */
  legalDueAt?: Date | null;
  /**
   * Prórroga (Ley 1581, art. 14): una sola vez, avisando antes de que venza y
   * con el motivo. `legalDueAt` ya trae el plazo extendido; aquí queda el rastro.
   */
  extendedAt?: Date | null;
  extensionReason?: string;
  resolvedAt?: Date | null;
  createdAt: Date; updatedAt: Date; }
const dataRequestSchema = new Schema<IDataRequest>({ userId: { type: Schema.Types.ObjectId, ref: 'User', required: true }, type: { type: String, enum: ['access','rectify','update','delete','revoke'], required: true }, detail: { type: String, required: true, maxlength: 2000 }, status: { type: String, enum: ['received','in_review','resolved','rejected'], default: 'received' }, response: { type: String, maxlength: 4000 }, handledBy: { type: Schema.Types.ObjectId, ref: 'User' }, legalDueAt: { type: Date, default: null }, extendedAt: { type: Date, default: null }, extensionReason: { type: String, maxlength: 1000 }, resolvedAt: { type: Date, default: null } }, { timestamps: true });
dataRequestSchema.index({ userId: 1, createdAt: -1 });
dataRequestSchema.index({ status: 1, legalDueAt: 1 });
export const DataRequest = mongoose.model<IDataRequest>('DataRequest', dataRequestSchema);
