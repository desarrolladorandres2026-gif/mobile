import { useEffect, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useThemeStore } from './stores/themeStore';
import UpdateBanner from './components/UpdateBanner';
import Layout from './components/Layout';
import { lazyPage } from './lib/lazyPage';

/**
 * Cada página se descarga al abrirla, no al entrar al panel.
 *
 * Antes solo el mapa de flota iba aparte y las otras veinticuatro páginas
 * —con Leaflet y leaflet-draw de Zonas dentro— viajaban en un único archivo
 * de 1 MB que había que descargar y evaluar antes de ver el Dashboard. Ahora
 * el primer pintado solo lleva el Layout y la página que se abre.
 *
 * mapbox-gl (~800 KB) sigue siendo lo más pesado y sigue en su propio
 * archivo, dentro de FleetMap.
 */
const Login = lazyPage(() => import('./pages/Login'));
const Dashboard = lazyPage(() => import('./pages/Dashboard'));
const DailySummary = lazyPage(() => import('./pages/DailySummary'));
const Orders = lazyPage(() => import('./pages/Orders'));
const Evidences = lazyPage(() => import('./pages/Evidences'));
const Businesses = lazyPage(() => import('./pages/Businesses'));
const BusinessApprovals = lazyPage(() => import('./pages/BusinessApprovals'));
const ReviewModeration = lazyPage(() => import('./pages/ReviewModeration'));
const Incidents = lazyPage(() => import('./pages/Incidents'));
const Support = lazyPage(() => import('./pages/Support'));
const Drivers = lazyPage(() => import('./pages/Drivers'));
const DriverDocuments = lazyPage(() => import('./pages/DriverDocuments'));
const FleetMap = lazyPage(() => import('./pages/FleetMap'));
const Users = lazyPage(() => import('./pages/Users'));
const Positions = lazyPage(() => import('./pages/Positions'));
const Roles = lazyPage(() => import('./pages/Roles'));
const Financials = lazyPage(() => import('./pages/Financials'));
const Pricing = lazyPage(() => import('./pages/Pricing'));
const Security = lazyPage(() => import('./pages/Security'));
const LegalOps = lazyPage(() => import('./pages/LegalOps'));
const Campaigns = lazyPage(() => import('./pages/Campaigns'));
const Coupons = lazyPage(() => import('./pages/Coupons'));
const Zones = lazyPage(() => import('./pages/Zones'));
const HomeBanners = lazyPage(() => import('./pages/HomeBanners'));
const HomeCategories = lazyPage(() => import('./pages/HomeCategories'));
const SearchInsights = lazyPage(() => import('./pages/SearchInsights'));

// 30 s de frescura por defecto: navegar entre páginas y volver no repite
// peticiones que acaban de hacerse, y cada pantalla sigue pudiendo pedir
// datos más frescos (o invalidarlos tras una edición) por su cuenta.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, gcTime: 10 * 60_000, retry: 1 },
  },
});

function App() {
  const initTheme = useThemeStore((s) => s.initTheme);

  useEffect(() => {
    initTheme();
  }, [initTheme]);

  return (
    <QueryClientProvider client={queryClient}>
      <UpdateBanner />
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Suspense fallback={null}><Login /></Suspense>} />
          <Route path="/" element={<Layout />}>
            <Route index element={<Dashboard />} />
            <Route path="daily-summary" element={<DailySummary />} />
            <Route path="orders" element={<Orders />} />
            <Route path="evidences" element={<Evidences />} />
            <Route path="businesses" element={<Businesses />} />
            <Route path="business-approvals" element={<BusinessApprovals />} />
            <Route path="reviews" element={<ReviewModeration />} />
            <Route path="drivers" element={<Drivers />} />
            <Route path="driver-documents" element={<DriverDocuments />} />
            <Route
              path="fleet"
              element={
                <Suspense fallback={<div className="p-8 text-sm text-[var(--color-text-secondary)]">Cargando el mapa…</div>}>
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
            <Route path="incidents" element={<Incidents />} />
            <Route path="support" element={<Support />} />
            <Route path="legal" element={<LegalOps />} />
            <Route path="campaigns" element={<Campaigns />} />
            <Route path="coupons" element={<Coupons />} />
            <Route path="zones" element={<Zones />} />
            <Route path="home-banners" element={<HomeBanners />} />
            <Route path="home-categories" element={<HomeCategories />} />
            <Route path="search-insights" element={<SearchInsights />} />
          </Route>
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

export default App;

