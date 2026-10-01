import { Permission } from './permissions';
import type { FluentIcon } from '@fluentui/react-icons';
import {
  GridRegular,
  CalendarRegular,
  BoxRegular,
  CameraRegular,
  VehicleMotorcycleRegular,
  DocumentRegular,
  LocationRegular,
  BuildingShopRegular,
  PeopleRegular,
  TagRegular,
  TicketDiagonalRegular,
  ImageRegular,
  AppsListRegular,
  MegaphoneRegular,
  ShieldRegular,
  WalletRegular,
  PersonTagRegular,
  KeyRegular,
  CompassNorthwestRegular,
} from '@fluentui/react-icons';

/**
 * Única tabla de navegación del panel: la leen la barra lateral (Layout) y
 * las rutas (App). Cada ítem declara el permiso que exige; es solo UX, el
 * backend vuelve a exigirlo en cada endpoint.
 */
export interface NavItem {
  path: string;
  Icon: FluentIcon;
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
    category: 'MENÚ',
    items: [
      { path: '/daily-summary', Icon: CalendarRegular, label: 'Resumen Diario', permission: Permission.REPORTS_VIEW },
    ],
  },
  {
    category: 'APLICACIONES',
    items: [
      { path: '/orders', Icon: BoxRegular, label: 'Pedidos', permission: Permission.ORDERS_VIEW_ALL },
      { path: '/fleet', Icon: LocationRegular, label: 'Flota en Vivo', permission: Permission.DRIVERS_TRACK },
      { path: '/drivers', Icon: VehicleMotorcycleRegular, label: 'Domiciliarios', permission: Permission.DRIVERS_VIEW },
      { path: '/driver-documents', Icon: DocumentRegular, label: 'Documentos', permission: Permission.DRIVERS_VIEW },
    ],
  },
  {
    category: 'FINANZAS Y SOPORTE',
    items: [
      { path: '/financials', Icon: WalletRegular, label: 'Finanzas', permission: Permission.FINANCE_VIEW },
      { path: '/settlements', Icon: WalletRegular, label: 'Liquidaciones', permission: Permission.FINANCE_VIEW },
      { path: '/payments', Icon: WalletRegular, label: 'Pagos en línea', permission: Permission.FINANCE_VIEW },
      { path: '/cash', Icon: WalletRegular, label: 'Efectivo', permission: Permission.FINANCE_VIEW },
      { path: '/refunds', Icon: BoxRegular, label: 'Reembolsos', permission: Permission.REFUNDS_VIEW },
      { path: '/support', Icon: PeopleRegular, label: 'Soporte', permission: Permission.SUPPORT_VIEW },
      { path: '/commissions', Icon: TagRegular, label: 'Comisiones', permission: Permission.COMMISSIONS_VIEW },
      { path: '/documents', Icon: DocumentRegular, label: 'Comprobantes', permission: Permission.FINANCE_VIEW },
      { path: '/ad-invoices', Icon: MegaphoneRegular, label: 'Facturas de publicidad', permission: Permission.FINANCE_VIEW },
      { path: '/exports', Icon: TagRegular, label: 'Exportes', permission: Permission.REPORTS_EXPORT },
      { path: '/legal', Icon: DocumentRegular, label: 'Legal y datos', permission: Permission.LEGAL_VIEW },
    ],
  },
  {
    category: 'SEGURIDAD Y ACCESO',
    items: [
      { path: '/security', Icon: ShieldRegular, label: 'Seguridad', permission: Permission.SECURITY_VIEW },
      { path: '/users', Icon: PeopleRegular, label: 'Usuarios', permission: Permission.USERS_VIEW },
      { path: '/roles', Icon: KeyRegular, label: 'Roles', permission: Permission.ROLES_VIEW },
      { path: '/positions', Icon: PersonTagRegular, label: 'Cargos', permission: Permission.POSITIONS_VIEW },
      { path: '/app-health', Icon: GridRegular, label: 'Salud de la app', permission: Permission.REPORTS_VIEW },
      { path: '/feature-flags', Icon: KeyRegular, label: 'Interruptores', permission: Permission.SETTINGS_VIEW },
      { path: '/incidents', Icon: CameraRegular, label: 'Incidentes', permission: Permission.ADMIN_PANEL, hidden: true },
    ],
  },
  {
    category: 'COMERCIOS Y CONTENIDO',
    items: [
      { path: '/business-approvals', Icon: DocumentRegular, label: 'Verificar Comercios', permission: Permission.BUSINESSES_VIEW },
      { path: '/businesses', Icon: BuildingShopRegular, label: 'Negocios', permission: Permission.BUSINESSES_VIEW },
      { path: '/pricing', Icon: TagRegular, label: 'Tarifas y Precios', permission: Permission.FINANCE_VIEW },
      { path: '/coupons', Icon: TicketDiagonalRegular, label: 'Cupones', permission: Permission.COUPONS_VIEW },
      { path: '/zones', Icon: LocationRegular, label: 'Zonas', permission: Permission.ZONES_VIEW },
      { path: '/reviews', Icon: PeopleRegular, label: 'Reseñas', permission: Permission.REVIEWS_VIEW },
      { path: '/campaigns', Icon: MegaphoneRegular, label: 'Publicidad', permission: Permission.ADS_VIEW },
      { path: '/pro', Icon: WalletRegular, label: 'Zipp Pro', permission: Permission.FINANCE_VIEW },
      { path: '/referrals', Icon: PeopleRegular, label: 'Referidos', permission: Permission.COUPONS_VIEW },
      { path: '/targeted-sends', Icon: MegaphoneRegular, label: 'Envíos dirigidos', permission: Permission.NOTIFICATIONS_VIEW },
      { path: '/home-banners', Icon: ImageRegular, label: 'Banners de Inicio', permission: Permission.CONTENT_VIEW },
      { path: '/home-content', Icon: CompassNorthwestRegular, label: 'Inicio y Explorar', permission: Permission.CONTENT_VIEW },
      { path: '/search-insights', Icon: AppsListRegular, label: 'Búsquedas', permission: Permission.CONTENT_VIEW },
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
