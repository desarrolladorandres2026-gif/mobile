import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IReview extends Document {
  orderId: Types.ObjectId;
  userId: Types.ObjectId;
  businessId: Types.ObjectId;
  driverId?: Types.ObjectId;
  businessRating: number;
  driverRating?: number;
  comment?: string;
  createdAt: Date;
}

const reviewSchema = new Schema<IReview>(
  {
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true, unique: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true },
    driverId: { type: Schema.Types.ObjectId, ref: 'Driver', default: null },
    businessRating: { type: Number, required: true, min: 1, max: 5 },
    driverRating: { type: Number, min: 1, max: 5, default: null },
    comment: { type: String, default: '', maxlength: 500 },
  },
  { timestamps: true }
);

reviewSchema.index({ businessId: 1, createdAt: -1 });
reviewSchema.index({ driverId: 1 });

export const Review = mongoose.model<IReview>('Review', reviewSchema);
