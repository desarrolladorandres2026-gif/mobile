import type { Schema, Types } from 'mongoose';
import { delByPrefix } from './core';

/**
 * Prefijos de las claves cacheadas. Cada lectura cacheada cuelga de uno,
 * y cada escritura borra los prefijos a los que puede afectar.
 */
export const CachePrefix = {
  /** Colecciones del inicio, bloques curados y banners posicionados. */
  HOME: 'home:',
  /**
   * El feed de descubrimiento (`/explore`).
   *
   * Prefijo propio y no una rama de `home:` porque los dos feeds se
   * invalidan por las mismas escrituras pero se **leen** con claves muy
   * distintas: el de explorar lleva franja horaria y, en su capa personal,
   * usuario. Mezclarlos haría que un cambio de banner borrara también las
   * claves por usuario, que son las caras de reconstruir.
   */
  EXPLORE: 'explore:',
  /**
   * Perfil de gustos por usuario, derivado de sus pedidos entregados.
   *
   * No lo toca el plugin de invalidación de ningún modelo: se borra a mano
   * cuando un pedido pasa a entregado. `Order` no lleva el plugin, y
   * ponérselo invalidaría el catálogo entero en cada cambio de estado de
   * cada pedido.
   */
  TASTE: 'taste:',
  OFFERS: 'offers:',
  HOME_CATEGORIES: 'homecat:',
  BANNERS: 'banners:',
  ZONES: 'zones:',
  /** Todo lo de todos los negocios. */
  BUSINESS_ALL: 'biz:',
  BUSINESS_SLUG: 'bizslug:',
  /** Ranking de ventas del inicio. Solo caduca por tiempo: no depende del catálogo. */
  SALES: 'sales:',
  /** Roles y permisos resueltos por cargo/roles (ver `authorization.service`). */
  AUTHZ: 'authz:',
  business: (id: string | Types.ObjectId) => `biz:${String(id)}:`,
} as const;

/** Borra varios prefijos a la vez, sin fallar nunca (la caché falla abierta). */
export async function invalidatePrefixes(prefixes: Iterable<string>): Promise<void> {
  await Promise.all(Array.from(new Set(prefixes)).map((p) => delByPrefix(p)));
}

/**
 * Lo que un cambio en un negocio puede dejar viejo: su ficha, su carta,
 * y cualquier listado donde aparezca.
 */
export function invalidateBusiness(businessId?: string | Types.ObjectId | null): Promise<void> {
  return invalidatePrefixes([
    businessId ? CachePrefix.business(businessId) : CachePrefix.BUSINESS_ALL,
    CachePrefix.BUSINESS_SLUG,
    CachePrefix.HOME,
    CachePrefix.EXPLORE,
    CachePrefix.OFFERS,
  ]);
}

/**
 * Qué se sabe de la escritura en el momento del hook: el documento (en
 * `save`, `insertMany` o un `findOneAndUpdate` que devolvió algo), o el
 * filtro y la actualización (en `updateOne`/`updateMany`/`deleteMany`).
 */
export interface WriteContext {
  doc?: Record<string, any> | null;
  filter?: Record<string, any>;
  update?: Record<string, any>;
}

export type PrefixesFor = (ctx: WriteContext) => string[];

const QUERY_WRITES = [
  'updateOne',
  'updateMany',
  'replaceOne',
  'findOneAndUpdate',
  'findOneAndReplace',
  'findOneAndDelete',
  'deleteOne',
  'deleteMany',
] as const;

/** `false` cuando el resultado dice explícitamente que no cambió nada. */
function changedSomething(result: any): boolean {
  if (result === null || result === undefined) return false;
  if (typeof result !== 'object') return true;
  if ('modifiedCount' in result || 'upsertedCount' in result || 'deletedCount' in result) {
    return (result.modifiedCount ?? 0) + (result.upsertedCount ?? 0) + (result.deletedCount ?? 0) > 0;
  }
  // `findOneAndUpdate` con `includeResultMetadata` devuelve `{ value, ok }`.
  if ('lastErrorObject' in result) return result.value !== null && result.value !== undefined;
  return true;
}

/** El documento que devolvió un `findOneAnd*`, si lo hay. */
function docFromResult(result: any): Record<string, any> | undefined {
  if (!result || typeof result !== 'object') return undefined;
  if ('modifiedCount' in result || 'deletedCount' in result) return undefined;
  if ('lastErrorObject' in result) return result.value ?? undefined;
  return result;
}

/**
 * Plugin de Mongoose que invalida la caché tras cada escritura del modelo.
 *
 * Va en el modelo y no en los servicios porque hay escrituras que no pasan
 * por ningún servicio (controladores que tocan el modelo directo, scripts,
 * el `bulkWrite` de reordenar banners): un olvido en un servicio dejaría
 * datos viejos hasta que caduque el TTL, y un hook no se olvida.
 *
 * Los hooks son `async` y Mongoose los espera: cuando la escritura
 * responde, la caché ya está limpia, y la siguiente lectura ve el cambio.
 * Una escritura que no cambió nada (`modifiedCount: 0`, o un
 * `findOneAndUpdate` sin coincidencia) no invalida — así, reservar stock de
 * un producto sin inventario no vacía la caché en cada pedido.
 */
export function cacheInvalidationPlugin(schema: Schema, options: { prefixesFor: PrefixesFor }): void {
  const run = (ctx: WriteContext) => invalidatePrefixes(options.prefixesFor(ctx)).catch(() => {});

  schema.post('save', async function (doc: any) {
    await run({ doc });
  });

  schema.post('deleteOne', { document: true, query: false }, async function (this: any) {
    await run({ doc: this });
  });

  for (const op of QUERY_WRITES) {
    schema.post(op, { document: false, query: true }, async function (this: any, result: any) {
      if (!changedSomething(result)) return;
      await run({
        doc: op.startsWith('findOneAnd') ? docFromResult(result) : undefined,
        filter: this.getFilter?.() ?? {},
        update: this.getUpdate?.() ?? {},
      });
    });
  }

  schema.post('insertMany', async function (docs: any) {
    const list = Array.isArray(docs) ? docs : [docs];
    await Promise.all(list.map((doc) => run({ doc })));
  });

  schema.post('bulkWrite', async function () {
    // Sin documentos a mano: se invalida como una escritura sin contexto.
    await run({});
  });
}

// ── Utilidades para los `prefixesFor` de cada modelo ─────────────────

/** Un id concreto del filtro o del documento, o `undefined` si es ambiguo. */
export function pickId(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value;
  // ObjectId (tiene toHexString) — un `{ $in: [...] }` no cuenta como uno solo.
  if (typeof value === 'object' && typeof (value as any).toHexString === 'function') {
    return (value as any).toHexString();
  }
  return undefined;
}

/** El valor de `field` que la escritura fija, si se puede saber sin ir a la base. */
export function fieldFrom(ctx: WriteContext, field: string): string | undefined {
  return (
    pickId(ctx.doc?.[field]) ??
    pickId(ctx.filter?.[field]) ??
    pickId(ctx.update?.[field]) ??
    pickId(ctx.update?.$set?.[field])
  );
}
