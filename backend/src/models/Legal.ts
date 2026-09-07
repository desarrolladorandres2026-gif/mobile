import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * `habeas_data` es la autorización de tratamiento de datos personales que exige
 * la Ley 1581 de 2012. Va aparte de `privacy`: la política dice qué hacemos con
 * los datos, la autorización es lo que el titular otorga.
 */
export type LegalDocumentKind = 'terms' | 'privacy' | 'habeas_data' | 'promotions' | 'cancellations' | 'payments' | 'delivery' | 'provider';

export interface ILegalDocument extends Document {
  kind: LegalDocumentKind; version: string; title: string; content: string; effectiveAt: Date; isActive: boolean; createdAt: Date; updatedAt: Date;
}
const legalDocumentSchema = new Schema<ILegalDocument>({
  kind: { type: String, enum: ['terms', 'privacy', 'habeas_data', 'promotions', 'cancellations', 'payments', 'delivery', 'provider'], required: true },
  version: { type: String, required: true, trim: true, maxlength: 30 },
  title: { type: String, required: true, trim: true, maxlength: 160 },
  content: { type: String, required: true, maxlength: 50000 },
  effectiveAt: { type: Date, required: true, default: () => new Date() },
  isActive: { type: Boolean, default: true },
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

export interface IDataRequest extends Document { userId: Types.ObjectId; type: 'access'|'rectify'|'update'|'delete'|'revoke'; detail: string; status: 'received'|'in_review'|'resolved'|'rejected'; response?: string; handledBy?: Types.ObjectId; createdAt: Date; updatedAt: Date; }
const dataRequestSchema = new Schema<IDataRequest>({ userId: { type: Schema.Types.ObjectId, ref: 'User', required: true }, type: { type: String, enum: ['access','rectify','update','delete','revoke'], required: true }, detail: { type: String, required: true, maxlength: 2000 }, status: { type: String, enum: ['received','in_review','resolved','rejected'], default: 'received' }, response: { type: String, maxlength: 4000 }, handledBy: { type: Schema.Types.ObjectId, ref: 'User' } }, { timestamps: true });
dataRequestSchema.index({ userId: 1, createdAt: -1 });
export const DataRequest = mongoose.model<IDataRequest>('DataRequest', dataRequestSchema);
