import { ObjectId } from 'mongodb';
import { DAY_MS, dayOf, parseDay as parseCalendarDay } from '../core/dates.js';
import { assertMinorUnits } from '../core/money.js';
import { COLLECTIONS } from '../data/db.js';
import { TenantCollection } from '../data/tenantCollection.js';
import { isDuplicate } from '../data/tx.js';
import { roundDiv } from '../invoicing/tax.js';

export const MAX_PAGE = 50;

export class TerminationError extends Error {
  constructor(message, code = 'VALIDATION') {
    super(message);
    this.name = 'TerminationError';
    this.code = code;
  }
}

const fail = (message, code) => {
  throw new TerminationError(message, code);
};
const ratio = (amount, numerator, denominator) => Number(roundDiv(BigInt(amount) * BigInt(numerator), BigInt(denominator)));
const objectId = (value, label) => (/^[a-f0-9]{24}$/.test(String(value ?? '')) ? new ObjectId(String(value)) : fail(`${label} inválido`));
const sum = (items, pick) => items.reduce((acc, item) => acc + pick(item), 0);

/*
 * Liquidación de contrato (retiro de un empleado).
 *
 * Con la fecha de retiro, calcula lo que se le debe y lo compara con lo provisionado:
 *   - cesantías del año en curso (base ÷ 12 de las nóminas del año hasta el retiro) y sus intereses (× 12 % × días / 360);
 *   - prima del semestre en curso (base ÷ 12 de las nóminas del semestre hasta el retiro);
 *   - vacaciones pendientes: salario ÷ 30 × los días que se indiquen;
 *   - indemnización, si la hay: el importe lo escribe quien liquida.
 * Lo que ya entró en una liquidación de prima o cesantías de ese período no se repite. El asiento `LC` cancela las provisiones
 * del empleado, lleva la diferencia al gasto y deja el total en salarios por pagar; `PL` lo paga. Exige que la nómina del mes
 * del retiro ya esté liquidada con el empleado, y al liquidar deja al empleado inactivo con su fecha de retiro.
 *
 * Límites: no calcula la indemnización (depende del tipo de contrato y de la causa del retiro); la retención en la fuente sobre
 * la liquidación se escribe a mano (no se calcula); no sabe qué vacaciones ya se disfrutaron: los días pendientes los indica quien
 * liquida; las cesantías de años anteriores sin liquidar no se incluyen (se liquidan primero por año).
 */
export function createTerminationService({ db, ledger, accounts, payroll, now = () => new Date() }) {
  const employeesOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.employees), tenantId);
  const runsOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.payrollRuns), tenantId);
  const benefitsOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.payrollBenefits), tenantId);
  const terminationsOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.payrollTerminations), tenantId);
  const tenants = db.collection(COLLECTIONS.tenants);

  /** Calcula la liquidación sin guardarla. */
  async function compute(tenantId, input) {
    const employee = await employeesOf(tenantId).findOne({ _id: objectId(input.employeeId, 'el empleado') });
    if (!employee) fail('el empleado no existe', 'NOT_FOUND');
    if (await terminationsOf(tenantId).findOne({ employeeId: employee._id, status: 'posted' })) fail('el contrato de este empleado ya está liquidado', 'DUPLICATE');
    const endDate = parseCalendarDay(input.endDate, 'la fecha de retiro', fail);
    if (endDate < employee.hireDate) fail('el retiro no puede ser anterior al ingreso');
    if (endDate.getTime() > now().getTime() + DAY_MS * 31) fail('la fecha de retiro es demasiado lejana');
    const vacationDays = input.vacationDaysPending ?? 0;
    if (!Number.isFinite(vacationDays) || vacationDays < 0 || vacationDays > 400) fail('los días de vacaciones pendientes van de 0 a 400');
    const severance = assertMinorUnits(input.severance ?? 0, 'la indemnización');
    const withholding = assertMinorUnits(input.withholding ?? 0, 'la retención');
    const period = dayOf(endDate).slice(0, 7);
    const year = period.slice(0, 4);
    const half = Number(period.slice(5)) <= 6 ? 1 : 2;

    const runs = await runsOf(tenantId).find({ status: 'posted', period: { $gte: `${year}-01`, $lte: period } }, { sort: { period: 1 } }).toArray();
    const mine = runs.map((r) => ({ period: r.period, item: r.items.find((i) => String(i.employeeId) === String(employee._id)) })).filter((x) => x.item);
    if (!mine.some((x) => x.period === period)) fail(`primero liquida la nómina de ${period} con este empleado`, 'INVALID_STATE');
    const settled = await benefitsOf(tenantId).find({ status: 'posted', 'items.employeeId': employee._id }).toArray();
    const alreadyPrima = settled.some((b) => b.kind === 'prima' && b.label === `${year}-${half}`);
    const alreadyCesantias = settled.some((b) => b.kind === 'cesantias' && b.label === year);

    const baseOf = (x) => (x.item.salaryType === 'integral' ? 0 : x.item.salaryEarned + x.item.salaryExtras + x.item.transportAid);
    const halfStart = `${year}-${half === 1 ? '01' : '07'}`;
    const primaRuns = mine.filter((x) => x.period >= halfStart);
    const primaBase = sum(primaRuns, baseOf);
    const cesBase = sum(mine, baseOf);
    const cesDays = sum(mine, (x) => x.item.days);

    const prima = alreadyPrima ? 0 : ratio(primaBase, 1, 12);
    const primaAccrued = alreadyPrima ? 0 : sum(primaRuns, (x) => x.item.provisions.prima);
    const cesantias = alreadyCesantias ? 0 : ratio(cesBase, 1, 12);
    const cesantiasAccrued = alreadyCesantias ? 0 : sum(mine, (x) => x.item.provisions.cesantias);
    const interest = alreadyCesantias ? 0 : ratio(cesantias, 12 * cesDays, 100 * 360);
    const interestAccrued = alreadyCesantias ? 0 : sum(mine, (x) => x.item.provisions.cesantiasInterest);

    // Vacaciones: toda la provisión del empleado (de todas las nóminas) frente a lo que se compensa.
    const allRuns = await runsOf(tenantId).find({ status: 'posted' }).toArray();
    const vacationAccrued = sum(allRuns.flatMap((r) => r.items.filter((i) => String(i.employeeId) === String(employee._id))), (i) => i.provisions.vacations);
    const vacations = ratio(employee.baseSalary, Math.round(vacationDays * 100), 3000);

    const gross = prima + cesantias + interest + vacations + severance;
    if (withholding > gross) fail('la retención no puede superar el total de la liquidación');
    const net = gross - withholding;
    if (net <= 0) fail('no hay nada que liquidar: sin nóminas del año ni vacaciones ni indemnización');
    return {
      employee: { _id: employee._id, name: employee.name, documentType: employee.documentType, documentNumber: employee.documentNumber, baseSalary: employee.baseSalary },
      endDate,
      period,
      vacationDays,
      lines: {
        prima: { base: primaBase, amount: prima, accrued: primaAccrued, skipped: alreadyPrima },
        cesantias: { base: cesBase, amount: cesantias, accrued: cesantiasAccrued, skipped: alreadyCesantias },
        interest: { days: cesDays, amount: interest, accrued: interestAccrued, skipped: alreadyCesantias },
        vacations: { days: vacationDays, amount: vacations, accrued: vacationAccrued },
        severance: { amount: severance },
      },
      gross,
      withholding,
      net,
    };
  }

  const api = {
    async preview(tenantId, input) {
      return compute(tenantId, input);
    },

    async settle(tenantId, input, ctx = {}) {
      const calc = await compute(tenantId, input);
      const acc = await payroll.requiredAccounts(tenantId);
      const tenant = await tenants.findOne({ _id: tenantId }, { projection: { currency: 1 } });
      const L = calc.lines;
      const parts = [
        { liability: acc.primaPayable, expense: acc.primaExpense, accrued: L.prima.accrued, amount: L.prima.amount },
        { liability: acc.cesantiasPayable, expense: acc.cesantiasExpense, accrued: L.cesantias.accrued, amount: L.cesantias.amount },
        { liability: acc.cesantiasInterestPayable, expense: acc.cesantiasInterestExpense, accrued: L.interest.accrued, amount: L.interest.amount },
        { liability: acc.vacationsPayable, expense: acc.vacationsExpense, accrued: L.vacations.accrued, amount: L.vacations.amount },
      ];
      const debits = new Map();
      const credits = new Map();
      const add = (map, accountId, amount) => {
        if (amount > 0) map.set(accountId, (map.get(accountId) ?? 0) + amount);
      };
      for (const p of parts) {
        add(debits, p.liability, p.accrued);
        const adjustment = p.amount - p.accrued;
        if (adjustment > 0) add(debits, p.expense, adjustment);
        else add(credits, p.expense, -adjustment);
      }
      add(debits, acc.nonSalaryExpense, L.severance.amount);
      add(credits, acc.payrollPayable, calc.net);
      add(credits, acc.withholdingPayable, calc.withholding);
      // Una cuenta que queda a los dos lados se netea: el asiento no lleva la misma cuenta en débito y en crédito.
      for (const [accountId, debit] of [...debits]) {
        const credit = credits.get(accountId);
        if (!credit) continue;
        if (debit > credit) {
          debits.set(accountId, debit - credit);
          credits.delete(accountId);
        } else if (credit > debit) {
          credits.set(accountId, credit - debit);
          debits.delete(accountId);
        } else {
          debits.delete(accountId);
          credits.delete(accountId);
        }
      }
      const lines = [...[...debits].map(([accountId, debit]) => ({ accountId, debit })), ...[...credits].map(([accountId, credit]) => ({ accountId, credit }))];
      const id = new ObjectId();
      const date = parseCalendarDay(dayOf(calc.endDate), 'la fecha', fail);
      try {
        const posted = await ledger.postJournal(
          tenantId,
          { docType: 'LC', date, currency: tenant.currency, idempotencyKey: `termination-${calc.employee._id}`, description: `Liquidación de contrato de ${calc.employee.name}`, source: { kind: 'payroll_termination', id: String(id) }, lines },
          {
            inTx: async (session, { journal }) => {
              await terminationsOf(tenantId).insertOne(
                { _id: id, employeeId: calc.employee._id, employee: calc.employee, status: 'posted', endDate: calc.endDate, period: calc.period, vacationDays: calc.vacationDays, lines: L, gross: calc.gross, withholding: calc.withholding, net: calc.net, journalId: journal._id, document: `LC${journal.number}`, createdBy: ctx.userId ?? null, createdAt: now() },
                session,
              );
              await employeesOf(tenantId).updateOne({ _id: calc.employee._id }, { $set: { endDate: calc.endDate, active: false, terminationId: id } }, { session });
              await ctx.auditTx?.(session, { action: 'payroll.termination', target: id, details: { employee: calc.employee.documentNumber, net: calc.net } });
            },
          },
        );
        if (posted.replayed) fail('el contrato de este empleado ya está liquidado', 'DUPLICATE');
      } catch (err) {
        if (isDuplicate(err, 'tenant_termination_employee')) fail('el contrato de este empleado ya está liquidado', 'DUPLICATE');
        throw err;
      }
      return { termination: await terminationsOf(tenantId).findOne({ _id: id }) };
    },

    async get(tenantId, id) {
      return terminationsOf(tenantId).findOne({ _id: objectId(id, 'la liquidación') });
    },

    async list(tenantId, { limit = 25 } = {}) {
      const rows = await terminationsOf(tenantId).find({}, { sort: { _id: -1 }, limit: Math.min(Math.max(Number(limit) || 25, 1), MAX_PAGE) }).toArray();
      return { items: rows };
    },

    /** Paga la liquidación (neto) con una salida de caja o bancos. */
    async pay(tenantId, id, input, ctx = {}) {
      const t = await api.get(tenantId, id);
      if (!t) fail('la liquidación no existe', 'NOT_FOUND');
      if (t.status !== 'posted') fail('la liquidación está anulada', 'INVALID_STATE');
      if (t.payment) fail('el pago ya se hizo', 'INVALID_STATE');
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
          docType: 'PL',
          date,
          currency: tenant.currency,
          idempotencyKey: `termination-pay-${t._id}`,
          description: `Pago de la liquidación de contrato de ${t.employee.name}`,
          source: { kind: 'payroll_termination_payment', id: String(t._id) },
          lines: [{ accountId: acc.payrollPayable, debit: t.net }, { accountId: account, credit: t.net }],
        },
        {
          inTx: async (session, { journal }) => {
            const res = await terminationsOf(tenantId).updateOne(
              { _id: t._id, status: 'posted', payment: { $exists: false } },
              { $set: { payment: { date, account, total: t.net, journalId: journal._id, document: `PL${journal.number}`, by: ctx.userId ?? null, at: now() } } },
              { session },
            );
            if (res.matchedCount === 0) fail('el pago ya se hizo', 'INVALID_STATE');
            await ctx.auditTx?.(session, { action: 'payroll.termination_pay', target: t._id, details: { employee: t.employee.documentNumber, total: t.net } });
          },
        },
      );
      return { termination: await api.get(tenantId, id) };
    },

    /** Anula una liquidación sin pago: reversa el asiento y devuelve al empleado a su estado anterior. */
    async void(tenantId, id, ctx = {}) {
      const t = await api.get(tenantId, id);
      if (!t) fail('la liquidación no existe', 'NOT_FOUND');
      if (t.status === 'void') return { termination: t, replayed: true };
      if (t.payment) fail('la liquidación tiene un pago: no se anula', 'INVALID_STATE');
      await ledger.reverseJournal(
        tenantId,
        t.journalId,
        { idempotencyKey: `termination-void-${t._id}`, date: t.endDate, description: `Anulación de la liquidación de contrato de ${t.employee.name}` },
        {
          inTx: async (session, { journal }) => {
            const res = await terminationsOf(tenantId).updateOne(
              { _id: t._id, status: 'posted', payment: { $exists: false } },
              { $set: { status: 'void', voidJournalId: journal._id, voidedAt: now(), voidedBy: ctx.userId ?? null } },
              { session },
            );
            if (res.matchedCount === 0) fail('la liquidación cambió mientras se anulaba', 'INVALID_STATE');
            await employeesOf(tenantId).updateOne({ _id: t.employeeId, terminationId: t._id }, { $set: { active: true }, $unset: { endDate: '', terminationId: '' } }, { session });
            await ctx.auditTx?.(session, { action: 'payroll.termination_void', target: t._id, details: { employee: t.employee.documentNumber } });
          },
        },
      );
      return { termination: await api.get(tenantId, id), replayed: false };
    },
  };
  return api;
}
