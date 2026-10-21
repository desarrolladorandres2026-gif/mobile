import { COLLECTIONS } from '../data/db.js';
import { TenantCollection } from '../data/tenantCollection.js';
import { isDuplicate, withTransaction } from '../data/tx.js';

export class CostCenterError extends Error {
  constructor(message, code = 'VALIDATION') {
    super(message);
    this.name = 'CostCenterError';
    this.code = code;
  }
}

const fail = (message, code) => {
  throw new CostCenterError(message, code);
};
const CODE = /^[A-Z0-9][A-Z0-9_-]{0,9}$/;
const clean = (value, label, max) => {
  const text = String(value ?? '').trim();
  if (!text) fail(`falta ${label}`);
  if (text.length > max) fail(`${label} admite como máximo ${max} caracteres`);
  return text;
};

/*
 * Centros de costo: una dimensión opcional de cada línea de asiento (una sede, un proyecto, un área) para ver el
 * resultado por separado. Un centro tiene código y nombre y se puede desactivar: deja de aceptarse en asientos
 * nuevos y sigue apareciendo en los que ya lo traen. No hay jerarquía ni se puede borrar uno con movimientos.
 * El libro valida que el código exista y esté activo, y lleva sus saldos por cuenta y período (`dimBalances`).
 */
export function createCostCenterService({ client, db, now = () => new Date() }) {
  const centersOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.costCenters), tenantId);

  return {
    async create(tenantId, input, { inTx } = {}) {
      const code = clean(input.code, 'el código del centro de costo', 10).toUpperCase();
      if (!CODE.test(code)) fail('el código admite letras, números, guion y guion bajo (hasta 10 caracteres)');
      const doc = { code, name: clean(input.name, 'el nombre del centro de costo', 100), active: true, createdAt: now() };
      return withTransaction(client, async (session) => {
        try {
          const { insertedId } = await centersOf(tenantId).insertOne({ ...doc }, session);
          const created = { ...doc, _id: insertedId, tenantId };
          if (inTx) await inTx(session, created);
          return created;
        } catch (err) {
          if (isDuplicate(err, 'tenant_costcenter_code')) fail(`ya existe un centro de costo con el código ${code}`, 'DUPLICATE');
          throw err;
        }
      });
    },

    async update(tenantId, code, changes, { inTx } = {}) {
      const center = await centersOf(tenantId).findOne({ code: String(code).toUpperCase() });
      if (!center) fail('el centro de costo no existe', 'NOT_FOUND');
      const set = {};
      if ('name' in changes) set.name = clean(changes.name, 'el nombre del centro de costo', 100);
      if ('active' in changes) set.active = Boolean(changes.active);
      if (Object.keys(set).length) {
        await withTransaction(client, async (session) => {
          await centersOf(tenantId).updateOne({ _id: center._id }, { $set: set }, { session });
          if (inTx) await inTx(session, { code: center.code, ...set });
        });
      }
      return centersOf(tenantId).findOne({ _id: center._id });
    },

    list(tenantId, { activeOnly = false } = {}) {
      return centersOf(tenantId)
        .find(activeOnly ? { active: true } : {}, { sort: { code: 1 }, limit: 500 })
        .toArray();
    },
  };
}
