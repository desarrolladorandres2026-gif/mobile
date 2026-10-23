import { BSON } from 'mongodb';
import { COLLECTIONS } from '../data/db.js';
import { TenantCollection } from '../data/tenantCollection.js';

export class ExportError extends Error {
  constructor(message, code = 'VALIDATION') {
    super(message);
    this.name = 'ExportError';
    this.code = code;
  }
}

export const EXPORT_FORMAT = 'lulubiz-export/1';

/**
 * Lo que no sale en una exportación: credenciales y secretos (sesiones, tokens de un solo uso, claves de API con su hash)
 * y la identidad global de los usuarios, que no pertenece a la empresa. Los miembros salen con nombre, correo y rol.
 */
const NEVER = new Set(['tenants', 'users', 'sessions', 'tokens', 'apiKeys', 'memberships']);
const COLLECTION_NAMES = Object.values(COLLECTIONS).filter((name) => !NEVER.has(name));

const line = (value) => `${BSON.EJSON.stringify(value, { relaxed: true })}\n`;

/**
 * Exportación completa de los datos de una empresa, para entregarlos a quien se va o para tener una copia propia.
 *
 * Formato: líneas JSON (una por documento), en JSON extendido de MongoDB para no perder fechas ni identificadores.
 *   1. `{ type: 'start', format, tenantId, startedAt }`
 *   2. `{ collection, doc }` por cada documento de cada colección
 *   3. `{ type: 'end', finishedAt, counts }`: si el archivo no termina en esta línea, la descarga se cortó.
 *
 * Es una lectura colección por colección, no una foto atómica de toda la base: un documento creado mientras se exporta
 * puede entrar en una colección y no en otra. Una sola exportación por empresa a la vez (el estado vive en la memoria
 * del proceso, igual que los demás límites; ver ARQUITECTURA §12).
 */
export function createExportService({ db, now = () => new Date() }) {
  const running = new Set();

  async function* generate(tenantId) {
    const counts = {};
    yield line({ type: 'start', format: EXPORT_FORMAT, tenantId, startedAt: now() });

    const tenant = await db.collection(COLLECTIONS.tenants).findOne({ _id: tenantId });
    yield line({ collection: 'tenants', doc: tenant });
    counts.tenants = 1;

    const members = await db.collection(COLLECTIONS.memberships).find({ tenantId }).toArray();
    const users = await db
      .collection(COLLECTIONS.users)
      .find({ _id: { $in: members.map((m) => m.userId) } }, { projection: { email: 1, name: 1 } })
      .toArray();
    const byId = new Map(users.map((u) => [String(u._id), u]));
    counts.memberships = 0;
    for (const m of members) {
      const user = byId.get(String(m.userId));
      yield line({ collection: 'memberships', doc: { ...m, email: user?.email ?? null, name: user?.name ?? null } });
      counts.memberships += 1;
    }

    for (const name of COLLECTION_NAMES) {
      const cursor = new TenantCollection(db.collection(name), tenantId).find({}, { sort: { _id: 1 }, batchSize: 500 });
      counts[name] = 0;
      try {
        for await (const doc of cursor) {
          yield line({ collection: name, doc });
          counts[name] += 1;
        }
      } finally {
        await cursor.close();
      }
    }
    yield line({ type: 'end', finishedAt: now(), counts });
  }

  return {
    /**
     * Empieza la exportación. Devuelve el flujo de líneas y `release`, que se llama al cerrarse la respuesta (termine bien,
     * se corte o ni siquiera empiece a leerse) para liberar la empresa. Falla si ya hay una en curso para ella.
     */
    start(tenantId) {
      const key = String(tenantId);
      if (running.has(key)) throw new ExportError('ya hay una exportación en curso para esta empresa; espera a que termine', 'EXPORT_RUNNING');
      running.add(key);
      return { lines: generate(tenantId), release: () => running.delete(key) };
    },
    /** Colecciones que entran, para documentarlas y para la prueba que exige que una colección nueva se decida a propósito. */
    collections: () => [...COLLECTION_NAMES],
    excluded: () => [...NEVER],
  };
}
