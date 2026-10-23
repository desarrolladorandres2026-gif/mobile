import { ObjectId } from 'mongodb';
import { COLLECTIONS } from '../data/db.js';
import { TenantCollection } from '../data/tenantCollection.js';

export class PayrollReportError extends Error {
  constructor(message, code = 'VALIDATION') {
    super(message);
    this.name = 'PayrollReportError';
    this.code = code;
  }
}

const fail = (message, code) => {
  throw new PayrollReportError(message, code);
};
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const sum = (items, pick) => items.reduce((acc, item) => acc + pick(item), 0);
const MAX_MONTHS = 36;

/*
 * Reportes de nómina, calculados desde las corridas liquidadas (no desde el libro): aportes a la seguridad social y
 * parafiscales por empleado y por mes (la base para preparar la planilla integrada de aportes), provisiones y su conciliación
 * con el libro, y el desprendible de pago de un empleado.
 */
export function createPayrollReports({ db, accounts, payroll }) {
  const runsOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.payrollRuns), tenantId);
  const benefitsOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.payrollBenefits), tenantId);
  const balancesOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.balances), tenantId);
  const tenants = db.collection(COLLECTIONS.tenants);

  return {
    /** Por mes y por empleado: base de cotización, salud, pensión, fondo de solidaridad, ARL y parafiscales. */
    async contributions(tenantId, { from, to }) {
      if (!PERIOD.test(String(from ?? '')) || !PERIOD.test(String(to ?? ''))) fail('el rango se pide por meses: AAAA-MM');
      if (from > to) fail('el mes inicial no puede ser posterior al final');
      const months = (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5)) - Number(from.slice(5)) + 1;
      if (months > MAX_MONTHS) fail(`el rango admite hasta ${MAX_MONTHS} meses`);
      const runs = await runsOf(tenantId).find({ status: 'posted', period: { $gte: from, $lte: to } }, { sort: { period: 1 } }).toArray();
      const rows = runs.flatMap((run) =>
        run.items.map((i) => ({
          period: run.period,
          employeeId: i.employeeId,
          name: i.name,
          documentType: i.documentType,
          documentNumber: i.documentNumber,
          days: i.days,
          ibc: i.ibc,
          employeeHealth: i.employee.health,
          employerHealth: i.employer.health,
          employeePension: i.employee.pension,
          solidarity: i.employee.solidarity,
          employerPension: i.employer.pension,
          arl: i.employer.arl,
          caja: i.employer.caja,
          sena: i.employer.sena,
          icbf: i.employer.icbf,
        })),
      );
      const total = (list) => ({
        ibc: sum(list, (r) => r.ibc),
        health: sum(list, (r) => r.employeeHealth + r.employerHealth),
        pension: sum(list, (r) => r.employeePension + r.solidarity + r.employerPension),
        arl: sum(list, (r) => r.arl),
        caja: sum(list, (r) => r.caja),
        sena: sum(list, (r) => r.sena),
        icbf: sum(list, (r) => r.icbf),
      });
      const periods = [...new Set(rows.map((r) => r.period))];
      return {
        from,
        to,
        rows,
        months: periods.map((period) => ({ period, ...total(rows.filter((r) => r.period === period)), employees: rows.filter((r) => r.period === period).length })),
        totals: total(rows),
      };
    },

    /**
     * Provisiones de cesantías, intereses, prima y vacaciones: lo provisionado por las nóminas, lo ya liquidado y lo que queda,
     * contra el saldo de cada cuenta de pasivo en el libro.
     */
    async provisions(tenantId) {
      const acc = await payroll.requiredAccounts(tenantId);
      const tenant = await tenants.findOne({ _id: tenantId }, { projection: { currency: 1 } });
      const runs = await runsOf(tenantId).find({ status: 'posted' }).toArray();
      const benefits = await benefitsOf(tenantId).find({ status: 'posted' }).toArray();
      const provisioned = { cesantias: 0, cesantiasInterest: 0, prima: 0, vacations: 0 };
      const byEmployee = new Map();
      for (const run of runs) {
        for (const item of run.items) {
          const row = byEmployee.get(String(item.employeeId)) ?? { employeeId: item.employeeId, name: item.name, cesantias: 0, cesantiasInterest: 0, prima: 0, vacations: 0 };
          for (const key of Object.keys(provisioned)) {
            row[key] += item.provisions[key];
            provisioned[key] += item.provisions[key];
          }
          byEmployee.set(String(item.employeeId), row);
        }
      }
      const settled = { cesantias: 0, cesantiasInterest: 0, prima: 0, vacations: 0 };
      for (const b of benefits) {
        for (const item of b.items) {
          const row = byEmployee.get(String(item.employeeId));
          if (b.kind === 'prima') {
            settled.prima += item.accrued;
            if (row) row.prima -= item.accrued;
          } else {
            settled.cesantias += item.accrued;
            settled.cesantiasInterest += item.accruedInterest;
            if (row) {
              row.cesantias -= item.accrued;
              row.cesantiasInterest -= item.accruedInterest;
            }
          }
        }
      }
      const accountOf = { cesantias: acc.cesantiasPayable, cesantiasInterest: acc.cesantiasInterestPayable, prima: acc.primaPayable, vacations: acc.vacationsPayable };
      const codes = Object.values(accountOf);
      const balanceRows = await balancesOf(tenantId)
        .aggregate([{ $match: { currency: tenant.currency, accountId: { $in: codes } } }, { $group: { _id: '$accountId', debit: { $sum: '$debit' }, credit: { $sum: '$credit' } } }])
        .toArray();
      const ledger = new Map(balanceRows.map((r) => [r._id, Number(r.credit) - Number(r.debit)]));
      const names = new Map((await accounts.list(tenantId)).map((a) => [a.code, a.name]));
      const lines = Object.keys(provisioned).map((key) => {
        const outstanding = provisioned[key] - settled[key];
        const ledgerBalance = ledger.get(accountOf[key]) ?? 0;
        return { key, account: accountOf[key], name: names.get(accountOf[key]) ?? null, provisioned: provisioned[key], settled: settled[key], outstanding, ledger: ledgerBalance, difference: ledgerBalance - outstanding };
      });
      return {
        currency: tenant.currency,
        lines,
        ok: lines.every((l) => l.difference === 0),
        employees: [...byEmployee.values()].filter((e) => e.cesantias || e.cesantiasInterest || e.prima || e.vacations).sort((a, b) => (a.name < b.name ? -1 : 1)),
      };
    },

    /** El desprendible de pago de un empleado en una corrida: devengado, deducciones y neto. */
    async payslip(tenantId, runId, employeeId) {
      if (!/^[a-f0-9]{24}$/.test(String(runId)) || !/^[a-f0-9]{24}$/.test(String(employeeId))) fail('corrida o empleado inválido');
      const run = await runsOf(tenantId).findOne({ _id: new ObjectId(runId) });
      if (!run) fail('la corrida no existe', 'NOT_FOUND');
      const item = run.items.find((i) => String(i.employeeId) === String(employeeId));
      if (!item) fail('el empleado no está en esa corrida', 'NOT_FOUND');
      const tenant = await tenants.findOne({ _id: tenantId }, { projection: { name: 1, currency: 1 } });
      return {
        company: tenant.name,
        currency: tenant.currency,
        period: run.period,
        status: run.status,
        document: run.document,
        paid: run.payment ? run.payment.date : null,
        employee: { name: item.name, documentType: item.documentType, documentNumber: item.documentNumber, baseSalary: item.baseSalary },
        days: item.days,
        earnings: [
          { label: 'Salario', amount: item.salaryEarned },
          ...(item.salaryExtras ? [{ label: 'Extras salariales', amount: item.salaryExtras }] : []),
          ...(item.nonSalaryExtras ? [{ label: 'Extras no salariales', amount: item.nonSalaryExtras }] : []),
          ...(item.transportAid ? [{ label: 'Auxilio de transporte', amount: item.transportAid }] : []),
        ],
        deductions: [
          { label: 'Salud', amount: item.employee.health },
          { label: 'Pensión', amount: item.employee.pension },
          ...(item.employee.solidarity ? [{ label: 'Fondo de solidaridad pensional', amount: item.employee.solidarity }] : []),
          ...(item.employee.withholding ? [{ label: 'Retención en la fuente', amount: item.employee.withholding }] : []),
          ...(item.employee.otherDeductions ? [{ label: 'Otras deducciones', amount: item.employee.otherDeductions }] : []),
        ],
        gross: item.gross,
        totalDeductions: item.deductions,
        net: item.net,
      };
    },
  };
}
