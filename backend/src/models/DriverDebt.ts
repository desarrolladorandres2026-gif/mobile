import mongoose, { Schema, Document, Types } from 'mongoose';
import { DebtStatus } from '../types';

export interface IDriverDebt extends Document {
  driverId: Types.ObjectId;
  orderId: Types.ObjectId;
  amount: number;
  status: DebtStatus;
  paidAt?: Date;
  createdAt: Date;
}

const driverDebtSchema = new Schema<IDriverDebt>(
  {
    driverId: { type: Schema.Types.ObjectId, ref: 'Driver', required: true },
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true },
    amount: { type: Number, required: true, min: 0 },
    status: { type: String, enum: Object.values(DebtStatus), default: DebtStatus.PENDING },
    paidAt: { type: Date, default: null },
  },
  { timestamps: true }
);

driverDebtSchema.index({ driverId: 1, status: 1 });

export const DriverDebt = mongoose.model<IDriverDebt>('DriverDebt', driverDebtSchema);
