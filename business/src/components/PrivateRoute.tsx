import { Navigate, Outlet } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';

/**
 * Protege todas las rutas hijas.
 * Si no hay sesión activa (token en store/localStorage) redirige al login.
 * No muestra contenido en blanco mientras decide — renderiza Navigate de inmediato.
 */
export default function PrivateRoute() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}

