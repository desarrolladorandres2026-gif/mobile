import { useEffect } from 'react';
import { Routes, Route, useLocation } from 'react-router-dom';
import Header from './components/Header';
import Footer from './components/Footer';
import Home from './pages/Home';
import LegalDocument from './pages/LegalDocument';
import BusinessShare from './pages/BusinessShare';

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
 * - La variable de Inter carga async y, como los títulos son grandes, el
 *   cambio de fuente reflowa la página justo después del primer render — si
 *   el scroll se hace una sola vez de inmediato, puede quedar apuntando a la
 *   posición vieja. Por eso reintenta tras el primer paint y una vez más
 *   200ms después.
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
    // aterrizar bien aunque el reflow de la fuente variable llegue tarde.
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
      <main className="flex-1">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/legal/:kind" element={<LegalDocument />} />
          <Route path="/negocio/:slug" element={<BusinessShare />} />
        </Routes>
      </main>
      <Footer />
    </div>
  );
}

export default App;
