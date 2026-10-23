import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { StateMessage } from './StateMessage';
import { useAuth } from '../lib/useAuth';

/**
 * Pantallas que exigen sesión. Mientras el perfil carga no se redirige:
 * mandar a iniciar sesión a quien ya la tiene (solo está esperando a
 * `/auth/me`) sería un parpadeo que además pierde su destino.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'loading') return <StateMessage kind="loading" title="Cargando tu cuenta" />;
  if (status === 'anonymous') {
    const volver = encodeURIComponent(`${location.pathname}${location.search}`);
    return <Navigate to={`/ingresar?volver=${volver}`} replace />;
  }
  return <>{children}</>;
}
