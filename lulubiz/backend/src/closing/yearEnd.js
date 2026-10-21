import { assertCurrency, assertMinorUnits } from '../core/money.js';
import { DAY_MS, parseDay as parseCalendarDay } from '../core/dates.js';
import { COLLECTIONS } from '../data/db.js';
import { TenantCollection } from '../data/tenantCollection.js';
import { withTransaction } from '../data/tx.js';

export const YEAR_CLOSE_TYPE = 'CA';
const RESULT_TYPES = ['income', 'cost', 'expense'];

export class YearEndError extends Error {
  constructor(message, code = 'VALIDATION') {
    super(message);
    this.name = 'YearEndError';
    this.code = code;
  }
}

const fail = (message, code) => {
  throw new YearEndError(message, code);
};

/**
 * Efecto de los asientos de cierre de ejercicio (originales y reversiones) por cuenta y período, hasta `toPeriod`.
 * Los reportes lo restan para mostrar la actividad real del año: sin esto, el estado de resultados de diciembre
 * saldría en cero justo después de cerrar.
 */
export async function closingEffects(db, tenantId, currency, toPeriod) {
  const journals = await db
    .collection(COLLECTIONS.journals)
    .find({ tenantId, docType: YEAR_CLOSE_TYPE, currency, period: { $lte: toPeriod } }, { projection: { period: 1, lines: 1 } })
    .toArray();
  return journals.flatMap((j) => j.lines.map((l) => ({ period: j.period, accountId: l.accountId, debit: l.debit, credit: l.credit })));
}

/*
 * Cierre de ejercicio.
 *
 * Lleva a cero, con un solo asiento `CC` fechado el 31 de diciembre, las cuentas de ingresos, costos y gastos del año
 * (de una moneda) y pasa la diferencia a una cuenta de patrimonio: utilidad si ganó, pérdida si perdió. Desde ahí el
 * balance general trae el resultado del año en el patrimonio y no como «resultado acumulado», y el del año siguiente
 * empieza de cero.
 *
 *  - Se cierra en orden: no se cierra un año si uno anterior con movimiento de resultados sigue abierto, porque su
 *    resultado quedaría mezclado con el de este.
 *  - Es idempotente: cerrar un año ya cerrado devuelve el cierre existente.
 *  - Si con este cierre todas las monedas que tuvieron movimiento de resultados en el año quedan cerradas, los doce
 *    períodos del año se cierran también (marcados con `closedByYear`). Así ningún asiento tardío descuadra un resultado
 *    que ya está en el patrimonio. Esos períodos no se reabren uno a uno: se reabre el ejercicio.
 *  - Reabrir el ejercicio reversa el asiento de cierre y reabre los períodos que cerró el cierre. Solo si no hay un
 *    ejercicio posterior cerrado.
 */
export function createYearEndService({ client, db, ledger, accounts, now = () => new Date() }) {
  const balancesOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.balances), tenantId);
  const journalsOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.journals), tenantId);
  const periodsOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.periods), tenantId);

  const periodsOfYear = (year) => Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
  const sourceId = (year, currency) => `${year}-${currency}`;

  function checkYear(year) {
    if (!Number.isInteger(year) || year < 2000 || year > 2100) fail('el año debe estar entre 2000 y 2100');
    return year;
  }

  async function resultCodes(tenantId) {
    const chart = await accounts.list(tenantId);
    return { chart, codes: chart.filter((a) => RESULT_TYPES.includes(a.type)).map((a) => a.code) };
  }

  /** Cierres vigentes (no reversados) de una moneda, con su año. */
  async function activeCloses(tenantId, { currency, year } = {}) {
    const filter = {
      docType: YEAR_CLOSE_TYPE,
      'source.kind': 'year_close',
      ...(currency ? { currency } : {}),
      ...(year ? { 'source.year': year } : {}),
    };
    const originals = await journalsOf(tenantId).find(filter, { sort: { _id: 1 } }).toArray();
    if (!originals.length) return { active: [], all: [] };
    const reversals = await journalsOf(tenantId)
      .find({ reversesJournalId: { $in: originals.map((j) => j._id) } }, { projection: { reversesJournalId: 1 } })
      .toArray();
    const reversed = new Set(reversals.map((r) => r.reversesJournalId.toHexString()));
    return { active: originals.filter((j) => !reversed.has(j._id.toHexString())), all: originals };
  }

  /** Movimiento del año por cuenta de resultados, sin contar los asientos de cierre. */
  async function yearActivity(tenantId, year, currency) {
    const { chart, codes } = await resultCodes(tenantId);
    const periods = periodsOfYear(year);
    const rows = await balancesOf(tenantId)
      .aggregate([
        { $match: { currency, accountId: { $in: codes }, period: { $in: periods } } },
        { $group: { _id: '$accountId', debit: { $sum: '$debit' }, credit: { $sum: '$credit' } } },
      ])
      .toArray();
    const net = new Map(rows.map((r) => [r._id, { debit: Number(r.debit), credit: Number(r.credit) }]));
    for (const e of await closingEffects(db, tenantId, currency, periods.at(-1))) {
      if (e.period < periods[0] || !net.has(e.accountId)) continue;
      const cur = net.get(e.accountId);
      cur.debit -= e.debit;
      cur.credit -= e.credit;
    }
    const byCode = new Map(chart.map((a) => [a.code, a]));
    return [...net]
      .map(([code, t]) => ({ code, name: byCode.get(code)?.name ?? null, type: byCode.get(code)?.type ?? null, debit: t.debit, credit: t.credit, net: t.debit - t.credit }))
      .filter((r) => r.debit !== 0 || r.credit !== 0)
      .sort((a, b) => (a.code < b.code ? -1 : 1));
  }

  /** Años anteriores con movimiento de resultados en esta moneda que todavía no tienen un cierre vigente. */
  async function openYearsBefore(tenantId, year, currency) {
    const { codes } = await resultCodes(tenantId);
    const rows = await balancesOf(tenantId)
      .aggregate([
        { $match: { currency, accountId: { $in: codes }, period: { $lt: `${year}-01` } } },
        { $group: { _id: { $substrBytes: ['$period', 0, 4] }, movement: { $sum: { $add: ['$debit', '$credit'] } } } },
      ])
      .toArray();
    const years = rows.filter((r) => Number(r.movement) > 0).map((r) => Number(r._id));
    const { active } = await activeCloses(tenantId, { currency });
    const closed = new Set(active.map((j) => j.source.year));
    return years.filter((y) => !closed.has(y)).sort();
  }

  async function activityCurrencies(tenantId, year) {
    const { codes } = await resultCodes(tenantId);
    const rows = await balancesOf(tenantId)
      .aggregate([
        { $match: { accountId: { $in: codes }, period: { $in: periodsOfYear(year) } } },
        { $group: { _id: '$currency', movement: { $sum: { $add: ['$debit', '$credit'] } } } },
      ])
      .toArray();
    return rows.filter((r) => Number(r.movement) > 0).map((r) => r._id);
  }

  const api = {
    /** Qué cerraría el ejercicio: cada cuenta de resultados con su saldo, el resultado y lo que lo impide. */
    async preview(tenantId, { year, currency }) {
      checkYear(year);
      assertCurrency(currency);
      const lines = await yearActivity(tenantId, year, currency);
      const sumNet = (type) => lines.filter((l) => l.type === type).reduce((acc, l) => acc + l.net, 0);
      const income = 0 - sumNet('income');
      const cost = sumNet('cost');
      const expense = sumNet('expense');
      const { active } = await activeCloses(tenantId, { currency, year });
      const blockers = [];
      const before = await openYearsBefore(tenantId, year, currency);
      if (before.length) blockers.push(`cierra primero el ejercicio ${before[0]}`);
      if (lines.length === 0) blockers.push('el ejercicio no tiene movimiento de ingresos, costos ni gastos');
      const december = await periodsOf(tenantId).findOne({ period: `${year}-12` });
      if (december?.status === 'closed' && !active.length) blockers.push(`el período ${year}-12 está cerrado: reábrelo para registrar el asiento de cierre`);
      return {
        year,
        currency,
        lines,
        totals: { income, cost, expense, result: income - cost - expense },
        closed: active.length ? { journalId: active[0]._id, closedAt: active[0].createdAt } : null,
        blockers,
      };
    },

    async list(tenantId) {
      const { active } = await activeCloses(tenantId);
      return active
        .map((j) => ({ year: j.source.year, currency: j.currency, journalId: j._id, number: j.number, closedAt: j.createdAt, result: j.source.result }))
        .sort((a, b) => b.year - a.year || (a.currency < b.currency ? -1 : 1));
    },

    async close(tenantId, input, ctx = {}) {
      const year = checkYear(input.year);
      const currency = assertCurrency(input.currency);
      const date = parseCalendarDay(`${year}-12-31`, 'la fecha del cierre', fail);
      if (date.getTime() > now().getTime() + DAY_MS) fail(`el ejercicio ${year} no ha terminado: se cierra desde el 31 de diciembre`);

      const existing = await activeCloses(tenantId, { currency, year });
      if (existing.active.length) {
        return { journal: existing.active[0], replayed: true, periodsClosed: [], pendingCurrencies: [] };
      }
      const before = await openYearsBefore(tenantId, year, currency);
      if (before.length) fail(`cierra primero el ejercicio ${before[0]}`, 'INVALID_STATE');

      const profitAccount = String(input.profitAccount ?? '').trim();
      const lossAccount = String(input.lossAccount ?? profitAccount).trim();
      if (!profitAccount) fail('indica la cuenta de patrimonio donde queda la utilidad del ejercicio');
      const problems = await accounts.postingProblems(tenantId, [profitAccount, lossAccount]);
      if (problems.length) fail(problems.join('; '));
      for (const code of new Set([profitAccount, lossAccount])) {
        if ((await accounts.get(tenantId, code)).type !== 'equity') fail(`la cuenta ${code} debe ser de patrimonio`);
      }

      const activity = await yearActivity(tenantId, year, currency);
      if (activity.length === 0) fail('el ejercicio no tiene movimiento de ingresos, costos ni gastos: no hay nada que cerrar', 'INVALID_STATE');
      // Cada cuenta de resultados se lleva a cero: su saldo (débitos − créditos) pasa al lado contrario.
      const lines = [];
      let debit = 0;
      let credit = 0;
      for (const a of activity) {
        if (a.net > 0) {
          lines.push({ accountId: a.code, credit: a.net });
          credit = assertMinorUnits(credit + a.net, 'total de créditos');
        } else if (a.net < 0) {
          lines.push({ accountId: a.code, debit: 0 - a.net });
          debit = assertMinorUnits(debit + (0 - a.net), 'total de débitos');
        }
      }
      // Lo que no cuadra entre los cierres es el resultado: utilidad al crédito del patrimonio, pérdida al débito.
      const result = debit - credit;
      if (result > 0) lines.push({ accountId: profitAccount, credit: result });
      else if (result < 0) lines.push({ accountId: lossAccount, debit: 0 - result });
      if (lines.length === 0) fail('el ejercicio ya está en cero: no hay nada que cerrar', 'INVALID_STATE');

      const attempt = existing.all.length + 1;
      const periods = periodsOfYear(year);
      const closedPeriods = [];
      let pendingCurrencies = [];
      const { journal, replayed } = await ledger.postJournal(
        tenantId,
        {
          docType: YEAR_CLOSE_TYPE,
          date,
          currency,
          idempotencyKey: `year-close-${sourceId(year, currency)}-${attempt}`,
          description: `Cierre del ejercicio ${year} (${currency}): ${result >= 0 ? 'utilidad' : 'pérdida'} de ${Math.abs(result)}`,
          source: { kind: 'year_close', id: sourceId(year, currency), year, result },
          lines,
        },
        {
          inTx: async (session, posted) => {
            await ctx.auditTx?.(session, { action: 'year.close', target: posted.journal._id, details: { year, currency, result } });
            // Con este cierre, ¿quedan cerradas todas las monedas que tuvieron resultados este año? Entonces se cierra el año.
            const currencies = await activityCurrencies(tenantId, year);
            const closedNow = new Set((await activeCloses(tenantId, { year })).active.map((j) => j.currency));
            closedNow.add(currency);
            pendingCurrencies = currencies.filter((c) => !closedNow.has(c));
            if (pendingCurrencies.length === 0) {
              for (const period of periods) {
                await periodsOf(tenantId).updateOne(
                  { period },
                  { $setOnInsert: { seq: 0, createdAt: now() }, $set: { status: 'closed', closedAt: now(), closedBy: ctx.userId ?? null, closedByYear: year } },
                  { upsert: true, session },
                );
              }
              closedPeriods.push(...periods);
            }
          },
        },
      );
      return { journal, replayed, periodsClosed: replayed ? [] : closedPeriods, pendingCurrencies };
    },

    /** Reabre un ejercicio cerrado: reabre los períodos que cerró y reversa su asiento de cierre. */
    async reopen(tenantId, input, ctx = {}) {
      const year = checkYear(input.year);
      const currency = assertCurrency(input.currency);
      const { active } = await activeCloses(tenantId, { currency, year });
      if (!active.length) fail(`el ejercicio ${year} no está cerrado`, 'NOT_FOUND');
      const later = (await activeCloses(tenantId, { currency })).active.filter((j) => j.source.year > year);
      if (later.length) fail(`el ejercicio ${later[0].source.year} está cerrado: reábrelo primero`, 'INVALID_STATE');

      const closing = active[0];
      const flagged = await periodsOf(tenantId).find({ closedByYear: year }).toArray();
      const reopen = () =>
        withTransaction(client, async (session) => {
          for (const p of flagged) {
            await periodsOf(tenantId).updateOne({ period: p.period }, { $set: { status: 'open', reopenedAt: now(), reopenedBy: ctx.userId ?? null }, $unset: { closedByYear: '' } }, { session });
          }
        });
      const restore = () =>
        withTransaction(client, async (session) => {
          for (const p of flagged) {
            await periodsOf(tenantId).updateOne({ period: p.period }, { $set: { status: 'closed', closedByYear: year } }, { session });
          }
        });

      // La reversión se fecha el 31 de diciembre, así que el período de diciembre tiene que estar abierto antes.
      if (flagged.length) await reopen();
      try {
        const { journal } = await ledger.reverseJournal(
          tenantId,
          closing._id,
          { idempotencyKey: `year-reopen-${closing._id}`, date: closing.date, description: `Reapertura del ejercicio ${year} (${currency})` },
          { inTx: async (session, posted) => ctx.auditTx?.(session, { action: 'year.reopen', target: posted.journal._id, details: { year, currency } }) },
        );
        return { journal, periodsReopened: flagged.map((p) => p.period) };
      } catch (err) {
        // Si no se pudo reversar, los períodos vuelven a quedar cerrados como estaban.
        if (flagged.length) await restore().catch(() => {});
        throw err;
      }
    },

    /** Un período que cerró el cierre del ejercicio no se reabre suelto: se reabre el ejercicio. */
    async assertPeriodReopenable(tenantId, period) {
      const doc = await periodsOf(tenantId).findOne({ period });
      if (doc?.closedByYear) fail(`el período ${period} lo cerró el cierre del ejercicio ${doc.closedByYear}: reabre el ejercicio`, 'INVALID_STATE');
    },
  };

  return api;
}
