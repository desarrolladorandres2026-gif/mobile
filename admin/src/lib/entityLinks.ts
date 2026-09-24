import { useCallback, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Permission } from './permissions';
import type { PermissionKey } from './permissions';

/**
 * Navegación cruzada entre fichas.
 *
 * Una sola convención para todo el panel: `?ficha=<tipo>:<id>` sobre la URL
 * en la que ya se está. `FichaHost` (montado una vez en `Layout`) lee ese
 * parámetro y pinta el panel lateral que toca, así que cualquier pantalla
 * abre la ficha de un pedido, comercio, cliente o domiciliario sin conocer
 * a las demás. Como vive en la URL, el enlace se puede compartir y "atrás"
 * vuelve a la ficha anterior.
 */
export type FichaType = 'order' | 'business' | 'user' | 'driver';

/**
 * Permiso que hace falta para ver la ficha de cada tipo. Es el mismo mapa
 * que `NOTE_PERMISSION` del backend. Solo es UX: la ruta vuelve a exigirlo.
 */
export const FICHA_VIEW_PERMISSION: Record<FichaType, PermissionKey> = {
  order: Permission.ORDERS_VIEW_ALL,
  business: Permission.BUSINESSES_VIEW,
  user: Permission.USERS_VIEW,
  driver: Permission.DRIVERS_VIEW,
};

/** Evento con el que una ficha avisa a la página de fondo de que algo cambió. */
export const FICHA_CHANGED_EVENT = 'zipp:ficha-changed';

export interface FichaRef {
  type: FichaType;
  id: string;
}

const FICHA_TYPES = Object.keys(FICHA_VIEW_PERMISSION) as FichaType[];

// El id acaba en una URL de la API: solo caracteres de un identificador.
const ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;

/** Lee `?ficha=<tipo>:<id>` de una query string. Null si falta o es inválido. */
export function parseFicha(search: string): FichaRef | null {
  const raw = new URLSearchParams(search).get('ficha');
  if (!raw) return null;
  const sep = raw.indexOf(':');
  if (sep < 1) return null;
  const type = raw.slice(0, sep);
  const id = raw.slice(sep + 1);
  if (!FICHA_TYPES.includes(type as FichaType) || !ID_SHAPE.test(id)) return null;
  return { type: type as FichaType, id };
}

export interface FichaControls {
  current: FichaRef | null;
  /** Abre una ficha empujando una entrada nueva al historial. */
  open: (type: FichaType, id: string) => void;
  /** Cierra la ficha visible quitando `ficha` de la URL. */
  close: () => void;
}

export function useFicha(): FichaControls {
  const navigate = useNavigate();
  const { pathname, search, hash } = useLocation();

  const current = useMemo(() => parseFicha(search), [search]);

  const open = useCallback(
    (type: FichaType, id: string) => {
      const params = new URLSearchParams(search);
      params.set('ficha', `${type}:${id}`);
      // Sin `replace`: abrir otra ficha es un paso más, y "atrás" vuelve a la anterior.
      navigate({ pathname, search: `?${params.toString()}`, hash });
    },
    [navigate, pathname, search, hash],
  );

  const close = useCallback(() => {
    const params = new URLSearchParams(search);
    params.delete('ficha');
    const rest = params.toString();
    // Con `replace`: cerrar no debe dejar una entrada que reabra la ficha al volver.
    navigate({ pathname, search: rest ? `?${rest}` : '', hash }, { replace: true });
  }, [navigate, pathname, search, hash]);

  return useMemo(() => ({ current, open, close }), [current, open, close]);
}
