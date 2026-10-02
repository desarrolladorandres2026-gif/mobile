import { Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { RealtimeProvider } from './hooks/RealtimeProvider';
import UpdateBanner from './components/UpdateBanner';
import PrivateRoute from './components/PrivateRoute';
import Layout from './components/Layout';
import { lazyPage } from './lib/lazyPage';

/**
 * Cada página se descarga al abrirla.
 *
 * Antes todo el panel —Leaflet incluido, que solo usa Ajustes— era un
 * único archivo de 670 KB que había que bajar y evaluar antes de ver la
 * cocina. Ahora el primer pintado solo lleva el Layout y la página abierta.
 */
const Login = lazyPage(() => import('./pages/Login'), '/login');
const TwoFactorSetup = lazyPage(() => import('./pages/TwoFactorSetup'), '/setup-2fa');
const HomePage = lazyPage(() => import('./pages/Home'), '/');
const OrdersPage = lazyPage(() => import('./pages/Orders'), '/orders');
const MenuPage = lazyPage(() => import('./pages/Menu'), '/menu');
const ReviewsPage = lazyPage(() => import('./pages/Reviews'), '/reviews');
const SupportPage = lazyPage(() => import('./pages/Support'), '/support');
const PromotionsPage = lazyPage(() => import('./pages/Promotions'), '/promotions');
const AdvertisingPage = lazyPage(() => import('./pages/Advertising'), '/advertising');
const SettlementsPage = lazyPage(() => import('./pages/Settlements'), '/settlements');
// El perfil del negocio vive en un único archivo (cabecera + pestañas) pero
// cuelga de cuatro rutas reales, una por pestaña, para que la barra lateral
// siga resaltando el ítem activo y cada pestaña tenga su propia URL. Cada
// `lazyPage` se registra con su propia ruta para que `preloadOn` funcione
// desde cualquiera de los cuatro enlaces; el `import()` es el mismo chunk.
const ProfileInfoPage = lazyPage(() => import('./pages/Profile'), '/settings');
const ProfileDocumentsPage = lazyPage(() => import('./pages/Profile'), '/documents');
const ProfileStaffPage = lazyPage(() => import('./pages/Profile'), '/staff');
const ProfileSecurityPage = lazyPage(() => import('./pages/Profile'), '/security');
const ProfileDesktopPage = lazyPage(() => import('./pages/Profile'), '/desktop');

/**
 * Caché de lecturas del panel. 30 s de frescura: ir de Pedidos a la cocina
 * y volver no repite peticiones que se acaban de hacer, y cada pantalla
 * invalida lo suyo tras editar o cuando el socket avisa de un cambio.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, gcTime: 10 * 60_000, retry: 1 },
  },
});

function PageLoading() {
  return (
    <div className="flex items-center justify-center py-24">
      <RefreshCw className="w-6 h-6 text-[var(--color-primary)] animate-spin" />
    </div>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
    <BrowserRouter>
      <UpdateBanner />
      {/*
        El proveedor envuelve también al login: la conexión solo se abre
        cuando hay sesión, y montarlo aquí evita que entrar al panel
        desmonte y vuelva a montar el socket con cada navegación.
      */}
      <RealtimeProvider>
        <Suspense fallback={<PageLoading />}>
        <Routes>
          {/* Ruta pública */}
          <Route path="/login" element={<Login />} />

          {/* Rutas protegidas — requieren sesión activa */}
          <Route element={<PrivateRoute />}>
            {/* Fuera del Layout: con el 2FA pendiente, todo lo que el Layout pide responde 403. */}
            <Route path="/setup-2fa" element={<TwoFactorSetup />} />
            <Route path="/" element={<Layout />}>
              <Route index element={<HomePage />} />
              <Route path="orders" element={<OrdersPage />} />
              <Route path="settlements" element={<SettlementsPage />} />
              <Route path="menu" element={<MenuPage />} />
              <Route path="reviews" element={<ReviewsPage />} />
              <Route path="support" element={<SupportPage />} />
              <Route path="promotions" element={<PromotionsPage />} />
              <Route path="advertising" element={<AdvertisingPage />} />
              <Route path="staff" element={<ProfileStaffPage />} />
              <Route path="documents" element={<ProfileDocumentsPage />} />
              <Route path="settings" element={<ProfileInfoPage />} />
              <Route path="security" element={<ProfileSecurityPage />} />
              <Route path="desktop" element={<ProfileDesktopPage />} />
            </Route>
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </Suspense>
      </RealtimeProvider>
    </BrowserRouter>
    </QueryClientProvider>
  );
}

export default App;
