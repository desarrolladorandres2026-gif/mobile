import { useEffect, lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useThemeStore } from './stores/themeStore';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import DailySummary from './pages/DailySummary';
import Login from './pages/Login';
import Orders from './pages/Orders';
import Evidences from './pages/Evidences';
import Businesses from './pages/Businesses';
import Drivers from './pages/Drivers';

/**
 * El mapa de flota se carga solo al abrirlo.
 *
 * mapbox-gl pesa ~800 KB minificado y lo usa una sola pantalla. Con un
 * import normal, cada administrador que entra a ver un pedido descarga la
 * librería de mapas entera antes de ver nada — y la mayoría de las
 * sesiones del panel nunca abren la flota.
 */
const FleetMap = lazy(() => import('./pages/FleetMap'));
import Users from './pages/Users';
import Positions from './pages/Positions';
import Roles from './pages/Roles';
import Financials from './pages/Financials';
import Pricing from './pages/Pricing';
import Security from './pages/Security';
import LegalOps from './pages/LegalOps';
import Campaigns from './pages/Campaigns';
import Coupons from './pages/Coupons';
import Zones from './pages/Zones';
import HomeBanners from './pages/HomeBanners';
import HomeCategories from './pages/HomeCategories';

const queryClient = new QueryClient();

function App() {
  const initTheme = useThemeStore((s) => s.initTheme);

  useEffect(() => {
    initTheme();
  }, [initTheme]);

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/" element={<Layout />}>
            <Route index element={<Dashboard />} />
            <Route path="daily-summary" element={<DailySummary />} />
            <Route path="orders" element={<Orders />} />
            <Route path="evidences" element={<Evidences />} />
            <Route path="businesses" element={<Businesses />} />
            <Route path="drivers" element={<Drivers />} />
            <Route
              path="fleet"
              element={
                <Suspense fallback={<div className="p-8 text-sm text-slate-500">Cargando el mapa…</div>}>
                  <FleetMap />
                </Suspense>
              }
            />
            <Route path="users" element={<Users />} />
            <Route path="positions" element={<Positions />} />
            <Route path="roles" element={<Roles />} />
            <Route path="financials" element={<Financials />} />
            <Route path="pricing" element={<Pricing />} />
            <Route path="security" element={<Security />} />
            <Route path="legal" element={<LegalOps />} />
            <Route path="campaigns" element={<Campaigns />} />
            <Route path="coupons" element={<Coupons />} />
            <Route path="zones" element={<Zones />} />
            <Route path="home-banners" element={<HomeBanners />} />
            <Route path="home-categories" element={<HomeCategories />} />
          </Route>
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

export default App;

