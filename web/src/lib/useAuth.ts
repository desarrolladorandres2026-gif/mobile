import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { authApi, logout as apiLogout, type User } from './authApi';
import { clearCart } from './cart';
import { hasSession, subscribeSession } from './session';

export const ME_KEY = ['me'] as const;

/**
 * Estado de sesión para la interfaz.
 *
 * `hasSession` sale del almacenamiento (¿hay refresh token?); el perfil se
 * pide a `/auth/me`. Mientras llega, `loading` es verdadero y las pantallas
 * protegidas esperan en vez de mandar a iniciar sesión.
 */
export function useAuth(): {
  status: 'anonymous' | 'loading' | 'authenticated';
  user: User | null;
  hasPassword: boolean;
  logout: () => Promise<void>;
} {
  const signedIn = useSyncExternalStore(subscribeSession, hasSession, () => false);
  const queryClient = useQueryClient();

  const me = useQuery({
    queryKey: ME_KEY,
    queryFn: authApi.me,
    enabled: signedIn,
    staleTime: 5 * 60_000,
  });

  // Al cerrar sesión (aquí o en otra pestaña) no puede quedar nada del usuario anterior.
  const wasSignedIn = useRef(signedIn);
  useEffect(() => {
    if (!signedIn) {
      queryClient.clear();
      // Solo al CERRAR sesión: quien arma un pedido sin haber entrado conserva su carrito hasta el login.
      // En un equipo compartido el carrito (con sus notas) no puede pasar al siguiente usuario.
      if (wasSignedIn.current) clearCart();
    }
    wasSignedIn.current = signedIn;
  }, [signedIn, queryClient]);

  const logout = async () => {
    await apiLogout();
    queryClient.clear();
  };

  if (!signedIn) return { status: 'anonymous', user: null, hasPassword: false, logout };
  if (me.isPending) return { status: 'loading', user: null, hasPassword: false, logout };
  if (me.data) return { status: 'authenticated', user: me.data.user, hasPassword: me.data.hasPassword, logout };
  // Falló `/auth/me` sin cerrar la sesión (red caída): se trata como cargando, no como anónimo.
  return { status: 'loading', user: null, hasPassword: false, logout };
}
