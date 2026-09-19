import type { CacheStore } from './types';

/**
 * Respaldo en memoria para cuando no hay `REDIS_URL`: desarrollo en
 * Windows (sin Docker ni Redis) y los tests.
 *
 * Un `Map` conserva el orden de inserción, así que reinsertar al leer lo
 * convierte en un LRU sin estructuras extra: lo primero del mapa es lo que
 * lleva más tiempo sin usarse, y es lo que sale cuando se llena.
 */
export class MemoryStore implements CacheStore {
  readonly kind = 'memory' as const;
  private readonly entries = new Map<string, { value: string; expiresAt: number }>();

  constructor(private readonly maxEntries: number) {}

  async get(key: string): Promise<string | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return null;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  async del(keys: string[]): Promise<void> {
    for (const key of keys) this.entries.delete(key);
  }

  async delByPrefix(prefix: string): Promise<void> {
    for (const key of Array.from(this.entries.keys())) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }

  async flush(): Promise<void> {
    this.entries.clear();
  }

  async close(): Promise<void> {
    this.entries.clear();
  }
}
