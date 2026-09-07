import mongoose, { Schema, Document, Types } from 'mongoose';
import { Permission } from '../security/rbac';

/**
 * Rol administrable desde el panel (Seguridad y Acceso → Roles).
 *
 * Es la unidad que agrupa Permisos. Un `User` puede tener varios Roles
 * (directos, vía `roleIds`, o heredados de su `Position`); sus permisos
 * efectivos son la unión de los de todos esos Roles — ver
 * `services/authorization.service.ts`, que es el único lugar que calcula
 * "qué puede hacer este usuario".
 *
 * `isSystem` marca los roles que no vienen del panel sino de la
 * instalación (hoy solo SUPER_ADMIN, sembrado en
 * `migrations/002-rbac.ts`): no se pueden editar, eliminar, ni cambiarles
 * los permisos por API, y solo alguien que ya lo tiene puede asignarlo a
 * otra cuenta. Ver `role.service.ts`.
 */
export interface IRole extends Document {
  _id: Types.ObjectId;
  name: string;
  slug: string;
  description?: string;
  permissions: Permission[];
  isActive: boolean;
  isSystem: boolean;
  createdBy?: Types.ObjectId;
  updatedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const roleSchema = new Schema<IRole>(
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
    permissions: {
      type: [String],
      enum: Object.values(Permission),
      default: [],
    },
    isActive: { type: Boolean, default: true },
    isSystem: { type: Boolean, default: false },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

roleSchema.index({ isActive: 1 });

export const Role = mongoose.model<IRole>('Role', roleSchema);
