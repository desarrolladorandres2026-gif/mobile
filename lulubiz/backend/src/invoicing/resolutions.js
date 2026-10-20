import { ObjectId } from 'mongodb';
import { COLLECTIONS } from '../data/db.js';
import { TenantCollection } from '../data/tenantCollection.js';
import { DUPLICATE_KEY, withTransaction } from '../data/tx.js';
import { InvoicingError } from './settings.js';

export const DOC_TYPES = ['invoice', 'credit_note'];
const PREFIX = /^[A-Z0-9]{0,6}$/;
const MAX_RANGE = 1_000_000_000;

const asDate = (value, label) => {
  const date = new Date(`${String(value ?? '')}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value)) || Number.isNaN(date.getTime())) throw new InvoicingError(`${label} debe ser una fecha AAAA-MM-DD`);
  return date;
};

/*
 * Resolución de numeración (referencia, sin tipos):
 * { _id, tenantId, docType 'invoice'|'credit_note', prefix, number (la de la autoridad), from, to, next,
 *   validFrom, validTo, active, createdAt }
 *
 * Los números de una resolución se asignan sin huecos y sin repetirse: `next` se incrementa dentro de la
 * transacción que crea el documento, así que si esa transacción falla el número no se consume. Dos rangos
 * del mismo tipo y prefijo no pueden solaparse: repetirían números.
 */
export function createResolutionService(client, db) {
  const resolutionsOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.resolutions), tenantId);

  return {
    async create(tenantId, input, { inTx } = {}) {
      if (!DOC_TYPES.includes(input.docType)) throw new InvoicingError(`tipo de documento inválido: ${input.docType}`);
      const prefix = String(input.prefix ?? '').trim().toUpperCase();
      if (!PREFIX.test(prefix)) throw new InvoicingError('el prefijo admite hasta 6 letras o números');
      const number = String(input.number ?? '').trim();
      if (!number || number.length > 40) throw new InvoicingError('falta el número de la resolución');
      const { from, to } = input;
      if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from || to > MAX_RANGE) {
        throw new InvoicingError('el rango debe ser de enteros positivos, con «hasta» mayor o igual que «desde»');
      }
      const validFrom = asDate(input.validFrom, 'la fecha de inicio');
      const validTo = new Date(asDate(input.validTo, 'la fecha de fin').getTime() + 86_399_999);
      if (validTo < validFrom) throw new InvoicingError('la vigencia termina antes de empezar');

      try {
        return await withTransaction(client, async (session) => {
          const overlapping = await resolutionsOf(tenantId).findOne(
            { docType: input.docType, prefix, from: { $lte: to }, to: { $gte: from } },
            { session },
          );
          if (overlapping) {
            throw new InvoicingError(`el rango se solapa con la resolución ${overlapping.number} (${overlapping.from} a ${overlapping.to})`, 'DUPLICATE');
          }
          const doc = { docType: input.docType, prefix, number, from, to, next: from, validFrom, validTo, active: true, createdAt: new Date() };
          const { insertedId } = await resolutionsOf(tenantId).insertOne({ ...doc }, session);
          const created = { ...doc, _id: insertedId };
          if (inTx) await inTx(session, created);
          return created;
        });
      } catch (err) {
        if (err?.code === DUPLICATE_KEY) throw new InvoicingError('ya existe una resolución con ese tipo, prefijo y rango inicial', 'DUPLICATE');
        throw err;
      }
    },

    list(tenantId) {
      return resolutionsOf(tenantId).find({}, { sort: { docType: 1, validTo: -1 } }).toArray();
    },

    async deactivate(tenantId, id, { inTx } = {}) {
      await withTransaction(client, async (session) => {
        const result = await resolutionsOf(tenantId).updateOne({ _id: new ObjectId(id) }, { $set: { active: false } }, { session });
        if (result.matchedCount === 0) throw new InvoicingError('la resolución no existe', 'NOT_FOUND');
        if (inTx) await inTx(session, { id });
      });
    },

    /**
     * Asigna el siguiente número de una resolución vigente y con números disponibles. Debe llamarse dentro de
     * la transacción que crea el documento. Con varias resoluciones vigentes usa la que vence primero.
     */
    async allocate(tenantId, docType, at, session) {
      const before = await resolutionsOf(tenantId).findOneAndUpdate(
        { docType, active: true, validFrom: { $lte: at }, validTo: { $gte: at }, $expr: { $lte: ['$next', '$to'] } },
        { $inc: { next: 1 } },
        { returnDocument: 'before', sort: { validTo: 1, _id: 1 }, session },
      );
      if (!before) {
        throw new InvoicingError(
          `no hay una resolución de numeración vigente con números disponibles para ${docType === 'invoice' ? 'facturas' : 'notas crédito'}`,
          'NO_RESOLUTION',
        );
      }
      return {
        resolutionId: before._id,
        prefix: before.prefix,
        number: before.next,
        fullNumber: `${before.prefix}${before.next}`,
        resolution: { number: before.number, from: before.from, to: before.to, validFrom: before.validFrom, validTo: before.validTo },
      };
    },
  };
}
