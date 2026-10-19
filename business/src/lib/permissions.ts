/**
 * Qué ve cada papel en el panel.
 *
 * Espeja `BusinessPermission` y `BusinessRole` del backend
 * (models/BusinessStaff.ts). El backend es quien decide: esto solo esconde
 * lo que de todas formas respondería 403, para que nadie navegue a
 * pantallas vacías ni pulse botones que el servidor le va a negar.
 */
export type BusinessPermission =
  | 'orders:view'
  | 'orders:manage'
  | 'orders:cancel'
  | 'orders:cancel_paid'
  | 'shift:view'
  | 'shift:close'
  | 'catalog:view'
  | 'catalog:create'
  | 'catalog:edit'
  | 'catalog:delete'
  | 'catalog:change_price'
  | 'catalog:availability'
  | 'promotions:view'
  | 'promotions:manage'
  | 'advertising:manage'
  | 'reviews:view'
  | 'reviews:respond'
  | 'team:view'
  | 'team:invite'
  | 'team:edit'
  | 'team:remove'
  | 'team:change_role'
  | 'analytics:view'
  | 'settlements:view'
  | 'settlements:manage'
  | 'financial:view'
  | 'documents:view'
  | 'documents:manage'
  | 'business:view'
  | 'business:edit'
  | 'settings:view'
  | 'settings:manage'
  | 'security:manage'
  | 'store:toggle'
  | 'support:view_team'
  | 'customers:contact';

export type BusinessRole = 'owner' | 'manager' | 'employee';
/** Los papeles que se pueden dar a alguien del equipo (el dueño no se asigna). */
export type StaffRole = Exclude<BusinessRole, 'owner'>;

export const ROLE_LABELS: Record<BusinessRole, string> = {
  owner: 'Propietario',
  manager: 'Administrador',
  employee: 'Empleado',
};

export const ROLE_DESCRIPTIONS: Record<StaffRole, string> = {
  manager: 'Pedidos (cancela solo los no pagados), menú, promociones, publicidad, reseñas, equipo operativo y pedir a ZIPP que contacte a un cliente. No ve liquidaciones, documentos ni ajustes, y no cambia roles.',
  employee: 'Ejecuta el día: pedidos (cancela solo los no pagados), agotar y reponer productos, y abrir y cerrar el local. No ve dinero ni equipo.',
};

/**
 * El mostrador se guardó como `staff` y luego como `operator` o `cashier`
 * hasta que el 2026-10-09 se fundió en `employee`; el backend ya lo traduce,
 * pero una respuesta en caché o una fila sin migrar no debe dejar la pantalla
 * sin etiqueta.
 */
export function normalizeRole(raw: string | null | undefined): BusinessRole | null {
  if (!raw) return null;
  // `staff`, `operator` y `cashier` son los nombres que tuvo el mostrador
  // antes de fundirse en `employee`; una respuesta en caché aún puede traerlos.
  if (raw === 'staff' || raw === 'operator' || raw === 'cashier') return 'employee';
  return raw in ROLE_LABELS ? (raw as BusinessRole) : null;
}

export interface MyAccess {
  role: BusinessRole | null;
  permissions: BusinessPermission[];
}

/**
 * El permiso que exige cada sección del menú lateral: el mismo que pide su
 * endpoint principal. Sin entrada, la sección es de todos (Soporte, la
 * seguridad de la propia cuenta, este equipo).
 */
export const NAV_REQUIREMENT: Record<string, BusinessPermission> = {
  // La portada es de todos los que ven pedidos: el propietario recibe el
  // cierre con dinero y el resto su resumen por papel (ver `pages/Home`).
  '/': 'orders:view',
  '/orders': 'orders:view',
  '/scheduled': 'orders:view',
  '/analytics': 'analytics:view',
  '/settlements': 'settlements:view',
  '/menu': 'catalog:view',
  '/promotions': 'promotions:view',
  '/advertising': 'advertising:manage',
  '/reviews': 'reviews:view',
  '/staff': 'team:view',
  // Listar los documentos ya pide `documents:manage` en el backend.
  '/documents': 'documents:manage',
  '/settings': 'settings:view',
};

/**
 * ¿Puede ver esta sección? Mientras no se sabe (cargando o sin respuesta)
 * se muestra: casi siempre entra el dueño, y ocultarle el menú en cada
 * carga sería peor que enseñarle al empleado un instante algo que el
 * backend igual le niega.
 */
export function canSee(path: string, access: MyAccess | undefined): boolean {
  const required = NAV_REQUIREMENT[path];
  if (!required || !access) return true;
  return access.permissions.includes(required);
}

/** La primera sección que este papel sí puede ver, para no dejarlo en una vacía. */
export function homeFor(access: MyAccess | undefined): string {
  return canSee('/', access) ? '/' : '/orders';
}
