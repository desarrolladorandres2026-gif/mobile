import { Permission } from './permissions';
import {
  DashboardLogo, PackageLogo, DeliveryLogo, StoreLogo,
  PeopleLogo, PricingLogo, CouponLogo, LocationLogo,
  BannerLogo, CategoriesLogo, MegaphoneLogo, SecurityLogo,
  WalletLogo, LegalLogo, CalendarLogo, EvidenceLogo,
  PositionsLogo, RolesLogo, ExploreLogo,
} from '../components/logos';

/**
 * Única tabla de navegación del panel: la leen la barra lateral (Layout) y
 * las rutas (App). Cada ítem declara el permiso que exige; es solo UX, el
 * backend vuelve a exigirlo en cada endpoint.
 */
export interface NavItem {
  path: string;
  Illustration: typeof DashboardLogo;
  label: string;
  permission: string;
}

export interface NavGroup {
  category: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    category: 'MENU',
    items: [
      { path: '/', Illustration: DashboardLogo, label: 'Dashboard', permission: Permission.ORDERS_VIEW_ALL },
      { path: '/daily-summary', Illustration: CalendarLogo, label: 'Resumen Diario', permission: Permission.REPORTS_VIEW },
    ],
  },
  {
    category: 'APPS',
    items: [
      { path: '/orders', Illustration: PackageLogo, label: 'Pedidos', permission: Permission.ORDERS_VIEW_ALL },
      { path: '/evidences', Illustration: EvidenceLogo, label: 'Evidencias', permission: Permission.EVIDENCES_VIEW },
      { path: '/drivers', Illustration: DeliveryLogo, label: 'Domiciliarios', permission: Permission.DRIVERS_VIEW },
      { path: '/driver-documents', Illustration: LegalLogo, label: 'Documentos', permission: Permission.DRIVERS_VIEW },
      { path: '/fleet', Illustration: LocationLogo, label: 'Flota en Vivo', permission: Permission.DRIVERS_TRACK },
    ],
  },
  {
    category: 'CUSTOM',
    items: [
      { path: '/businesses', Illustration: StoreLogo, label: 'Negocios', permission: Permission.BUSINESSES_VIEW },
      { path: '/business-approvals', Illustration: LegalLogo, label: 'Verificar Comercios', permission: Permission.BUSINESSES_VIEW },
      { path: '/reviews', Illustration: PeopleLogo, label: 'Reseñas', permission: Permission.REVIEWS_VIEW },
      { path: '/pricing', Illustration: PricingLogo, label: 'Tarifas y Precios', permission: Permission.FINANCE_VIEW },
      { path: '/coupons', Illustration: CouponLogo, label: 'Cupones', permission: Permission.COUPONS_VIEW },
      { path: '/zones', Illustration: LocationLogo, label: 'Zonas', permission: Permission.ZONES_VIEW },
      { path: '/home-banners', Illustration: BannerLogo, label: 'Banners de Inicio', permission: Permission.CONTENT_VIEW },
      { path: '/home-categories', Illustration: CategoriesLogo, label: 'Categorías de Inicio', permission: Permission.CONTENT_VIEW },
      { path: '/curated-home-blocks', Illustration: BannerLogo, label: 'Bloques Curados de Inicio', permission: Permission.CONTENT_VIEW },
      { path: '/campaigns', Illustration: MegaphoneLogo, label: 'Publicidad', permission: Permission.ADS_VIEW },
      { path: '/search-insights', Illustration: CategoriesLogo, label: 'Búsquedas', permission: Permission.CONTENT_VIEW },
      { path: '/explore-builder', Illustration: ExploreLogo, label: 'Constructor de Explorar', permission: Permission.EXPLORE_VIEW },
    ],
  },
  {
    // Sección "Seguridad y Acceso": Usuarios, Cargos, Roles se administran
    // aquí; Permisos/Auditoría/Sesiones viven como pestañas dentro de
    // "Seguridad" (misma página, `/security`).
    category: 'SEGURIDAD Y ACCESO',
    items: [
      { path: '/users', Illustration: PeopleLogo, label: 'Usuarios', permission: Permission.USERS_VIEW },
      { path: '/positions', Illustration: PositionsLogo, label: 'Cargos', permission: Permission.POSITIONS_VIEW },
      { path: '/roles', Illustration: RolesLogo, label: 'Roles', permission: Permission.ROLES_VIEW },
      { path: '/security', Illustration: SecurityLogo, label: 'Seguridad', permission: Permission.SECURITY_VIEW },
      // El centro de incidentes filtra cada tipo por su permiso en el backend.
      { path: '/incidents', Illustration: EvidenceLogo, label: 'Incidentes', permission: Permission.ADMIN_PANEL },
    ],
  },
  {
    category: 'COMPONENTS',
    items: [
      { path: '/financials', Illustration: WalletLogo, label: 'Finanzas', permission: Permission.FINANCE_VIEW },
      { path: '/legal', Illustration: LegalLogo, label: 'Datos personales', permission: Permission.LEGAL_VIEW },
      { path: '/support', Illustration: PeopleLogo, label: 'Soporte', permission: Permission.SUPPORT_VIEW },
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
