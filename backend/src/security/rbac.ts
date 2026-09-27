import { UserRole } from '../types';

// ── RBAC Permission System ──

export enum Permission {
  // User management
  USERS_VIEW = 'users:view',
  USERS_CREATE = 'users:create',
  USERS_UPDATE = 'users:update',
  USERS_DELETE = 'users:delete',
  USERS_BLOCK = 'users:block',
  USERS_ROLE_CHANGE = 'users:role_change',
  // Quitar el 2FA de una cuenta que perdió el celular y sus códigos. No está
  // en ningún rol base: solo Super Administrador, salvo Rol explícito.
  USERS_RESET_2FA = 'users:reset_2fa',

  // Order management
  ORDERS_VIEW_OWN = 'orders:view_own',
  ORDERS_VIEW_ALL = 'orders:view_all',
  ORDERS_CREATE = 'orders:create',
  ORDERS_UPDATE = 'orders:update',
  ORDERS_CANCEL = 'orders:cancel',
  ORDERS_MODIFY = 'orders:modify',
  ORDERS_ASSIGN_DRIVER = 'orders:assign_driver',

  // Business management
  BUSINESSES_VIEW = 'businesses:view',
  BUSINESSES_CREATE = 'businesses:create',
  BUSINESSES_UPDATE_OWN = 'businesses:update_own',
  BUSINESSES_UPDATE_ALL = 'businesses:update_all',
  BUSINESSES_DELETE = 'businesses:delete',
  BUSINESSES_APPROVE = 'businesses:approve',

  // Product management
  PRODUCTS_VIEW = 'products:view',
  PRODUCTS_CREATE = 'products:create',
  PRODUCTS_UPDATE = 'products:update',
  PRODUCTS_DELETE = 'products:delete',

  // Driver management
  DRIVERS_VIEW = 'drivers:view',
  DRIVERS_APPROVE = 'drivers:approve',
  DRIVERS_SUSPEND = 'drivers:suspend',
  DRIVERS_UPDATE = 'drivers:update',
  DRIVERS_TRACK = 'drivers:track',

  // Financial
  FINANCE_VIEW = 'finance:view',
  FINANCE_MANAGE = 'finance:manage',
  COMMISSIONS_VIEW = 'commissions:view',
  COMMISSIONS_MANAGE = 'commissions:manage',
  PAYOUTS_PROCESS = 'payouts:process',

  // Admin
  ADMIN_PANEL = 'admin:panel',
  ADMIN_SETTINGS = 'admin:settings',
  ADMIN_AUDIT_LOGS = 'admin:audit_logs',
  ADMIN_SECURITY = 'admin:security',
  ADMIN_REPORTS = 'admin:reports',

  // Security center
  SECURITY_VIEW = 'security:view',
  SECURITY_MANAGE = 'security:manage',
  FRAUD_ALERTS_VIEW = 'fraud:alerts_view',
  FRAUD_ALERTS_MANAGE = 'fraud:alerts_manage',

  // Notifications
  NOTIFICATIONS_SEND = 'notifications:send',
  NOTIFICATIONS_VIEW = 'notifications:view',

  // ── Seguridad y Acceso: Cargos, Roles, Reportes, Configuración ──
  // Módulos administrables desde el panel (ver rbac.routes.ts). Mismo
  // convenio `modulo:accion` que el resto del enum — no se introduce un
  // segundo formato aunque el enunciado original use puntos.
  POSITIONS_VIEW = 'positions:view',
  POSITIONS_CREATE = 'positions:create',
  POSITIONS_UPDATE = 'positions:update',
  POSITIONS_DELETE = 'positions:delete',

  ROLES_VIEW = 'roles:view',
  ROLES_CREATE = 'roles:create',
  ROLES_UPDATE = 'roles:update',
  ROLES_DELETE = 'roles:delete',

  REPORTS_VIEW = 'reports:view',
  REPORTS_EXPORT = 'reports:export',

  SETTINGS_VIEW = 'settings:view',
  SETTINGS_UPDATE = 'settings:update',

  // ── Constructor de Explorar ──
  // Separados de `settings:*` porque quien diseña Explorar (banners,
  // colecciones) no tiene por qué poder tocar la configuración general.
  EXPLORE_VIEW = 'explore:view',
  EXPLORE_MANAGE = 'explore:manage',

  // ── Zonas de cobertura (D9) ──
  // Una zona cambia lo que se cobra y se paga por cada domicilio de su
  // polígono: editarla es tocar el precio. Permiso propio y no `settings:*`
  // ni `finance:manage` (decisión del 2026-09-23: cupones y zonas tienen
  // permiso por módulo, con versión y auditoría).
  ZONES_VIEW = 'zones:view',
  ZONES_MANAGE = 'zones:manage',

  // ── Fase 1 del panel admin: permisos por módulo (2026-09-24) ──
  // Solo se AÑADEN: `Role.permissions` valida contra este enum, así que
  // renombrar o borrar uno invalidaría roles ya guardados.
  USERS_VIEW_SENSITIVE = 'users:view_sensitive', // cédula completa, nacimiento, IP, dispositivos
  EVIDENCES_VIEW = 'evidences:view',
  PAYOUTS_REVEAL_ACCOUNT = 'payouts:reveal_account',
  REFUNDS_VIEW = 'refunds:view',
  REFUNDS_CREATE = 'refunds:create',
  COUPONS_VIEW = 'coupons:view',
  COUPONS_MANAGE = 'coupons:manage',
  ADS_VIEW = 'ads:view',
  ADS_MANAGE = 'ads:manage',
  REVIEWS_VIEW = 'reviews:view',
  REVIEWS_MODERATE = 'reviews:moderate',
  CONTENT_VIEW = 'content:view',
  CONTENT_MANAGE = 'content:manage',
  SUPPORT_VIEW = 'support:view',
  SUPPORT_MANAGE = 'support:manage',
  LEGAL_VIEW = 'legal:view',
  LEGAL_MANAGE = 'legal:manage',
  // Publicar una versión nueva de un documento legal. Sin rol base: solo el Super Administrador.
  LEGAL_PUBLISH = 'legal:publish',
  SOS_VIEW = 'sos:view',
  SOS_MANAGE = 'sos:manage',
}

// ── Extended Roles ──
//
// Estos son los roles *legacy*, resueltos únicamente a partir de
// `User.role` (el tipo de cuenta). Desde la Fase 1 (2026-09-24) este mapa ya
// NO es la autoridad para las cuentas `admin`: un admin solo trae
// `admin:panel` y el resto sale de los Roles de RBAC que se le asignen (ver
// `STAFF_ROLE_PERMISSIONS` abajo y `authorization.service.ts`). Este mapa
// sigue siendo el permiso real de comercios, domiciliarios y clientes, y el
// "conjunto legacy" con el que el modo observación compara lo que un admin
// dejaría de poder hacer.
export enum ExtendedRole {
  SUPER_ADMIN = 'super_admin',
  ADMIN = 'admin',
  OPERATOR = 'operator',
  BUSINESS = 'business',
  DRIVER = 'driver',
  CLIENT = 'client',
}

/**
 * Slug del rol de sistema con acceso total.
 *
 * Un documento `Role` con este slug es especial: `isSystem: true`, no
 * editable, no eliminable, y solo alguien que YA lo tiene puede otorgarlo.
 * Ver `authorization.service.ts` (`assertCanAssignRoles`) y
 * `role.service.ts`.
 */
export const SUPER_ADMIN_ROLE_SLUG = 'super_admin';

// ── Role-Permission Mapping ──
const rolePermissions: Record<string, Permission[]> = {
  [ExtendedRole.SUPER_ADMIN]: Object.values(Permission), // All permissions

  [ExtendedRole.ADMIN]: [
    Permission.USERS_VIEW,
    Permission.USERS_CREATE,
    Permission.USERS_UPDATE,
    Permission.USERS_BLOCK,
    Permission.USERS_ROLE_CHANGE,
    Permission.ORDERS_VIEW_ALL,
    Permission.ORDERS_UPDATE,
    Permission.ORDERS_CANCEL,
    Permission.ORDERS_MODIFY,
    Permission.ORDERS_ASSIGN_DRIVER,
    Permission.BUSINESSES_VIEW,
    Permission.BUSINESSES_UPDATE_ALL,
    Permission.BUSINESSES_APPROVE,
    Permission.PRODUCTS_VIEW,
    Permission.DRIVERS_VIEW,
    Permission.DRIVERS_APPROVE,
    Permission.DRIVERS_SUSPEND,
    Permission.DRIVERS_TRACK,
    Permission.FINANCE_VIEW,
    Permission.COMMISSIONS_VIEW,
    Permission.ADMIN_PANEL,
    Permission.ADMIN_REPORTS,
    Permission.ADMIN_AUDIT_LOGS,
    Permission.SECURITY_VIEW,
    Permission.FRAUD_ALERTS_VIEW,
    Permission.FRAUD_ALERTS_MANAGE,
    Permission.NOTIFICATIONS_SEND,
    Permission.NOTIFICATIONS_VIEW,
    // Solo lectura: crear/editar Cargos, Roles o Configuración exige un
    // Role de RBAC explícito (ver migrations/002-rbac.ts), no basta con el
    // tipo de cuenta `admin` legacy — mínimo privilegio por defecto.
    Permission.POSITIONS_VIEW,
    Permission.ROLES_VIEW,
    Permission.REPORTS_VIEW,
    Permission.REPORTS_EXPORT,
    Permission.SETTINGS_VIEW,
    // Mismo alcance que ya tenía sobre banners y bloques curados (que se
    // gestionan con `authorize(UserRole.ADMIN)`): Explorar es contenido.
    Permission.EXPLORE_VIEW,
    Permission.EXPLORE_MANAGE,
    // Se mantienen aquí solo para el modo observación (conjunto legacy): en
    // modo estricto un admin recibe `zones:*` únicamente por un Rol (Finanzas
    // tiene `zones:manage`; Operaciones solo `zones:view`).
    Permission.ZONES_VIEW,
    Permission.ZONES_MANAGE,
  ],

  [ExtendedRole.OPERATOR]: [
    Permission.USERS_VIEW,
    Permission.ORDERS_VIEW_ALL,
    Permission.ORDERS_UPDATE,
    Permission.ORDERS_ASSIGN_DRIVER,
    Permission.BUSINESSES_VIEW,
    Permission.PRODUCTS_VIEW,
    Permission.DRIVERS_VIEW,
    Permission.DRIVERS_TRACK,
    Permission.ADMIN_PANEL,
    Permission.NOTIFICATIONS_VIEW,
    Permission.FRAUD_ALERTS_VIEW,
  ],

  // NOTE: UserRole.ADMIN ('admin') maps to ExtendedRole.ADMIN above

  [UserRole.BUSINESS]: [
    Permission.ORDERS_VIEW_OWN,
    Permission.ORDERS_UPDATE,
    Permission.BUSINESSES_VIEW,
    Permission.BUSINESSES_UPDATE_OWN,
    Permission.PRODUCTS_VIEW,
    Permission.PRODUCTS_CREATE,
    Permission.PRODUCTS_UPDATE,
    Permission.PRODUCTS_DELETE,
    Permission.FINANCE_VIEW,
    Permission.COMMISSIONS_VIEW,
    Permission.NOTIFICATIONS_VIEW,
  ],

  [UserRole.DRIVER]: [
    Permission.ORDERS_VIEW_OWN,
    Permission.ORDERS_UPDATE,
    Permission.DRIVERS_VIEW,
    Permission.DRIVERS_UPDATE,
    Permission.FINANCE_VIEW,
    Permission.NOTIFICATIONS_VIEW,
  ],

  [UserRole.CLIENT]: [
    Permission.ORDERS_VIEW_OWN,
    Permission.ORDERS_CREATE,
    Permission.ORDERS_CANCEL,
    Permission.BUSINESSES_VIEW,
    Permission.PRODUCTS_VIEW,
    Permission.NOTIFICATIONS_VIEW,
  ],
};

/**
 * Roles base del personal (Fase 1). FUENTE ÚNICA: la migración 019 los
 * siembra desde aquí. Decisiones del dueño (2026-09-24): `users:block`,
 * anonimizar datos personales y escribir la cuenta de pago de un comercio son
 * solo del Super Administrador, así que no aparecen en ningún rol base;
 * `zones:manage` solo en Finanzas; Soporte solo tiene `refunds:view`.
 */
export interface StaffRoleDefinition {
  name: string;
  description: string;
  permissions: Permission[];
}

export const STAFF_ROLE_PERMISSIONS: Record<
  'operaciones' | 'soporte' | 'finanzas' | 'comercios_contenido',
  StaffRoleDefinition
> = {
  operaciones: {
    name: 'Operaciones + Domiciliarios',
    description: 'Pedidos, reparto, domiciliarios, SOS y mapa de flota.',
    permissions: [
      Permission.ADMIN_PANEL,
      Permission.ORDERS_VIEW_ALL,
      Permission.ORDERS_UPDATE,
      Permission.ORDERS_CANCEL,
      Permission.ORDERS_MODIFY,
      Permission.ORDERS_ASSIGN_DRIVER,
      Permission.EVIDENCES_VIEW,
      Permission.DRIVERS_VIEW,
      Permission.DRIVERS_APPROVE,
      Permission.DRIVERS_SUSPEND,
      Permission.DRIVERS_TRACK,
      Permission.ZONES_VIEW,
      Permission.SOS_VIEW,
      Permission.SOS_MANAGE,
      Permission.BUSINESSES_VIEW,
      Permission.USERS_VIEW,
      Permission.FRAUD_ALERTS_VIEW,
      Permission.REPORTS_VIEW,
    ],
  },
  soporte: {
    name: 'Soporte',
    description: 'PQRS, atención al cliente y consulta de pedidos.',
    permissions: [
      Permission.ADMIN_PANEL,
      Permission.SUPPORT_VIEW,
      Permission.SUPPORT_MANAGE,
      Permission.USERS_VIEW,
      Permission.ORDERS_VIEW_ALL,
      Permission.EVIDENCES_VIEW,
      Permission.REFUNDS_VIEW,
      Permission.BUSINESSES_VIEW,
      Permission.DRIVERS_VIEW,
    ],
  },
  finanzas: {
    name: 'Finanzas',
    description: 'Dinero: tarifas, efectivo, liquidaciones, reembolsos y zonas.',
    permissions: [
      Permission.ADMIN_PANEL,
      Permission.FINANCE_VIEW,
      Permission.FINANCE_MANAGE,
      Permission.COMMISSIONS_VIEW,
      Permission.COMMISSIONS_MANAGE,
      Permission.PAYOUTS_PROCESS,
      Permission.PAYOUTS_REVEAL_ACCOUNT,
      Permission.REFUNDS_VIEW,
      Permission.REFUNDS_CREATE,
      Permission.ORDERS_VIEW_ALL,
      Permission.BUSINESSES_VIEW,
      Permission.DRIVERS_VIEW,
      Permission.REPORTS_VIEW,
      Permission.COUPONS_VIEW,
      Permission.ADS_VIEW,
      Permission.ZONES_VIEW,
      Permission.ZONES_MANAGE,
    ],
  },
  comercios_contenido: {
    name: 'Comercios + Contenido',
    description: 'Comercios, catálogo, reseñas, Explorar, cupones y publicidad.',
    permissions: [
      Permission.ADMIN_PANEL,
      Permission.BUSINESSES_VIEW,
      Permission.BUSINESSES_UPDATE_ALL,
      Permission.BUSINESSES_APPROVE,
      Permission.PRODUCTS_CREATE,
      Permission.PRODUCTS_UPDATE,
      Permission.PRODUCTS_DELETE,
      Permission.REVIEWS_VIEW,
      Permission.REVIEWS_MODERATE,
      Permission.EXPLORE_VIEW,
      Permission.EXPLORE_MANAGE,
      Permission.CONTENT_VIEW,
      Permission.CONTENT_MANAGE,
      Permission.COUPONS_VIEW,
      Permission.COUPONS_MANAGE,
      Permission.ADS_VIEW,
      Permission.ADS_MANAGE,
    ],
  },
};

/**
 * Check if a role has a specific permission
 */
export function hasPermission(role: string, permission: Permission): boolean {
  const permissions = rolePermissions[role];
  if (!permissions) return false;
  return permissions.includes(permission);
}

/**
 * Check if a role has ALL specified permissions
 */
export function hasAllPermissions(role: string, permissions: Permission[]): boolean {
  return permissions.every((p) => hasPermission(role, p));
}

/**
 * Check if a role has ANY of the specified permissions
 */
export function hasAnyPermission(role: string, permissions: Permission[]): boolean {
  return permissions.some((p) => hasPermission(role, p));
}

/**
 * Get all permissions for a role
 */
export function getPermissionsForRole(role: string): Permission[] {
  return rolePermissions[role] || [];
}

/**
 * Map legacy UserRole to extended role
 */
export function mapToExtendedRole(role: UserRole): ExtendedRole {
  switch (role) {
    case UserRole.ADMIN:
      return ExtendedRole.ADMIN;
    case UserRole.BUSINESS:
      return ExtendedRole.BUSINESS;
    case UserRole.DRIVER:
      return ExtendedRole.DRIVER;
    case UserRole.CLIENT:
      return ExtendedRole.CLIENT;
    default:
      return ExtendedRole.CLIENT;
  }
}
