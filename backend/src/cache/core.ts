import { config } from '../config/env';
import { MemoryStore } from './memoryStore';
import { RedisStore } from './redisStore';
import type { CacheStore } from './types';

/**
 * Caché de lecturas públicas.
 *
 * Tres reglas que no se negocian:
 *
 * 1. **Falla abierta.** Cualquier error del almacén se registra (con
 *    freno, para no inundar el log con Redis caído) y la lectura sigue a
 *    Mongo. Nunca un 500 por culpa de la caché.
 * 2. **Siempre JSON plano.** Lo que sale de `wrap` es el resultado de un
 *    `JSON.parse`, tanto en acierto como en fallo — así el controlador no
 *    ve un documento de Mongoose en un caso y un objeto plano en el otro.
 *    Cada llamada recibe su propia copia: nadie puede mutar la de otro.
 * 3. **Una invalidación gana a una lectura en vuelo.** Si mientras se
 *    calculaba un valor alguien invalidó, ese valor ya puede ser viejo y
 *    no se guarda (ver `epoch`).
 */

let store: CacheStore | null = null;

/**
 * Sube con cada invalidación. Una lectura que empezó antes de una
 * invalidación y terminó después trae datos leídos antes de la escritura:
 * guardarla dejaría en caché justo lo que se acababa de borrar.
 */
let epoch = 0;

/** Una sola consulta a Mongo por clave aunque lleguen cien peticiones a la vez. */
const inflight = new Map<string, Promise<string | undefined>>();

let lastErrorLogAt = 0;
function logError(op: string, error: unknown): void {
  const now = Date.now();
  if (now - lastErrorLogAt < 30_000) return;
  lastErrorLogAt = now;
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`⚠️  Caché (${op}) no disponible, leyendo de Mongo: ${message}`);
}

function getStore(): CacheStore {
  if (!store) {
    store = config.cache.redisUrl
      ? new RedisStore(config.cache.redisUrl, config.cache.keyPrefix)
      : new MemoryStore(config.cache.memoryMaxEntries);
  }
  return store;
}

const full = (key: string) => `${config.cache.keyPrefix}${key}`;

/** Crea el almacén al arrancar, para que el log diga cuál quedó activo. */
export function initCache(): 'memory' | 'redis' | 'disabled' {
  if (config.cache.disabled) return 'disabled';
  return getStore().kind;
}

export async function closeCache(): Promise<void> {
  const current = store;
  store = null;
  await current?.close().catch(() => {});
}

export async function get<T>(key: string): Promise<T | undefined> {
  if (config.cache.disabled) return undefined;
  try {
    const raw = await getStore().get(full(key));
    return raw === null ? undefined : (JSON.parse(raw) as T);
  } catch (error) {
    logError('get', error);
    return undefined;
  }
}

export async function set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  if (config.cache.disabled) return;
  const raw = JSON.stringify(value);
  if (raw === undefined) return;
  try {
    await getStore().set(full(key), raw, ttlSeconds);
  } catch (error) {
    logError('set', error);
  }
}

/**
 * Devuelve el valor cacheado o lo calcula con `fn`, lo guarda `ttlSeconds`
 * y lo devuelve. `fn` debe devolver el payload final de la respuesta, no
 * documentos a medio transformar: lo que se guarda es su JSON.
 */
export async function wrap<T>(key: string, ttlSeconds: number, fn: () => Promise<T>): Promise<T> {
  if (config.cache.disabled) return JSON.parse(JSON.stringify(await fn()) ?? 'null') as T;

  // Se toma al entrar y no al empezar `fn`: cualquier invalidación desde
  // aquí en adelante descarta el resultado. Es más conservador de lo
  // estrictamente necesario, y a cambio no hay hueco entre la lectura de la
  // caché y la de Mongo por el que se cuele un valor viejo.
  const startedAt = epoch;

  const hit = await get<T>(key);
  if (hit !== undefined) return hit;

  let pending = inflight.get(key);
  if (!pending) {
    pending = (async () => {
      const raw = JSON.stringify(await fn());
      if (raw !== undefined && epoch === startedAt) {
        try {
          await getStore().set(full(key), raw, ttlSeconds);
        } catch (error) {
          logError('set', error);
        }
      }
      return raw;
    })().finally(() => {
      if (inflight.get(key) === pending) inflight.delete(key);
    });
    inflight.set(key, pending);
  }

  const raw = await pending;
  return (raw === undefined ? undefined : JSON.parse(raw)) as T;
}

function bumpEpoch(prefixOrKeys: string | string[]): void {
  epoch++;
  const matches = typeof prefixOrKeys === 'string'
    ? (k: string) => k.startsWith(prefixOrKeys)
    : (k: string) => prefixOrKeys.includes(k);
  for (const key of Array.from(inflight.keys())) {
    if (matches(key)) inflight.delete(key);
  }
}

export async function del(...keys: string[]): Promise<void> {
  if (!keys.length) return;
  bumpEpoch(keys);
  if (config.cache.disabled) return;
  try {
    await getStore().del(keys.map(full));
  } catch (error) {
    logError('del', error);
  }
}

export async function delByPrefix(prefix: string): Promise<void> {
  bumpEpoch(prefix);
  if (config.cache.disabled) return;
  try {
    await getStore().delByPrefix(full(prefix));
  } catch (error) {
    logError('delByPrefix', error);
  }
}

/** Vacía todo lo de este entorno. Para tests y para el script de despliegue. */
export async function flush(): Promise<void> {
  bumpEpoch('');
  inflight.clear();
  try {
    await getStore().flush();
  } catch (error) {
    logError('flush', error);
  }
}

