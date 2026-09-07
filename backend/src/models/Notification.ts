import mongoose, { Schema, Document, Types } from 'mongoose';
import { NotificationType } from '../types';

export interface INotification extends Document {
  userId: Types.ObjectId;
  title: string;
  body: string;
  type: NotificationType;
  isRead: boolean;
  data?: Record<string, unknown>;
  createdAt: Date;
}

const notificationSchema = new Schema<INotification>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, required: true },
    body: { type: String, required: true },
    type: { type: String, enum: Object.values(NotificationType), required: true },
    isRead: { type: Boolean, default: false },
    data: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

notificationSchema.index({ userId: 1, isRead: 1, createdAt: -1 });

export const Notification = mongoose.model<INotification>('Notification', notificationSchema);
