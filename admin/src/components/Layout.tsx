import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom';
import { Suspense, useEffect, useState } from 'react';
import ConfirmDialog from './ConfirmDialog';
import OrderNotifications from './OrderNotifications';
import FichaHost from './fichas/FichaHost';
import { useAuthStore } from '../stores/authStore';
import { NAV_GROUPS } from '../lib/navigation';
import { preloadOn } from '../lib/lazyPage';
import { useAdminSocketStatus } from '../hooks/useAdminSocket';
/** Lo que se ve el instante en que llega el archivo de una página. */
function PageLoading() {
 return (
 <p className="px-1 py-1 text-sm text-[var(--color-text-main)]">Cargando…</p>
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
 const socketStatus = useAdminSocketStatus();

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
 <div className="flex h-screen bg-[var(--color-bg)] text-[var(--color-text-main)] overflow-hidden font-sans">
 {/* ── Navegación compacta, compartida con Business ── */}
 <aside className={`
 admin-sidebar fixed inset-y-0 left-0 z-50 w-[var(--zp-sidebar-w)] bg-[var(--color-bg-alt)] border-r border-[var(--color-border)] flex flex-col
 transform transition-transform duration-100 ease-out
 lg:translate-x-0 lg:static lg:inset-0
 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
 `}>
 <div className="relative h-10 shrink-0 border-b border-[var(--color-border)] flex items-center px-4">
 <span className="text-sm font-semibold text-[var(--color-text-main)]">ZIPP Admin</span>
 <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 px-1 text-sm text-[var(--color-text-main)] hover:underline lg:hidden" onClick={() => setSidebarOpen(false)}>
 Cerrar
 </button>
 </div>
 {/* Navigation Categories */}
 <nav aria-label="Navegación principal" lang="es" className="flex-1 overflow-y-auto overflow-x-hidden admin-sidebar-scroll py-1">
 {/* Lista de una columna, solo texto, con un encabezado por sección. */}
 {NAV_GROUPS.map((group) => {
 const items = group.items.filter((item) => !item.hidden && hasPermission(item.permission));
 if (items.length === 0) return null;
 return (
 <section key={group.category} aria-label={group.category} className="pb-1">
 <h2 className="px-4 pb-1 pt-3 text-xs font-semibold text-[var(--color-text-secondary)]">{group.category}</h2>
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
 className={`relative flex h-8 min-w-0 items-center px-4 text-sm text-[var(--color-text-main)] transition-colors duration-100 hover:bg-[var(--color-surface-hover)] ${isActive
 ? 'bg-[var(--color-surface-hover)] dark:bg-[var(--zp-surface-active)] font-semibold before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-[var(--color-primary)]'
 : 'font-normal'
 }`}
 >
 <span className="w-full truncate">{item.label}</span>
 </NavLink>
 );
 })}
 </section>
 );
 })}
 </nav>

 {/* Sidebar Footer */}
 <div className="border-t border-[var(--color-border)] px-4 py-2 text-sm">
 {user?.name && <p className="truncate font-semibold text-[var(--color-text-main)]" title={user.name}>{user.name}</p>}
 {socketStatus && (
 <p className="text-xs text-[var(--color-text-secondary)]">{socketStatus === 'live' ? 'Conectado' : 'Reconectando…'}</p>
 )}
 <button
 onClick={() => setShowLogoutModal(true)}
 className="mt-1 cursor-pointer text-sm font-semibold text-[var(--color-text-main)] hover:underline"
 >
 Cerrar sesión
 </button>
 </div>
 </aside>

 {/* Mobile overlay */}
 {sidebarOpen && (
 <div
 className="fixed inset-0 z-40 bg-black/60 lg:hidden"
 onClick={() => setSidebarOpen(false)}
 />
 )}

 {/* ── Main Content Area ── */}
 <main className="flex-1 overflow-y-auto flex flex-col min-w-0 bg-[var(--color-bg)]">
 <OrderNotifications />
 {/* Sin barra superior: en pantallas sin barra lateral fija queda solo el botón del menú. */}
 <button
 aria-label="Abrir menú"
 className="lg:hidden fixed top-3 left-3 z-30 h-8 px-3 rounded bg-[var(--color-bg-alt)] border border-[var(--color-border)] text-sm text-[var(--color-text-main)] cursor-pointer"
 onClick={() => setSidebarOpen(true)}
 >
 Menú
 </button>

 {authzMode === 'observe' && observedPermissions.length > 0 && (
 <p className="px-4 pt-3 text-xs font-semibold text-[var(--color-text-main)]">
 Modo observación: hoy conservas accesos que perderás al activar el bloqueo.
 </p>
 )}

 {/* Page Outlet */}
 <div className="p-4 flex-1">
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

