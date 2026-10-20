import { COLLECTIONS } from '../data/db.js';
import { TenantCollection } from '../data/tenantCollection.js';
import { DUPLICATE_KEY, withTransaction } from '../data/tx.js';

export class AccountError extends Error {
  constructor(message, code = 'VALIDATION') {
    super(message);
    this.name = 'AccountError';
    this.code = code;
  }
}

/** Tipos de cuenta y su naturaleza normal. `memo` (cuentas de orden) exige naturaleza explícita. */
export const ACCOUNT_TYPES = {
  asset: 'debit',
  expense: 'debit',
  cost: 'debit',
  liability: 'credit',
  equity: 'credit',
  income: 'credit',
  memo: null,
};

const CODE_PATTERN = /^[0-9]{1,12}$/;

/*
 * Forma de una cuenta (referencia, sin tipos):
 * { _id, tenantId, code, name, type, nature 'debit'|'credit', parentCode?, postable, active, createdAt }
 *
 * - `postable: false` es una cuenta de agrupación: no recibe asientos, solo organiza.
 * - Un padre debe existir, ser de agrupación, del mismo tipo, y su código debe ser prefijo del hijo.
 * - Las cuentas nunca se borran: se desactivan, para no dejar asientos huérfanos.
 * - Los métodos que escriben aceptan `{ inTx }`: se llama con la sesión de la transacción para
 *   que la auditoría se confirme junto con la operación.
 */

export function createAccountService(client, db) {
  const accountsOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.accounts), tenantId);

  /** Valida y arma el documento. Lee con la sesión para ver los padres creados en la misma transacción. */
  async function buildDoc(tenantId, input, session) {
    const code = String(input.code ?? '').trim();
    if (!CODE_PATTERN.test(code)) throw new AccountError('el código debe ser numérico, de 1 a 12 dígitos');
    const name = String(input.name ?? '').trim();
    if (!name) throw new AccountError('falta el nombre de la cuenta');
    if (!Object.hasOwn(ACCOUNT_TYPES, input.type)) throw new AccountError(`tipo de cuenta inválido: ${input.type}`);

    const nature = ACCOUNT_TYPES[input.type] ?? input.nature;
    if (nature !== 'debit' && nature !== 'credit') {
      throw new AccountError('las cuentas de orden necesitan naturaleza débito o crédito');
    }
    if (ACCOUNT_TYPES[input.type] && input.nature && input.nature !== nature) {
      throw new AccountError(`una cuenta de tipo ${input.type} tiene naturaleza ${nature}`);
    }

    const parentCode = input.parentCode ? String(input.parentCode).trim() : null;
    if (parentCode) {
      const parent = await accountsOf(tenantId).findOne({ code: parentCode }, { session });
      if (!parent) throw new AccountError(`la cuenta padre ${parentCode} no existe`);
      if (parent.postable) throw new AccountError(`la cuenta padre ${parentCode} no es de agrupación`);
      if (parent.type !== input.type) throw new AccountError('el hijo debe ser del mismo tipo que su padre');
      if (!code.startsWith(parentCode) || code === parentCode) {
        throw new AccountError(`el código ${code} debe empezar por el de su padre ${parentCode}`);
      }
    }

    return {
      code,
      name,
      type: input.type,
      nature,
      ...(parentCode ? { parentCode } : {}),
      postable: input.postable ?? true,
      active: true,
      createdAt: new Date(),
    };
  }

  const translate = (err, code) => {
    if (err?.code === DUPLICATE_KEY) return new AccountError(`ya existe la cuenta ${code}`, 'DUPLICATE');
    return err;
  };

  return {
    async create(tenantId, input, { inTx } = {}) {
      try {
        return await withTransaction(client, async (session) => {
          const doc = await buildDoc(tenantId, input, session);
          await accountsOf(tenantId).insertOne({ ...doc }, session);
          if (inTx) await inTx(session, doc);
          return doc;
        });
      } catch (err) {
        throw translate(err, String(input?.code ?? '').trim());
      }
    },

    get(tenantId, code) {
      return accountsOf(tenantId).findOne({ code });
    },

    list(tenantId, { parentCode, activeOnly = false } = {}) {
      const filter = {
        ...(parentCode !== undefined ? { parentCode } : {}),
        ...(activeOnly ? { active: true } : {}),
      };
      return accountsOf(tenantId).find(filter, { sort: { code: 1 } }).toArray();
    },

    async deactivate(tenantId, code, { inTx } = {}) {
      await withTransaction(client, async (session) => {
        const result = await accountsOf(tenantId).updateOne({ code }, { $set: { active: false } }, { session });
        if (result.matchedCount === 0) throw new AccountError(`la cuenta ${code} no existe`, 'NOT_FOUND');
        if (inTx) await inTx(session, { code });
      });
    },

    /** Una cuenta desactivada se puede reactivar: así desactivar nunca es un callejón sin salida. */
    async reactivate(tenantId, code, { inTx } = {}) {
      await withTransaction(client, async (session) => {
        const result = await accountsOf(tenantId).updateOne({ code }, { $set: { active: true } }, { session });
        if (result.matchedCount === 0) throw new AccountError(`la cuenta ${code} no existe`, 'NOT_FOUND');
        if (inTx) await inTx(session, { code });
      });
    },

    /**
     * Verifica que todas las cuentas existan, estén activas y reciban asientos.
     * Devuelve la lista de problemas; vacía si todo está bien.
     */
    async postingProblems(tenantId, codes, session) {
      const unique = [...new Set(codes)];
      const found = await accountsOf(tenantId)
        .find({ code: { $in: unique } }, session ? { session } : undefined)
        .toArray();
      const byCode = new Map(found.map((a) => [a.code, a]));
      const problems = [];
      for (const code of unique) {
        const account = byCode.get(code);
        if (!account) problems.push(`la cuenta ${code} no existe`);
        else if (!account.active) problems.push(`la cuenta ${code} está inactiva`);
        else if (!account.postable) problems.push(`la cuenta ${code} es de agrupación y no recibe asientos`);
      }
      return problems;
    },

    /**
     * Crea las cuentas de un paquete de país que aún no existan, todas en una transacción:
     * o queda el plan completo o no queda nada. Repetirlo no duplica.
     */
    async seed(tenantId, accounts, { inTx } = {}) {
      return withTransaction(client, async (session) => {
        const existing = new Set((await accountsOf(tenantId).find({}, { session }).toArray()).map((a) => a.code));
        let created = 0;
        // De menor a mayor longitud: cada padre se crea antes que sus hijos.
        for (const account of [...accounts].sort((a, b) => a.code.length - b.code.length)) {
          if (existing.has(account.code)) continue;
          const doc = await buildDoc(tenantId, account, session);
          await accountsOf(tenantId).insertOne({ ...doc }, session);
          created += 1;
        }
        const result = { created };
        if (inTx) await inTx(session, result);
        return result;
      });
    },
  };
}
