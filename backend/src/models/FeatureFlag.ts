import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * A quién alcanza una función que todavía no es de todos.
 *
 * `all` y `off` son los dos extremos honestos. `staff` sirve para probar en
 * producción con gente que sabe qué está mirando, y `percentage` para
 * repartos graduales — encender algo para el 5% y ver si algo se rompe
 * antes de que se rompa para todos.
 */
export type FeatureAudience = 'off' | 'all' | 'staff' | 'percentage';

export interface IFeatureFlag extends Document {
  key: string;
  description: string;
  audience: FeatureAudience;
  /** Solo se mira con `audience: 'percentage'`. */
  percentage: number;
  updatedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const featureFlagSchema = new Schema<IFeatureFlag>(
  {
    key: { type: String, required: true, unique: true, trim: true, maxlength: 60 },
    description: { type: String, required: true, trim: true, maxlength: 300 },
    audience: {
      type: String,
      enum: ['off', 'all', 'staff', 'percentage'],
      default: 'off',
    },
    percentage: { type: Number, default: 0, min: 0, max: 100 },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

export const FeatureFlag = mongoose.model<IFeatureFlag>('FeatureFlag', featureFlagSchema);
