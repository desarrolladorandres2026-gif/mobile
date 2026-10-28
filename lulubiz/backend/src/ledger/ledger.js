import { createHash } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { createAccountService } from '../accounts/accounts.js';
import { calendarToday } from '../core/dates.js';
import { createKeyedLimiter } from '../core/limiter.js';
import { addMinor, assertCurrency, assertMinorUnits } from '../core/money.js';
import { COLLECTIONS } from '../data/db.js';
import { TenantCollection } from '../data/tenantCollection.js';
import { isDuplicate, withTransaction } from '../data/tx.js';

/** Máximo de líneas por asiento. Evita documentos que crecen sin límite. */
export const MAX_LINES_PER_JOURNAL = 500;
export const MAX_JOURNAL_PAGE = 50;

/**
 * Tipos de documento que generan los módulos (facturas, cobros, compras…). Un asiento manual no puede usarlos:
 * consumiría su consecutivo y dejaría huecos, y un asiento a mano sobre sus cuentas no actualiza el documento.
 */
export const MODULE_DOC_TYPES = ['FV', 'NC', 'RC', 'FC', 'CE', 'NP', 'MI', 'PV', 'CJ', 'CA', 'AA', 'CB', 'NDP', 'DP', 'BF', 'NM', 'PN', 'PA', 'PR', 'PB', 'LC', 'PL', 'CI'];
const PERIOD_PATTERN = /^[0-9]{4}-(0[1-9]|1[0-2])$/;

export class LedgerValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LedgerValidationError';
  }
}

/** El asiento no cuadra: la suma de débitos no es igual a la de créditos. */
export class LedgerImbalanceError extends Error {
  constructor(totalDebit, totalCredit) {
    super(`asiento descuadrado: débitos ${totalDebit} ≠ créditos ${totalCredit}`);
    this.name = 'LedgerImbalanceError';
    this.totalDebit = totalDebit;
    this.totalCredit = totalCredit;
  }
}

/** Se repitió una clave de idempotencia con un contenido distinto: no es un reintento, es otra operación. */
export class IdempotencyConflictError extends Error {
  constructor() {
    super('esa clave de idempotencia ya se usó con un contenido distinto: usa una clave nueva para un asiento nuevo');
    this.name = 'IdempotencyConflictError';
    this.code = 'IDEMPOTENCY_CONFLICT';
  }
}

/** Huella del contenido de un asiento manual (lo que el cliente envía), para detectar una clave repetida con otro cuerpo. */
export function journalPayloadHash(body) {
  const canonical = JSON.stringify([
    String(body.docType ?? '').trim().toUpperCase(),
    String(body.date ?? ''),
    String(body.currency ?? ''),
    body.description ?? '',
    (body.lines ?? []).map((l) => [String(l.accountId ?? '').trim(), l.debit ?? 0, l.credit ?? 0, l.description ?? '', String(l.costCenter ?? '').trim().toUpperCase(), String(l.partyId ?? '')]),
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

export class JournalNotFoundError extends Error {
  constructor(id) {
    super(`asiento no encontrado: ${id}`);
    this.name = 'JournalNotFoundError';
  }
}

export class JournalAlreadyReversedError extends Error {
  constructor(id) {
    super(`el asiento ${id} ya fue revertido`);
    this.name = 'JournalAlreadyReversedError';
  }
}

export class PeriodClosedError extends Error {
  constructor(period) {
    super(`el período ${period} está cerrado`);
    this.name = 'PeriodClosedError';
    this.period = period;
  }
}

/*
 * Forma de los documentos (referencia, sin tipos):
 *
 * Línea de entrada: { accountId, debit?, credit?, description? }
 * Entrada de postJournal: { docType, date, currency, lines, idempotencyKey, description?, source? }
 *   - idempotencyKey es obligatoria: repetirla devuelve el asiento original sin escribir.
 * Asiento guardado: { _id, tenantId, docType, number, date, period 'YYYY-MM' (UTC), currency,
 *   lines, totalDebit, totalCredit, idempotencyKey, reversesJournalId?, description?, source?, createdAt }
 * Período: { tenantId, period, status 'open'|'closed', seq, closedAt?, closedBy?, reopenedAt?, reopenedBy? }
 * Resultado: { journal, replayed } — replayed es true si la clave ya existía.
 *
 * Todo método que escribe acepta `{ inTx }`: se invoca con `(session, resultado)` dentro de la
 * misma transacción, y solo si se escribió algo nuevo. Así la auditoría se confirma con la operación.
 * También acepta `{ prepare }`: se invoca con `(session)` dentro de la misma transacción, antes de escribir y solo si no es
 * una repetición. En `postJournal` puede devolver `{ lines, description, source }` que reemplazan los de la entrada (las líneas
 * se calculan leyendo con la misma sesión que escribe; así lo leído y lo asentado no se separan). Sirve también para
 * preparar el terreno de forma atómica (p. ej. reabrir períodos antes de revertir).
 */

export function periodOf(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new LedgerValidationError('fecha inválida');
  }
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function assertPeriod(period) {
  if (typeof period !== 'string' || !PERIOD_PATTERN.test(period)) {
    throw new LedgerValidationError('el período debe tener el formato AAAA-MM');
  }
  return period;
}

const DOC_TYPE = /^[A-Z0-9]{1,10}$/;

/** El tipo de documento se guarda en mayúsculas y sin espacios: «fv» o « FV » no son otro tipo que escape de `MODULE_DOC_TYPES`. */
export function normalizeDocType(value) {
  const docType = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!docType) throw new LedgerValidationError('falta el tipo de documento');
  if (!DOC_TYPE.test(docType)) throw new LedgerValidationError('el tipo de documento debe tener de 1 a 10 letras o números');
  return docType;
}

const COST_CENTER = /^[A-Z0-9][A-Z0-9_-]{0,9}$/;

/** Valida y normaliza las líneas. Cada línea tiene débito o crédito, nunca ambos. */
function normalizeLines(lines) {
  if (!Array.isArray(lines) || lines.length < 2) {
    throw new LedgerValidationError('un asiento necesita al menos dos líneas');
  }
  if (lines.length > MAX_LINES_PER_JOURNAL) {
    throw new LedgerValidationError(`un asiento admite como máximo ${MAX_LINES_PER_JOURNAL} líneas`);
  }
  let totalDebit = 0;
  let totalCredit = 0;
  const normalized = lines.map((line, i) => {
    if (typeof line.accountId !== 'string' || !line.accountId.trim()) {
      throw new LedgerValidationError(`línea ${i + 1}: falta la cuenta`);
    }
    const debit = assertMinorUnits(line.debit ?? 0, `línea ${i + 1} débito`);
    const credit = assertMinorUnits(line.credit ?? 0, `línea ${i + 1} crédito`);
    if (debit < 0 || credit < 0) {
      throw new LedgerValidationError(`línea ${i + 1}: los importes no pueden ser negativos`);
    }
    if (debit > 0 === credit > 0) {
      throw new LedgerValidationError(`línea ${i + 1}: debe tener débito o crédito, no ambos ni ninguno`);
    }
    totalDebit = addMinor(totalDebit, debit);
    totalCredit = addMinor(totalCredit, credit);
    // Dimensiones opcionales: el centro de costo (su código) y el tercero.
    const costCenter = line.costCenter ? String(line.costCenter).trim().toUpperCase() : undefined;
    if (costCenter && !COST_CENTER.test(costCenter)) throw new LedgerValidationError(`línea ${i + 1}: el centro de costo ${costCenter} no es un código válido`);
    let partyId;
    if (line.partyId) {
      const hex = String(line.partyId);
      if (!/^[a-f0-9]{24}$/.test(hex)) throw new LedgerValidationError(`línea ${i + 1}: el tercero no es válido`);
      partyId = new ObjectId(hex);
    }
    return {
      accountId: line.accountId.trim(),
      debit,
      credit,
      ...(line.description ? { description: line.description } : {}),
      ...(costCenter ? { costCenter } : {}),
      ...(partyId ? { partyId } : {}),
    };
  });
  if (totalDebit !== totalCredit) throw new LedgerImbalanceError(totalDebit, totalCredit);
  return { lines: normalized, totalDebit, totalCredit };
}

/**
 * `options.concurrencyPerTenant` (por defecto 1) limita las escrituras simultáneas de una misma empresa en
 * este proceso: todas tocan los mismos documentos, y sin límite los choques en cadena bajan el rendimiento
 * al subir la concurrencia. Medido: con 1 simultánea el rendimiento es estable (≈130/s en un nodo local, con
 * cualquier número de clientes); sin límite, con 32 clientes caía a 47/s y p99 de 3,7 s. Como el consecutivo sin
 * huecos obliga a serializar de todos modos, 1 es lo correcto. Las que sobran esperan turno (hasta `queueTimeoutMs`) en una cola acotada.
 */
export function createLedger(client, db, options = {}) {
  const limiter = createKeyedLimiter({
    maxConcurrent: options.concurrencyPerTenant ?? 1,
    maxQueue: options.maxQueue ?? 500,
    queueTimeoutMs: options.queueTimeoutMs ?? 10_000,
  });
  const accounts = createAccountService(client, db);
  const journalsOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.journals), tenantId);
  const balancesOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.balances), tenantId);
  const countersOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.counters), tenantId);
  const periodsOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.periods), tenantId);

  /** Garantiza que exista el contador antes de la transacción: el upsert dentro de ella chocaría entre concurrentes. */
  async function ensureCounter(tenantId, docType) {
    try {
      await countersOf(tenantId).updateOne({ docType }, { $setOnInsert: { last: 0 } }, { upsert: true });
    } catch (err) {
      if (!isDuplicate(err, 'tenant_doctype')) throw err;
    }
  }

  /** Lo mismo para el documento del período, que hace de compuerta de cierre. */
  async function ensurePeriod(tenantId, period) {
    try {
      await periodsOf(tenantId).updateOne(
        { period },
        { $setOnInsert: { status: 'open', seq: 0, createdAt: new Date() } },
        { upsert: true },
      );
    } catch (err) {
      if (!isDuplicate(err, 'tenant_period')) throw err;
    }
  }

  /**
   * Escribe asiento, consecutivo y saldos. Debe llamarse dentro de una transacción.
   * La compuerta del período se incrementa con la condición `status: 'open'`: cerrar un período
   * modifica ese mismo documento, así que un cierre y un asiento simultáneos chocan y se
   * serializan en vez de cruzarse. Contrapartida: los asientos de una empresa en el mismo período
   * comparten ese documento y se serializan entre sí (igual que ya lo hace el consecutivo por tipo).
   */
  async function commit(tenantId, draft, session) {
    const gate = await periodsOf(tenantId).findOneAndUpdate(
      { period: draft.period, status: 'open' },
      { $inc: { seq: 1 } },
      { returnDocument: 'after', session },
    );
    if (!gate) throw new PeriodClosedError(draft.period);

    const counter = await countersOf(tenantId).findOneAndUpdate(
      { docType: draft.docType },
      { $inc: { last: 1 } },
      { returnDocument: 'after', session },
    );
    if (!counter) throw new Error('contador inexistente: falta ensureCounter');

    const journal = { ...draft, _id: new ObjectId(), number: counter.last, createdAt: new Date() };
    await journalsOf(tenantId).insertOne(journal, session);

    // Saldos: una operación atómica por cuenta, dentro de la misma transacción.
    const byAccount = new Map();
    for (const line of draft.lines) {
      const acc = byAccount.get(line.accountId) ?? { debit: 0, credit: 0 };
      acc.debit = addMinor(acc.debit, line.debit);
      acc.credit = addMinor(acc.credit, line.credit);
      byAccount.set(line.accountId, acc);
    }
    const balances = balancesOf(tenantId);
    for (const [accountId, amounts] of byAccount) {
      await balances.updateOne(
        { accountId, period: draft.period, currency: draft.currency },
        { $inc: { debit: amounts.debit, credit: amounts.credit } },
        { upsert: true, session },
      );
    }
    // Saldos por dimensión (centro de costo y tercero), en la misma transacción: el mismo recorrido, solo de las líneas que las traen.
    const dims = new Map();
    for (const line of draft.lines) {
      for (const [dimension, key] of [['costCenter', line.costCenter], ['party', line.partyId ? String(line.partyId) : undefined]]) {
        if (!key) continue;
        const id = `${dimension}|${key}|${line.accountId}`;
        const acc = dims.get(id) ?? { dimension, key, accountId: line.accountId, debit: 0, credit: 0 };
        acc.debit = addMinor(acc.debit, line.debit);
        acc.credit = addMinor(acc.credit, line.credit);
        dims.set(id, acc);
      }
    }
    const dimBalances = new TenantCollection(db.collection(COLLECTIONS.dimBalances), tenantId);
    for (const { dimension, key, accountId, debit, credit } of dims.values()) {
      await dimBalances.updateOne({ dimension, key, accountId, period: draft.period, currency: draft.currency }, { $inc: { debit, credit } }, { upsert: true, session });
    }
    return { ...journal, tenantId };
  }

  /** Los centros de costo de las líneas existen y están activos, y los terceros son de la empresa. */
  async function checkDimensions(tenantId, lines) {
    const codes = [...new Set(lines.map((l) => l.costCenter).filter(Boolean))];
    if (codes.length) {
      const found = await db.collection(COLLECTIONS.costCenters).find({ tenantId, code: { $in: codes }, active: true }, { projection: { code: 1 } }).toArray();
      const ok = new Set(found.map((c) => c.code));
      const missing = codes.filter((c) => !ok.has(c));
      if (missing.length) throw new LedgerValidationError(`el centro de costo ${missing.join(', ')} no existe o está inactivo`);
    }
    const parties = [...new Map(lines.filter((l) => l.partyId).map((l) => [String(l.partyId), l.partyId])).values()];
    if (parties.length) {
      const found = await db.collection(COLLECTIONS.parties).countDocuments({ tenantId, _id: { $in: parties } });
      if (found !== parties.length) throw new LedgerValidationError('un tercero de las líneas no existe en esta empresa');
    }
  }

  /** Repetir una clave devuelve el asiento original, salvo que traiga otro contenido (si ambos tienen huella). */
  function replay(existing, payloadHash) {
    if (payloadHash && existing.payloadHash && existing.payloadHash !== payloadHash) throw new IdempotencyConflictError();
    return { journal: existing, replayed: true };
  }

  const api = {
    async postJournal(tenantId, input, { inTx, prepare } = {}) {
      if (!input.idempotencyKey?.trim()) throw new LedgerValidationError('falta la clave de idempotencia');
      const docType = normalizeDocType(input.docType);
      const currency = assertCurrency(input.currency);
      const period = periodOf(input.date);
      // Con `prepare` las líneas pueden venir de la propia transacción; se validan allí.
      const early = prepare && !input.lines ? null : normalizeLines(input.lines);
      if (early) await checkDimensions(tenantId, early.lines);

      await ensureCounter(tenantId, docType);
      await ensurePeriod(tenantId, period);
      const find = () => journalsOf(tenantId).findOne({ idempotencyKey: input.idempotencyKey });

      try {
        return await withTransaction(client, async (session) => {
          const existing = await journalsOf(tenantId).findOne({ idempotencyKey: input.idempotencyKey }, { session });
          if (existing) return replay(existing, input.payloadHash);
          let { lines, totalDebit, totalCredit } = early ?? {};
          let description = input.description;
          let source = input.source;
          if (prepare) {
            const built = await prepare(session);
            if (built?.lines) {
              ({ lines, totalDebit, totalCredit } = normalizeLines(built.lines));
              await checkDimensions(tenantId, lines);
              if (built.description !== undefined) description = built.description;
              if (built.source !== undefined) source = built.source;
            }
          }
          if (!lines) throw new LedgerValidationError('un asiento necesita al menos dos líneas');
          const problems = await accounts.postingProblems(
            tenantId,
            lines.map((l) => l.accountId),
            session,
          );
          if (problems.length) throw new LedgerValidationError(problems.join('; '));
          const journal = await commit(
            tenantId,
            {
              docType,
              date: input.date,
              period,
              currency,
              lines,
              totalDebit,
              totalCredit,
              idempotencyKey: input.idempotencyKey,
              ...(description ? { description } : {}),
              ...(source ? { source } : {}),
              ...(input.payloadHash ? { payloadHash: input.payloadHash } : {}),
            },
            session,
          );
          const result = { journal, replayed: false };
          if (inTx) await inTx(session, result);
          return result;
        });
      } catch (err) {
        // Dos peticiones con la misma clave a la vez: la que pierde relee y repite el resultado.
        if (isDuplicate(err, 'tenant_idempotency')) {
          const existing = await find();
          if (existing) return replay(existing, input.payloadHash);
        }
        throw err;
      }
    },

    async reverseJournal(tenantId, journalId, input, { inTx, prepare } = {}) {
      if (!input.idempotencyKey?.trim()) throw new LedgerValidationError('falta la clave de idempotencia');
      const original = await journalsOf(tenantId).findOne({ _id: journalId });
      if (!original) throw new JournalNotFoundError(journalId.toHexString());
      if (original.reversesJournalId) throw new LedgerValidationError('no se revierte un asiento de reversión');

      const date = input.date ?? calendarToday();
      const period = periodOf(date);
      await ensureCounter(tenantId, original.docType);
      await ensurePeriod(tenantId, period);
      // La reversión no revalida las cuentas: el asiento original ya las pasó, y una cuenta
      // desactivada después no puede impedir corregir un error. Sí respeta el cierre del período.
      try {
        return await withTransaction(client, async (session) => {
          const existing = await journalsOf(tenantId).findOne({ idempotencyKey: input.idempotencyKey }, { session });
          if (existing) return { journal: existing, replayed: true };
          if (prepare) await prepare(session);
          const journal = await commit(
            tenantId,
            {
              docType: original.docType,
              date,
              period,
              currency: original.currency,
              lines: original.lines.map((l) => ({
                accountId: l.accountId,
                debit: l.credit,
                credit: l.debit,
                ...(l.description ? { description: l.description } : {}),
                ...(l.costCenter ? { costCenter: l.costCenter } : {}),
                ...(l.partyId ? { partyId: l.partyId } : {}),
              })),
              totalDebit: original.totalCredit,
              totalCredit: original.totalDebit,
              idempotencyKey: input.idempotencyKey,
              reversesJournalId: original._id,
              ...(input.description ? { description: input.description } : {}),
            },
            session,
          );
          const result = { journal, replayed: false };
          if (inTx) await inTx(session, result);
          return result;
        });
      } catch (err) {
        if (isDuplicate(err, 'tenant_reverses_once')) throw new JournalAlreadyReversedError(journalId.toHexString());
        if (isDuplicate(err, 'tenant_idempotency')) {
          const existing = await journalsOf(tenantId).findOne({ idempotencyKey: input.idempotencyKey });
          if (existing) return { journal: existing, replayed: true };
        }
        throw err;
      }
    },

    getJournal(tenantId, journalId) {
      return journalsOf(tenantId).findOne({ _id: journalId });
    },

    /**
     * Lista asientos, el más reciente primero, con paginación por cursor (`_id` del último).
     * Cada elemento trae `reversedByJournalId` si fue revertido.
     */
    async listJournals(tenantId, { period, docType, accountId, limit = 25, cursor } = {}) {
      const size = Math.min(Math.max(Number(limit) || 25, 1), MAX_JOURNAL_PAGE);
      const filter = {};
      if (period) filter.period = assertPeriod(period);
      if (docType) filter.docType = String(docType).trim().toUpperCase();
      if (accountId) filter['lines.accountId'] = String(accountId);
      if (cursor) filter._id = { $lt: new ObjectId(cursor) };

      const rows = await journalsOf(tenantId).find(filter, { sort: { _id: -1 }, limit: size + 1 }).toArray();
      const hasMore = rows.length > size;
      const items = hasMore ? rows.slice(0, size) : rows;

      const reversals = items.length
        ? await journalsOf(tenantId)
            .find({ reversesJournalId: { $in: items.map((j) => j._id) } }, { projection: { reversesJournalId: 1 } })
            .toArray()
        : [];
      const reversedBy = new Map(reversals.map((r) => [r.reversesJournalId.toHexString(), r._id]));
      return {
        items: items.map((j) => ({ ...j, ...(reversedBy.has(j._id.toHexString()) ? { reversedByJournalId: reversedBy.get(j._id.toHexString()) } : {}) })),
        nextCursor: hasMore ? items[items.length - 1]._id.toHexString() : null,
      };
    },

    async getBalance(tenantId, accountId, period, currency) {
      const doc = await balancesOf(tenantId).findOne({ accountId, period, currency });
      return { debit: doc?.debit ?? 0, credit: doc?.credit ?? 0 };
    },

    // ---- Cierre de períodos ----

    /** Un período cerrado rechaza asientos y reversiones fechados en él, hasta que se reabra. */
    async closePeriod(tenantId, period, userId, { inTx } = {}) {
      assertPeriod(period);
      await ensurePeriod(tenantId, period);
      return withTransaction(client, async (session) => {
        const result = await periodsOf(tenantId).updateOne(
          { period, status: 'open' },
          { $set: { status: 'closed', closedAt: new Date(), closedBy: userId } },
          { session },
        );
        if (result.matchedCount === 0) {
          throw Object.assign(new LedgerValidationError(`el período ${period} ya está cerrado`), { code: 'ALREADY_CLOSED' });
        }
        if (inTx) await inTx(session, { period });
        return { period, status: 'closed' };
      });
    },

    async reopenPeriod(tenantId, period, userId, { inTx } = {}) {
      assertPeriod(period);
      return withTransaction(client, async (session) => {
        const result = await periodsOf(tenantId).updateOne(
          { period, status: 'closed' },
          { $set: { status: 'open', reopenedAt: new Date(), reopenedBy: userId } },
          { session },
        );
        if (result.matchedCount === 0) {
          throw Object.assign(new LedgerValidationError(`el período ${period} no está cerrado`), { code: 'NOT_CLOSED' });
        }
        if (inTx) await inTx(session, { period });
        return { period, status: 'open' };
      });
    },

    async listPeriods(tenantId) {
      return periodsOf(tenantId).find({}, { sort: { period: -1 } }).toArray();
    },
  };

  // Las operaciones que escriben en los documentos calientes de la empresa pasan por el limitador.
  const limited = new Set(['postJournal', 'reverseJournal', 'closePeriod', 'reopenPeriod']);
  return Object.fromEntries(
    Object.entries(api).map(([name, fn]) => [name, limited.has(name) ? (tenantId, ...args) => limiter.run(tenantId, () => fn(tenantId, ...args)) : fn]),
  );
}
