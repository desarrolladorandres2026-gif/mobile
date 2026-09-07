import { useMemo } from 'react';
import { useHomeCategoriesQuery } from './useApi';
import { BUSINESS_CATEGORIES } from '../constants/config';

/**
 * Una categoría ya lista para pintar: siempre tiene `key` y `label`, e
 * `imageUrl` solo cuando el admin subió una imagen para esa categoría.
 */
export interface DisplayCategory {
  key: string;
  label: string;
  imageUrl?: string;
}

const FALLBACK: DisplayCategory[] = BUSINESS_CATEGORIES.map((c) => ({
  key: c.key,
  label: c.label,
}));

/**
 * Categorías de la pantalla inicial, con imagen configurable desde el admin.
 *
 * El backend manda `{ key, name, imageUrl }` ya ordenado y filtrado a
 * activas. Si la llamada falla o todavía no hay ninguna categoría creada en
 * el panel, se usa `BUSINESS_CATEGORIES` de siempre — sin `imageUrl`, así
 * `CategoryTile` cae solo en la ilustración local y la pantalla nunca se
 * queda vacía por un problema del servidor.
 */
export function useHomeCategories() {
  const { data, isLoading, isError } = useHomeCategoriesQuery();

  const categories = useMemo<DisplayCategory[]>(() => {
    if (!data || data.length === 0) return FALLBACK;
    return data.map((c) => ({
      key: c.key,
      label: c.name,
      imageUrl: c.imageUrl,
    }));
  }, [data]);

  return { categories, isLoading, isError };
}
