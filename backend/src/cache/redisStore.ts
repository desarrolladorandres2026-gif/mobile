import Redis from 'ioredis';
import type { CacheStore } from './types';

/**
 * Almacén sobre Redis.
 *
 * Configurado para fallar rápido, no para insistir: sin cola offline, un
 * solo reintento y 200 ms de tope por comando. Una caché que tarda más que
 * la base de datos a la que sustituye es peor que no tenerla, así que ante
 * cualquier duda el comando falla y `cache/index.ts` va a Mongo.
 */
export class RedisStore implements CacheStore {
  readonly kind = 'redis' as const;
  private readonly client: Redis;

  constructor(url: string, private readonly prefix: string) {
    this.client = new Redis(url, {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      commandTimeout: 200,
      connectTimeout: 2000,
      // Reconecta en segundo plano con espera creciente; mientras tanto los
      // comandos fallan al instante (sin cola) y se lee de Mongo.
      retryStrategy: (times) => Math.min(times * 500, 10_000),
      lazyConnect: false,
    });
    // Sin este listener, un Redis caído emite 'error' sin manejar y tumba
    // el proceso. El registro con throttle lo hace `cache/index.ts`.
    this.client.on('error', () => {});
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.client.set(key, value, 'EX', Math.max(1, Math.round(ttlSeconds)));
  }

  async del(keys: string[]): Promise<void> {
    if (keys.length) await this.client.unlink(...keys);
  }

  /**
   * SCAN y no KEYS: KEYS bloquea Redis entero mientras recorre el espacio
   * de claves. El prefijo del entorno va en el patrón a mano porque el
   * `keyPrefix` de ioredis no se aplica a los patrones de SCAN.
   */
  async delByPrefix(prefix: string): Promise<void> {
    let cursor = '0';
    const pattern = `${escapeGlob(prefix)}*`;
    do {
      const [next, keys] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
      cursor = next;
      if (keys.length) await this.client.unlink(...keys);
    } while (cursor !== '0');
  }

  /** Solo lo de este entorno: la instancia puede ser compartida. */
  async flush(): Promise<void> {
    await this.delByPrefix(this.prefix);
  }

  async close(): Promise<void> {
    await this.client.quit().catch(() => this.client.disconnect());
  }
}

/** Los ids y slugs no traen comodines, pero un `*` en una clave no debe borrar de más. */
function escapeGlob(value: string): string {
  return value.replace(/([*?[\]\\])/g, '\\$1');
}
