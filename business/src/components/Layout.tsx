import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom';
import {
  AlertCircle, LogOut,
  ChevronDown
} from 'lucide-react';
import { Suspense, useCallback, useEffect, useState } from 'react';
import api from '../services/api';
import { useAuthStore } from '../stores/authStore';
import ConfirmDialog from './ConfirmDialog';
import { apiMessage } from '../lib/apiError';
import OrderNotifications from './OrderNotifications';
import DocumentExpiryNotice from './DocumentExpiryNotice';
import NewDeviceNotice from './NewDeviceNotice';
import { preloadOn } from '../lib/lazyPage';
import { onDesktopCloseStoreRequest, takePendingDesktopCrashReport, clearDesktopCrashReport } from '../lib/desktop';
import { usePermissions } from '../hooks/usePermissions';
import { canSee, homeFor } from '../lib/permissions';
import PendingInvitations from './PendingInvitations';
import CounterSwitch from './CounterSwitch';
import StoreStatusButton from './StoreStatusButton';
import ThemeButton from './ThemeButton';
import { revokeServerSessions } from '../lib/session';
import { useSupportAttention } from '../hooks/useSupportAttention';
import {
  CalendarLtrRegular, CalendarClockRegular, BoxRegular, WalletRegular,
  FoodRegular, TagRegular, MegaphoneRegular, StarRegular,
  PeopleRegular, DocumentRegular, ChatRegular, SettingsRegular,
} from '@fluentui/react-icons';

/**
 * La barra está siempre en pantalla, sea cual sea el ancho: una columna fija
 * de icono con su título debajo (80 px en teléfono, 96 px desde `sm`). No hay
 * cajón ni botón de menú: el panel se opera con ella a la vista.
 */

const nav = [
  { path: '/', Icon: CalendarLtrRegular, label: 'Resumen del día' },
  { path: '/orders', Icon: BoxRegular, label: 'Pedidos' },
  { path: '/scheduled', Icon: CalendarClockRegular, label: 'Programados' },
  { path: '/settlements', Icon: WalletRegular, label: 'Liquidaciones' },
  { path: '/menu', Icon: FoodRegular, label: 'Menú & Catálogo' },
  { path: '/promotions', Icon: TagRegular, label: 'Promociones' },
  { path: '/advertising', Icon: MegaphoneRegular, label: 'Publicidad' },
  { path: '/reviews', Icon: StarRegular, label: 'Reseñas' },
  { path: '/staff', Icon: PeopleRegular, label: 'Equipo' },
  { path: '/documents', Icon: DocumentRegular, label: 'Documentos' },
  { path: '/support', Icon: ChatRegular, label: 'Soporte' },
  { path: '/settings', Icon: SettingsRegular, label: 'Personalización' },
];

export default function Layout() {
  const navigate = useNavigate();
  const location = useLocation();
  const businesses = useAuthStore((s) => s.businesses);
  const selectedBusiness = useAuthStore((s) => s.selectedBusiness);
  const setSelectedBusiness = useAuthStore((s) => s.setSelectedBusiness);
  const setBusinesses = useAuthStore((s) => s.setBusinesses);
  const logout = useAuthStore((s) => s.logout);
  const [showLogoutModal, setShowLogoutModal] = useState(false);
  const [businessesError, setBusinessesError] = useState('');
  const [pausing, setPausing] = useState(false);
  const [pauseError, setPauseError] = useState('');
  const [loadingBusinesses, setLoadingBusinesses] = useState(false);
  const { access, can } = usePermissions(selectedBusiness?._id);
  const supportWaiting = useSupportAttention(selectedBusiness?._id);
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

  const setStoreOpen = async (next: boolean, closeMinutes?: number) => {
    if (!selectedBusiness || pausing) return;
    setPausing(true);
    setPauseError('');
    try {
      // Endpoint propio: lo usan también el encargado y el mostrador, que no
      // pueden pasar por el PUT del perfil.
      const { data } = await api.patch(`/businesses/${selectedBusiness._id}/open`, {
        isActive: next,
        ...(closeMinutes ? { closeMinutes } : {}),
      });
      // Se refleja lo que respondió el servidor, no lo que se pidió: si la
      // escritura no cuajó, el interruptor no debe mentir.
      setSelectedBusiness({
        ...selectedBusiness,
        isActive: data.data?.isActive ?? next,
        reopenAt: data.data?.reopenAt ?? null,
      });
    } catch (err) {
      setPauseError(apiMessage(err, 'No pudimos cambiar el estado del local.'));
    } finally {
      setPausing(false);
    }
  };

  // Zipp Negocios pide cerrar el negocio antes de salir ("Cerrar el negocio
  // y salir" de la bandeja). Si ya estaba cerrado no hay nada que hacer —
  // y sobre todo, no hay que "abrirlo" por error llamando a toggle.
  useEffect(() => onDesktopCloseStoreRequest(() => {
    if (isStoreOpen) return setStoreOpen(false);
    // setStoreOpen cierra sobre selectedBusiness (ya en deps): no es estable y resuscribiría en cada render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // El servidor reabre el local solo cuando vence el cierre temporal; este
  // panel se entera volviendo a pedir la lista justo después de esa hora.
  const reopenAt = selectedBusiness?.isActive === false ? selectedBusiness.reopenAt : null;
  useEffect(() => {
    if (!reopenAt) return;
    const wait = Math.max(new Date(reopenAt).getTime() - Date.now(), 0) + 65_000;
    const timer = window.setTimeout(loadBusinesses, wait);
    return () => window.clearTimeout(timer);
  }, [reopenAt, loadBusinesses]);

  const handleBusinessChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const found = businesses.find((b) => b._id === e.target.value);
    if (found) setSelectedBusiness(found);
  };

  const handleLogout = () => {
    revokeServerSessions();
    logout();
    navigate('/login');
  };


  return (
    <div className="flex h-screen bg-[var(--color-bg)] text-[var(--color-text-main)] overflow-hidden font-sans">
      {/* ── Barra lateral: columna fija de iconos con su título debajo ── */}
      <aside className="business-sidebar relative z-50 flex h-full w-20 sm:w-24 shrink-0 flex-col overflow-hidden bg-[var(--zipp-obsidian)] border-r border-white/10 rounded-r-3xl">
        {/* Marca */}
        <div className="h-16 shrink-0 flex items-center px-2">
          {/* Marca en oro: es el único ancla de color de la barra. */}
          <span className="grid h-10 w-full place-items-center rounded-xl bg-[var(--zipp-gold)] text-sm sm:text-base font-black tracking-tight text-[var(--zipp-obsidian)]">
            ZIPP
          </span>
        </div>

        {/* Local activo: solo se elige cuando hay más de uno. */}
        {businesses.length > 1 && (
          <div className="px-2 py-2">
            <div className="relative">
              <select
                value={selectedBusiness?._id || ''}
                onChange={handleBusinessChange}
                aria-label="Seleccionar establecimiento"
                title={selectedBusiness?.name || 'Seleccionar establecimiento'}
                className="w-full h-8 bg-[var(--zipp-obsidian)] border border-white/20 rounded-md pl-2 pr-5 text-xs font-medium text-white focus:outline-none focus:border-[var(--color-primary)] cursor-pointer appearance-none truncate"
              >
                {businesses.map((bus) => (
                  <option key={bus._id} value={bus._id}>
                    {bus.name}
                  </option>
                ))}
              </select>
              <ChevronDown className="w-3.5 h-3.5 text-white/70 absolute right-1 top-1/2 -translate-y-1/2 pointer-events-none" />
            </div>
          </div>
        )}

        {/* Navegación */}
        <nav aria-label="Navegación principal" className="flex-1 flex flex-col overflow-y-auto business-sidebar-scroll py-2 px-2">
          <div className="flex flex-1 flex-col gap-1">
            {visibleNav.map((item) => {
              const isActive = item.path === '/' ? location.pathname === '/' : location.pathname.startsWith(item.path);
              return (
                <NavLink
                  key={item.path}
                  to={item.path}
                  end={item.path === '/'}
                  {...preloadOn(item.path)}
                  title={item.label}
                  aria-label={item.label}
                  className={`sidebar-item relative flex flex-1 items-center min-h-[64px] sm:min-h-[84px] rounded-xl ${isActive
                      ? 'bg-[color-mix(in_srgb,var(--zipp-gold)_24%,transparent)] text-white font-semibold'
                      : 'text-white hover:bg-white/10'
                    }`}
                >
                  <span className="flex w-full min-w-0 flex-col items-center justify-center gap-1 text-center">
                    <item.Icon className="sidebar-icon shrink-0 text-[26px] sm:text-[30px]" />
                    {item.path === '/support' && supportWaiting > 0 && (
                      <span
                        className="absolute right-3 top-3 h-2.5 w-2.5 rounded-full bg-[var(--color-primary)]"
                        role="status"
                        aria-label={supportWaiting === 1 ? 'Una respuesta nueva de Soporte' : `${supportWaiting} respuestas nuevas de Soporte`}
                      />
                    )}
                    <span className="w-full px-0.5 text-[10px] sm:text-xs font-medium leading-tight line-clamp-2 break-words">{item.label}</span>
                  </span>
                </NavLink>
              );
            })}
          </div>
        </nav>

        {/* Pie */}
        <div className="px-2 py-2 border-t border-white/10">
          {/* El error sí se ve: con el aviso oculto, un Abierto/Cerrado que no
              cuajó no dejaba ninguna señal y el comercio creía haber cerrado. */}
          {pauseError && (
            <p role="alert" className="mb-2 text-xs leading-snug text-[var(--color-danger)]">
              {pauseError}
            </p>
          )}
          {/* Tres partes iguales y discretas: salir, tema y abrir/cerrar el local. */}
          <div className="flex">
            <button
              onClick={() => setShowLogoutModal(true)}
              title="Cerrar sesión"
              aria-label="Cerrar sesión"
              className="grid h-14 flex-1 place-items-center rounded-xl text-white hover:text-[var(--color-danger)] hover:bg-white/10 cursor-pointer"
            >
              <LogOut className="w-5 h-5" strokeWidth={1.8} />
            </button>
            <ThemeButton />
            <StoreStatusButton
              compact
              business={selectedBusiness}
              busy={pausing}
              canToggle={can('store:toggle')}
              onSetOpen={setStoreOpen}
            />
          </div>
        </div>
      </aside>

      {/* ── Main Content Area ── */}
      <main className="flex-1 overflow-y-auto flex flex-col min-w-0 bg-[var(--color-bg)]">
        <OrderNotifications />
        {/* Page Outlet */}
        <div className="px-3 py-4 sm:px-5 sm:py-5 lg:px-8 lg:py-6 flex-1 flex flex-col">
          <div className="page-container flex-1 flex flex-col gap-5">
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

      <CounterSwitch />

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
