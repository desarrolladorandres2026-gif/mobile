import { Permission } from './permissions';

/**
 * Única tabla de navegación del panel: la leen la barra lateral (Layout) y
 * las rutas (App). Cada ítem declara el permiso que exige; es solo UX, el
 * backend vuelve a exigirlo en cada endpoint.
 */
export interface NavItem {
  path: string;
  label: string;
  permission: string;
  /** Ruta y permiso válidos, pero sin entrada propia en la barra lateral (vive dentro de otra pantalla). */
  hidden?: boolean;
}

export interface NavGroup {
  category: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    category: 'Hoy',
    items: [
      { path: '/daily-summary', label: 'Resumen diario', permission: Permission.REPORTS_VIEW },
      { path: '/orders', label: 'Pedidos', permission: Permission.ORDERS_VIEW_ALL },
      { path: '/fleet', label: 'Flota en vivo', permission: Permission.DRIVERS_TRACK },
      { path: '/support', label: 'Soporte', permission: Permission.SUPPORT_VIEW },
    ],
  },
  {
    category: 'Repartidores',
    items: [
      { path: '/drivers', label: 'Domiciliarios', permission: Permission.DRIVERS_VIEW },
      { path: '/driver-documents', label: 'Documentos', permission: Permission.DRIVERS_VIEW },
    ],
  },
  {
    category: 'Dinero',
    items: [
      { path: '/financials', label: 'Finanzas', permission: Permission.FINANCE_VIEW },
      { path: '/settlements', label: 'Liquidaciones', permission: Permission.FINANCE_VIEW },
      { path: '/payments', label: 'Pagos en línea', permission: Permission.FINANCE_VIEW },
      { path: '/cash', label: 'Efectivo', permission: Permission.FINANCE_VIEW },
      { path: '/refunds', label: 'Reembolsos', permission: Permission.REFUNDS_VIEW },
      { path: '/commissions', label: 'Comisiones', permission: Permission.COMMISSIONS_VIEW },
      { path: '/documents', label: 'Comprobantes', permission: Permission.FINANCE_VIEW },
      { path: '/ad-invoices', label: 'Cobros de publicidad', permission: Permission.FINANCE_VIEW },
      { path: '/exports', label: 'Exportes', permission: Permission.REPORTS_EXPORT },
    ],
  },
  {
    category: 'Comercios',
    items: [
      { path: '/business-approvals', label: 'Verificar comercios', permission: Permission.BUSINESSES_VIEW },
      { path: '/businesses', label: 'Negocios', permission: Permission.BUSINESSES_VIEW },
      { path: '/pricing', label: 'Tarifas y precios', permission: Permission.FINANCE_VIEW },
      { path: '/tax-rules', label: 'Impuestos', permission: Permission.FINANCE_VIEW },
      { path: '/zones', label: 'Zonas', permission: Permission.ZONES_VIEW },
      { path: '/reviews', label: 'Reseñas', permission: Permission.REVIEWS_VIEW },
    ],
  },
  {
    category: 'Crecimiento',
    items: [
      { path: '/coupons', label: 'Cupones', permission: Permission.COUPONS_VIEW },
      { path: '/campaigns', label: 'Publicidad', permission: Permission.ADS_VIEW },
      { path: '/pro', label: 'Zipp Pro', permission: Permission.FINANCE_VIEW },
      { path: '/referrals', label: 'Referidos', permission: Permission.COUPONS_VIEW },
      { path: '/targeted-sends', label: 'Envíos dirigidos', permission: Permission.NOTIFICATIONS_VIEW },
    ],
  },
  {
    category: 'Contenido',
    items: [
      { path: '/home-banners', label: 'Banners de inicio', permission: Permission.CONTENT_VIEW },
      { path: '/home-content', label: 'Inicio y explorar', permission: Permission.CONTENT_VIEW },
      { path: '/search-insights', label: 'Búsquedas', permission: Permission.CONTENT_VIEW },
    ],
  },
  {
    category: 'Sistema',
    items: [
      { path: '/users', label: 'Usuarios', permission: Permission.USERS_VIEW },
      { path: '/roles', label: 'Roles', permission: Permission.ROLES_VIEW },
      { path: '/positions', label: 'Cargos', permission: Permission.POSITIONS_VIEW },
      { path: '/security', label: 'Seguridad', permission: Permission.SECURITY_VIEW },
      { path: '/app-health', label: 'Salud de la app', permission: Permission.REPORTS_VIEW },
      { path: '/feature-flags', label: 'Interruptores', permission: Permission.SETTINGS_VIEW },
      { path: '/legal', label: 'Legal y datos', permission: Permission.LEGAL_VIEW },
      { path: '/incidents', label: 'Incidentes', permission: Permission.ADMIN_PANEL, hidden: true },
    ],
  },
];

const ALL_ITEMS = NAV_GROUPS.flatMap((g) => g.items);

export function findNavItem(path: string): NavItem | undefined {
  return ALL_ITEMS.find((i) => i.path === path);
}

/** ¿Tiene el usuario acceso a al menos una pantalla? Si no, no tiene rol. */
export function hasAnyAccess(has: (permission: string) => boolean): boolean {
  return ALL_ITEMS.some((i) => has(i.permission));
}

/**
 * Primera pantalla a la que el usuario sí tiene acceso. Incidentes
 * (`admin:panel`) va al final: no debe ser el destino por defecto de quien
 * tiene cosas más concretas.
 */
export function firstAccessiblePath(has: (permission: string) => boolean): string | null {
  const hit = ALL_ITEMS.find((i) => i.path !== '/incidents' && has(i.permission));
  if (hit) return hit.path;
  const incidents = findNavItem('/incidents');
  return incidents && has(incidents.permission) ? incidents.path : null;
}
