import mongoose, { Schema, Document, Types } from 'mongoose';

export enum AdEventType {
  IMPRESSION = 'impression',
  CLICK = 'click',
}

/**
 * Analytics trail for sponsored campaigns. Kept as its own capped
 * collection (same shape of trade-off as AuditLog) so high-volume
 * impression/click writes never compete with the operational data in
 * Advertisement, and the collection self-prunes instead of growing forever.
 */
export interface IAdEvent extends Document {
  campaignId: Types.ObjectId;
  /** Denormalized so historical analytics survive a deleted campaign. */
  campaignName: string;
  eventType: AdEventType;
  /** Anonymous device/session id, or the authenticated user's id. */
  deviceId: string;
  userId?: Types.ObjectId | null;
  timestamp: Date;
}

const adEventSchema = new Schema<IAdEvent>(
  {
    campaignId: { type: Schema.Types.ObjectId, ref: 'Advertisement', required: true, index: true },
    campaignName: { type: String, required: true },
    eventType: { type: String, enum: Object.values(AdEventType), required: true, index: true },
    deviceId: { type: String, required: true, maxlength: 100 },
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    timestamp: { type: Date, default: Date.now, index: true },
  },
  {
    timestamps: false,
    capped: { size: 209715200, max: 2000000 }, // 200MB cap, 2M docs max
  }
);

adEventSchema.index({ campaignId: 1, eventType: 1, timestamp: -1 });

export const AdEvent = mongoose.model<IAdEvent>('AdEvent', adEventSchema);
