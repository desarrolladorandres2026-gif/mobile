/**
 * Espejo en el frontend del enum `Permission` del backend
 * (`backend/src/security/rbac.ts`). Son literales de texto (`modulo:accion`)
 * — no hay forma de compartir el enum de TypeScript entre los dos paquetes
 * de Vite/Node sin un monorepo con paths compartidos, así que este archivo
 * se mantiene sincronizado a mano. Si agregas un permiso nuevo en el
 * backend, agrégalo aquí también.
 *
 * Solo se usa para UX (ocultar botones, condicionar rutas) — ver
 * `components/PermissionGate.tsx` y `stores/authStore.ts`. El backend
 * vuelve a exigir el permiso real en cada endpoint.
 */
export const Permission = {
  USERS_VIEW: 'users:view',
  USERS_CREATE: 'users:create',
  USERS_UPDATE: 'users:update',
  USERS_DELETE: 'users:delete',
  USERS_BLOCK: 'users:block',
  USERS_ROLE_CHANGE: 'users:role_change',

  ORDERS_VIEW_OWN: 'orders:view_own',
  ORDERS_VIEW_ALL: 'orders:view_all',
  ORDERS_CREATE: 'orders:create',
  ORDERS_UPDATE: 'orders:update',
  ORDERS_CANCEL: 'orders:cancel',
  ORDERS_MODIFY: 'orders:modify',
  ORDERS_ASSIGN_DRIVER: 'orders:assign_driver',

  BUSINESSES_VIEW: 'businesses:view',
  BUSINESSES_CREATE: 'businesses:create',
  BUSINESSES_UPDATE_OWN: 'businesses:update_own',
  BUSINESSES_UPDATE_ALL: 'businesses:update_all',
  BUSINESSES_DELETE: 'businesses:delete',
  BUSINESSES_APPROVE: 'businesses:approve',

  PRODUCTS_VIEW: 'products:view',
  PRODUCTS_CREATE: 'products:create',
  PRODUCTS_UPDATE: 'products:update',
  PRODUCTS_DELETE: 'products:delete',

  DRIVERS_VIEW: 'drivers:view',
  DRIVERS_APPROVE: 'drivers:approve',
  DRIVERS_SUSPEND: 'drivers:suspend',
  DRIVERS_UPDATE: 'drivers:update',
  DRIVERS_TRACK: 'drivers:track',

  FINANCE_VIEW: 'finance:view',
  FINANCE_MANAGE: 'finance:manage',
  COMMISSIONS_VIEW: 'commissions:view',
  COMMISSIONS_MANAGE: 'commissions:manage',
  PAYOUTS_PROCESS: 'payouts:process',

  ADMIN_PANEL: 'admin:panel',
  ADMIN_SETTINGS: 'admin:settings',
  ADMIN_AUDIT_LOGS: 'admin:audit_logs',
  ADMIN_SECURITY: 'admin:security',
  ADMIN_REPORTS: 'admin:reports',

  SECURITY_VIEW: 'security:view',
  SECURITY_MANAGE: 'security:manage',
  FRAUD_ALERTS_VIEW: 'fraud:alerts_view',
  FRAUD_ALERTS_MANAGE: 'fraud:alerts_manage',

  NOTIFICATIONS_SEND: 'notifications:send',
  NOTIFICATIONS_VIEW: 'notifications:view',

  POSITIONS_VIEW: 'positions:view',
  POSITIONS_CREATE: 'positions:create',
  POSITIONS_UPDATE: 'positions:update',
  POSITIONS_DELETE: 'positions:delete',

  ROLES_VIEW: 'roles:view',
  ROLES_CREATE: 'roles:create',
  ROLES_UPDATE: 'roles:update',
  ROLES_DELETE: 'roles:delete',

  REPORTS_VIEW: 'reports:view',
  REPORTS_EXPORT: 'reports:export',

  SETTINGS_VIEW: 'settings:view',
  SETTINGS_UPDATE: 'settings:update',

  EXPLORE_VIEW: 'explore:view',
  EXPLORE_MANAGE: 'explore:manage',
  ZONES_VIEW: 'zones:view',
  ZONES_MANAGE: 'zones:manage',
  USERS_VIEW_SENSITIVE: 'users:view_sensitive',
  EVIDENCES_VIEW: 'evidences:view',
  PAYOUTS_REVEAL_ACCOUNT: 'payouts:reveal_account',
  REFUNDS_VIEW: 'refunds:view',
  REFUNDS_CREATE: 'refunds:create',
  COUPONS_VIEW: 'coupons:view',
  COUPONS_MANAGE: 'coupons:manage',
  ADS_VIEW: 'ads:view',
  ADS_MANAGE: 'ads:manage',
  REVIEWS_VIEW: 'reviews:view',
  REVIEWS_MODERATE: 'reviews:moderate',
  CONTENT_VIEW: 'content:view',
  CONTENT_MANAGE: 'content:manage',
  SUPPORT_VIEW: 'support:view',
  SUPPORT_MANAGE: 'support:manage',
  LEGAL_VIEW: 'legal:view',
  LEGAL_MANAGE: 'legal:manage',
  LEGAL_PUBLISH: 'legal:publish',
  SOS_VIEW: 'sos:view',
  SOS_MANAGE: 'sos:manage',
} as const;

export type PermissionKey = (typeof Permission)[keyof typeof Permission];

export const SUPER_ADMIN_ROLE_SLUG = 'super_admin';

/** Etiquetas en español para el catálogo de permisos (matriz de Roles). */
export const MODULE_LABELS: Record<string, string> = {
  users: 'Usuarios',
  orders: 'Pedidos',
  businesses: 'Negocios',
  products: 'Productos',
  drivers: 'Domiciliarios',
  finance: 'Finanzas',
  commissions: 'Comisiones',
  payouts: 'Liquidaciones',
  admin: 'Panel Admin',
  security: 'Seguridad',
  fraud: 'Antifraude',
  notifications: 'Notificaciones',
  positions: 'Cargos',
  roles: 'Roles',
  reports: 'Reportes',
  settings: 'Configuración',
  explore: 'Constructor de Explorar',
  zones: 'Zonas',
  evidences: 'Evidencias',
  refunds: 'Reembolsos',
  coupons: 'Cupones',
  ads: 'Publicidad',
  reviews: 'Reseñas',
  content: 'Contenido de Inicio',
  support: 'Soporte',
  legal: 'Datos personales',
  sos: 'SOS',
};

export const ACTION_LABELS: Record<string, string> = {
  view: 'Ver',
  view_own: 'Ver propios',
  view_all: 'Ver todos',
  create: 'Crear',
  update: 'Editar',
  delete: 'Eliminar',
  block: 'Bloquear',
  role_change: 'Cambiar rol',
  cancel: 'Cancelar',
  modify: 'Modificar',
  assign_driver: 'Asignar domiciliario',
  update_own: 'Editar propio',
  update_all: 'Editar todos',
  approve: 'Aprobar',
  suspend: 'Suspender',
  track: 'Rastrear',
  manage: 'Gestionar',
  process: 'Procesar',
  panel: 'Acceso al panel',
  settings: 'Configuración',
  audit_logs: 'Auditoría',
  security: 'Seguridad',
  reports: 'Reportes',
  alerts_view: 'Ver alertas',
  alerts_manage: 'Gestionar alertas',
  send: 'Enviar',
  export: 'Exportar',
  view_sensitive: 'Ver datos sensibles',
  reveal_account: 'Revelar cuenta',
  moderate: 'Moderar',
};

export function moduleLabel(mod: string): string {
  return MODULE_LABELS[mod] || mod;
}

export function actionLabel(action: string): string {
  return ACTION_LABELS[action] || action;
}
