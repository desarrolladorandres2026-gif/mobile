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
  /** Administrador / encargado: dirige la operación, no el dinero ni los ajustes. */
  MANAGER = 'manager',
  /** Operador: pedidos, y el catálogo solo para consultarlo. */
  OPERATOR = 'operator',
  /** Cajero: pedidos, cobro y ventas del turno. */
  CASHIER = 'cashier',
}

/** Papeles que se pueden guardar en `BusinessStaff` (el dueño no se guarda). */
export type StaffRole = BusinessRole.MANAGER | BusinessRole.OPERATOR | BusinessRole.CASHIER;
export const STAFF_ROLES: StaffRole[] = [BusinessRole.MANAGER, BusinessRole.OPERATOR, BusinessRole.CASHIER];

/** Papeles "de mostrador": ven solo los pedidos del día y nunca el margen de ZIPP. */
export const COUNTER_ROLES: BusinessRole[] = [BusinessRole.OPERATOR, BusinessRole.CASHIER];

/**
 * Antes del 2026-10-02 el papel del mostrador se guardaba como `staff`. La
 * migración 025 lo reescribe a `operator`; mientras no corra, se lee igual.
 */
export function normalizeStaffRole(raw: string): StaffRole {
  return (raw === 'staff' ? BusinessRole.OPERATOR : raw) as StaffRole;
}

export type StaffStatus = 'active' | 'pending' | 'suspended';

export enum BusinessPermission {
  ORDERS_VIEW = 'orders:view',
  ORDERS_MANAGE = 'orders:manage',
  ORDERS_CANCEL = 'orders:cancel',
  /** Ventas del turno: lo que se cobró hoy, sin comisiones ni neto. */
  SHIFT_VIEW = 'shift:view',

  CATALOG_VIEW = 'catalog:view',
  CATALOG_CREATE = 'catalog:create',
  CATALOG_EDIT = 'catalog:edit',
  CATALOG_DELETE = 'catalog:delete',
  CATALOG_CHANGE_PRICE = 'catalog:change_price',

  PROMOTIONS_VIEW = 'promotions:view',
  PROMOTIONS_MANAGE = 'promotions:manage',
  ADVERTISING_MANAGE = 'advertising:manage',

  REVIEWS_VIEW = 'reviews:view',
  REVIEWS_RESPOND = 'reviews:respond',

  TEAM_VIEW = 'team:view',
  TEAM_INVITE = 'team:invite',
  TEAM_EDIT = 'team:edit',
  TEAM_REMOVE = 'team:remove',
  TEAM_CHANGE_ROLE = 'team:change_role',

  ANALYTICS_VIEW = 'analytics:view',
  SETTLEMENTS_VIEW = 'settlements:view',
  SETTLEMENTS_MANAGE = 'settlements:manage',
  /** Neto, comisiones de ZIPP y costos: la capa financiera del resumen. */
  FINANCIAL_VIEW = 'financial:view',

  DOCUMENTS_VIEW = 'documents:view',
  DOCUMENTS_MANAGE = 'documents:manage',

  BUSINESS_VIEW = 'business:view',
  BUSINESS_EDIT = 'business:edit',
  SETTINGS_VIEW = 'settings:view',
  SETTINGS_MANAGE = 'settings:manage',
  SECURITY_MANAGE = 'security:manage',

  /**
   * Abrir y cerrar el negocio (`isActive`). Es operación del día, no
   * ajustes: lo hace quien está en el mostrador al llegar y al irse. Va por
   * su propio endpoint, que solo toca ese campo.
   */
  STORE_TOGGLE = 'store:toggle',
}

const P = BusinessPermission;

/**
 * Qué puede hacer cada papel. Los papeles son solo conjuntos de permisos: el
 * backend pregunta por el permiso, nunca por el nombre del papel.
 *
 * El administrador se queda deliberadamente fuera de liquidaciones, datos
 * financieros, documentos, datos del negocio y seguridad: son los lugares
 * donde se ve y se dirige el dinero, y delegarlos es una decisión distinta a
 * delegar la operación del día.
 */
export const BUSINESS_ROLE_PERMISSIONS: Record<BusinessRole, BusinessPermission[]> = {
  [BusinessRole.OWNER]: Object.values(BusinessPermission),
  [BusinessRole.MANAGER]: [
    P.ORDERS_VIEW, P.ORDERS_MANAGE, P.ORDERS_CANCEL, P.SHIFT_VIEW,
    P.CATALOG_VIEW, P.CATALOG_CREATE, P.CATALOG_EDIT, P.CATALOG_DELETE, P.CATALOG_CHANGE_PRICE,
    P.PROMOTIONS_VIEW, P.PROMOTIONS_MANAGE, P.ADVERTISING_MANAGE,
    P.REVIEWS_VIEW, P.REVIEWS_RESPOND,
    P.TEAM_VIEW, P.TEAM_INVITE, P.TEAM_EDIT, P.TEAM_REMOVE, P.TEAM_CHANGE_ROLE,
    P.ANALYTICS_VIEW, P.STORE_TOGGLE,
  ],
  [BusinessRole.OPERATOR]: [P.ORDERS_VIEW, P.ORDERS_MANAGE, P.CATALOG_VIEW, P.STORE_TOGGLE],
  [BusinessRole.CASHIER]: [P.ORDERS_VIEW, P.ORDERS_MANAGE, P.SHIFT_VIEW],
};

export interface IBusinessStaff extends Document {
  businessId: Types.ObjectId;
  userId: Types.ObjectId;
  role: BusinessRole;
  /** Atajo de `status === 'active'`; se conserva porque otras consultas ya filtran por él. */
  isActive: boolean;
  status: StaffStatus;
  /** Lo que escribió quien invitó; el nombre real lo manda la cuenta. */
  invitedName?: string;
  invitedEmail?: string;
  invitedBy?: Types.ObjectId;
  acceptedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const businessStaffSchema = new Schema<IBusinessStaff>(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    role: {
      type: String,
      // 'staff' sigue aceptado hasta que corra la migración 025.
      enum: [...STAFF_ROLES, 'staff'],
      required: true,
    },
    isActive: { type: Boolean, default: true },
    status: { type: String, enum: ['active', 'pending', 'suspended'], default: 'active' },
    invitedName: { type: String, trim: true, maxlength: 120 },
    invitedEmail: { type: String, trim: true, lowercase: true, maxlength: 160 },
    acceptedAt: { type: Date },
    invitedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// Una persona tiene un solo papel en un negocio. Dos filas para el mismo
// par dejarían el permiso dependiendo de cuál se leyera primero.
businessStaffSchema.index({ businessId: 1, userId: 1 }, { unique: true });
businessStaffSchema.index({ userId: 1, isActive: 1 });

export const BusinessStaff = mongoose.model<IBusinessStaff>('BusinessStaff', businessStaffSchema);
