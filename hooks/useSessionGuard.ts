import { useEffect, useRef } from 'react';
import { useRouter, useSegments } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '../stores/authStore';
import { socketService } from '../services/socket';

/**
 * Devuelve al login cuando la sesión se cae estando dentro de la app.
 *
 * Hasta ahora, el único sitio que miraba `isAuthenticated` para decidir a
 * dónde ir era la pantalla de splash (`app/index.tsx`), y esa corre **una
 * sola vez** al arrancar. Si la sesión moría después —y muere: el backend
 * revoca todas las sesiones al detectar reutilización de un refresh token,
 * un admin puede bloquear la cuenta, o el usuario simplemente ya no
 * existe— el interceptor de axios llamaba a `logout()` y ahí se acababa
 * todo: nadie navegaba a ninguna parte.
 *
 * La pantalla seguía montada, React Query seguía reintentando y cada
 * petición devolvía 401 en menos de un milisegundo, para siempre. Desde
 * fuera parecía que la app se había colgado; desde el servidor parecía un
 * ataque. El usuario no tenía forma de salir salvo reinstalar.
 */
export function useSessionGuard(): void {
  const router = useRouter();
  const segments = useSegments();
  const queryClient = useQueryClient();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const wasAuthenticated = useRef(isAuthenticated);

  useEffect(() => {
    const lost = wasAuthenticated.current && !isAuthenticated;
    wasAuthenticated.current = isAuthenticated;

    // Solo interesa la *transición* de sesión viva a sesión muerta.
    //
    // Reaccionar a `!isAuthenticated` a secas rompería el arranque: durante
    // el splash todavía no hay sesión cargada y el guardián mandaría al
    // login a alguien que sí la tiene, antes de que `loadStoredAuth`
    // terminara de leer el almacenamiento.
    if (!lost) return;

    // Ya estamos en la zona de autenticación (por ejemplo, el propio login
    // tras un intento fallido). Redirigir otra vez solo apilaría pantallas.
    const zone = segments[0];
    if (zone === '(auth)' || zone === undefined) return;

    // Las peticiones en vuelo y la caché pertenecen a la sesión que acaba
    // de morir. Sin esto, el siguiente usuario que entre en este teléfono
    // vería por un instante los pedidos del anterior mientras se refrescan
    // las consultas — datos de otra persona en pantalla.
    queryClient.cancelQueries();
    queryClient.clear();

    // El socket se autentica con el token en el handshake. Dejarlo abierto
    // lo dejaría reintentando con una credencial muerta.
    socketService.disconnect();

    router.replace('/(auth)/login');
  }, [isAuthenticated, segments, router, queryClient]);
}
