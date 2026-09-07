import mongoose, { Schema, Document, Types } from 'mongoose';
export type DriverDocumentType = 'identity' | 'license' | 'soat' | 'technical_review' | 'vehicle_registration';
export interface IDriverDocument extends Document { driverId: Types.ObjectId; type: DriverDocumentType; reference: string; expiresAt?: Date; status: 'pending'|'approved'|'rejected'|'expired'; reviewedBy?: Types.ObjectId; reviewedAt?: Date; createdAt: Date; updatedAt: Date; }
const schema = new Schema<IDriverDocument>({ driverId: { type: Schema.Types.ObjectId, ref: 'Driver', required: true }, type: { type: String, enum: ['identity','license','soat','technical_review','vehicle_registration'], required: true }, reference: { type: String, required: true, trim: true, maxlength: 500 }, expiresAt: Date, status: { type: String, enum: ['pending','approved','rejected','expired'], default: 'pending' }, reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' }, reviewedAt: Date }, { timestamps: true });
schema.index({ driverId: 1, type: 1 }, { unique: true }); schema.index({ expiresAt: 1, status: 1 });
export const DriverDocument = mongoose.model<IDriverDocument>('DriverDocument', schema);
