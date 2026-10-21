export const PERMISSIONS = [
  'tenant:manage',
  'users:manage',
  'accounts:read',
  'accounts:manage',
  'parties:read',
  'parties:manage',
  'journals:read',
  'journals:post',
  'journals:reverse',
  'reports:read',
  'audit:read',
  'periods:manage',
  'periods:reopen',
  'invoices:read',
  'invoices:issue',
  'receipts:create',
  'receipts:void',
  'settings:manage',
  'purchases:read',
  'purchases:create',
  'purchases:void',
  'payments:create',
  'payments:void',
  'inventory:read',
  'inventory:manage',
  'inventory:adjust',
  'pos:read',
  'pos:sell',
  'pos:void',
  'pos:manage',
  'apikeys:manage',
  'bank:read',
  'bank:manage',
  'assets:read',
  'assets:manage',
];

const READ = ['accounts:read', 'parties:read', 'journals:read', 'reports:read', 'invoices:read', 'purchases:read', 'inventory:read', 'pos:read', 'bank:read', 'assets:read'];

/** Permisos por rol. Lo no listado está denegado. */
export const ROLE_PERMISSIONS = {
  owner: [...PERMISSIONS],
  admin: PERMISSIONS.filter((p) => p !== 'tenant:manage'),
  accountant: [...READ, 'accounts:manage', 'parties:manage', 'journals:post', 'journals:reverse', 'periods:manage', 'invoices:issue', 'receipts:create', 'receipts:void', 'purchases:create', 'purchases:void', 'payments:create', 'payments:void', 'inventory:manage', 'inventory:adjust', 'pos:sell', 'pos:void', 'pos:manage', 'bank:manage', 'assets:manage'],
  // El cajero vende y cierra su turno; no ve la contabilidad ni anula ventas.
  cashier: ['pos:read', 'pos:sell', 'inventory:read', 'parties:read'],
  viewer: [...READ],
};

export const ROLES = Object.keys(ROLE_PERMISSIONS);

export const isRole = (role) => Object.hasOwn(ROLE_PERMISSIONS, role);

export function can(role, permission) {
  return isRole(role) && ROLE_PERMISSIONS[role].includes(permission);
}
