import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Updates from 'expo-updates';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import type { Query } from '@tanstack/react-query';

/**
 * Lo que la app cliente guarda entre aperturas para pintar al instante.
 *
 * Sin esto cada arranque en frío empezaba de cero: esqueletos en el Inicio,
 * en las categorías y en cada tienda, aunque fueran los mismos de hace diez
 * minutos. Ahora se pinta lo último conocido y se refresca por detrás.
 *
 * **Solo catálogo y direcciones** (decisión del 2026-09-18). Nunca pedidos,
 * pagos, tarjetas, saldos, billetera ni nada del domiciliario: ver
 * un estado de pedido o un saldo de ayer sería peor que ver un esqueleto.
 * Por eso la regla es una lista de lo permitido, no de lo prohibido: una
 * clave nueva no se guarda hasta que alguien la añade aquí a propósito.
 */

export const QUERY_CACHE_STORAGE_KEY = 'zipp-rq-v1';

/** Lo guardado caduca a las 24 h aunque no se haya refrescado. */
export const PERSIST_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Sube este número si cambia la forma de alguna de las respuestas
 * guardadas: todo lo anterior se descarta al abrir.
 */
const PERSIST_SCHEMA = 1;

/** Raíces de clave que se pueden guardar. */
const PERSISTED_ROOTS = new Set([
  'home-sections',
  'homeCategories',
  'banners',
  'business',
  'categories',
  'products',
]);

/**
 * Por encima de esto se guardan solo las pantallas de arranque (Inicio,
 * categorías, banners, direcciones) y se sueltan las cartas. En Android una
 * fila de AsyncStorage de más de ~2 MB deja de poder leerse entera.
 */
const MAX_SERIALIZED_CHARS = 1_500_000;
const TRIMMABLE_ROOTS = new Set(['business', 'categories', 'products']);

export function shouldPersistQuery(query: Pick<Query, 'queryKey' | 'state'>): boolean {
  if (query.state.status !== 'success') return false;
  const [root, ...rest] = query.queryKey;
  // Solo la lista de direcciones, no las búsquedas de direcciones.
  if (root === 'addresses') return rest.length === 0;
  return typeof root === 'string' && PERSISTED_ROOTS.has(root);
}

/** Cambia con cada versión publicada, así una actualización no hereda la caché de la anterior. */
export const persistBuster = `${PERSIST_SCHEMA}:${Updates.updateId ?? 'embedded'}`;

export const queryPersister = createAsyncStoragePersister({
  storage: AsyncStorage,
  key: QUERY_CACHE_STORAGE_KEY,
  // Guardar es serializar todo lo permitido: una vez cada 3 s como mucho,
  // no en cada respuesta que llega durante el arranque.
  throttleTime: 3000,
  serialize: (client) => {
    const full = JSON.stringify(client);
    if (full.length <= MAX_SERIALIZED_CHARS) return full;
    return JSON.stringify({
      ...client,
      clientState: {
        ...client.clientState,
        queries: client.clientState.queries.filter(
          (q) => !TRIMMABLE_ROOTS.has(String(q.queryKey[0]))
        ),
      },
    });
  },
});

/** Borra lo guardado: al cerrar sesión o cuando entra otra persona. */
export async function clearPersistedQueries(): Promise<void> {
  await AsyncStorage.removeItem(QUERY_CACHE_STORAGE_KEY).catch(() => {});
}
