import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom';
import {
 LogOut, Menu, ArrowLeft, ArrowRight, Home,
 ChevronDown, RefreshCw,
} from 'lucide-react';
import { Suspense, useEffect, useState } from 'react';
import { ThemeToggle } from './ThemeToggle';
import ConfirmDialog from './ConfirmDialog';
import GlobalSearch from './GlobalSearch';
import AlertsTray from './AlertsTray';
import OrderNotifications from './OrderNotifications';
import FichaHost from './fichas/FichaHost';
import { useAdminSocketStatus } from '../hooks/useAdminSocket';
import { useAuthStore } from '../stores/authStore';
import { NAV_GROUPS } from '../lib/navigation';
import { preloadOn } from '../lib/lazyPage';
import { ZippMark } from './ZippMark';
/** Lo que se ve el instante en que llega el archivo de una página. */
function PageLoading() {
 return (
 <div className="flex items-center justify-center py-24">
 <RefreshCw className="w-6 h-6 text-[var(--color-text-main)] animate-spin" />
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
  const liveStatus = useAdminSocketStatus();
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
 {/* ── Navegación compacta, compartida con Business ── */}
 <aside className={`
 admin-sidebar fixed inset-y-0 left-0 z-50 w-30 bg-[var(--color-bg-alt)] border-r border-[var(--color-border)] flex flex-col shadow-[1px_0_3px_rgba(0,0,0,0.08)]
 transform transition-transform duration-300 ease-out
 lg:translate-x-0 lg:static lg:inset-0
 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
 `}>
 <div className="relative h-14 shrink-0 border-b border-[var(--color-border)] flex items-center justify-center gap-2">
 <ZippMark size={25} mono="#D69E26" />
 <span className="text-[15px] font-semibold tracking-tight text-[var(--color-text-secondary)]">ZIPP</span>
 <button aria-label="Cerrar menú" className="absolute right-2 top-2 p-1 text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)] lg:hidden" onClick={() => setSidebarOpen(false)}>
 <Menu className="w-4 h-4" />
 </button>
 </div>
 {/* Navigation Categories */}
 <nav aria-label="Navegación principal" lang="es" className="flex-1 overflow-y-auto overflow-x-hidden admin-sidebar-scroll py-1">
 {/* Una sola cuadrícula de dos columnas para todos los grupos: así no
 quedan huecos cuando un grupo tiene un número impar de ítems. */}
 <div className="grid grid-cols-2 border-t border-[var(--color-border)]">
 {NAV_GROUPS.flatMap((group) => group.items)
 .filter((item) => !item.hidden && hasPermission(item.permission))
 .map((item) => {
 const isActive = item.path === '/' ? location.pathname === '/' : location.pathname.startsWith(item.path);
 return (
 <NavLink
 key={item.path}
 to={item.path}
 end={item.path === '/'}
 onClick={() => setSidebarOpen(false)}
 // El archivo de la pagina se pide al apuntar, no al
 // pulsar: para cuando llega el clic ya esta descargado
 // y no hay spinner. Ver `preloadOn`.
 {...preloadOn(item.path)}
 title={item.label}
 aria-label={item.label}
 className={`relative flex min-h-16 min-w-0 flex-col items-center justify-center gap-0.5 border-b border-[var(--color-border)] px-0.5 py-1.5 text-[9.5px] font-medium transition-colors duration-150 odd:border-r ${isActive
 ? 'text-[var(--color-text-main)] font-semibold'
 : 'text-[var(--color-text-main)] hover:bg-[var(--color-surface-hover)]'
 }`}
 >
 {/* Con dos columnas una barra lateral quedaría en medio de la
 barra: el activo se marca con el icono en dorado. */}
 <item.Icon fontSize={20} style={{ color: isActive ? 'var(--color-text-main)' : 'currentColor' }} />
 <span className="w-full text-balance hyphens-auto break-words text-center leading-[1.15]">{item.label}</span>
 </NavLink>
 );
 })}
 </div>
 </nav>

 {/* Sidebar Footer */}
 <div className="px-2 py-2 border-t border-[var(--color-border)]">
 <button
 onClick={() => setShowLogoutModal(true)}
 title="Cerrar sesión"
 className="group flex flex-col items-center gap-1 w-full py-1 text-[var(--color-text-main)] hover:text-[var(--color-danger)] cursor-pointer"
 >
 <LogOut className="w-5 h-5" strokeWidth={1.8} />
 <span className="text-[10px] font-medium">Salir</span>
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
 {/* Barra superior tipo Spotify, con búsqueda global existente. */}
 <header className="sticky top-0 z-30 h-20 bg-[var(--color-bg-alt)] border-b border-[var(--color-border)] px-4 sm:px-6 flex items-center gap-3 sm:gap-4 shadow-[0_1px_3px_rgba(0,0,0,0.08)]">
 <div className="flex items-center gap-2 sm:gap-3 shrink-0">
 <button
 aria-label="Abrir menú"
 className="lg:hidden p-2 rounded-full text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] transition-colors cursor-pointer"
 onClick={() => setSidebarOpen(true)}
 >
 <Menu className="w-5 h-5" />
 </button>
 <button aria-label="Página anterior" onClick={() => navigate(-1)} className="hidden sm:grid w-9 h-9 place-items-center rounded-full text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)] hover:bg-[var(--color-surface-hover)] cursor-pointer"><ArrowLeft className="w-5 h-5" strokeWidth={2.4} /></button>
 <button aria-label="Página siguiente" onClick={() => navigate(1)} className="hidden sm:grid w-9 h-9 place-items-center rounded-full text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)] hover:bg-[var(--color-surface-hover)] cursor-pointer"><ArrowRight className="w-5 h-5" strokeWidth={2.4} /></button>
 <button aria-label="Ir al resumen diario" onClick={() => navigate('/daily-summary')} className="grid w-12 h-12 place-items-center rounded-full text-[var(--color-text-main)] hover:scale-105 hover:text-[var(--color-text-secondary)] cursor-pointer"><Home className="w-6 h-6 fill-current" strokeWidth={2.2} /></button>
 </div>

 {/* Búsqueda global: pedidos, clientes, comercios, domiciliarios, cupones */}
 <div className="hidden md:block flex-1 max-w-2xl"><GlobalSearch /></div>

 {/* Right Header Actions */}
 <div className="ml-auto flex items-center gap-2 sm:gap-3 shrink-0">
 {liveStatus && (
 <span
 role="status"
 className={`hidden sm:inline text-[11px] font-semibold ${liveStatus === 'live' ? 'text-[var(--color-success)]' : 'text-[var(--color-text-main)]'}`}
 >
 {liveStatus === 'live' ? 'En vivo' : 'Reconectando…'}
 </span>
 )}
 {/* Theme Toggle (Claro / Oscuro / Automático) */}
 <ThemeToggle />

 {/* Bandeja de alertas */}
 <AlertsTray />

 {/* User Profile */}
 <div className="relative">
 <button
 onClick={() => setUserMenuOpen(!userMenuOpen)}
 className="flex items-center gap-2 hover:opacity-80 transition-opacity cursor-pointer"
 >
 <div className="w-10 h-10 rounded-full bg-[#D69E26] flex items-center justify-center text-sm font-bold text-white">
 {user?.name?.charAt(0)?.toUpperCase() || 'A'}
 </div>
 <div className="text-left hidden xl:block max-w-36">
 <p className="text-xs font-bold text-[var(--color-text-main)] leading-none truncate">{user?.name || 'Administrador'}</p>
 <p className="text-[10px] text-[var(--color-text-secondary)] mt-1 leading-none truncate">{positionName || 'Sin cargo asignado'}</p>
 </div>
 <ChevronDown className="w-3.5 h-3.5 text-[var(--color-text-secondary)] hidden sm:block" />
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
 <p className="px-6 lg:px-8 pt-3 text-xs font-semibold text-[var(--color-text-main)]">
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

