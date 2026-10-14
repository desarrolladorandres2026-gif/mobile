import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom';
import { Menu, RefreshCw } from 'lucide-react';
import { Suspense, useEffect, useState } from 'react';
import ConfirmDialog from './ConfirmDialog';
import OrderNotifications from './OrderNotifications';
import FichaHost from './fichas/FichaHost';
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
 const navigate = useNavigate();
 const location = useLocation();
 const [sidebarOpen, setSidebarOpen] = useState(false);
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

 const handleLogout = async () => {
 setShowLogoutModal(false);
 setSidebarOpen(false);
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
 {/* Lista de una columna, solo texto, con un encabezado por sección. */}
 {NAV_GROUPS.map((group) => {
 const items = group.items.filter((item) => !item.hidden && hasPermission(item.permission));
 if (items.length === 0) return null;
 return (
 <section key={group.category} aria-label={group.category} className="border-b border-[var(--color-border)] pb-1">
 <h2 className="px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-secondary)]">{group.category}</h2>
 {items.map((item) => {
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
 aria-current={isActive ? 'page' : undefined}
 className={`relative flex min-w-0 items-center px-3 py-1.5 text-[12.5px] leading-tight text-[var(--color-text-main)] transition-colors duration-150 hover:bg-[var(--color-surface-hover)] ${isActive
 ? 'bg-[var(--color-surface-hover)] font-semibold before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-[#D69E26]'
 : 'font-medium'
 }`}
 >
 <span className="w-full break-words">{item.label}</span>
 </NavLink>
 );
 })}
 </section>
 );
 })}
 </nav>

 {/* Sidebar Footer */}
 <div className="px-2 py-2 border-t border-[var(--color-border)]">
 <button
 onClick={() => setShowLogoutModal(true)}
 title="Cerrar sesión"
 className="group flex flex-col items-center gap-1 w-full py-1 text-[var(--color-text-main)] hover:text-[var(--color-danger)] cursor-pointer"
 >
 <span className="text-[12.5px] font-medium">Salir</span>
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
 {/* Sin barra superior: en pantallas sin barra lateral fija queda solo el botón del menú. */}
 <button
 aria-label="Abrir menú"
 className="lg:hidden fixed top-3 left-3 z-30 p-2 rounded-full bg-[var(--color-bg-alt)] border border-[var(--color-border)] text-[var(--color-text-main)] shadow-sm cursor-pointer"
 onClick={() => setSidebarOpen(true)}
 >
 <Menu className="w-5 h-5" />
 </button>

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

