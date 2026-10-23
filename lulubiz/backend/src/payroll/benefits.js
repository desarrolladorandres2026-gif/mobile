import { ObjectId } from 'mongodb';
import { DAY_MS, dayOf, parseDay as parseCalendarDay } from '../core/dates.js';
import { roundDiv } from '../invoicing/tax.js';
import { COLLECTIONS } from '../data/db.js';
import { TenantCollection } from '../data/tenantCollection.js';
import { isDuplicate } from '../data/tx.js';

export const MAX_PAGE = 50;
export const KINDS = ['prima', 'cesantias'];

export class BenefitError extends Error {
  constructor(message, code = 'VALIDATION') {
    super(message);
    this.name = 'BenefitError';
    this.code = code;
  }
}

const fail = (message, code) => {
  throw new BenefitError(message, code);
};
const ratio = (amount, numerator, denominator) => Number(roundDiv(BigInt(amount) * BigInt(numerator), BigInt(denominator)));
const sum = (items, pick) => items.reduce((acc, item) => acc + pick(item), 0);

/** Ventana de meses de una prestación. Prima: `AAAA-1` (enero a junio) o `AAAA-2` (julio a diciembre). Cesantías: `AAAA`. */
export function windowOf(kind, label) {
  if (kind === 'prima') {
    const m = /^(\d{4})-([12])$/.exec(String(label ?? ''));
    if (!m) fail('la prima se liquida por semestre: AAAA-1 (enero a junio) o AAAA-2 (julio a diciembre)');
    return m[2] === '1' ? { from: `${m[1]}-01`, to: `${m[1]}-06` } : { from: `${m[1]}-07`, to: `${m[1]}-12` };
  }
  if (kind === 'cesantias') {
    if (!/^\d{4}$/.test(String(label ?? ''))) fail('las cesantías se liquidan por año: AAAA');
    return { from: `${label}-01`, to: `${label}-12` };
  }
  return fail('la prestación es prima o cesantías');
}

/*
 * Prestaciones sociales: prima de servicios (semestral) y cesantías con sus intereses (anual).
 *
 * Cada mes la nómina provisiona estas obligaciones (gasto contra pasivo). Liquidarlas calcula lo que de verdad se debe a cada
 * empleado con las nóminas del semestre o del año y lo compara con lo provisionado:
 *   - prima = suma de la base mensual (salario, extras salariales y auxilio de transporte) dividida por 12;
 *   - cesantías = lo mismo; intereses = cesantías × 12 % × días trabajados / 360.
 * El asiento cancela el pasivo provisionado, lleva la diferencia al gasto (a favor o en contra) y deja lo que se debe por pagar
 * en la cuenta de salarios por pagar. Después se paga con una salida de caja o bancos (para las cesantías, la consignación al
 * fondo). Una liquidación por prestación y período; no se puede anular una nómina que ya entró en una liquidación.
 *
 * Límites: no hay retención en la fuente sobre la prima; el salario integral no genera estas prestaciones; no hay
 * liquidación parcial por retiro (ver liquidación de contrato); si faltan nóminas del período, la liquidación solo cubre las
 * que existen (la pantalla avisa cuántos meses cubre).
 */
export function createBenefitsService({ db, ledger, accounts, payroll, now = () => new Date() }) {
  const runsOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.payrollRuns), tenantId);
  const benefitsOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.payrollBenefits), tenantId);
  const tenants = db.collection(COLLECTIONS.tenants);

  const lastDayOf = (period) => {
    const [y, m] = period.split('-').map(Number);
    const end = new Date(Date.UTC(y, m, 0, 12));
    const today = parseCalendarDay(dayOf(now()), 'hoy', fail);
    return end > today ? today : end;
  };

  /** Calcula sin guardar: lo debido, lo provisionado y la diferencia de cada empleado. */
  async function compute(tenantId, kind, label) {
    const { from, to } = windowOf(kind, label);
    const runs = await runsOf(tenantId).find({ status: 'posted', period: { $gte: from, $lte: to } }, { sort: { period: 1 } }).toArray();
    const byEmployee = new Map();
    for (const run of runs) {
      for (const item of run.items) {
        const key = String(item.employeeId);
        const row = byEmployee.get(key) ?? { employeeId: item.employeeId, name: item.name, documentType: item.documentType, documentNumber: item.documentNumber, base: 0, days: 0, accrued: 0, accruedInterest: 0, months: 0 };
        // El salario integral no genera prima ni cesantías: su provisión es cero y su base no cuenta.
        if (item.salaryType !== 'integral') row.base += item.salaryEarned + item.salaryExtras + item.transportAid;
        row.days += item.days;
        row.accrued += kind === 'prima' ? item.provisions.prima : item.provisions.cesantias;
        row.accruedInterest += item.provisions.cesantiasInterest;
        row.months += 1;
        byEmployee.set(key, row);
      }
    }
    const items = [];
    for (const row of byEmployee.values()) {
      if (row.base === 0) continue;
      const main = ratio(row.base, 1, 12);
      const interest = kind === 'cesantias' ? ratio(main, 12 * row.days, 100 * 360) : 0;
      items.push({
        employeeId: row.employeeId,
        name: row.name,
        documentType: row.documentType,
        documentNumber: row.documentNumber,
        months: row.months,
        days: row.days,
        base: row.base,
        amount: main,
        accrued: row.accrued,
        adjustment: main - row.accrued,
        ...(kind === 'cesantias' ? { interest, accruedInterest: row.accruedInterest, interestAdjustment: interest - row.accruedInterest } : {}),
      });
    }
    items.sort((a, b) => (a.name < b.name ? -1 : 1));
    const totals = {
      amount: sum(items, (i) => i.amount),
      accrued: sum(items, (i) => i.accrued),
      adjustment: sum(items, (i) => i.adjustment),
      ...(kind === 'cesantias' ? { interest: sum(items, (i) => i.interest), accruedInterest: sum(items, (i) => i.accruedInterest), interestAdjustment: sum(items, (i) => i.interestAdjustment) } : {}),
      employees: items.length,
    };
    const monthsWithRuns = new Set(runs.map((r) => r.period)).size;
    const monthsInWindow = kind === 'prima' ? 6 : 12;
    return { kind, label, from, to, items, totals, monthsCovered: monthsWithRuns, monthsInWindow };
  }

  const api = {
    async preview(tenantId, { kind, label }) {
      return compute(tenantId, kind, label);
    },

    /** Liquida y asienta una prestación. Una por tipo y período. */
    async settle(tenantId, input, ctx = {}) {
      const { kind, label } = input;
      const calc = await compute(tenantId, kind, label);
      if (!calc.items.length) fail('no hay nóminas liquidadas en ese período');
      if (await benefitsOf(tenantId).findOne({ kind, label, status: 'posted' })) fail('esa prestación ya está liquidada', 'DUPLICATE');
      const acc = await payroll.requiredAccounts(tenantId);
      const tenant = await tenants.findOne({ _id: tenantId }, { projection: { currency: 1 } });
      const t = calc.totals;
      const parts = kind === 'prima'
        ? [{ liability: acc.primaPayable, expense: acc.primaExpense, accrued: t.accrued, amount: t.amount }]
        : [
            { liability: acc.cesantiasPayable, expense: acc.cesantiasExpense, accrued: t.accrued, amount: t.amount },
            { liability: acc.cesantiasInterestPayable, expense: acc.cesantiasInterestExpense, accrued: t.accruedInterest, amount: t.interest },
          ];
      const lines = [];
      let owed = 0;
      for (const p of parts) {
        if (p.accrued > 0) lines.push({ accountId: p.liability, debit: p.accrued });
        const adjustment = p.amount - p.accrued;
        if (adjustment > 0) lines.push({ accountId: p.expense, debit: adjustment });
        else if (adjustment < 0) lines.push({ accountId: p.expense, credit: -adjustment });
        owed += p.amount;
      }
      lines.push({ accountId: acc.payrollPayable, credit: owed });
      const benefitId = new ObjectId();
      const date = lastDayOf(calc.to);
      try {
        const posted = await ledger.postJournal(
          tenantId,
          {
            docType: 'PR',
            date,
            currency: tenant.currency,
            idempotencyKey: `benefit-${kind}-${label}`,
            description: kind === 'prima' ? `Prima de servicios ${label}` : `Cesantías e intereses ${label}`,
            source: { kind: 'payroll_benefit', id: String(benefitId) },
            lines,
          },
          {
            inTx: async (session, { journal: posted }) => {
              await benefitsOf(tenantId).insertOne(
                { _id: benefitId, kind, label, fromPeriod: calc.from, toPeriod: calc.to, status: 'posted', items: calc.items, totals: t, total: owed, monthsCovered: calc.monthsCovered, journalId: posted._id, document: `PR${posted.number}`, createdBy: ctx.userId ?? null, createdAt: now() },
                session,
              );
              await ctx.auditTx?.(session, { action: 'payroll.benefit', target: benefitId, details: { kind, label, total: owed } });
            },
          },
        );
        // Otra petición idéntica ya asentó este comprobante (misma clave): esta no liquidó nada.
        if (posted.replayed) fail('esa prestación ya está liquidada', 'DUPLICATE');
      } catch (err) {
        if (isDuplicate(err, 'tenant_benefit_period')) fail('esa prestación ya está liquidada', 'DUPLICATE');
        throw err;
      }
      return { benefit: await benefitsOf(tenantId).findOne({ _id: benefitId }) };
    },

    async get(tenantId, id) {
      if (!/^[a-f0-9]{24}$/.test(String(id))) fail('liquidación inválida');
      return benefitsOf(tenantId).findOne({ _id: new ObjectId(id) });
    },

    async list(tenantId, { limit = 25 } = {}) {
      const rows = await benefitsOf(tenantId).find({}, { sort: { _id: -1 }, limit: Math.min(Math.max(Number(limit) || 25, 1), MAX_PAGE), projection: { items: 0 } }).toArray();
      return { items: rows };
    },

    /** Paga lo liquidado con una salida de caja o bancos (para las cesantías, la consignación al fondo). */
    async pay(tenantId, id, input, ctx = {}) {
      const benefit = await api.get(tenantId, id);
      if (!benefit) fail('la liquidación no existe', 'NOT_FOUND');
      if (benefit.payment) fail('el pago ya se hizo', 'INVALID_STATE');
      const date = parseCalendarDay(input.date, 'la fecha del pago', fail);
      if (date.getTime() > now().getTime() + DAY_MS) fail('la fecha del pago no puede ser futura');
      const account = String(input.account ?? '').trim();
      if (!/^[0-9]{1,12}$/.test(account)) fail('indica la cuenta de caja o bancos de donde sale el dinero');
      const problems = await accounts.postingProblems(tenantId, [account]);
      if (problems.length) fail(problems.join('; '));
      if ((await accounts.get(tenantId, account)).type !== 'asset') fail('el dinero sale de una cuenta de activo: caja o bancos');
      const acc = await payroll.requiredAccounts(tenantId);
      const tenant = await tenants.findOne({ _id: tenantId }, { projection: { currency: 1 } });
      await ledger.postJournal(
        tenantId,
        {
          docType: 'PB',
          date,
          currency: tenant.currency,
          idempotencyKey: `benefit-pay-${benefit._id}`,
          description: `Pago de ${benefit.kind === 'prima' ? 'prima de servicios' : 'cesantías e intereses'} ${benefit.label}`,
          source: { kind: 'payroll_benefit_payment', id: String(benefit._id) },
          lines: [{ accountId: acc.payrollPayable, debit: benefit.total }, { accountId: account, credit: benefit.total }],
        },
        {
          inTx: async (session, { journal }) => {
            const res = await benefitsOf(tenantId).updateOne(
              { _id: benefit._id, status: 'posted', payment: { $exists: false } },
              { $set: { payment: { date, account, total: benefit.total, journalId: journal._id, document: `PB${journal.number}`, by: ctx.userId ?? null, at: now() } } },
              { session },
            );
            if (res.matchedCount === 0) fail('el pago ya se hizo', 'INVALID_STATE');
            await ctx.auditTx?.(session, { action: 'payroll.benefit_pay', target: benefit._id, details: { kind: benefit.kind, label: benefit.label, total: benefit.total } });
          },
        },
      );
      return { benefit: await api.get(tenantId, id) };
    },
  };
  return api;
}
