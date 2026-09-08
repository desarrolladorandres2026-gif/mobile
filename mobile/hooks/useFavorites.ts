import { useCallback, useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { favoritesApi, type FavoriteKind } from '../services/endpoints';
import { useAuthStore } from '../stores/authStore';
import { useFavoritesStore } from '../stores/favoritesStore';

/**
 * Favoritos, ahora en el servidor.
 *
 * Hasta ahora vivían en el almacenamiento local del teléfono: cambiar de
 * móvil, reinstalar o limpiar los datos borraba la lista entera sin aviso.
 * Es de las pocas cosas que un cliente construye a mano, una por una, así
 * que perderla se nota mucho más que perder una caché.
 *
 * La forma del hook imita a la del store anterior —`favorites`, `toggle`,
 * `isFavorite`— para que las pantallas que ya lo usaban cambien de fuente
 * sin cambiar de lógica.
 */
export function useFavorites() {
  const queryClient = useQueryClient();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  const ids = useQuery({
    queryKey: ['favorites', 'ids'],
    queryFn: () => favoritesApi.ids(),
    enabled: isAuthenticated,
    staleTime: 5 * 60_000,
  });

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['favorites'] });
  }, [queryClient]);

  const add = useMutation({
    mutationFn: ({ kind, targetId }: { kind: FavoriteKind; targetId: string }) =>
      favoritesApi.add(kind, targetId),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: ({ kind, targetId }: { kind: FavoriteKind; targetId: string }) =>
      favoritesApi.remove(kind, targetId),
    onSuccess: invalidate,
  });

  const isFavorite = useCallback(
    (targetId: string, kind: FavoriteKind = 'business') => {
      const list = kind === 'business' ? ids.data?.businesses : ids.data?.products;
      return !!list?.includes(targetId);
    },
    [ids.data]
  );

  const toggle = useCallback(
    (targetId: string, kind: FavoriteKind = 'business') => {
      // Se decide con lo que hay en pantalla, que es lo que el usuario
      // acaba de ver. Consultar al servidor antes de decidir metería una
      // espera en un gesto que tiene que sentirse instantáneo.
      if (isFavorite(targetId, kind)) {
        remove.mutate({ kind, targetId });
      } else {
        add.mutate({ kind, targetId });
      }
    },
    [isFavorite, add, remove]
  );

  return {
    businessIds: ids.data?.businesses ?? [],
    productIds: ids.data?.products ?? [],
    isFavorite,
    toggle,
    isLoading: ids.isLoading,
  };
}

/** La lista completa, con su contenido, para la pantalla de favoritos. */
export function useFavoritesList() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  return useQuery({
    queryKey: ['favorites', 'list'],
    queryFn: () => favoritesApi.list(),
    enabled: isAuthenticated,
  });
}

/**
 * Sube una sola vez los favoritos que quedaron guardados en el teléfono.
 *
 * Sin esto, estrenar la sincronización empezaría vaciándole la lista al
 * cliente, que es la peor forma posible de mejorar algo. Se ejecuta al
 * entrar con sesión y se marca como hecha para no repetirla.
 */
export function useFavoritesMigration() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const localFavorites = useFavoritesStore((s) => s.favorites);
  const clearLocal = useFavoritesStore((s) => s.clearLocal);
  const queryClient = useQueryClient();
  const done = useRef(false);

  useEffect(() => {
    if (!isAuthenticated || done.current || !localFavorites.length) return;
    done.current = true;

    favoritesApi
      .importLocal(localFavorites.map((f) => ({ kind: 'business' as const, targetId: f._id })))
      .then(() => {
        // Solo se borra lo local cuando el servidor confirma que lo tiene.
        // Al revés, un fallo de red se llevaría la lista por delante.
        clearLocal();
        queryClient.invalidateQueries({ queryKey: ['favorites'] });
      })
      .catch(() => {
        // Se reintenta en el siguiente arranque: la lista local sigue ahí.
        done.current = false;
      });
  }, [isAuthenticated, localFavorites, clearLocal, queryClient]);
}
