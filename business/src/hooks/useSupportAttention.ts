import { useQuery, useQueryClient } from '@tanstack/react-query';
import api from '../services/api';
import { awaitingYou } from '../lib/supportState';
import { useBusinessEvent } from './realtimeContext';

/**
 * Casos propios que esperan una lectura. Alimenta el punto del menú lateral.
 *
 * El panel web no recibe push (la push de Expo solo llega a teléfonos; ver
 * `DocumentExpiryNotice`), así que esto es lo único que avisa a un comercio
 * con el panel abierto en otra pantalla. Comparte la clave de la lista de
 * Soporte: abrir esa pantalla no hace una segunda consulta.
 */
export const supportKey = (businessId: string | undefined) => ['business', businessId, 'support'];

export function useSupportAttention(businessId: string | undefined): number {
  const queryClient = useQueryClient();
  const key = supportKey(businessId);

  const { data } = useQuery({
    queryKey: key,
    enabled: !!businessId,
    staleTime: 60_000,
    queryFn: async () => (await api.get('/pqrs/my', { params: { businessId } })).data.data as Array<{ status: string; responses?: Array<{ from?: 'staff' | 'requester' }> }>,
    select: (tickets) => tickets.filter(awaitingYou).length,
  });

  // ZIPP respondió: el punto aparece sin recargar, en la pantalla que sea.
  useBusinessEvent('support:replied', () => {
    queryClient.invalidateQueries({ queryKey: key });
  });

  return data ?? 0;
}
