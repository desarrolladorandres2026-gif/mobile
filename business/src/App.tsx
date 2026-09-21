import { Suspense, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useThemeStore } from './stores/themeStore';
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
const Dashboard = lazyPage(() => import('./pages/Dashboard'), '/');
const OrdersPage = lazyPage(() => import('./pages/Orders'), '/orders');
const MenuPage = lazyPage(() => import('./pages/Menu'), '/menu');
const ReviewsPage = lazyPage(() => import('./pages/Reviews'), '/reviews');
const SettingsPage = lazyPage(() => import('./pages/Settings'), '/settings');
const PromotionsPage = lazyPage(() => import('./pages/Promotions'), '/promotions');
const AdvertisingPage = lazyPage(() => import('./pages/Advertising'), '/advertising');
const AnalyticsPage = lazyPage(() => import('./pages/Analytics'), '/analytics');
const StaffPage = lazyPage(() => import('./pages/Staff'), '/staff');
const SettlementsPage = lazyPage(() => import('./pages/Settlements'), '/settlements');

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
  const initTheme = useThemeStore((s) => s.initTheme);

  useEffect(() => {
    initTheme();
  }, [initTheme]);

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
            <Route path="/" element={<Layout />}>
              <Route index element={<Dashboard />} />
              <Route path="orders" element={<OrdersPage />} />
              <Route path="settlements" element={<SettlementsPage />} />
              <Route path="menu" element={<MenuPage />} />
              <Route path="reviews" element={<ReviewsPage />} />
              <Route path="analytics" element={<AnalyticsPage />} />
              <Route path="promotions" element={<PromotionsPage />} />
              <Route path="advertising" element={<AdvertisingPage />} />
              <Route path="staff" element={<StaffPage />} />
              <Route path="settings" element={<SettingsPage />} />
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
