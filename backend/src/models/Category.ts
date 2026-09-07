import mongoose, { Schema, Document, Types } from 'mongoose';

export interface ICategory extends Document {
  businessId: Types.ObjectId;
  name: string;
  sortOrder: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const categorySchema = new Schema<ICategory>(
  {
    businessId: {
      type: Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
    },
    name: {
      type: String,
      required: [true, 'El nombre de la categoría es requerido'],
      trim: true,
      maxlength: [50, 'El nombre no puede exceder 50 caracteres'],
    },
    sortOrder: {
      type: Number,
      default: 0,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

categorySchema.index({ businessId: 1, sortOrder: 1 });

export const Category = mongoose.model<ICategory>('Category', categorySchema);
