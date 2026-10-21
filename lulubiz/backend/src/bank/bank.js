import { createHash } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { DAY_MS, dayOf, parseDay as parseCalendarDay, startOfDay } from '../core/dates.js';
import { assertCurrency } from '../core/money.js';
import { COLLECTIONS } from '../data/db.js';
import { TenantCollection } from '../data/tenantCollection.js';
import { isDuplicate, withTransaction } from '../data/tx.js';

export const MAX_IMPORT_LINES = 500;
export const MAX_LISTED = 1000;
export const MAX_AUTO_CANDIDATES = 5000;
export const DEFAULT_WINDOW_DAYS = 10;

export class BankError extends Error {
  constructor(message, code = 'VALIDATION') {
    super(message);
    this.name = 'BankError';
    this.code = code;
  }
}

const fail = (message, code) => {
  throw new BankError(message, code);
};
const parseDay = (value, label) => parseCalendarDay(value, label, fail);
const ACCOUNT = /^[0-9]{1,12}$/;
const OBJECT_ID = /^[a-f0-9]{24}$/;
const objectId = (value, label) => (OBJECT_ID.test(String(value ?? '')) ? new ObjectId(String(value)) : fail(`${label} inválido`));
const endOf = (date) => new Date(startOfDay(date).getTime() + DAY_MS);
const safeInt = (value) => Number.isSafeInteger(value);
/** El día más reciente de dos fechas, como `AAAA-MM-DD`. */
const later = (a, b) => (dayOf(a) > dayOf(b) ? dayOf(a) : dayOf(b));

/*
 * Conciliación bancaria: compara el extracto del banco con lo que dice el libro de una cuenta de bancos.
 *
 *  - El extracto se carga como líneas (`bankLines`): fecha, detalle y un importe con signo (positivo entra dinero, o sea
 *    débito en el libro; negativo sale). Cargar de nuevo el mismo extracto no duplica: cada línea tiene una huella.
 *  - Una **conciliación** (`bankMatches`) une una línea del extracto con una línea de asiento de la misma cuenta y el mismo
 *    importe. No toca el asiento (el libro no se edita): vive aparte, y se puede deshacer. Una línea de asiento solo
 *    se concilia una vez, y una línea del extracto también; lo garantizan índices únicos, no una lectura previa.
 *  - Una línea del extracto que el libro no tiene (comisión, intereses, impuesto) se **contabiliza** desde ahí: crea el
 *    asiento `CB` contra la cuenta que se elija y lo concilia en la misma transacción.
 *  - Una línea de asiento anterior al extracto se **marca como conciliada** sin línea de extracto, con una razón: es el
 *    saldo con el que se empieza.
 *  - El resumen a una fecha: saldo del libro, saldo del extracto (lo escribe quien concilia), partidas del libro que el
 *    banco aún no tiene (cheques y consignaciones en tránsito) y partidas del banco que el libro aún no tiene. La
 *    diferencia entre «extracto + partidas del libro sin conciliar» y «libro + partidas del banco sin conciliar» debe
 *    ser cero. Una conciliación cuenta a una fecha solo si las dos fechas, la del banco y la del libro, son de esa fecha o
 *    anteriores: así un cheque que el banco pagó después queda «en tránsito» en el cierre anterior.
 *  - **Cerrar** una conciliación exige diferencia cero y deja una fotografía. Lo cerrado no se altera: no se importan,
 *    quitan ni conciliar líneas de esa fecha o anteriores. Solo se reabre la última.
 */
export function createBankService({ client, db, ledger, accounts, now = () => new Date() }) {
  const linesOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.bankLines), tenantId);
  const matchesOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.bankMatches), tenantId);
  const reconciliationsOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.bankReconciliations), tenantId);
  const journalsOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.journals), tenantId);
  const tenants = db.collection(COLLECTIONS.tenants);

  async function tenantCurrency(tenantId) {
    const tenant = await tenants.findOne({ _id: tenantId }, { projection: { currency: 1 } });
    if (!tenant) fail('la empresa no existe', 'NOT_FOUND');
    return tenant.currency;
  }

  async function bankAccount(tenantId, code) {
    const text = String(code ?? '').trim();
    if (!ACCOUNT.test(text)) fail('indica la cuenta de bancos');
    const account = await accounts.get(tenantId, text);
    if (!account) fail(`la cuenta ${text} no existe`, 'NOT_FOUND');
    if (account.type !== 'asset') fail('la conciliación es de una cuenta de activo: bancos o caja');
    if (!account.postable) fail('la cuenta es de agrupación: elige la cuenta que recibe asientos');
    return account;
  }

  async function lastClosed(tenantId, accountId, currency) {
    return reconciliationsOf(tenantId).findOne({ accountId, currency, status: 'closed' }, { sort: { asOf: -1 } });
  }

  /** Falla si `date` cae en un tramo ya conciliado y cerrado. */
  async function assertOpenDate(tenantId, accountId, currency, date, what) {
    const closed = await lastClosed(tenantId, accountId, currency);
    if (closed && dayOf(date) <= dayOf(closed.asOf)) fail(`${what}: la conciliación está cerrada hasta el ${dayOf(closed.asOf)}`, 'RECONCILED');
  }

  const presentLine = (line, match) => ({
    _id: line._id,
    accountId: line.accountId,
    currency: line.currency,
    date: line.date,
    description: line.description,
    ...(line.reference ? { reference: line.reference } : {}),
    amount: line.amount,
    status: match ? 'matched' : 'open',
    ...(match ? { match: { _id: match._id, journalId: match.journalId, lineIndex: match.lineIndex, document: match.document ?? null, manual: Boolean(match.manual) } } : {}),
  });

  /** Líneas del extracto con su conciliación vigente, si la tienen. `asOfEnd` aplica la regla de «cuenta a una fecha». */
  function bankLinePipeline({ accountId, currency, from, to, asOfEnd }) {
    const date = { $lt: to };
    if (from) date.$gte = from;
    return [
      { $match: { accountId, currency, status: 'active', date } },
      {
        $lookup: {
          from: COLLECTIONS.bankMatches,
          let: { id: '$_id', tenant: '$tenantId' },
          pipeline: [{ $match: { $expr: { $and: [{ $eq: ['$tenantId', '$$tenant'] }, { $eq: ['$bankLineId', '$$id'] }, { $eq: ['$active', true] }] } } }],
          as: 'm',
        },
      },
      ...(asOfEnd ? [{ $match: { $expr: { $or: [{ $eq: [{ $size: '$m' }, 0] }, { $gte: [{ $arrayElemAt: ['$m.bookDate', 0] }, asOfEnd] }] } } }] : []),
    ];
  }

  /** Líneas de asiento de la cuenta que aún no están conciliadas (o que lo están con algo posterior a `asOfEnd`). */
  function bookLinePipeline({ accountId, currency, from, to, asOfEnd }) {
    const date = { $lt: to };
    if (from) date.$gte = from;
    return [
      { $match: { currency, date, 'lines.accountId': accountId } },
      { $project: { tenantId: 1, docType: 1, number: 1, date: 1, description: 1, lines: 1 } },
      { $unwind: { path: '$lines', includeArrayIndex: 'lineIndex' } },
      { $match: { 'lines.accountId': accountId } },
      {
        $lookup: {
          from: COLLECTIONS.bankMatches,
          let: { j: '$_id', i: '$lineIndex', tenant: '$tenantId' },
          pipeline: [{ $match: { $expr: { $and: [{ $eq: ['$tenantId', '$$tenant'] }, { $eq: ['$journalId', '$$j'] }, { $eq: ['$lineIndex', '$$i'] }, { $eq: ['$active', true] }] } } }],
          as: 'm',
        },
      },
      { $match: { $expr: { $or: [{ $eq: [{ $size: '$m' }, 0] }, ...(asOfEnd ? [{ $gte: [{ $arrayElemAt: ['$m.bankDate', 0] }, asOfEnd] }] : [])] } } },
      {
        $project: {
          journalId: '$_id',
          lineIndex: 1,
          date: 1,
          document: { $concat: ['$docType', { $toString: '$number' }] },
          description: { $ifNull: ['$lines.description', '$description'] },
          amount: { $subtract: [{ $ifNull: ['$lines.debit', 0] }, { $ifNull: ['$lines.credit', 0] }] },
        },
      },
    ];
  }

  const presentBook = (r) => ({ journalId: r.journalId, lineIndex: r.lineIndex, date: r.date, document: r.document, description: r.description ?? '', amount: r.amount });

  async function unmatchedBook(tenantId, params, limit) {
    const pipeline = bookLinePipeline(params);
    const [facet] = await journalsOf(tenantId)
      .aggregate([...pipeline, { $facet: { items: [{ $sort: { date: 1, journalId: 1, lineIndex: 1 } }, { $limit: limit + 1 }], total: [{ $group: { _id: null, net: { $sum: '$amount' }, count: { $sum: 1 } } }] } }])
      .toArray();
    const items = facet.items;
    return { items: items.slice(0, limit).map(presentBook), truncated: items.length > limit, net: facet.total[0]?.net ?? 0, count: facet.total[0]?.count ?? 0 };
  }

  async function unmatchedBank(tenantId, params, limit) {
    const pipeline = bankLinePipeline({ ...params, asOfEnd: params.asOfEnd ?? new Date(8.64e15) });
    const [facet] = await linesOf(tenantId)
      .aggregate([...pipeline, { $facet: { items: [{ $sort: { date: 1, _id: 1 } }, { $limit: limit + 1 }], total: [{ $group: { _id: null, net: { $sum: '$amount' }, count: { $sum: 1 } } }] } }])
      .toArray();
    const items = facet.items;
    return { items: items.slice(0, limit).map((l) => presentLine(l, null)), truncated: items.length > limit, net: facet.total[0]?.net ?? 0, count: facet.total[0]?.count ?? 0 };
  }

  async function bookBalance(tenantId, { accountId, currency, to }) {
    const [row] = await journalsOf(tenantId)
      .aggregate([
        { $match: { currency, date: { $lt: to }, 'lines.accountId': accountId } },
        { $unwind: '$lines' },
        { $match: { 'lines.accountId': accountId } },
        { $group: { _id: null, debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' } } },
      ])
      .toArray();
    return row ? Number(row.debit) - Number(row.credit) : 0;
  }

  async function summary(tenantId, { accountId, currency, asOf, statementBalance }) {
    const asOfEnd = endOf(asOf);
    const [book, bank, balance, closed] = await Promise.all([
      unmatchedBook(tenantId, { accountId, currency, to: asOfEnd, asOfEnd }, MAX_LISTED),
      unmatchedBank(tenantId, { accountId, currency, to: asOfEnd, asOfEnd }, MAX_LISTED),
      bookBalance(tenantId, { accountId, currency, to: asOfEnd }),
      lastClosed(tenantId, accountId, currency),
    ]);
    const adjustedBank = statementBalance + book.net;
    const adjustedBook = balance + bank.net;
    return {
      accountId,
      currency,
      asOf: dayOf(asOf),
      statementBalance,
      bookBalance: balance,
      unmatchedBook: { items: book.items, count: book.count, net: book.net, truncated: book.truncated },
      unmatchedBank: { items: bank.items, count: bank.count, net: bank.net, truncated: bank.truncated },
      adjustedBank,
      adjustedBook,
      difference: adjustedBank - adjustedBook,
      lastClosedAsOf: closed ? dayOf(closed.asOf) : null,
    };
  }

  const present = (r) => ({ _id: r._id, accountId: r.accountId, currency: r.currency, asOf: dayOf(r.asOf), statementBalance: r.statementBalance, bookBalance: r.bookBalance, unmatchedBookNet: r.unmatchedBookNet, unmatchedBankNet: r.unmatchedBankNet, unmatchedBookCount: r.unmatchedBookCount, unmatchedBankCount: r.unmatchedBankCount, status: r.status, closedAt: r.closedAt });

  async function insertMatch(tenantId, session, doc, ctx, action, details) {
    try {
      const { insertedId } = await matchesOf(tenantId).insertOne({ ...doc, active: true, createdBy: ctx.userId ?? null, createdAt: now() }, session);
      await ctx.auditTx?.(session, { action, target: insertedId, details });
      return insertedId;
    } catch (err) {
      if (isDuplicate(err, 'tenant_bankmatch_book')) fail('esa línea del libro ya está conciliada', 'ALREADY_MATCHED');
      if (isDuplicate(err, 'tenant_bankmatch_line')) fail('esa línea del extracto ya está conciliada', 'ALREADY_MATCHED');
      throw err;
    }
  }

  /** La línea de asiento `lineIndex` del asiento, con su importe neto; falla si no es de la cuenta o la moneda. */
  async function bookLine(tenantId, accountId, currency, journalId, lineIndex) {
    const journal = await journalsOf(tenantId).findOne({ _id: journalId });
    if (!journal) fail('el asiento no existe', 'NOT_FOUND');
    const line = journal.lines[lineIndex];
    if (!line) fail('la línea del asiento no existe', 'NOT_FOUND');
    if (line.accountId !== accountId) fail('la línea del asiento es de otra cuenta');
    if (journal.currency !== currency) fail('el asiento es de otra moneda');
    return { journal, line, amount: (line.debit ?? 0) - (line.credit ?? 0), document: `${journal.docType}${journal.number}` };
  }

  const api = {
    /**
     * Carga líneas de extracto. Una línea idéntica a una ya cargada (misma fecha, importe, detalle y referencia, y el mismo
     * orden entre iguales dentro del archivo) se salta, así que volver a cargar un extracto es seguro. No es atómica.
     */
    async importLines(tenantId, input, ctx = {}) {
      const account = await bankAccount(tenantId, input.account);
      const currency = assertCurrency(input.currency ?? (await tenantCurrency(tenantId)));
      const raw = input.lines;
      if (!Array.isArray(raw) || raw.length === 0) fail('el extracto no tiene líneas');
      if (raw.length > MAX_IMPORT_LINES) fail(`se cargan como máximo ${MAX_IMPORT_LINES} líneas por vez`);
      const closed = await lastClosed(tenantId, account.code, currency);
      const seen = new Map();
      const prepared = raw.map((l, i) => {
        const date = parseDay(l?.date, `línea ${i + 1}: la fecha`);
        if (date.getTime() > now().getTime() + DAY_MS) fail(`línea ${i + 1}: la fecha no puede ser futura`);
        if (closed && dayOf(date) <= dayOf(closed.asOf)) fail(`línea ${i + 1}: la conciliación está cerrada hasta el ${dayOf(closed.asOf)}`, 'RECONCILED');
        if (!safeInt(l.amount) || l.amount === 0) fail(`línea ${i + 1}: el importe debe ser un entero distinto de cero`);
        const description = String(l.description ?? '').trim().slice(0, 200);
        if (!description) fail(`línea ${i + 1}: falta el detalle`);
        const reference = String(l.reference ?? '').trim().slice(0, 60);
        const base = `${dayOf(date)}|${l.amount}|${description.toLowerCase()}|${reference.toLowerCase()}`;
        const n = (seen.get(base) ?? 0) + 1;
        seen.set(base, n);
        const dedupeKey = createHash('sha256').update(`${account.code}|${currency}|${base}|${n}`).digest('hex');
        return { dedupeKey, date, description, ...(reference ? { reference } : {}), amount: l.amount };
      });
      let created = 0;
      let skipped = 0;
      for (const line of prepared) {
        try {
          await linesOf(tenantId).insertOne({ ...line, accountId: account.code, currency, status: 'active', createdBy: ctx.userId ?? null, createdAt: now() });
          created += 1;
        } catch (err) {
          if (!isDuplicate(err, 'tenant_bankline_dedupe')) throw err;
          skipped += 1;
        }
      }
      await ctx.auditTx?.(undefined, { action: 'bank.import', details: { account: account.code, currency, created, skipped } });
      return { created, skipped };
    },

    async listLines(tenantId, { account, currency, from, to, status = 'all' }) {
      const accountId = (await bankAccount(tenantId, account)).code;
      const cur = assertCurrency(currency ?? (await tenantCurrency(tenantId)));
      const start = parseDay(from, 'la fecha inicial');
      const end = endOf(parseDay(to, 'la fecha final'));
      if (start >= end) fail('la fecha inicial no puede ser posterior a la final');
      const rows = await linesOf(tenantId)
        .aggregate([
          ...bankLinePipeline({ accountId, currency: cur, from: startOfDay(start), to: end }),
          ...(status === 'open' ? [{ $match: { $expr: { $eq: [{ $size: '$m' }, 0] } } }] : status === 'matched' ? [{ $match: { $expr: { $gt: [{ $size: '$m' }, 0] } } }] : []),
          { $sort: { date: 1, _id: 1 } },
          { $limit: MAX_LISTED + 1 },
        ])
        .toArray();
      if (rows.length > MAX_LISTED) throw Object.assign(new BankError(`el rango tiene más de ${MAX_LISTED} líneas: elige uno más corto`, 'RANGE_TOO_LARGE'));
      const closed = await lastClosed(tenantId, accountId, cur);
      return { items: rows.map((r) => presentLine(r, r.m[0])), lastClosedAsOf: closed ? dayOf(closed.asOf) : null };
    },

    /** Quita una línea del extracto que no está conciliada (por ejemplo, cargada en la cuenta equivocada). */
    async removeLine(tenantId, id, ctx = {}) {
      const line = await linesOf(tenantId).findOne({ _id: objectId(id, 'la línea'), status: 'active' });
      if (!line) fail('la línea del extracto no existe', 'NOT_FOUND');
      await assertOpenDate(tenantId, line.accountId, line.currency, line.date, 'no se quita la línea');
      return withTransaction(client, async (session) => {
        if (await matchesOf(tenantId).findOne({ bankLineId: line._id, active: true }, { session })) fail('la línea está conciliada: deshaz primero la conciliación', 'ALREADY_MATCHED');
        const res = await linesOf(tenantId).updateOne({ _id: line._id, status: 'active' }, { $set: { status: 'removed', removedAt: now(), removedBy: ctx.userId ?? null } }, { session });
        if (res.modifiedCount !== 1) fail('la línea del extracto ya no existe', 'NOT_FOUND');
        await ctx.auditTx?.(session, { action: 'bank.line_remove', target: line._id, details: { date: dayOf(line.date), amount: line.amount } });
        return { removed: true };
      });
    },

    /** Líneas del libro sin conciliar, del mismo importe y a pocos días de la línea del extracto. */
    async candidates(tenantId, id, { days = DEFAULT_WINDOW_DAYS } = {}) {
      const line = await linesOf(tenantId).findOne({ _id: objectId(id, 'la línea'), status: 'active' });
      if (!line) fail('la línea del extracto no existe', 'NOT_FOUND');
      if (!Number.isInteger(days) || days < 0 || days > 60) fail('la ventana de días va de 0 a 60');
      const from = startOfDay(new Date(line.date.getTime() - days * DAY_MS));
      const to = endOf(new Date(line.date.getTime() + days * DAY_MS));
      const book = await unmatchedBook(tenantId, { accountId: line.accountId, currency: line.currency, from, to }, MAX_AUTO_CANDIDATES);
      const exact = book.items.filter((b) => b.amount === line.amount).sort((a, b) => Math.abs(a.date - line.date) - Math.abs(b.date - line.date));
      return { line: presentLine(line, null), items: exact.slice(0, 20) };
    },

    /** Une una línea del extracto con una línea de asiento de la misma cuenta y el mismo importe. */
    async match(tenantId, input, ctx = {}) {
      const line = await linesOf(tenantId).findOne({ _id: objectId(input.bankLineId, 'la línea del extracto'), status: 'active' });
      if (!line) fail('la línea del extracto no existe', 'NOT_FOUND');
      const book = await bookLine(tenantId, line.accountId, line.currency, objectId(input.journalId, 'el asiento'), input.lineIndex);
      if (book.amount !== line.amount) fail(`los importes no coinciden: el extracto dice ${line.amount} y el libro ${book.amount}`);
      const closed = await lastClosed(tenantId, line.accountId, line.currency);
      if (closed && later(line.date, book.journal.date) <= dayOf(closed.asOf)) fail(`no se concilia: la conciliación está cerrada hasta el ${dayOf(closed.asOf)}`, 'RECONCILED');
      return withTransaction(client, async (session) => {
        const doc = { accountId: line.accountId, currency: line.currency, bankLineId: line._id, journalId: book.journal._id, lineIndex: input.lineIndex, document: book.document, amount: line.amount, bankDate: line.date, bookDate: book.journal.date };
        const insertedId = await insertMatch(tenantId, session, doc, ctx, 'bank.match', { document: book.document, amount: line.amount });
        return { match: { ...doc, _id: insertedId, tenantId, active: true } };
      });
    },

    /** Marca una línea del libro como conciliada sin línea de extracto: el saldo con el que se empieza. Exige una razón. */
    async matchManual(tenantId, input, ctx = {}) {
      const accountId = (await bankAccount(tenantId, input.account)).code;
      const currency = assertCurrency(input.currency ?? (await tenantCurrency(tenantId)));
      const reason = String(input.reason ?? '').trim().slice(0, 200);
      if (!reason) fail('escribe la razón: por qué esta línea no tiene línea de extracto');
      const book = await bookLine(tenantId, accountId, currency, objectId(input.journalId, 'el asiento'), input.lineIndex);
      await assertOpenDate(tenantId, accountId, currency, book.journal.date, 'no se concilia');
      return withTransaction(client, async (session) => {
        const doc = { accountId, currency, journalId: book.journal._id, lineIndex: input.lineIndex, document: book.document, amount: book.amount, bankDate: book.journal.date, bookDate: book.journal.date, manual: true, reason };
        const insertedId = await insertMatch(tenantId, session, doc, ctx, 'bank.match_manual', { document: book.document, amount: book.amount, reason });
        return { match: { ...doc, _id: insertedId, tenantId, active: true } };
      });
    },

    async unmatch(tenantId, id, ctx = {}) {
      const match = await matchesOf(tenantId).findOne({ _id: objectId(id, 'la conciliación'), active: true });
      if (!match) fail('la conciliación no existe o ya se deshizo', 'NOT_FOUND');
      const closed = await lastClosed(tenantId, match.accountId, match.currency);
      if (closed && later(match.bankDate, match.bookDate) <= dayOf(closed.asOf)) fail(`no se deshace: la conciliación está cerrada hasta el ${dayOf(closed.asOf)}`, 'RECONCILED');
      return withTransaction(client, async (session) => {
        const res = await matchesOf(tenantId).updateOne({ _id: match._id, active: true }, { $set: { active: false, undoneAt: now(), undoneBy: ctx.userId ?? null } }, { session });
        if (res.modifiedCount !== 1) fail('la conciliación ya se deshizo', 'NOT_FOUND');
        await ctx.auditTx?.(session, { action: 'bank.unmatch', target: match._id, details: { document: match.document, amount: match.amount } });
        return { undone: true };
      });
    },

    /**
     * Concilia solas las líneas del extracto que tienen una sola candidata (mismo importe, a pocos días) y cuya candidata
     * no lo es de ninguna otra línea. Lo ambiguo se deja para quien concilia.
     */
    async autoMatch(tenantId, input, ctx = {}) {
      const accountId = (await bankAccount(tenantId, input.account)).code;
      const currency = assertCurrency(input.currency ?? (await tenantCurrency(tenantId)));
      const days = input.days ?? DEFAULT_WINDOW_DAYS;
      if (!Number.isInteger(days) || days < 0 || days > 60) fail('la ventana de días va de 0 a 60');
      const open = await unmatchedBank(tenantId, { accountId, currency, to: new Date(8.64e15) }, MAX_AUTO_CANDIDATES);
      if (open.truncated) fail('hay demasiadas líneas sin conciliar para hacerlo de una vez: concilia primero las más antiguas', 'RANGE_TOO_LARGE');
      if (open.items.length === 0) return { matched: 0, ambiguous: 0, unmatched: 0 };
      const dates = open.items.map((l) => l.date.getTime());
      const book = await unmatchedBook(tenantId, { accountId, currency, from: startOfDay(new Date(Math.min(...dates) - days * DAY_MS)), to: endOf(new Date(Math.max(...dates) + days * DAY_MS)) }, MAX_AUTO_CANDIDATES);
      if (book.truncated) fail('hay demasiadas líneas del libro sin conciliar para hacerlo de una vez', 'RANGE_TOO_LARGE');
      const closed = await lastClosed(tenantId, accountId, currency);
      const closedDay = closed ? dayOf(closed.asOf) : null;
      const near = (a, b) => Math.abs(a.getTime() - b.getTime()) <= days * DAY_MS;
      const candidatesOf = new Map(open.items.map((l) => [String(l._id), book.items.filter((b) => b.amount === l.amount && near(b.date, l.date))]));
      const claimed = new Map();
      for (const list of candidatesOf.values()) for (const b of list) claimed.set(`${b.journalId}:${b.lineIndex}`, (claimed.get(`${b.journalId}:${b.lineIndex}`) ?? 0) + 1);
      let matched = 0;
      let ambiguous = 0;
      for (const l of open.items) {
        const list = candidatesOf.get(String(l._id));
        if (list.length === 0) continue;
        const only = list[0];
        if (list.length > 1 || claimed.get(`${only.journalId}:${only.lineIndex}`) > 1) {
          ambiguous += 1;
          continue;
        }
        if (closedDay && later(l.date, only.date) <= closedDay) continue;
        try {
          await withTransaction(client, async (session) => {
            await insertMatch(tenantId, session, { accountId, currency, bankLineId: l._id, journalId: only.journalId, lineIndex: only.lineIndex, document: only.document, amount: l.amount, bankDate: l.date, bookDate: only.date, auto: true }, ctx, 'bank.match', { document: only.document, amount: l.amount, auto: true });
          });
          matched += 1;
        } catch (err) {
          if (err.code !== 'ALREADY_MATCHED') throw err;
        }
      }
      return { matched, ambiguous, unmatched: open.items.length - matched - ambiguous };
    },

    /** Contabiliza una línea del extracto que el libro no tiene (comisión, intereses): crea el asiento `CB` y lo concilia. */
    async bookLine(tenantId, id, input, ctx = {}) {
      const line = await linesOf(tenantId).findOne({ _id: objectId(id, 'la línea'), status: 'active' });
      if (!line) fail('la línea del extracto no existe', 'NOT_FOUND');
      if (await matchesOf(tenantId).findOne({ bankLineId: line._id, active: true })) fail('esa línea del extracto ya está conciliada', 'ALREADY_MATCHED');
      await assertOpenDate(tenantId, line.accountId, line.currency, line.date, 'no se contabiliza');
      const counter = String(input.counterAccount ?? '').trim();
      if (!ACCOUNT.test(counter)) fail('indica la cuenta contra la que se contabiliza');
      if (counter === line.accountId) fail('la cuenta contrapartida no puede ser la de bancos');
      const problems = await accounts.postingProblems(tenantId, [counter]);
      if (problems.length) fail(problems.join('; '));
      const out = line.amount < 0;
      const amount = Math.abs(line.amount);
      const bankLine = { accountId: line.accountId, ...(out ? { credit: amount } : { debit: amount }) };
      const counterLine = { accountId: counter, ...(out ? { debit: amount } : { credit: amount }), ...(input.costCenter ? { costCenter: input.costCenter } : {}), ...(input.partyId ? { partyId: input.partyId } : {}) };
      const description = String(input.description ?? '').trim().slice(0, 200) || `Extracto: ${line.description}`;
      const lines = out ? [counterLine, bankLine] : [bankLine, counterLine];
      const lineIndex = lines.indexOf(bankLine);
      const { journal } = await ledger.postJournal(
        tenantId,
        { docType: 'CB', date: line.date, currency: line.currency, idempotencyKey: `bank-book-${line._id}`, description, source: { kind: 'bank_line', id: String(line._id) }, lines },
        {
          inTx: async (session, { journal: posted }) => {
            await insertMatch(tenantId, session, { accountId: line.accountId, currency: line.currency, bankLineId: line._id, journalId: posted._id, lineIndex, document: `CB${posted.number}`, amount: line.amount, bankDate: line.date, bookDate: line.date, booked: true }, ctx, 'bank.book', { document: `CB${posted.number}`, amount: line.amount, counter });
          },
        },
      );
      return { journal };
    },

    /** Resumen de la conciliación a una fecha. `statementBalance` es el saldo final del extracto a esa fecha, con signo. */
    async reconciliation(tenantId, { account, currency, asOf, statementBalance }) {
      const accountId = (await bankAccount(tenantId, account)).code;
      const cur = assertCurrency(currency ?? (await tenantCurrency(tenantId)));
      if (!safeInt(statementBalance)) fail('el saldo del extracto debe ser un entero');
      return summary(tenantId, { accountId, currency: cur, asOf: parseDay(asOf, 'la fecha de la conciliación'), statementBalance });
    },

    async listReconciliations(tenantId, { account, currency }) {
      const accountId = (await bankAccount(tenantId, account)).code;
      const cur = assertCurrency(currency ?? (await tenantCurrency(tenantId)));
      const rows = await reconciliationsOf(tenantId).find({ accountId, currency: cur }, { sort: { asOf: -1 }, limit: 100 }).toArray();
      return { items: rows.map(present) };
    },

    /** Cierra la conciliación a una fecha: exige diferencia cero y deja una fotografía. Lo cerrado no se altera. */
    async close(tenantId, input, ctx = {}) {
      const accountId = (await bankAccount(tenantId, input.account)).code;
      const currency = assertCurrency(input.currency ?? (await tenantCurrency(tenantId)));
      if (!safeInt(input.statementBalance)) fail('el saldo del extracto debe ser un entero');
      const asOf = parseDay(input.asOf, 'la fecha de la conciliación');
      if (asOf.getTime() > now().getTime() + DAY_MS) fail('la fecha de la conciliación no puede ser futura');
      const previous = await lastClosed(tenantId, accountId, currency);
      if (previous && dayOf(asOf) <= dayOf(previous.asOf)) fail(`ya hay una conciliación cerrada al ${dayOf(previous.asOf)}: la nueva debe ser posterior`, 'RECONCILED');
      const result = await summary(tenantId, { accountId, currency, asOf, statementBalance: input.statementBalance });
      if (result.difference !== 0) fail(`la conciliación no cuadra: diferencia de ${result.difference}`, 'NOT_BALANCED');
      return withTransaction(client, async (session) => {
        const doc = {
          accountId,
          currency,
          asOf,
          statementBalance: result.statementBalance,
          bookBalance: result.bookBalance,
          unmatchedBookNet: result.unmatchedBook.net,
          unmatchedBankNet: result.unmatchedBank.net,
          unmatchedBookCount: result.unmatchedBook.count,
          unmatchedBankCount: result.unmatchedBank.count,
          status: 'closed',
          closedBy: ctx.userId ?? null,
          closedAt: now(),
        };
        try {
          const { insertedId } = await reconciliationsOf(tenantId).insertOne({ ...doc }, session);
          await ctx.auditTx?.(session, { action: 'bank.reconcile', target: insertedId, details: { account: accountId, asOf: dayOf(asOf), statementBalance: doc.statementBalance } });
          return present({ ...doc, _id: insertedId });
        } catch (err) {
          if (isDuplicate(err, 'tenant_bankrec_closed')) fail('esa fecha ya está conciliada', 'RECONCILED');
          throw err;
        }
      });
    },

    /** Reabre la última conciliación cerrada de la cuenta. */
    async reopen(tenantId, id, ctx = {}) {
      const rec = await reconciliationsOf(tenantId).findOne({ _id: objectId(id, 'la conciliación'), status: 'closed' });
      if (!rec) fail('la conciliación no existe o ya está abierta', 'NOT_FOUND');
      const latest = await lastClosed(tenantId, rec.accountId, rec.currency);
      if (String(latest._id) !== String(rec._id)) fail('solo se reabre la última conciliación cerrada', 'INVALID_STATE');
      return withTransaction(client, async (session) => {
        const res = await reconciliationsOf(tenantId).updateOne({ _id: rec._id, status: 'closed' }, { $set: { status: 'reopened', reopenedAt: now(), reopenedBy: ctx.userId ?? null } }, { session });
        if (res.modifiedCount !== 1) fail('la conciliación ya está abierta', 'NOT_FOUND');
        await ctx.auditTx?.(session, { action: 'bank.reopen', target: rec._id, details: { account: rec.accountId, asOf: dayOf(rec.asOf) } });
        return { reopened: true };
      });
    },
  };
  return api;
}
