import { useEffect, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useThemeStore } from './stores/themeStore';
import UpdateBanner from './components/UpdateBanner';
import Layout from './components/Layout';
import { lazyPage } from './lib/lazyPage';
import RequireAccess, { NoRoleScreen } from './components/RequireAccess';
import { findNavItem, hasAnyAccess } from './lib/navigation';
import { useAuthStore } from './stores/authStore';
import { Permission } from './lib/permissions';

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
const Login = lazyPage(() => import('./pages/Login'), '/login');
const TwoFactorSetup = lazyPage(() => import('./pages/TwoFactorSetup'), '/setup-2fa');
const Dashboard = lazyPage(() => import('./pages/Dashboard'), '/');
const DailySummary = lazyPage(() => import('./pages/DailySummary'), '/daily-summary');
const Orders = lazyPage(() => import('./pages/Orders'), '/orders');
const Evidences = lazyPage(() => import('./pages/Evidences'), '/evidences');
const Businesses = lazyPage(() => import('./pages/Businesses'), '/businesses');
const BusinessSecurity = lazyPage(() => import('./pages/BusinessSecurity'), '/businesses/security');
const BusinessApprovals = lazyPage(() => import('./pages/BusinessApprovals'), '/business-approvals');
const ReviewModeration = lazyPage(() => import('./pages/ReviewModeration'), '/reviews');
const Incidents = lazyPage(() => import('./pages/Incidents'), '/incidents');
const Support = lazyPage(() => import('./pages/Support'), '/support');
const Drivers = lazyPage(() => import('./pages/Drivers'), '/drivers');
const DriverFunnel = lazyPage(() => import('./pages/DriverFunnel'), '/driver-onboarding');
const DriverDocuments = lazyPage(() => import('./pages/DriverDocuments'), '/driver-documents');
const FleetMap = lazyPage(() => import('./pages/FleetMap'), '/fleet');
const Users = lazyPage(() => import('./pages/Users'), '/users');
const Positions = lazyPage(() => import('./pages/Positions'), '/positions');
const Roles = lazyPage(() => import('./pages/Roles'), '/roles');
const Financials = lazyPage(() => import('./pages/Financials'), '/financials');
const Settlements = lazyPage(() => import('./pages/Settlements'), '/settlements');
const Commissions = lazyPage(() => import('./pages/Commissions'), '/commissions');
const Refunds = lazyPage(() => import('./pages/Refunds'), '/refunds');
const Payments = lazyPage(() => import('./pages/Payments'), '/payments');
const AdInvoices = lazyPage(() => import('./pages/AdInvoices'), '/ad-invoices');
const Cash = lazyPage(() => import('./pages/Cash'), '/cash');
const FiscalDocuments = lazyPage(() => import('./pages/FiscalDocuments'), '/documents');
const Exports = lazyPage(() => import('./pages/Exports'), '/exports');
const Pricing = lazyPage(() => import('./pages/Pricing'), '/pricing');
const Security = lazyPage(() => import('./pages/Security'), '/security');
const LegalOps = lazyPage(() => import('./pages/LegalOps'), '/legal');
const LegalDocuments = lazyPage(() => import('./pages/LegalDocuments'), '/legal-documents');
const SupportMacros = lazyPage(() => import('./pages/SupportMacros'), '/support-macros');
const Campaigns = lazyPage(() => import('./pages/Campaigns'), '/campaigns');
const TargetedSends = lazyPage(() => import('./pages/TargetedSends'), '/targeted-sends');
const Referrals = lazyPage(() => import('./pages/Referrals'), '/referrals');
const ProMembership = lazyPage(() => import('./pages/ProMembership'), '/pro');
const AppHealth = lazyPage(() => import('./pages/AppHealth'), '/app-health');
const FeatureFlags = lazyPage(() => import('./pages/FeatureFlags'), '/feature-flags');
const Coupons = lazyPage(() => import('./pages/Coupons'), '/coupons');
const Zones = lazyPage(() => import('./pages/Zones'), '/zones');
const HomeBanners = lazyPage(() => import('./pages/HomeBanners'), '/home-banners');
const HomeCategories = lazyPage(() => import('./pages/HomeCategories'), '/home-categories');
const CuratedHomeBlocks = lazyPage(() => import('./pages/CuratedHomeBlocks'), '/curated-home-blocks');
const SearchInsights = lazyPage(() => import('./pages/SearchInsights'), '/search-insights');
const ExploreBuilder = lazyPage(() => import('./pages/ExploreBuilder'), '/explore-builder');

// 30 s de frescura por defecto: navegar entre páginas y volver no repite
// peticiones que acaban de hacerse, y cada pantalla sigue pudiendo pedir
// datos más frescos (o invalidarlos tras una edición) por su cuenta.
const queryClient = new QueryClient({
 defaultOptions: {
 queries: { staleTime: 30_000, gcTime: 10 * 60_000, retry: 1 },
 },
});

/** Envuelve una página con el permiso que declara lib/navigation. */
function guard(path: string, element: React.ReactNode) {
 const item = findNavItem(path);
 if (!item) return element;
 return (
 <RequireAccess permission={item.permission} redirectHome={path === '/'}>
 {element}
 </RequireAccess>
 );
}

/** Sin ningún permiso no hay panel que mostrar: pide un rol. */
function AccessLayout() {
 const user = useAuthStore((s) => s.user);
 const hasPermission = useAuthStore((s) => s.hasPermission);
 useAuthStore((s) => s.permissions);
 useAuthStore((s) => s.observedPermissions);
 if (user && !hasAnyAccess(hasPermission)) return <NoRoleScreen />;
 return <Layout />;
}

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
 <Route path="/setup-2fa" element={<Suspense fallback={null}><TwoFactorSetup /></Suspense>} />
 <Route path="/" element={<AccessLayout />}>
 <Route index element={guard('/', <Dashboard />)} />
 <Route path="daily-summary" element={guard('/daily-summary', <DailySummary />)} />
 <Route path="orders" element={guard('/orders', <Orders />)} />
 <Route path="evidences" element={guard('/evidences', <Evidences />)} />
 <Route path="businesses" element={guard('/businesses', <Businesses />)} />
 {/* Centro de seguridad del comercio: Negocios → ficha → Seguridad. */}
 <Route
 path="businesses/:id/security"
 element={guard('/businesses', <RequireAccess permission={Permission.SECURITY_VIEW}><BusinessSecurity /></RequireAccess>)}
 />
 <Route path="business-approvals" element={guard('/business-approvals', <BusinessApprovals />)} />
 <Route path="reviews" element={guard('/reviews', <ReviewModeration />)} />
 <Route path="drivers" element={guard('/drivers', <Drivers />)} />
 <Route path="driver-onboarding" element={guard('/driver-onboarding', <DriverFunnel />)} />
 <Route path="driver-documents" element={guard('/driver-documents', <DriverDocuments />)} />
 <Route
 path="fleet"
 element={guard('/fleet',
 <Suspense fallback={<div className="p-8 text-sm text-[var(--color-text-main)]">Cargando el mapa…</div>}>
 <FleetMap />
 </Suspense>
 )}
 />
 <Route path="users" element={guard('/users', <Users />)} />
 <Route path="positions" element={guard('/positions', <Positions />)} />
 <Route path="roles" element={guard('/roles', <Roles />)} />
 <Route path="financials" element={guard('/financials', <Financials />)} />
 <Route path="settlements" element={guard('/settlements', <Settlements />)} />
 <Route path="commissions" element={guard('/commissions', <Commissions />)} />
 <Route path="refunds" element={guard('/refunds', <Refunds />)} />
 <Route path="payments" element={guard('/payments', <Payments />)} />
 <Route path="ad-invoices" element={guard('/ad-invoices', <AdInvoices />)} />
 <Route path="cash" element={guard('/cash', <Cash />)} />
 <Route path="documents" element={guard('/documents', <FiscalDocuments />)} />
 <Route path="exports" element={guard('/exports', <Exports />)} />
 <Route path="pricing" element={guard('/pricing', <Pricing />)} />
 <Route path="security" element={guard('/security', <Security />)} />
 <Route path="incidents" element={guard('/incidents', <Incidents />)} />
 <Route path="support" element={guard('/support', <Support />)} />
 <Route path="legal" element={guard('/legal', <LegalOps />)} />
 <Route path="legal-documents" element={guard('/legal-documents', <LegalDocuments />)} />
 <Route path="support-macros" element={guard('/support-macros', <SupportMacros />)} />
 <Route path="campaigns" element={guard('/campaigns', <Campaigns />)} />
 <Route path="targeted-sends" element={guard('/targeted-sends', <TargetedSends />)} />
 <Route path="referrals" element={guard('/referrals', <Referrals />)} />
 <Route path="pro" element={guard('/pro', <ProMembership />)} />
 <Route path="app-health" element={guard('/app-health', <AppHealth />)} />
 <Route path="feature-flags" element={guard('/feature-flags', <FeatureFlags />)} />
 <Route path="coupons" element={guard('/coupons', <Coupons />)} />
 <Route path="zones" element={guard('/zones', <Zones />)} />
 <Route path="home-banners" element={guard('/home-banners', <HomeBanners />)} />
 <Route path="home-categories" element={guard('/home-categories', <HomeCategories />)} />
 <Route path="curated-home-blocks" element={guard('/curated-home-blocks', <CuratedHomeBlocks />)} />
 <Route path="search-insights" element={guard('/search-insights', <SearchInsights />)} />
 <Route path="explore-builder" element={guard('/explore-builder', <ExploreBuilder />)} />
 </Route>
 <Route path="*" element={<Navigate to="/" />} />
 </Routes>
 </BrowserRouter>
 </QueryClientProvider>
 );
}

export default App;

