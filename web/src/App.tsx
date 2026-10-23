import { Suspense, useEffect } from 'react';
import { Routes, Route, useLocation } from 'react-router-dom';
import Header from './components/Header';
import Footer from './components/Footer';
import Home from './pages/Home';
import { lazyPage } from './lib/lazyPage';
import { RequireAuth } from './components/RequireAuth';

// La portada va en el archivo principal: es lo que abre casi todo el mundo
// y no debe esperar una segunda descarga. El resto se baja al entrar.
const LegalDocument = lazyPage(() => import('./pages/LegalDocument'));
const Businesses = lazyPage(() => import('./pages/Businesses'));
const BusinessShare = lazyPage(() => import('./pages/BusinessShare'));
const PaymentReturn = lazyPage(() => import('./pages/PaymentReturn'));
const Ingresar = lazyPage(() => import('./pages/Ingresar'));
const Recuperar = lazyPage(() => import('./pages/Recuperar'));
const Cuenta = lazyPage(() => import('./pages/Cuenta'));
const Pedido = lazyPage(() => import('./pages/Pedido'));
const Pedidos = lazyPage(() => import('./pages/Pedidos'));
const PedidoDetalle = lazyPage(() => import('./pages/PedidoDetalle'));
const Soporte = lazyPage(() => import('./pages/Soporte'));
const UneComercio = lazyPage(() => import('./pages/UneComercio'));
const Repartidores = lazyPage(() => import('./pages/Repartidores'));
const EliminarCuenta = lazyPage(() => import('./pages/EliminarCuenta'));

/**
 * React Router no reproduce el scroll nativo del navegador a un `#id`: en una
 * carga completa (o al volver de otra ruta) el navegador intenta el scroll
 * antes de que React monte las secciones, y se queda arriba. Sin esto, los
 * enlaces del header con hash (`/#simulador`) se ven rotos desde cualquier
 * página que no sea ya "/".
 *
 * Dos gotchas no obvios:
 * - `behavior: 'auto'` en `scrollIntoView` NO es instantáneo: la spec dice
 *   que "auto" deja mandar al `scroll-behavior` de CSS, y `index.css` pone
 *   `scroll-behavior: smooth` en `html`. Hay que pedir `'instant'` explícito
 *   para saltar ahí mismo, sin animación.
 * - Las rutas lazy (`LegalDocument`, `BusinessShare`, `PaymentReturn`) y las
 *   imágenes de la página siguen reflowando después del primer render — si
 *   el scroll se hace una sola vez de inmediato, puede quedar apuntando a la
 *   posición vieja. Por eso reintenta tras el primer paint y una vez más
 *   1500ms después.
 */
function ScrollToHash() {
  const { hash, pathname } = useLocation();

  useEffect(() => {
    if (!hash) {
      window.scrollTo(0, 0);
      return;
    }

    let cancelled = false;
    const scroll = () => {
      if (cancelled) return;
      document.getElementById(hash.slice(1))?.scrollIntoView({ behavior: 'instant', block: 'start' });
    };

    // Reintenta tras el primer pintado y una vez más un poco después, para
    // aterrizar bien aunque el reflow de una ruta lazy o una imagen llegue tarde.
    const raf = requestAnimationFrame(() => requestAnimationFrame(scroll));
    const timeout = setTimeout(scroll, 1500);

    return () => { cancelled = true; cancelAnimationFrame(raf); clearTimeout(timeout); };
  }, [hash, pathname]);

  return null;
}

function App() {
  return (
    <div className="flex min-h-dvh flex-col">
      <ScrollToHash />
      <Header />
      <main className="min-h-[calc(100dvh-4rem)] flex-1">
        <Suspense fallback={null}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/comercios" element={<Businesses />} />
            <Route path="/legal/:kind" element={<LegalDocument />} />
            <Route path="/negocio/:slug" element={<BusinessShare />} />
            <Route path="/pago/retorno" element={<PaymentReturn />} />
            <Route path="/ingresar" element={<Ingresar />} />
            <Route path="/pedido" element={<RequireAuth><Pedido /></RequireAuth>} />
            <Route path="/pedidos" element={<RequireAuth><Pedidos /></RequireAuth>} />
            <Route path="/pedidos/:id" element={<RequireAuth><PedidoDetalle /></RequireAuth>} />
            <Route path="/recuperar" element={<Recuperar />} />
            <Route path="/cuenta" element={<RequireAuth><Cuenta /></RequireAuth>} />
            <Route path="/soporte" element={<Soporte />} />
            <Route path="/unete-comercio" element={<UneComercio />} />
            <Route path="/repartidores" element={<Repartidores />} />
            <Route path="/eliminar-cuenta" element={<EliminarCuenta />} />
          </Routes>
        </Suspense>
      </main>
      <Footer />
    </div>
  );
}

export default App;
