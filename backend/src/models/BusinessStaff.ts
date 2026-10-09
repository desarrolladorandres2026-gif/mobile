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
  /** Empleado: ejecuta la operación del día — pedidos, agotar productos y abrir el local. */
  EMPLOYEE = 'employee',
}

/** Papeles que se pueden guardar en `BusinessStaff` (el dueño no se guarda). */
export type StaffRole = BusinessRole.MANAGER | BusinessRole.EMPLOYEE;
export const STAFF_ROLES: StaffRole[] = [BusinessRole.MANAGER, BusinessRole.EMPLOYEE];

/**
 * Valores que el mostrador tuvo antes de que existiera `employee`: `staff`
 * (hasta 2026-10-02), y `operator` y `cashier` (hasta 2026-10-09, cuando se
 * fundieron en un solo papel). La migración 026 los reescribe; mientras no
 * corra, y mientras haya paneles viejos en caché mandándolos, se leen igual.
 */
export const LEGACY_COUNTER_ROLES = ['staff', 'operator', 'cashier'] as const;

/** Papeles "de mostrador": ven solo los pedidos del día y nunca el margen de ZIPP. */
export const COUNTER_ROLES: BusinessRole[] = [BusinessRole.EMPLOYEE];

/**
 * Un valor desconocido se lee como `employee`, el papel con menos poder del
 * negocio: ante una fila que ya no entendemos, mejor que ceda de más en
 * restricción que que se quede sin acceso o, peor, con el de un
 * administrador. Antes se devolvía el texto tal cual y un valor sin mapa
 * dejaba permisos vacíos sin avisar.
 */
export function normalizeStaffRole(raw: string): StaffRole {
  return raw === BusinessRole.MANAGER ? BusinessRole.MANAGER : BusinessRole.EMPLOYEE;
}

export type StaffStatus = 'active' | 'pending' | 'suspended';

export enum BusinessPermission {
  ORDERS_VIEW = 'orders:view',
  ORDERS_MANAGE = 'orders:manage',
  /** Cancelar un pedido que aún no se ha cobrado. No mueve dinero. */
  ORDERS_CANCEL = 'orders:cancel',
  /**
   * Cancelar un pedido ya pagado. Aparte de `orders:cancel` porque cancelar
   * uno pagado dispara un reembolso al cliente y descuadra liquidación y
   * comisión: es una decisión con dinero detrás, no de operación.
   */
  ORDERS_CANCEL_PAID = 'orders:cancel_paid',
  /** Ventas del turno: lo que se cobró hoy, sin comisiones ni neto. */
  SHIFT_VIEW = 'shift:view',

  CATALOG_VIEW = 'catalog:view',
  CATALOG_CREATE = 'catalog:create',
  CATALOG_EDIT = 'catalog:edit',
  CATALOG_DELETE = 'catalog:delete',
  CATALOG_CHANGE_PRICE = 'catalog:change_price',
  /**
   * Marcar un producto agotado o volver a ofrecerlo (y reponer unidades).
   * Es lo único del catálogo que reacciona a la cocina del momento; nada de
   * nombre, precio, foto, categoría ni adicionales.
   */
  CATALOG_AVAILABILITY = 'catalog:availability',

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
 * delegar la operación del día. Tampoco cambia roles (`team:change_role`):
 * repartir poder es del propietario; el administrador solo invita, suspende
 * y retira a operadores y cajeros.
 *
 * Cancelar es de todos mientras el pedido no esté pagado (`orders:cancel`);
 * uno pagado exige además `orders:cancel_paid`, que es solo del propietario
 * (decisión 2026-10-09: cancelar uno pagado emite un reembolso completo y el
 * administrador no toca el dinero). Y ningún rol cancela un pedido que ya salió
 * del local: ver `BUSINESS_CANCELLABLE_STATUSES` en order.service.ts.
 */
export const BUSINESS_ROLE_PERMISSIONS: Record<BusinessRole, BusinessPermission[]> = {
  [BusinessRole.OWNER]: Object.values(BusinessPermission),
  [BusinessRole.MANAGER]: [
    P.ORDERS_VIEW, P.ORDERS_MANAGE, P.ORDERS_CANCEL, P.SHIFT_VIEW,
    P.CATALOG_VIEW, P.CATALOG_CREATE, P.CATALOG_EDIT, P.CATALOG_DELETE, P.CATALOG_CHANGE_PRICE,
    P.CATALOG_AVAILABILITY,
    P.PROMOTIONS_VIEW, P.PROMOTIONS_MANAGE, P.ADVERTISING_MANAGE,
    P.REVIEWS_VIEW, P.REVIEWS_RESPOND,
    P.TEAM_VIEW, P.TEAM_INVITE, P.TEAM_EDIT, P.TEAM_REMOVE,
    P.ANALYTICS_VIEW, P.STORE_TOGGLE,
  ],
  // Sin `shift:view` a propósito (decisión 2026-10-09): son cifras de dinero y
  // el empleado ejecuta, no cuadra caja. Al fundir operador y cajero, quien
  // era cajero pierde su resumen de turno y gana agotar y abrir/cerrar.
  [BusinessRole.EMPLOYEE]: [
    P.ORDERS_VIEW, P.ORDERS_MANAGE, P.ORDERS_CANCEL,
    P.CATALOG_VIEW, P.CATALOG_AVAILABILITY, P.STORE_TOGGLE,
  ],
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
  /** El teléfono tal como lo escribió quien invitó; es lo único que ve de una invitación pendiente. */
  invitedPhone?: string;
  invitedBy?: Types.ObjectId;
  /**
   * Quién suspendió y con qué papel. Hace falta para que una suspensión del
   * propietario no la deshaga un administrador. Filas suspendidas antes de
   * 2026-10-09 no lo tienen y se tratan como suspensión de un administrador.
   */
  suspendedBy?: Types.ObjectId;
  suspendedByRole?: BusinessRole;
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
      enum: [...STAFF_ROLES, ...LEGACY_COUNTER_ROLES],
      required: true,
    },
    isActive: { type: Boolean, default: true },
    status: { type: String, enum: ['active', 'pending', 'suspended'], default: 'active' },
    invitedName: { type: String, trim: true, maxlength: 120 },
    invitedEmail: { type: String, trim: true, lowercase: true, maxlength: 160 },
    invitedPhone: { type: String, trim: true, maxlength: 20 },
    acceptedAt: { type: Date },
    invitedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    suspendedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    suspendedByRole: { type: String, enum: Object.values(BusinessRole) },
  },
  { timestamps: true }
);

// Una persona tiene un solo papel en un negocio. Dos filas para el mismo
// par dejarían el permiso dependiendo de cuál se leyera primero.
businessStaffSchema.index({ businessId: 1, userId: 1 }, { unique: true });
businessStaffSchema.index({ userId: 1, isActive: 1 });

export const BusinessStaff = mongoose.model<IBusinessStaff>('BusinessStaff', businessStaffSchema);
