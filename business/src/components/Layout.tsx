import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom';
import {
  AlertCircle, LogOut, Menu, X,
  ChevronDown, ArrowLeft, ArrowRight, Home
} from 'lucide-react';
import { Suspense, useCallback, useEffect, useState } from 'react';
import api from '../services/api';
import { useAuthStore } from '../stores/authStore';
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
import { canSee, homeFor, ROLE_LABELS } from '../lib/permissions';
import PendingInvitations from './PendingInvitations';
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
  const user = useAuthStore((s) => s.user);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showLogoutModal, setShowLogoutModal] = useState(false);
  const [businessesError, setBusinessesError] = useState('');
  const [pausing, setPausing] = useState(false);
  const [pauseError, setPauseError] = useState('');
  const [loadingBusinesses, setLoadingBusinesses] = useState(false);
  const { access, can } = usePermissions(selectedBusiness?._id);
  const visibleNav = nav
    .filter((item) => canSee(item.path, access))
    // Para el cajero la portada son sus ventas del turno, y así se llama.
    .map((item) =>
      item.path === '/' && access && !access.permissions.includes('financial:view') && access.permissions.includes('shift:view')
        ? { ...item, label: 'Ventas del turno' }
        : item
    );

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
    <div className="flex h-screen bg-[var(--color-bg)] text-[var(--color-text-main)] overflow-hidden font-sans">
      {/* ── Barra lateral: icono y nombre en una fila, como en el software de escritorio ── */}
      <aside className={`
        business-sidebar fixed inset-y-0 left-0 z-50 w-52 bg-[var(--color-surface)] border-r border-[var(--color-border)] flex flex-col
        transform transition-transform duration-200 ease-out
        lg:translate-x-0 lg:static lg:inset-0
        ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
      `}>
        {/* Marca */}
        <div className="h-12 shrink-0 border-b border-[var(--color-border)] flex items-center gap-2 px-4">
          <ZippMark size={20} />
          <span className="text-sm font-semibold text-[var(--color-text-main)]">ZIPP</span>
          <span className="text-sm text-[var(--color-text-secondary)]">Negocios</span>
          <button
            aria-label="Cerrar menú"
            className="ml-auto p-1 rounded-md text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)] hover:bg-[var(--color-surface-hover)] lg:hidden cursor-pointer"
            onClick={() => setSidebarOpen(false)}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Local activo y estado: lo que el comercio mira antes de operar. */}
        <div className="px-3 py-3 space-y-2 border-b border-[var(--color-border)]">
          {businesses.length > 0 && (
            <div className="relative">
              <select
                value={selectedBusiness?._id || ''}
                onChange={handleBusinessChange}
                aria-label="Seleccionar establecimiento"
                title={selectedBusiness?.name || 'Seleccionar establecimiento'}
                className="w-full h-8 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-md pl-2.5 pr-7 text-xs font-medium text-[var(--color-text-main)] focus:outline-none focus:border-[var(--color-primary)] cursor-pointer appearance-none truncate"
              >
                {businesses.map((bus) => (
                  <option key={bus._id} value={bus._id}>
                    {bus.name}
                  </option>
                ))}
              </select>
              <ChevronDown className="w-3.5 h-3.5 text-[var(--color-text-secondary)] absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none" />
            </div>
          )}

          <div className="flex items-center justify-between gap-2">
            <button
              onClick={toggleStore}
              disabled={pausing || !selectedBusiness || !can('store:toggle')}
              aria-pressed={isStoreOpen}
              title={
                isStoreOpen
                  ? 'Tu local está recibiendo pedidos. Púlsalo para dejar de recibirlos.'
                  : 'Tu local no recibe pedidos. Púlsalo para volver a abrir.'
              }
              className={`flex items-center gap-1.5 text-xs font-medium cursor-pointer disabled:opacity-60 disabled:cursor-wait ${
                isStoreOpen ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]'
              }`}
            >
              <span
                className={`w-2 h-2 rounded-full ${
                  isStoreOpen ? 'bg-[var(--color-success)]' : 'bg-[var(--color-danger)]'
                }`}
              />
              <span>{pausing ? 'Guardando…' : isStoreOpen ? 'Abierto' : 'Cerrado'}</span>
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
            <p role="alert" className="text-xs leading-snug text-[var(--color-danger)]">
              {pauseError}
            </p>
          )}
        </div>

        {/* Navegación */}
        <nav aria-label="Navegación principal" className="flex-1 overflow-y-auto business-sidebar-scroll py-2 px-2">
          <div className="flex flex-col gap-px">
            {visibleNav.map((item) => {
              const isActive = item.path === '/' ? location.pathname === '/' : location.pathname.startsWith(item.path);
              return (
                <NavLink
                  key={item.path}
                  to={item.path}
                  end={item.path === '/'}
                  onClick={() => setSidebarOpen(false)}
                  {...preloadOn(item.path)}
                  className={`relative flex items-center gap-2.5 h-8 px-2.5 rounded-md text-[13px] ${isActive
                      ? 'bg-[var(--color-surface-hover)] text-[var(--color-text-main)] font-semibold'
                      : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)] hover:bg-[var(--color-surface-hover)]'
                    }`}
                >
                  {isActive && (
                    <span aria-hidden className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-full bg-[var(--color-primary)]" />
                  )}
                  <item.Icon fontSize={18} className="shrink-0" />
                  <span className="truncate">{item.label}</span>
                </NavLink>
              );
            })}
          </div>
        </nav>

        {/* Pie */}
        <div className="px-2 py-2 border-t border-[var(--color-border)]">
          <button
            onClick={() => { setSidebarOpen(false); setShowLogoutModal(true); }}
            className="flex items-center gap-2.5 w-full h-8 px-2.5 rounded-md text-[13px] text-[var(--color-text-secondary)] hover:text-[var(--color-danger)] hover:bg-[var(--color-surface-hover)] cursor-pointer"
          >
            <LogOut className="w-4 h-4" strokeWidth={1.8} />
            Cerrar sesión
          </button>
        </div>
      </aside>

      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* ── Main Content Area ── */}
      <main className="flex-1 overflow-y-auto flex flex-col min-w-0 bg-[var(--color-bg)]">
        <OrderNotifications />
        {/* Barra superior: navegación del historial (Zipp Negocios no tiene la
            del navegador), conexión y la cuenta activa. */}
        <header className="sticky top-0 z-30 h-12 bg-[var(--color-surface)] border-b border-[var(--color-border)] px-3 sm:px-5 flex items-center gap-1">
          <button
            aria-label="Abrir menú"
            className="lg:hidden grid w-8 h-8 place-items-center rounded-md text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)] hover:bg-[var(--color-surface-hover)] cursor-pointer"
            onClick={() => setSidebarOpen(true)}
          >
            <Menu className="w-4 h-4" />
          </button>
          <button aria-label="Página anterior" title="Atrás" onClick={() => navigate(-1)} className="hidden sm:grid w-8 h-8 place-items-center rounded-md text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)] hover:bg-[var(--color-surface-hover)] cursor-pointer">
            <ArrowLeft className="w-4 h-4" />
          </button>
          <button aria-label="Página siguiente" title="Adelante" onClick={() => navigate(1)} className="hidden sm:grid w-8 h-8 place-items-center rounded-md text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)] hover:bg-[var(--color-surface-hover)] cursor-pointer">
            <ArrowRight className="w-4 h-4" />
          </button>
          <button aria-label="Ir al inicio" title="Inicio" onClick={() => navigate('/')} className="grid w-8 h-8 place-items-center rounded-md text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)] hover:bg-[var(--color-surface-hover)] cursor-pointer">
            <Home className="w-4 h-4" />
          </button>

          {/* Acciones de la cuenta */}
          <div className="ml-auto flex items-center gap-4 shrink-0">
            <ConnectionStatus />
            {/* Quién está conectado y con qué papel: con varias personas en el
                mismo PC del mostrador, saber en qué cuenta se está evita
                que alguien opere con la sesión de otro sin darse cuenta. */}
            <button
              type="button"
              onClick={() => navigate(canSee('/settings', access) ? '/settings' : '/security')}
              title={canSee('/settings', access) ? 'Ver perfil del negocio' : 'Ver la seguridad de tu cuenta'}
              aria-label={canSee('/settings', access) ? 'Ver perfil del negocio' : 'Ver la seguridad de tu cuenta'}
              className="flex items-center gap-2 h-8 pl-1 pr-2 rounded-md hover:bg-[var(--color-surface-hover)] cursor-pointer"
            >
              <span className="w-6 h-6 rounded-md bg-[var(--color-bg-alt)] border border-[var(--color-border)] grid place-items-center text-xs font-semibold text-[var(--color-text-main)]">
                {selectedBusiness?.name?.charAt(0) || 'N'}
              </span>
              <span className="text-left hidden sm:block max-w-56 leading-tight">
                <span className="block text-xs font-medium text-[var(--color-text-main)] truncate">{selectedBusiness?.name || 'Comercio'}</span>
                <span className="block text-[11px] text-[var(--color-text-secondary)] truncate">
                  {user?.name || 'Tu cuenta'}
                  {access?.role ? ` · ${ROLE_LABELS[access.role]}` : ''}
                </span>
              </span>
            </button>
          </div>
        </header>

        {/* Page Outlet */}
        <div className="px-5 py-5 lg:px-8 lg:py-6 flex-1">
          <div className="page-container space-y-5">
            {businessesError && (
              <div role="alert" className="border-l-2 border-[var(--color-danger)] pl-3 text-[var(--color-danger)] text-xs flex items-start gap-3">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <div className="flex-1 space-y-1">
                  <p className="font-semibold">{businessesError}</p>
                  <p className="text-[var(--color-text-main)]">
                    Sin esa lista el panel no sabe cuáles son tus locales y las
                    páginas se ven vacías. No has perdido el negocio: es la
                    conexión con ZIPP la que no responde.
                  </p>
                </div>
                <button
                  onClick={loadBusinesses}
                  disabled={loadingBusinesses}
                  className="shrink-0 px-3 py-1.5 rounded-md border border-[var(--color-danger)]/40 font-semibold text-[11px] cursor-pointer hover:bg-[var(--color-danger)]/10 transition-colors disabled:cursor-wait disabled:opacity-60"
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
            <PendingInvitations onAccepted={loadBusinesses} />
            {/* Solo quien puede subir documentos: al resto el aviso no le
                sirve y la consulta le respondería 403 en cada página. */}
            {selectedBusiness && access?.permissions.includes('documents:manage') && (
              <DocumentExpiryNotice businessId={selectedBusiness._id} />
            )}
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
