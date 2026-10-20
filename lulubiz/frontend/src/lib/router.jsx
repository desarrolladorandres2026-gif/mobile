import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

/** Enrutador mínimo sobre la API de historial: lo que necesita la aplicación y nada más. */
const RouterContext = createContext(null);

export function RouterProvider({ children }) {
  const [location, setLocation] = useState(() => window.location.pathname + window.location.search);

  useEffect(() => {
    const onPop = () => setLocation(window.location.pathname + window.location.search);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((to, { replace = false } = {}) => {
    window.history[replace ? 'replaceState' : 'pushState'](null, '', to);
    setLocation(to);
    window.scrollTo?.(0, 0);
  }, []);

  const value = useMemo(() => {
    const query = location.indexOf('?');
    return {
      pathname: query === -1 ? location : location.slice(0, query),
      search: query === -1 ? '' : location.slice(query),
      navigate,
    };
  }, [location, navigate]);

  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useRouter() {
  const value = useContext(RouterContext);
  if (!value) throw new Error('useRouter va dentro de RouterProvider');
  return value;
}

/** Lleva a otra ruta al montarse. Reemplaza la entrada del historial: el botón «atrás» no vuelve a la redirección. */
export function Redirect({ to }) {
  const { navigate } = useRouter();
  useEffect(() => {
    navigate(to, { replace: true });
  }, [to, navigate]);
  return null;
}

export function Link({ href, children, className = '', onClick, ...rest }) {
  const { navigate } = useRouter();
  return (
    <a
      href={href}
      className={`text-azul underline underline-offset-2 hover:text-azul-oscuro ${className}`}
      onClick={(event) => {
        onClick?.(event);
        // Respeta abrir en pestaña nueva y los clics con teclas modificadoras.
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        navigate(href);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}
