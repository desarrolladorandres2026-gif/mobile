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
}

// ── Extended Roles ──
//
// Estos son los roles *legacy*, resueltos únicamente a partir de
// `User.role` (el tipo de cuenta) para mantener retrocompatibilidad total:
// cualquier cuenta que no tenga Roles de RBAC asignados explícitamente
// sigue teniendo exactamente los permisos que tenía antes de este módulo.
// Los Cargos/Roles administrables desde el panel (colecciones `Position` y
// `Role`, ver rbac.routes.ts) se resuelven aparte, en
// `services/authorization.service.ts`, y se **suman** a estos.
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
