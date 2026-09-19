import mongoose, { Schema, Document, Types } from 'mongoose';
import { cacheInvalidationPlugin, CachePrefix } from '../cache';

/**
 * Cargo administrable desde el panel (Seguridad y Acceso → Cargos).
 *
 * Agrupa Roles: asignarle un Cargo a un usuario le otorga, además de sus
 * Roles directos, los Roles asociados al Cargo. Es la pieza "humana" de la
 * jerarquía (Usuario → Cargo → Rol → Permiso) — describe el puesto de la
 * persona en la organización, no lo que puede hacer en el sistema; eso lo
 * definen los Roles que trae asociados.
 */
export interface IPosition extends Document {
  _id: Types.ObjectId;
  name: string;
  slug: string;
  description?: string;
  roleIds: Types.ObjectId[];
  isActive: boolean;
  createdBy?: Types.ObjectId;
  updatedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const positionSchema = new Schema<IPosition>(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    slug: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      match: [/^[a-z0-9_]+$/, 'El slug solo puede tener minúsculas, números y guion bajo'],
    },
    description: { type: String, trim: true, maxlength: 500, default: '' },
    roleIds: [{ type: Schema.Types.ObjectId, ref: 'Role' }],
    isActive: { type: Boolean, default: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

positionSchema.index({ isActive: 1 });

// Cada escritura limpia lo que la caché de lecturas tenga de este modelo.
positionSchema.plugin(cacheInvalidationPlugin, {
  prefixesFor: () => [CachePrefix.AUTHZ],
});

export const Position = mongoose.model<IPosition>('Position', positionSchema);
