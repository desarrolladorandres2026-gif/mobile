import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom';
import {
  LogOut, Menu,
  Search, Bell, ChevronDown, ChevronRight,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { ThemeToggle } from './ThemeToggle';
import ConfirmDialog from './ConfirmDialog';
import { useAuthStore } from '../stores/authStore';
import { Permission } from '../lib/permissions';
import {
  DashboardIllustration, PackageIllustration, DeliveryIllustration, StoreIllustration,
  PeopleIllustration, PricingIllustration, CouponIllustration, LocationIllustration,
  BannerIllustration, CategoriesIllustration, MegaphoneIllustration, SecurityIllustration,
  WalletIllustration, LegalIllustration, CalendarIllustration, EvidenceIllustration,
  PositionsIllustration, RolesIllustration,
} from './illustrations';

const navGroups: Array<{
  category: string;
  items: Array<{ path: string; Illustration: typeof DashboardIllustration; label: string; permission?: string }>;
}> = [
  {
    category: 'MENU',
    items: [
      { path: '/', Illustration: DashboardIllustration, label: 'Dashboard' },
      { path: '/daily-summary', Illustration: CalendarIllustration, label: 'Resumen Diario' },
    ],
  },
  {
    category: 'APPS',
    items: [
      { path: '/orders', Illustration: PackageIllustration, label: 'Pedidos' },
      { path: '/evidences', Illustration: EvidenceIllustration, label: 'Evidencias' },
      { path: '/drivers', Illustration: DeliveryIllustration, label: 'Domiciliarios' },
      { path: '/fleet', Illustration: LocationIllustration, label: 'Flota en Vivo' },
    ],
  },
  {
    category: 'CUSTOM',
    items: [
      { path: '/businesses', Illustration: StoreIllustration, label: 'Negocios' },
      { path: '/pricing', Illustration: PricingIllustration, label: 'Tarifas y Precios' },
      { path: '/coupons', Illustration: CouponIllustration, label: 'Cupones' },
      { path: '/zones', Illustration: LocationIllustration, label: 'Zonas' },
      { path: '/home-banners', Illustration: BannerIllustration, label: 'Banners de Inicio' },
      { path: '/home-categories', Illustration: CategoriesIllustration, label: 'Categorías de Inicio' },
      { path: '/campaigns', Illustration: MegaphoneIllustration, label: 'Publicidad' },
    ],
  },
  {
    // Sección "Seguridad y Acceso": Usuarios, Cargos, Roles se administran
    // aquí; Permisos/Auditoría/Sesiones viven como pestañas dentro de
    // "Seguridad" (misma página, `/security`).
    category: 'SEGURIDAD Y ACCESO',
    items: [
      { path: '/users', Illustration: PeopleIllustration, label: 'Usuarios', permission: Permission.USERS_VIEW },
      { path: '/positions', Illustration: PositionsIllustration, label: 'Cargos', permission: Permission.POSITIONS_VIEW },
      { path: '/roles', Illustration: RolesIllustration, label: 'Roles', permission: Permission.ROLES_VIEW },
      { path: '/security', Illustration: SecurityIllustration, label: 'Seguridad', permission: Permission.SECURITY_VIEW },
    ],
  },
  {
    category: 'COMPONENTS',
    items: [
      { path: '/financials', Illustration: WalletIllustration, label: 'Finanzas' },
      { path: '/legal', Illustration: LegalIllustration, label: 'Legal y PQRS' },
    ],
  },
];

export default function Layout() {
  const navigate = useNavigate();
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [showLogoutModal, setShowLogoutModal] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const { user, hasPermission, refresh, clear } = useAuthStore();

  useEffect(() => {
    const token = localStorage.getItem('admin_token');
    if (!token || !localStorage.getItem('admin_user')) {
      navigate('/login');
      return;
    }
    if (user && user.role !== 'admin') {
      clear();
      navigate('/login');
      return;
    }
    // Recalcula permisos/rol contra el backend en cada carga del panel: si
    // otro administrador cambió el rol/cargo de esta cuenta, se refleja
    // sin tener que cerrar sesión y volver a entrar.
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigate]);

  const positionName =
    user?.positionId && typeof user.positionId === 'object' ? user.positionId.name : null;

  const handleLogout = () => {
    setShowLogoutModal(false);
    setSidebarOpen(false);
    setUserMenuOpen(false);
    clear();
    navigate('/login');
  };

  return (
    <div className="flex h-screen bg-[var(--color-bg)] dark:bg-[#080B11] text-[var(--color-text-main)] dark:text-[#EDF1F5] overflow-hidden font-sans transition-colors duration-200">
      {/* ── Sidebar (Dark Slate Zipp Theme) ── */}
      <aside className={`
        fixed inset-y-0 left-0 z-50 w-64 bg-[var(--color-sidebar-hover)] border-r border-[var(--color-sidebar-border)] flex flex-col
        transform transition-transform duration-300 ease-out
        lg:translate-x-0 lg:static lg:inset-0
        ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
      `}>
        {/* Brand Header */}
        <div className="flex items-center gap-3 px-6 py-5 border-b border-[var(--color-sidebar-border)]/70">
          <img
            src="/zipp-crown-logo.png"
            alt="ZIPP"
            className="h-8 w-auto object-contain select-none"
          />
          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-[var(--color-primary-light)]/20 text-[var(--color-primary-light)] border border-[var(--color-primary-light)]/30">
            ADMIN
          </span>
        </div>

        {/* Navigation Categories */}
        <nav className="flex-1 overflow-y-auto sidebar-scroll px-3 py-4 space-y-4">
          {navGroups.map((group) => {
            const visibleItems = group.items.filter((item) => !item.permission || hasPermission(item.permission));
            if (visibleItems.length === 0) return null;
            return (
            <div key={group.category}>
              <p className="text-[10px] font-bold tracking-wider text-[var(--color-text-secondary)] uppercase px-3 mb-1.5">
                {group.category}
              </p>
              <div className="space-y-0.5">
                {visibleItems.map((item) => {
                  const isActive = item.path === '/' ? location.pathname === '/' : location.pathname.startsWith(item.path);
                  return (
                    <NavLink
                      key={item.path}
                      to={item.path}
                      end={item.path === '/'}
                      onClick={() => setSidebarOpen(false)}
                      className={`relative flex items-center gap-3 px-3 py-2 rounded-lg text-xs font-medium transition-all duration-150 ${isActive
                          ? 'bg-[#1B2437] text-white font-semibold shadow-sm'
                          : 'text-[var(--color-text-muted)] hover:text-white hover:bg-[#1B2437]/60'
                        }`}
                    >
                      {isActive && (
                        <span className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-1 rounded-full bg-[var(--color-primary)]" />
                      )}
                      <item.Illustration size={26} />
                      <span className="truncate">{item.label}</span>
                    </NavLink>
                  );
                })}
              </div>
            </div>
            );
          })}
        </nav>

        {/* Sidebar Footer */}
        <div className="p-3 border-t border-[var(--color-sidebar-border)]/70 bg-[var(--color-sidebar)]">
          <button
            onClick={() => setShowLogoutModal(true)}
            className="group flex items-center gap-3 w-full px-4 py-3.5 rounded-2xl border border-[var(--color-danger)]/15 bg-[var(--color-danger)]/5 hover:bg-[var(--color-danger)]/10 hover:border-[var(--color-danger)]/25 active:scale-[0.985] transition-all cursor-pointer"
          >
            <span className="w-10 h-10 shrink-0 rounded-xl bg-[var(--color-danger)]/12 flex items-center justify-center">
              <LogOut className="w-4 h-4 text-[var(--color-danger)]" strokeWidth={1.8} />
            </span>
            <span className="flex-1 min-w-0 text-left">
              <p className="text-xs font-bold text-[var(--color-danger)] leading-tight">Cerrar sesión</p>
              <p className="text-[10px] text-[var(--color-sidebar-text)] leading-tight mt-0.5">Salir del panel de administración</p>
            </span>
            <ChevronRight className="w-4 h-4 text-[var(--color-danger)] opacity-45 shrink-0 transition-transform group-hover:translate-x-0.5" />
          </button>
        </div>
      </aside>

      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-xs lg:hidden animate-fade-in"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* ── Main Content Area ── */}
      <main className="flex-1 overflow-y-auto flex flex-col min-w-0 bg-[var(--color-bg)] dark:bg-[#080B11] transition-colors duration-200">
        {/* Top Header */}
        <header className="sticky top-0 z-30 bg-[var(--color-surface)] dark:bg-[#1B2437] border-b border-[var(--color-border)] dark:border-slate-800/80 px-6 lg:px-8 h-16 flex items-center justify-between gap-4 shadow-xs transition-colors duration-200">
          <div className="flex items-center gap-4 flex-1">
            <button
              className="lg:hidden p-2 rounded-lg text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
              onClick={() => setSidebarOpen(true)}
            >
              <Menu className="w-5 h-5" />
            </button>

            {/* Clean Top Search Bar */}
            <div className="relative w-full max-w-xs md:max-w-sm">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="Buscar en el panel..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-9 pr-4 py-1.5 text-xs rounded-lg bg-slate-50 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:border-[var(--color-primary)] focus:bg-[var(--color-surface)] dark:focus:bg-slate-900 transition-all"
              />
            </div>
          </div>

          {/* Right Header Actions */}
          <div className="flex items-center gap-2 sm:gap-3">
            {/* Theme Toggle (Claro / Oscuro / Automático) */}
            <ThemeToggle />

            {/* Notification Bell */}
            <button
              title="Notificaciones"
              className="p-2 rounded-lg text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
            >
              <Bell className="w-4 h-4" />
            </button>

            <div className="w-px h-6 bg-slate-200 dark:bg-slate-800" />

            {/* User Profile */}
            <div className="relative">
              <button
                onClick={() => setUserMenuOpen(!userMenuOpen)}
                className="flex items-center gap-2.5 p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800/80 transition-all cursor-pointer"
              >
                <div className="w-8 h-8 rounded-full bg-[var(--color-sidebar-hover)] border border-slate-300 dark:border-slate-700 flex items-center justify-center text-xs font-bold text-white shadow-xs">
                  {user?.name?.charAt(0)?.toUpperCase() || 'A'}
                </div>
                <div className="text-left hidden sm:block">
                  <p className="text-xs font-bold text-slate-800 dark:text-slate-100 leading-none">{user?.name || 'Administrador'}</p>
                  <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5 leading-none">{positionName || 'Sin cargo asignado'}</p>
                </div>
                <ChevronDown className="w-3.5 h-3.5 text-slate-400 hidden sm:block" />
              </button>

              {userMenuOpen && (
                <div className="absolute right-0 mt-2 w-52 rounded-xl zipp-modal py-1.5 z-50 border border-slate-200 dark:border-slate-800 animate-fade-in shadow-xl bg-[var(--color-surface)] dark:bg-[#1B2437]">
                  <div className="px-4 py-2 border-b border-slate-100 dark:border-slate-800">
                    <p className="text-xs font-bold text-slate-800 dark:text-slate-100">{user?.name || 'Administrador'}</p>
                    <p className="text-[10px] text-slate-500 dark:text-slate-400 truncate">{user?.email || 'admin@zipp.com'}</p>
                  </div>
                  <button
                    onClick={() => {
                      setUserMenuOpen(false);
                      setShowLogoutModal(true);
                    }}
                    className="w-full text-left px-3.5 py-2.5 text-xs text-rose-600 dark:text-rose-400 hover:bg-rose-500/10 dark:hover:bg-rose-500/15 transition-colors flex items-center gap-2.5 font-semibold cursor-pointer border-t border-slate-100 dark:border-slate-800"
                  >
                    <div className="w-6 h-6 rounded-md bg-rose-500/10 flex items-center justify-center shrink-0">
                      <LogOut className="w-3.5 h-3.5 text-rose-500" />
                    </div>
                    <span>Cerrar Sesión</span>
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        {/* Page Outlet */}
        <div className="p-6 lg:p-8 flex-1">
          <div className="page-container">
            <Outlet />
          </div>
        </div>
      </main>

      {/* Modal de confirmación de Cerrar Sesión */}
      {showLogoutModal && (
        <ConfirmDialog
          title="¿Cerrar sesión?"
          message="Estás a punto de salir del panel de administración ZIPP. Deberás ingresar tus credenciales nuevamente para acceder."
          confirmLabel="Cerrar sesión"
          cancelLabel="Cancelar"
          variant="danger"
          onConfirm={handleLogout}
          onCancel={() => setShowLogoutModal(false)}
        />
      )}
    </div>
  );
}

