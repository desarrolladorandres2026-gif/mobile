/**
 * Qué ve cada papel en el panel.
 *
 * Espeja `BusinessPermission` y `BusinessRole` del backend
 * (models/BusinessStaff.ts). El backend es quien decide: esto solo esconde
 * lo que de todas formas respondería 403, para que el mostrador no navegue a
 * pantallas vacías.
 */
export type BusinessPermission =
  | 'orders:view'
  | 'orders:manage'
  | 'menu:manage'
  | 'promotions:manage'
  | 'analytics:view'
  | 'settlements:view'
  | 'reviews:reply'
  | 'settings:manage'
  | 'staff:manage'
  | 'store:toggle';

export type BusinessRole = 'owner' | 'manager' | 'staff';

export interface MyAccess {
  role: BusinessRole | null;
  permissions: BusinessPermission[];
}

/**
 * Lo que exige cada sección del menú lateral: un permiso, o `'owner'` cuando
 * sus endpoints todavía comprueban `ownerId` y no `assertCan` (así el
 * encargado no entra a "Menú" por tener `menu:manage` para chocar con un
 * 403). Al pasar un endpoint a `assertCan`, su fila cambia a su permiso.
 * Sin entrada, la sección es de todos (Soporte).
 */
export const NAV_REQUIREMENT: Record<string, BusinessPermission | 'owner'> = {
  '/': 'owner',
  '/orders': 'orders:view',
  '/settlements': 'owner',
  '/menu': 'owner',
  '/promotions': 'owner',
  '/advertising': 'owner',
  '/reviews': 'owner',
  '/staff': 'owner',
  '/documents': 'owner',
  '/settings': 'owner',
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
  if (required === 'owner') return access.role === 'owner';
  return access.permissions.includes(required);
}

/** La primera sección que este papel sí puede ver, para no dejarlo en una vacía. */
export function homeFor(access: MyAccess | undefined): string {
  return canSee('/', access) ? '/' : '/orders';
}
