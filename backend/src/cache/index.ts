import { get, set, wrap, del, delByPrefix, flush } from './core';

export { initCache, closeCache } from './core';
export {
  CachePrefix,
  cacheInvalidationPlugin,
  invalidateBusiness,
  invalidatePrefixes,
  fieldFrom,
  pickId,
} from './invalidation';

export const cache = { get, set, wrap, del, delByPrefix, flush };
