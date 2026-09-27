import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom';
import {
 LogOut, Menu,
 ChevronDown, ChevronRight, RefreshCw,
} from 'lucide-react';
import { Suspense, useEffect, useState } from 'react';
import { ThemeToggle } from './ThemeToggle';
import ConfirmDialog from './ConfirmDialog';
import GlobalSearch from './GlobalSearch';
import AlertsTray from './AlertsTray';
import OrderNotifications from './OrderNotifications';
import FichaHost from './fichas/FichaHost';
import { useAuthStore } from '../stores/authStore';
import { NAV_GROUPS } from '../lib/navigation';
import { preloadOn } from '../lib/lazyPage';
/** Lo que se ve el instante en que llega el archivo de una página. */
function PageLoading() {
 return (
 <div className="flex items-center justify-center py-24">
 <RefreshCw className="w-6 h-6 text-[var(--color-primary)] animate-spin" />
 </div>
 );
}

const IDLE_LIMIT_MS = 30 * 60_000;
const IDLE_WARNING_MS = 60_000;
const ACTIVITY_KEY = 'admin_last_activity';

const markActivity = (at: number) => {
 try {
 localStorage.setItem(ACTIVITY_KEY, String(at));
 } catch {
 // Sin almacenamiento, cada pestaña mide solo su propia actividad.
 }
};

const lastActivity = () => {
 try {
 return Number(localStorage.getItem(ACTIVITY_KEY)) || Date.now();
 } catch {
 return Date.now();
 }
};

export default function Layout() {
 const navigate = useNavigate();
 const location = useLocation();
 const [sidebarOpen, setSidebarOpen] = useState(false);
 const [userMenuOpen, setUserMenuOpen] = useState(false);
 const [showLogoutModal, setShowLogoutModal] = useState(false);
 const [idleWarning, setIdleWarning] = useState(false);
 const { user, hasPermission, refresh, clear, logout, authzMode, observedPermissions } = useAuthStore();

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

 // Mismo plazo que el servidor (30 min sin uso). La actividad se comparte
 // entre pestañas por localStorage: si no, una pestaña de fondo cerraba la
 // sesión de todas, incluida la que vigila el SOS.
 useEffect(() => {
 let lastWrite = 0;
 const touch = () => {
 const now = Date.now();
 if (now - lastWrite < 15_000) return;
 lastWrite = now;
 markActivity(now);
 };
 const check = () => {
 const idle = Date.now() - lastActivity();
 if (idle >= IDLE_LIMIT_MS) {
 void logout().then(() => navigate('/login?motivo=inactividad'));
 } else {
 setIdleWarning(idle >= IDLE_LIMIT_MS - IDLE_WARNING_MS);
 }
 };
 const events = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'] as const;
 events.forEach((e) => window.addEventListener(e, touch, { passive: true }));
 markActivity(Date.now());
 const interval = setInterval(check, 10_000);
 return () => {
 clearInterval(interval);
 events.forEach((e) => window.removeEventListener(e, touch));
 };
 }, [logout, navigate]);

 //"Sigo aquí" también toca el servidor: si solo se miró el mapa o el SOS,
 // no hubo peticiones y la sesión del servidor caducaría igual.
 const stayActive = () => {
 markActivity(Date.now());
 setIdleWarning(false);
 void refresh();
 };

 const positionName =
 user?.positionId && typeof user.positionId === 'object' ? user.positionId.name : null;

 const handleLogout = async () => {
 setShowLogoutModal(false);
 setSidebarOpen(false);
 setUserMenuOpen(false);
 await logout();
 navigate('/login');
 };

 return (
 <div className="flex h-screen bg-[var(--color-bg)] dark:bg-[#080B11] text-[var(--color-text-main)] overflow-hidden font-sans transition-colors duration-200">
 {/* ── Sidebar (Dark Slate Zipp Theme) ── */}
 <aside className={`
 fixed inset-y-0 left-0 z-50 w-64 bg-linear-to-b from-[var(--color-sidebar-deep)] from-35% to-[var(--color-sidebar-glow)] border-r border-[var(--color-sidebar-border)] flex flex-col
 transform transition-transform duration-300 ease-out
 lg:translate-x-0 lg:static lg:inset-0
 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
 `}>
 {/* Navigation Categories */}
 <nav className="flex-1 overflow-y-auto sidebar-scroll px-3 py-3 space-y-3">
 {NAV_GROUPS.map((group) => {
 const visibleItems = group.items.filter((item) => hasPermission(item.permission));
 if (visibleItems.length === 0) return null;
 return (
 <div key={group.category}>
 <p className="text-xs font-bold tracking-wider text-white uppercase px-3 mb-1">
 {group.category}
 </p>
 <div className="space-y-0">
 {visibleItems.map((item) => {
 const isActive = item.path === '/' ? location.pathname === '/' : location.pathname.startsWith(item.path);
 return (
 <div key={item.path} className="ml-6">
 <NavLink
 to={item.path}
 end={item.path === '/'}
 onClick={() => setSidebarOpen(false)}
 // El archivo de la pagina se pide al apuntar, no al
 // pulsar: para cuando llega el clic ya esta descargado
 // y no hay spinner. Ver `preloadOn`.
 {...preloadOn(item.path)}
 className={`relative flex items-center gap-3 px-3 py-0.5 rounded-lg text-xs font-medium transition-all duration-150 ${isActive
 ? 'bg-[#1B2437] text-white font-semibold shadow-sm'
 : 'text-[var(--color-sidebar-text)] hover:text-white hover:bg-[#1B2437]/60'
 }`}
 >
 {isActive && (
 <span className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-1 rounded-full bg-[var(--color-primary)]" />
 )}
 <item.Icon fontSize={20} style={{ color: 'white' }} />
 <span className="truncate">{item.label}</span>
 </NavLink>
 </div>
 );
 })}
 </div>
 </div>
 );
 })}
 </nav>

 {/* Sidebar Footer */}
 <div className="px-3 py-3 border-t border-[var(--color-sidebar-border)]/70">
 <button
 onClick={() => setShowLogoutModal(true)}
 className="group flex items-center gap-3 w-full px-1 py-1 cursor-pointer"
 >
 <LogOut className="w-4 h-4 shrink-0 text-[var(--color-danger)]" strokeWidth={1.8} />
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
 <OrderNotifications />
 {/* Top Header */}
 <header className="sticky top-0 z-30 bg-[var(--color-surface)] dark:bg-[#1B2437] border-b border-[var(--color-border)] dark:border-slate-800/80 px-6 lg:px-8 h-16 flex items-center justify-between gap-4 shadow-xs transition-colors duration-200">
 <div className="flex items-center gap-4 flex-1">
 <button
 className="lg:hidden p-2 rounded-lg text-slate-900 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
 onClick={() => setSidebarOpen(true)}
 >
 <Menu className="w-5 h-5" />
 </button>

 {/* Búsqueda global: pedidos, clientes, comercios, domiciliarios, cupones */}
 <GlobalSearch />
 </div>

 {/* Right Header Actions */}
 <div className="flex items-center gap-2 sm:gap-3">
 {/* Theme Toggle (Claro / Oscuro / Automático) */}
 <ThemeToggle />

 {/* Bandeja de alertas */}
 <AlertsTray />

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
 <p className="text-[10px] text-slate-900 dark:text-slate-400 mt-0.5 leading-none">{positionName || 'Sin cargo asignado'}</p>
 </div>
 <ChevronDown className="w-3.5 h-3.5 text-slate-900 hidden sm:block" />
 </button>

 {userMenuOpen && (
 <div className="absolute right-0 mt-2 w-52 rounded-xl zipp-modal py-1.5 z-50 border border-slate-200 dark:border-slate-800 animate-fade-in shadow-xl bg-[var(--color-surface)] dark:bg-[#1B2437]">
 <div className="px-4 py-2 border-b border-slate-100 dark:border-slate-800">
 <p className="text-xs font-bold text-slate-800 dark:text-slate-100">{user?.name || 'Administrador'}</p>
 <p className="text-[10px] text-slate-900 dark:text-slate-400 truncate">{user?.email || 'admin@zipp.com'}</p>
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

 {authzMode === 'observe' && observedPermissions.length > 0 && (
 <p className="px-6 lg:px-8 pt-3 text-xs font-semibold text-[var(--color-warning)]">
 Modo observación: hoy conservas accesos que perderás al activar el bloqueo.
 </p>
 )}

 {/* Page Outlet */}
 <div className="p-6 lg:p-8 flex-1">
 <div className="page-container">
 {/* La barra lateral y la cabecera siguen en pantalla mientras
 llega el archivo de la página (ver lazyPage en App.tsx). */}
 <Suspense fallback={<PageLoading />}>
 <Outlet />
 </Suspense>
 </div>
 </div>
 </main>

 {/* Ficha lateral (?ficha=tipo:id), sobre cualquier página */}
 <FichaHost />

 {idleWarning && (
 <ConfirmDialog
 title="¿Sigues ahí?"
 message="Por seguridad, la sesión se cierra en menos de un minuto si no hay actividad."
 confirmLabel="Sigo aquí"
 cancelLabel="Cerrar sesión"
 variant="warning"
 onConfirm={stayActive}
 onCancel={() => {
 setIdleWarning(false);
 void handleLogout();
 }}
 />
 )}

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

