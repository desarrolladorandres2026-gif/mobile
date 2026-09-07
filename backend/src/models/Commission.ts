import mongoose, { Schema, Document, Types } from 'mongoose';
import { CommissionStatus } from '../types';

export interface ICommission extends Document {
  orderId: Types.ObjectId;
  businessId: Types.ObjectId;
  driverId?: Types.ObjectId;
  platformAmount: number;
  businessAmount: number;
  driverAmount: number;
  status: CommissionStatus;
  settledAt?: Date;
  createdAt: Date;
}

const commissionSchema = new Schema<ICommission>(
  {
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true },
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true },
    driverId: { type: Schema.Types.ObjectId, ref: 'Driver', default: null },
    platformAmount: { type: Number, required: true, min: 0 },
    businessAmount: { type: Number, required: true, min: 0 },
    driverAmount: { type: Number, required: true, min: 0 },
    status: { type: String, enum: Object.values(CommissionStatus), default: CommissionStatus.PENDING },
    settledAt: { type: Date, default: null },
  },
  { timestamps: true }
);

commissionSchema.index({ orderId: 1 });
commissionSchema.index({ businessId: 1, status: 1 });
commissionSchema.index({ driverId: 1, status: 1 });

export const Commission = mongoose.model<ICommission>('Commission', commissionSchema);
