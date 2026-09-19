/**
 * Lo mínimo que la caché necesita de un almacén. Las claves llegan ya con
 * el prefijo del entorno puesto; el almacén no sabe nada de él.
 */
export interface CacheStore {
  readonly kind: 'memory' | 'redis';
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(keys: string[]): Promise<void>;
  delByPrefix(prefix: string): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
}
