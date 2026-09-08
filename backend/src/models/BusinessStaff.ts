import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * Quién más puede entrar al panel de un negocio.
 *
 * Hasta ahora un comercio era una sola persona: `Business.ownerId`. En la
 * práctica eso significaba que el dueño le pasaba su contraseña al cajero,
 * y con ella iban también las liquidaciones, los precios y la posibilidad
 * de cambiar la cuenta bancaria donde entra el dinero.
 *
 * Se replica el patrón del RBAC de plataforma, pero mucho más corto: un
 * negocio de pueblo no necesita cincuenta permisos, necesita tres papeles
 * que se entiendan sin explicación.
 */
export enum BusinessRole {
  /** El dueño. No se guarda aquí: es `Business.ownerId` y lo puede todo. */
  OWNER = 'owner',
  /** Encargado: opera y vende, pero no ve el dinero ni toca los ajustes. */
  MANAGER = 'manager',
  /** Mostrador: solo los pedidos del día. */
  STAFF = 'staff',
}

export enum BusinessPermission {
  ORDERS_VIEW = 'orders:view',
  ORDERS_MANAGE = 'orders:manage',
  MENU_MANAGE = 'menu:manage',
  PROMOTIONS_MANAGE = 'promotions:manage',
  ANALYTICS_VIEW = 'analytics:view',
  SETTLEMENTS_VIEW = 'settlements:view',
  REVIEWS_REPLY = 'reviews:reply',
  SETTINGS_MANAGE = 'settings:manage',
  STAFF_MANAGE = 'staff:manage',
}

/**
 * Qué puede hacer cada papel.
 *
 * El encargado se queda deliberadamente fuera de liquidaciones y ajustes:
 * son las dos pantallas donde se ve y se dirige el dinero, y delegarlas es
 * una decisión distinta a delegar la operación del día.
 */
export const BUSINESS_ROLE_PERMISSIONS: Record<BusinessRole, BusinessPermission[]> = {
  [BusinessRole.OWNER]: Object.values(BusinessPermission),
  [BusinessRole.MANAGER]: [
    BusinessPermission.ORDERS_VIEW,
    BusinessPermission.ORDERS_MANAGE,
    BusinessPermission.MENU_MANAGE,
    BusinessPermission.PROMOTIONS_MANAGE,
    BusinessPermission.ANALYTICS_VIEW,
    BusinessPermission.REVIEWS_REPLY,
  ],
  [BusinessRole.STAFF]: [
    BusinessPermission.ORDERS_VIEW,
    BusinessPermission.ORDERS_MANAGE,
  ],
};

export interface IBusinessStaff extends Document {
  businessId: Types.ObjectId;
  userId: Types.ObjectId;
  role: BusinessRole;
  isActive: boolean;
  invitedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const businessStaffSchema = new Schema<IBusinessStaff>(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    role: {
      type: String,
      enum: [BusinessRole.MANAGER, BusinessRole.STAFF],
      required: true,
    },
    isActive: { type: Boolean, default: true },
    invitedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// Una persona tiene un solo papel en un negocio. Dos filas para el mismo
// par dejarían el permiso dependiendo de cuál se leyera primero.
businessStaffSchema.index({ businessId: 1, userId: 1 }, { unique: true });
businessStaffSchema.index({ userId: 1, isActive: 1 });

export const BusinessStaff = mongoose.model<IBusinessStaff>('BusinessStaff', businessStaffSchema);
