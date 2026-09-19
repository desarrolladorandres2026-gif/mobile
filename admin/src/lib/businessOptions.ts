import type { QueryClient } from '@tanstack/react-query';
import api from '../services/api';

/**
 * La lista de comercios para los selectores del panel (cupones, campañas,
 * banners, bloques curados).
 *
 * Las cuatro páginas la pedían cada una por su cuenta y en cada visita —y
 * Banners y Bloques curados, que se montan juntas, dos veces en la misma
 * carga—. Ahora pasa por la caché de react-query: una sola petición en
 * vuelo y cinco minutos de vida entre páginas. Devuelve la misma forma que
 * `api.get` (`{ data: cuerpo }`) para que quien la usa no cambie.
 */
export async function fetchBusinessOptions(queryClient: QueryClient) {
  const body = await queryClient.fetchQuery({
    queryKey: ['admin', 'business-options'],
    queryFn: async () => (await api.get('/businesses?limit=100')).data,
    staleTime: 5 * 60_000,
  });
  return { data: body };
}
