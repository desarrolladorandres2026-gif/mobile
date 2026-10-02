import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom';
import {
  AlertCircle, LogOut, Menu, X,
  Volume2, VolumeX, ChevronDown, ArrowLeft, ArrowRight, Bell, Home, Search
} from 'lucide-react';
import { Suspense, useCallback, useEffect, useState } from 'react';
import api from '../services/api';
import { useAuthStore } from '../stores/authStore';
import { usePreferencesStore } from '../stores/preferencesStore';
import ConfirmDialog from './ConfirmDialog';
import { apiMessage } from '../lib/apiError';
import OrderNotifications from './OrderNotifications';
import ConnectionStatus from './ConnectionStatus';
import DocumentExpiryNotice from './DocumentExpiryNotice';
import NewDeviceNotice from './NewDeviceNotice';
import { ZippMark } from './ZippMark';
import { preloadOn } from '../lib/lazyPage';
import { onDesktopCloseStoreRequest, takePendingDesktopCrashReport, clearDesktopCrashReport } from '../lib/desktop';
import { usePermissions } from '../hooks/usePermissions';
import { canSee, homeFor } from '../lib/permissions';
import {
  CalendarLtrRegular, BoxRegular, WalletRegular,
  FoodRegular, TagRegular, MegaphoneRegular, StarRegular,
  PeopleRegular, DocumentRegular, ChatRegular, SettingsRegular,
} from '@fluentui/react-icons';

const nav = [
  { path: '/', Icon: CalendarLtrRegular, label: 'Resumen del día' },
  { path: '/orders', Icon: BoxRegular, label: 'Pedidos' },
  { path: '/settlements', Icon: WalletRegular, label: 'Liquidaciones' },
  { path: '/menu', Icon: FoodRegular, label: 'Menú & Catálogo' },
  { path: '/promotions', Icon: TagRegular, label: 'Promociones' },
  { path: '/advertising', Icon: MegaphoneRegular, label: 'Publicidad' },
  { path: '/reviews', Icon: StarRegular, label: 'Reseñas' },
  { path: '/staff', Icon: PeopleRegular, label: 'Equipo' },
  { path: '/documents', Icon: DocumentRegular, label: 'Documentos' },
  { path: '/support', Icon: ChatRegular, label: 'Soporte' },
  { path: '/settings', Icon: SettingsRegular, label: 'Ajustes' },
];

export default function Layout() {
  const navigate = useNavigate();
  const location = useLocation();
  const businesses = useAuthStore((s) => s.businesses);
  const selectedBusiness = useAuthStore((s) => s.selectedBusiness);
  const setSelectedBusiness = useAuthStore((s) => s.setSelectedBusiness);
  const setBusinesses = useAuthStore((s) => s.setBusinesses);
  const logout = useAuthStore((s) => s.logout);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showLogoutModal, setShowLogoutModal] = useState(false);
  const [businessesError, setBusinessesError] = useState('');
  const [pausing, setPausing] = useState(false);
  const [pauseError, setPauseError] = useState('');
  const [loadingBusinesses, setLoadingBusinesses] = useState(false);
  const soundEnabled = usePreferencesStore((s) => s.soundEnabled);
  const toggleSound = usePreferencesStore((s) => s.toggleSound);
  const { access, can } = usePermissions(selectedBusiness?._id);
  const visibleNav = nav.filter((item) => canSee(item.path, access));

  // Un empleado que cae en una sección del dueño (la portada es el resumen
  // de ventas) se lleva a la primera que sí puede usar, en vez de dejarlo
  // ante una pantalla que responde 403.
  const section = nav.find((item) =>
    item.path === '/' ? location.pathname === '/' : location.pathname.startsWith(item.path)
  )?.path;
  useEffect(() => {
    if (access && section && !canSee(section, access)) navigate(homeFor(access), { replace: true });
  }, [access, section, navigate]);

  /**
   * Abierto / cerrado es un hecho del servidor, no de esta pestaña.
   *
   * El interruptor guardaba antes un `useState` y nada más: el comercio
   * lo pulsaba, veía "Cerrado" y ZIPP seguía mandándole pedidos. Ahora
   * escribe `isActive` en el negocio, que es exactamente el campo que
   * `order.service.create` comprueba antes de aceptar un pedido nuevo.
   */
  const isStoreOpen = selectedBusiness?.isActive !== false;

  const setStoreOpen = async (next: boolean) => {
    if (!selectedBusiness || pausing) return;
    setPausing(true);
    setPauseError('');
    try {
      // Endpoint propio: lo usan también el encargado y el mostrador, que no
      // pueden pasar por el PUT del perfil.
      const { data } = await api.patch(`/businesses/${selectedBusiness._id}/open`, { isActive: next });
      // Se refleja lo que respondió el servidor, no lo que se pidió: si la
      // escritura no cuajó, el interruptor no debe mentir.
      setSelectedBusiness({ ...selectedBusiness, isActive: data.data?.isActive ?? next });
    } catch (err) {
      setPauseError(apiMessage(err, 'No pudimos cambiar el estado del local.'));
    } finally {
      setPausing(false);
    }
  };

  const toggleStore = () => setStoreOpen(!isStoreOpen);

  // Zipp Negocios pide cerrar el negocio antes de salir ("Cerrar el negocio
  // y salir" de la bandeja). Si ya estaba cerrado no hay nada que hacer —
  // y sobre todo, no hay que "abrirlo" por error llamando a toggle.
  useEffect(() => onDesktopCloseStoreRequest(() => {
    if (isStoreOpen) return setStoreOpen(false);
  }), [isStoreOpen, selectedBusiness]);

  // Si Zipp Negocios se cayó o se congeló antes de esta carga, el
  // contenedor dejó el reporte guardado — él no tiene sesión para
  // mandarlo. Se envía una sola vez, al montar el layout ya autenticado,
  // y solo se borra si el POST sale bien.
  useEffect(() => {
    let cancelled = false;
    takePendingDesktopCrashReport().then(async (report) => {
      if (!report || cancelled) return;
      try {
        await api.post('/telemetry/crash', report);
        await clearDesktopCrashReport();
      } catch {
        // Se reintenta en el próximo arranque: no se borra sin confirmar.
      }
    });
    return () => { cancelled = true; };
  }, []);

  /**
   * Refresca la lista de negocios del usuario autenticado al montar el layout.
   * PrivateRoute ya garantiza que hay sesión activa antes de llegar aquí.
   *
   * El fallo se enseña en pantalla, no en la consola. Antes esto era un
   * `console.error` y nada más, así que una API caída se veía exactamente
   * igual que no tener ningún local: selector vacío, páginas vacías y cero
   * explicación. El comercio no tiene por qué abrir las herramientas de
   * desarrollo para enterarse de que la petición se cayó.
   */
  const loadBusinesses = useCallback(async () => {
    setLoadingBusinesses(true);
    setBusinessesError('');
    try {
      const { data } = await api.get('/businesses/my/businesses');
      // Si la respuesta no trae una lista, no se pasa adelante: el store la
      // serializa a localStorage y un `undefined` ahí deja escrito el texto
      // "undefined", que revienta el `JSON.parse` de la siguiente carga.
      setBusinesses(Array.isArray(data.data) ? data.data : []);
    } catch (err) {
      setBusinessesError(apiMessage(err, 'No pudimos cargar tus establecimientos.'));
    } finally {
      setLoadingBusinesses(false);
    }
  }, [setBusinesses]);

  useEffect(() => { loadBusinesses(); }, [loadBusinesses]);

  const handleBusinessChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const found = businesses.find((b) => b._id === e.target.value);
    if (found) setSelectedBusiness(found);
  };

  const handleLogout = () => {
    logout();
    navigate('/login');
  };


  return (
    <div className="flex h-screen bg-[var(--color-bg)] text-[var(--color-text-main)] overflow-hidden font-sans transition-colors duration-200">
      {/* ── Sidebar compacta, inspirada en el panel de referencia ── */}
    <aside className={`
        business-sidebar fixed inset-y-0 left-0 z-50 w-30 bg-[var(--color-bg-alt)] border-r border-[var(--color-border)] flex flex-col shadow-[1px_0_3px_rgba(0,0,0,0.08)]
        transform transition-transform duration-300 ease-out
        lg:translate-x-0 lg:static lg:inset-0
        ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
      `}>
        {/* Brand header */}
        <div className="h-14 shrink-0 border-b border-[var(--color-border)] flex items-center justify-center gap-2">
          <ZippMark size={25} />
          <span className="text-[15px] font-semibold tracking-tight text-[var(--color-text-secondary)]">ZIPP</span>
          <button
            aria-label="Cerrar menú"
            className="absolute right-2 top-2 p-1 text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)] lg:hidden transition-colors cursor-pointer"
            onClick={() => setSidebarOpen(false)}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Selector de negocio: compacto para conservar la función de varias sedes. */}
        {businesses.length > 0 && (
          <div className="px-2 pt-2">
            <div className="relative">
              <select
                value={selectedBusiness?._id || ''}
                onChange={handleBusinessChange}
                aria-label="Seleccionar establecimiento"
                title={selectedBusiness?.name || 'Seleccionar establecimiento'}
                className="w-full h-7 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-sm pl-2 pr-5 text-[9px] font-semibold text-[var(--color-text-secondary)] focus:outline-none focus:border-[var(--color-success)] cursor-pointer appearance-none truncate"
              >
                {businesses.map((bus) => (
                  <option key={bus._id} value={bus._id}>
                    {bus.name}
                  </option>
                ))}
              </select>
              <ChevronDown className="w-3 h-3 text-[var(--color-text-secondary)] absolute right-1.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            </div>
          </div>
        )}

        {/* Estado y sonido se mantienen accesibles sin ensanchar la barra. */}
        <div className="px-2 pt-2 pb-1">
          <div className="flex items-center justify-center gap-2">
            <button
              onClick={toggleStore}
              disabled={pausing || !selectedBusiness || !can('store:toggle')}
              aria-pressed={isStoreOpen}
              title={
                isStoreOpen
                  ? 'Tu local está recibiendo pedidos. Púlsalo para dejar de recibirlos.'
                  : 'Tu local no recibe pedidos. Púlsalo para volver a abrir.'
              }
              className={`flex items-center gap-1 text-[9px] font-bold uppercase tracking-wide cursor-pointer transition-all disabled:opacity-60 disabled:cursor-wait ${
                isStoreOpen ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]'
              }`}
            >
              <span
                className={`w-2 h-2 rounded-full ${
                  isStoreOpen ? 'bg-[var(--color-success)] animate-pulse' : 'bg-[var(--color-danger)]'
                }`}
              />
              <span>{pausing ? 'Guardando…' : isStoreOpen ? 'Abierto' : 'Cerrado'}</span>
            </button>

            <button
              onClick={toggleSound}
              aria-pressed={soundEnabled}
              className="p-1 text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)] transition-all cursor-pointer"
              title={
                soundEnabled
                  ? 'Suena un aviso al entrar un pedido. Púlsalo para silenciarlo.'
                  : 'Los pedidos entran en silencio. Púlsalo para activar el aviso.'
              }
            >
              {soundEnabled ? (
                <Volume2 className="w-3.5 h-3.5 text-[var(--color-success)]" />
              ) : (
                <VolumeX className="w-3.5 h-3.5 text-[var(--color-text-secondary)]" />
              )}
            </button>
          </div>

          {/* Aunque el dueño lo tenga "Abierto", una suspensión de ZIPP o la
              falta de aprobación dejan el local sin pedidos: hay que decirlo. */}
          {selectedBusiness?.isSuspended ? (
            <p className="sr-only">
              ZIPP suspendió este local
              {selectedBusiness.suspensionReason ? `: ${selectedBusiness.suspensionReason}` : ''}. No
              recibe pedidos hasta que soporte levante la suspensión.
            </p>
          ) : selectedBusiness && selectedBusiness.isApproved === false ? (
            <p className="sr-only">
              Tu local aún no está aprobado: los clientes no lo ven hasta que
              ZIPP revise tus documentos.
            </p>
          ) : null}

          {!isStoreOpen && !pauseError && !selectedBusiness?.isSuspended && (
            <p className="sr-only">
              No estás recibiendo pedidos nuevos. Los que ya tienes en cocina
              siguen su curso.
            </p>
          )}

          {/* El error sí se ve: con el aviso oculto, un Abierto/Cerrado que no
              cuajó no dejaba ninguna señal y el comercio creía haber cerrado. */}
          {pauseError && (
            <p role="alert" className="mt-1 text-center text-[9px] font-semibold leading-snug text-[var(--color-danger)]">
              {pauseError}
            </p>
          )}
        </div>

        {/* Navigation */}
        <nav aria-label="Navegación principal" className="flex-1 overflow-y-auto business-sidebar-scroll pt-1">
          <div className="flex flex-col">
            {visibleNav.map((item) => {
              const isActive = item.path === '/' ? location.pathname === '/' : location.pathname.startsWith(item.path);
              return (
                <NavLink
                  key={item.path}
                  to={item.path}
                  end={item.path === '/'}
                  onClick={() => setSidebarOpen(false)}
                  {...preloadOn(item.path)}
                  title={item.label}
                  aria-label={item.label}
                  className={`relative flex flex-col items-center gap-1 py-2.5 px-1 text-[11px] font-medium tracking-wide transition-colors duration-150 ${isActive
                      ? 'text-[var(--color-text-main)] font-semibold'
                      : 'text-[var(--color-text-main)] hover:bg-[var(--color-surface-hover)]'
                    }`}
                >
                  {isActive && (
                    <span className="absolute left-0 top-1/2 -translate-y-1/2 h-12 w-1 rounded-r-full bg-[#D69E26]" />
                  )}
                  <item.Icon fontSize={25} style={{ color: isActive ? 'var(--color-text-main)' : 'currentColor' }} />
                  <span className="w-full text-balance break-words text-center leading-tight">{item.label}</span>
                </NavLink>
              );
            })}
          </div>
        </nav>

        {/* Sidebar Footer */}
        <div className="px-2 py-2 border-t border-[var(--color-border)]">
          <button
            onClick={() => { setSidebarOpen(false); setShowLogoutModal(true); }}
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
      <main
        className="flex-1 overflow-y-auto flex flex-col min-w-0 bg-[var(--color-bg)] transition-colors duration-200"
        // `.page-header` (index.css) pinta esta variable como fondo difuminado.
        style={
          selectedBusiness?.coverImage
            ? ({ '--business-cover': `url(${JSON.stringify(selectedBusiness.coverImage)})` } as React.CSSProperties)
            : undefined
        }
      >
        <OrderNotifications />
        {/* Barra superior con la composición de navegación de Spotify. */}
        <header className="sticky top-0 z-30 h-20 bg-[var(--color-bg-alt)] border-b border-[var(--color-border)] px-4 sm:px-6 flex items-center gap-3 sm:gap-4 shadow-[0_1px_3px_rgba(0,0,0,0.08)]">
          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            <button
              aria-label="Abrir menú"
              className="lg:hidden p-2 rounded-full text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] transition-colors cursor-pointer"
              onClick={() => setSidebarOpen(true)}
            >
              <Menu className="w-5 h-5" />
            </button>
            <button aria-label="Página anterior" onClick={() => navigate(-1)} className="hidden sm:grid w-9 h-9 place-items-center rounded-full text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)] hover:bg-[var(--color-surface-hover)] cursor-pointer">
              <ArrowLeft className="w-5 h-5" strokeWidth={2.4} />
            </button>
            <button aria-label="Página siguiente" onClick={() => navigate(1)} className="hidden sm:grid w-9 h-9 place-items-center rounded-full text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)] hover:bg-[var(--color-surface-hover)] cursor-pointer">
              <ArrowRight className="w-5 h-5" strokeWidth={2.4} />
            </button>
            <button aria-label="Ir al inicio" onClick={() => navigate('/')} className="grid w-12 h-12 place-items-center rounded-full text-[var(--color-text-main)] hover:scale-105 hover:text-[#D69E26] cursor-pointer">
              <Home className="w-6 h-6 fill-current" strokeWidth={2.2} />
            </button>
          </div>

          <label className="hidden md:flex flex-1 max-w-2xl h-12 items-center gap-3 rounded-full bg-[var(--color-surface)] px-5 text-[var(--color-text-secondary)] border border-[var(--color-border)] focus-within:border-[#D69E26] focus-within:ring-2 focus-within:ring-[#D69E26]/20 transition-colors">
            <Search className="w-6 h-6 shrink-0" strokeWidth={2} />
            <input
              aria-label="Buscar en el panel"
              type="search"
              placeholder="¿Qué quieres gestionar?"
              className="w-full bg-transparent text-[16px] font-medium text-[var(--color-text-main)] placeholder:text-[var(--color-text-secondary)] outline-none"
            />
          </label>

          {/* Acciones de la cuenta */}
          <div className="ml-auto flex items-center gap-2 sm:gap-3 shrink-0">
            <ConnectionStatus />
            <button aria-label="Notificaciones" title="Notificaciones" className="hidden sm:grid w-9 h-9 place-items-center text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)] hover:bg-[var(--color-surface-hover)] rounded-full cursor-pointer">
              <Bell className="w-5 h-5" />
            </button>
            <button
              type="button"
              onClick={() => navigate('/settings')}
              title="Ver perfil del negocio"
              aria-label="Ver perfil del negocio"
              className="flex items-center gap-2 cursor-pointer hover:opacity-80 transition-opacity"
            >
              <div className="w-10 h-10 rounded-full bg-[#D69E26] flex items-center justify-center text-sm font-bold text-white">
                {selectedBusiness?.name?.charAt(0) || 'N'}
              </div>
              <div className="text-left hidden xl:block max-w-36">
                <p className="text-xs font-bold text-[var(--color-text-main)] leading-none truncate">{selectedBusiness?.name || 'Comercio'}</p>
                <p className="text-[10px] text-[var(--color-text-secondary)] mt-1 leading-none">Negocio aliado</p>
              </div>
            </button>
          </div>
        </header>

        {/* Page Outlet */}
        <div className="p-6 lg:p-8 flex-1">
          <div className="page-container space-y-6">
            {businessesError && (
              <div className="bg-[var(--color-danger-bg)] border border-[var(--color-danger-bg)] text-[var(--color-danger)] text-xs p-4 rounded-xl flex items-start gap-3">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <div className="flex-1 space-y-1">
                  <p className="font-bold">{businessesError}</p>
                  <p className="font-semibold opacity-80">
                    Sin esa lista el panel no sabe cuáles son tus locales y las
                    páginas se ven vacías. No has perdido el negocio: es la
                    conexión con ZIPP la que no responde.
                  </p>
                </div>
                <button
                  onClick={loadBusinesses}
                  disabled={loadingBusinesses}
                  className="shrink-0 px-3 py-1.5 rounded-lg border border-[var(--color-danger)]/40 font-bold uppercase tracking-wider text-[10px] cursor-pointer hover:bg-[var(--color-danger)]/10 transition-all disabled:cursor-wait disabled:opacity-60"
                >
                  {loadingBusinesses ? 'Reintentando…' : 'Reintentar'}
                </button>
              </div>
            )}
            {/* Avisos de cuenta y del local: antes vivían solo en el
                Dashboard ("/"), así que desaparecían del todo en cualquier
                otra pantalla. Van aquí, arriba de cada página, porque un
                documento vencido bloquea pedidos sin importar dónde esté
                mirando el dueño. */}
            {selectedBusiness && <DocumentExpiryNotice businessId={selectedBusiness._id} />}
            <NewDeviceNotice />
            {/* La barra lateral sigue en pantalla mientras llega el archivo
                de la página (las páginas se cargan bajo demanda, ver App). */}
            <Suspense
              fallback={
                <div className="flex items-center justify-center py-24">
                  <div className="w-6 h-6 rounded-full border-2 border-[var(--color-primary)] border-t-transparent animate-spin" />
                </div>
              }
            >
              <Outlet />
            </Suspense>
          </div>
        </div>
      </main>

      {showLogoutModal && (
        <ConfirmDialog
          title="¿Cerrar sesión?"
          message="Estás a punto de salir del panel de comercio ZIPP. Deberás ingresar tus credenciales nuevamente para acceder."
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
