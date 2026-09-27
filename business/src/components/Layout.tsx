import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom';
import {
  AlertCircle, LogOut, Menu, X,
  Volume2, VolumeX, ChevronDown, ChevronRight
} from 'lucide-react';
import { Suspense, useCallback, useEffect, useState } from 'react';
import api from '../services/api';
import { useAuthStore } from '../stores/authStore';
import { usePreferencesStore } from '../stores/preferencesStore';
import { ThemeToggle } from './ThemeToggle';
import ConfirmDialog from './ConfirmDialog';
import { apiMessage } from '../lib/apiError';
import OrderNotifications from './OrderNotifications';
import { preloadOn } from '../lib/lazyPage';
import {
  GridRegular, BoxRegular, WalletRegular, DataUsageRegular,
  FoodRegular, TagRegular, MegaphoneRegular, StarRegular,
  PeopleRegular, DocumentRegular, ChatRegular, SettingsRegular,
} from '@fluentui/react-icons';

const nav = [
  { path: '/', Icon: GridRegular, label: 'Resumen General' },
  { path: '/orders', Icon: BoxRegular, label: 'Pedidos' },
  { path: '/settlements', Icon: WalletRegular, label: 'Liquidaciones' },
  { path: '/analytics', Icon: DataUsageRegular, label: 'Analíticas' },
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

  /**
   * Abierto / cerrado es un hecho del servidor, no de esta pestaña.
   *
   * El interruptor guardaba antes un `useState` y nada más: el comercio
   * lo pulsaba, veía "Cerrado" y ZIPP seguía mandándole pedidos. Ahora
   * escribe `isActive` en el negocio, que es exactamente el campo que
   * `order.service.create` comprueba antes de aceptar un pedido nuevo.
   */
  const isStoreOpen = selectedBusiness?.isActive !== false;

  const toggleStore = async () => {
    if (!selectedBusiness || pausing) return;
    const next = !isStoreOpen;
    setPausing(true);
    setPauseError('');
    try {
      const { data } = await api.put(`/businesses/${selectedBusiness._id}`, { isActive: next });
      // Se refleja lo que respondió el servidor, no lo que se pidió: si la
      // escritura no cuajó, el interruptor no debe mentir.
      setSelectedBusiness({ ...selectedBusiness, isActive: data.data?.isActive ?? next });
    } catch (err) {
      setPauseError(apiMessage(err, 'No pudimos cambiar el estado del local.'));
    } finally {
      setPausing(false);
    }
  };

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
    <div className="flex h-screen bg-[var(--color-bg)] dark:bg-[#080B11] text-[var(--color-text-main)] dark:text-[var(--color-bg)] overflow-hidden font-sans transition-colors duration-200">
      {/* ── Sidebar (Índigo profundo — paleta ink) ── */}
    <aside className={`
        fixed inset-y-0 left-0 z-50 w-64 bg-linear-to-b from-[var(--color-sidebar-deep)] from-35% to-[var(--color-sidebar-glow)] border-r border-[var(--color-sidebar-border)] flex flex-col
        transform transition-transform duration-300 ease-out
        lg:translate-x-0 lg:static lg:inset-0
        ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
      `}>
        {/* Brand Header */}
        <div className="flex lg:hidden justify-end px-6 py-4">
          <button
            className="text-[var(--color-sidebar-text)] hover:text-white transition-colors cursor-pointer"
            onClick={() => setSidebarOpen(false)}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Business Selector */}
        {businesses.length > 0 && (
          <div className="px-4 py-3">
            <div className="relative">
              <select
                value={selectedBusiness?._id || ''}
                onChange={handleBusinessChange}
                className="w-full h-9 bg-transparent pl-0 pr-6 text-xs font-semibold text-white focus:outline-none cursor-pointer appearance-none"
              >
                {businesses.map((bus) => (
                  <option key={bus._id} value={bus._id} className="bg-[var(--color-sidebar)] text-white">
                    {bus.name}
                  </option>
                ))}
              </select>
              <ChevronDown className="w-3.5 h-3.5 text-[var(--color-sidebar-text)] absolute right-0 top-1/2 -translate-y-1/2 pointer-events-none" />
            </div>
          </div>
        )}

        {/* Estado del local y aviso sonoro */}
        <div className="px-4 py-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <button
              onClick={toggleStore}
              disabled={pausing || !selectedBusiness}
              aria-pressed={isStoreOpen}
              title={
                isStoreOpen
                  ? 'Tu local está recibiendo pedidos. Púlsalo para dejar de recibirlos.'
                  : 'Tu local no recibe pedidos. Púlsalo para volver a abrir.'
              }
              className={`flex items-center gap-2 text-sm font-bold uppercase tracking-wider cursor-pointer transition-all disabled:opacity-60 disabled:cursor-wait ${
                isStoreOpen ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]'
              }`}
            >
              <span
                className={`w-2.5 h-2.5 rounded-full ${
                  isStoreOpen ? 'bg-[var(--color-success)] animate-pulse' : 'bg-[var(--color-danger)]'
                }`}
              />
              <span>{pausing ? 'Guardando…' : isStoreOpen ? 'Abierto' : 'Cerrado'}</span>
            </button>

            <button
              onClick={toggleSound}
              aria-pressed={soundEnabled}
              className="p-1.5 text-[var(--color-sidebar-text)] hover:text-white transition-all cursor-pointer"
              title={
                soundEnabled
                  ? 'Suena un aviso al entrar un pedido. Púlsalo para silenciarlo.'
                  : 'Los pedidos entran en silencio. Púlsalo para activar el aviso.'
              }
            >
              {soundEnabled ? (
                <Volume2 className="w-3.5 h-3.5 text-[var(--color-accent)]" />
              ) : (
                <VolumeX className="w-3.5 h-3.5 text-[var(--color-sidebar-text)]" />
              )}
            </button>
          </div>

          {/* Aunque el dueño lo tenga "Abierto", una suspensión de ZIPP o la
              falta de aprobación dejan el local sin pedidos: hay que decirlo. */}
          {selectedBusiness?.isSuspended ? (
            <p className="text-[10px] font-semibold text-[var(--color-danger)] leading-snug">
              ZIPP suspendió este local
              {selectedBusiness.suspensionReason ? `: ${selectedBusiness.suspensionReason}` : ''}. No
              recibe pedidos hasta que soporte levante la suspensión.
            </p>
          ) : selectedBusiness && selectedBusiness.isApproved === false ? (
            <p className="text-[10px] font-semibold text-[var(--color-warning)] leading-snug">
              Tu local aún no está aprobado: los clientes no lo ven hasta que
              ZIPP revise tus documentos.
            </p>
          ) : null}

          {!isStoreOpen && !pauseError && !selectedBusiness?.isSuspended && (
            <p className="text-[10px] font-semibold text-[var(--color-danger)] leading-snug">
              No estás recibiendo pedidos nuevos. Los que ya tienes en cocina
              siguen su curso.
            </p>
          )}

          {pauseError && (
            <p className="text-[10px] font-semibold text-[var(--color-danger)] leading-snug">
              {pauseError}
            </p>
          )}
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto sidebar-scroll px-3 py-3">
          <p className="text-xs font-bold tracking-wider text-white uppercase px-3 mb-1">
            OPERACIONES
          </p>
          <div className="space-y-0">
            {nav.map((item) => {
              const isActive = item.path === '/' ? location.pathname === '/' : location.pathname.startsWith(item.path);
              return (
                <div key={item.path} className="ml-6 border-b border-white/10">
                  <NavLink
                    to={item.path}
                    end={item.path === '/'}
                    onClick={() => setSidebarOpen(false)}
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
        </nav>

        {/* Sidebar Footer */}
        <div className="px-3 py-3 border-t border-[var(--color-sidebar-border)]/70">
          <button
            onClick={() => { setSidebarOpen(false); setShowLogoutModal(true); }}
            className="group flex items-center gap-3 w-full px-1 py-1 cursor-pointer"
          >
            <LogOut className="w-4 h-4 shrink-0 text-[var(--color-danger)]" strokeWidth={1.8} />
            <span className="flex-1 min-w-0 text-left">
              <p className="text-xs font-bold text-[var(--color-danger)] leading-tight">Cerrar sesión</p>
              <p className="text-[10px] text-[var(--color-sidebar-text)] leading-tight mt-0.5">Salir del panel de comercio</p>
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
        <header className="sticky top-0 z-30 bg-white dark:bg-[var(--color-sidebar)] border-b border-[var(--color-border-light)] dark:border-[var(--color-sidebar-border)]/80 px-6 lg:px-8 h-16 flex items-center justify-between gap-4 shadow-xs transition-colors duration-200">
          <div className="flex items-center gap-4 flex-1">
            <button
              className="lg:hidden p-2 rounded-lg text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)] dark:text-[var(--color-sidebar-text)] dark:hover:text-white hover:bg-[var(--color-bg-alt)] dark:hover:bg-[var(--color-sidebar-hover)] transition-colors cursor-pointer"
              onClick={() => setSidebarOpen(true)}
            >
              <Menu className="w-5 h-5" />
            </button>

            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-[var(--color-text-main)] dark:text-[var(--color-bg)]">
                {selectedBusiness?.name || 'Panel de Comercio'}
              </span>
            </div>
          </div>

          {/* Right Header Actions */}
          <div className="flex items-center gap-2 sm:gap-3">
            {/* Theme Toggle (Claro / Oscuro / Automático) */}
            <ThemeToggle />

            <div className="w-px h-6 bg-[var(--color-border)] dark:bg-[var(--color-sidebar-border)]" />

            <div className="flex items-center gap-2.5 p-1 rounded-lg">
              <div className="w-8 h-8 rounded-full bg-[var(--color-primary)] flex items-center justify-center text-xs font-bold text-white shadow-xs">
                {selectedBusiness?.name?.charAt(0) || 'N'}
              </div>
              <div className="text-left hidden md:block">
                <p className="text-xs font-bold text-[var(--color-text-main)] dark:text-[var(--color-bg)] leading-none">{selectedBusiness?.name || 'Comercio'}</p>
                <p className="text-[10px] text-[var(--color-text-muted)] dark:text-[var(--color-sidebar-text)] mt-0.5 leading-none">Negocio Aliado</p>
              </div>
            </div>
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
