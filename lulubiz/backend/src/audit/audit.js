import { ObjectId } from 'mongodb';
import { COLLECTIONS } from '../data/db.js';

export const MAX_AUDIT_PAGE = 100;

/*
 * Bitácora de auditoría, solo de agregar. Evento (referencia, sin tipos):
 * { _id, at, tenantId|null, userId|null, apiKeyId?, action, target?, ip, requestId, details? }
 * `apiKeyId` va en lugar de `userId` cuando quien actuó fue una clave de API.
 *
 * Las operaciones que modifican datos reciben `inTx(session, resultado)` y escriben aquí con esa
 * misma sesión: la operación y su evento se confirman juntos o ninguno. Solo los eventos que no
 * acompañan una escritura (un inicio de sesión fallido) se anotan sueltos.
 */
export function createAuditService(db) {
  const events = db.collection(COLLECTIONS.audit);

  return {
    async record({ tenantId = null, userId = null, apiKeyId, action, target, ip, requestId, details }, { session } = {}) {
      await events.insertOne(
        {
          at: new Date(),
          tenantId,
          userId,
          ...(apiKeyId ? { apiKeyId } : {}),
          action,
          ...(target ? { target: String(target) } : {}),
          ip: ip ?? null,
          requestId: requestId ?? null,
          ...(details ? { details } : {}),
        },
        session ? { session } : undefined,
      );
    },

    /** Más reciente primero. `cursor` es el `_id` del último evento de la página anterior. */
    async list(tenantId, { limit = 50, cursor } = {}) {
      const size = Math.min(Math.max(Number(limit) || 50, 1), MAX_AUDIT_PAGE);
      const filter = { tenantId, ...(cursor ? { _id: { $lt: new ObjectId(cursor) } } : {}) };
      const rows = await events.find(filter, { sort: { _id: -1 }, limit: size + 1 }).toArray();
      const hasMore = rows.length > size;
      const items = hasMore ? rows.slice(0, size) : rows;
      return { items, nextCursor: hasMore ? items[items.length - 1]._id.toHexString() : null };
    },
  };
}
