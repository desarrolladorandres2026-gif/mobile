import { ObjectId } from 'mongodb';
import { DAY_MS, dayOf, parseDay as parseCalendarDay } from '../core/dates.js';
import { normalizeCenter } from '../core/dims.js';
import { assertMinorUnits } from '../core/money.js';
import { COLLECTIONS } from '../data/db.js';
import { TenantCollection } from '../data/tenantCollection.js';
import { isDuplicate } from '../data/tx.js';
import { PayrollCalcError, calculateEmployee, resolveParams } from './calc.js';

export const MAX_EMPLOYEES_PER_RUN = 500;
export const MAX_PAGE = 50;
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const CONTRACTS = ['indefinite', 'fixed', 'service'];
const SALARY_TYPES = ['ordinary', 'integral'];
const DOC_TYPES = ['CC', 'CE', 'TI', 'PASSPORT', 'PEP', 'PPT'];

/** Cuentas que la nómina necesita, con el tipo que debe tener cada una. `expense`: gasto o costo; `liability`: pasivo. */
export const ACCOUNT_KEYS = {
  salaryExpense: 'expense',
  nonSalaryExpense: 'expense',
  transportExpense: 'expense',
  employerHealthExpense: 'expense',
  employerPensionExpense: 'expense',
  arlExpense: 'expense',
  cajaExpense: 'expense',
  senaExpense: 'expense',
  icbfExpense: 'expense',
  cesantiasExpense: 'expense',
  cesantiasInterestExpense: 'expense',
  primaExpense: 'expense',
  vacationsExpense: 'expense',
  payrollPayable: 'liability',
  healthPayable: 'liability',
  pensionPayable: 'liability',
  arlPayable: 'liability',
  cajaPayable: 'liability',
  senaPayable: 'liability',
  icbfPayable: 'liability',
  withholdingPayable: 'liability',
  deductionsPayable: 'liability',
  cesantiasPayable: 'liability',
  cesantiasInterestPayable: 'liability',
  primaPayable: 'liability',
  vacationsPayable: 'liability',
};

export class PayrollError extends Error {
  constructor(message, code = 'VALIDATION') {
    super(message);
    this.name = 'PayrollError';
    this.code = code;
  }
}

const fail = (message, code) => {
  throw new PayrollError(message, code);
};
const parseDay = (value, label) => parseCalendarDay(value, label, fail);
const text = (value, label, { required = false, max = 200 } = {}) => {
  const clean = String(value ?? '').trim();
  if (required && !clean) fail(`falta ${label}`);
  if (clean.length > max) fail(`${label} admite como máximo ${max} caracteres`);
  return clean || undefined;
};
const objectId = (value, label) => (/^[a-f0-9]{24}$/.test(String(value ?? '')) ? new ObjectId(String(value)) : fail(`${label} inválido`));
const sum = (items, pick) => items.reduce((acc, item) => acc + pick(item), 0);

/*
 * Nómina mensual. Empleados con su contrato, parámetros del año (los que cambian por decreto los trae la empresa) y las
 * cuentas contables; cada mes se liquida a todos los empleados vinculados en una corrida que asienta un solo comprobante
 * `NM` y se puede pagar (`PN`) y pagar sus aportes (`PA`).
 *
 *  - **Liquidar** calcula devengado, deducciones del empleado, aportes patronales y provisiones (`calc.js`) y asienta:
 *    gasto de salarios, auxilio de transporte, aportes patronales y provisiones contra el neto por pagar, las
 *    retenciones y aportes por pagar y las provisiones. Una corrida por mes; se puede anular mientras no se haya pagado.
 *  - El salario base de un empleado y los parámetros del año se guardan con la corrida: cambiarlos después no reescribe lo
 *    liquidado.
 *  - **Pagar** asienta contra caja o bancos el neto por pagar de la corrida; **pagar aportes** cancela salud, pensión,
 *    ARL, caja, SENA e ICBF. Cada uno se hace una sola vez (condición en la actualización, dentro de la transacción).
 *  - La vista previa calcula todo igual y no guarda nada.
 *
 * Límites: es un borrador que debe validar el contador (retención simplificada, ver `calc.js`); no hay quincenas,
 * incapacidades ni licencias como novedad (se liquidan como días trabajados), vacaciones disfrutadas, préstamos con cuotas,
 * liquidación de contrato ni nómina electrónica ante la DIAN (requiere un proveedor autorizado).
 */
export function createPayrollService({ client, db, ledger, accounts, now = () => new Date() }) {
  const employeesOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.employees), tenantId);
  const configOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.payrollConfig), tenantId);
  const runsOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.payrollRuns), tenantId);
  const tenants = db.collection(COLLECTIONS.tenants);

  async function tenantInfo(tenantId) {
    const tenant = await tenants.findOne({ _id: tenantId }, { projection: { currency: 1, country: 1 } });
    if (!tenant) fail('la empresa no existe', 'NOT_FOUND');
    return tenant;
  }

  const lastDayOf = (period) => {
    const [y, m] = period.split('-').map(Number);
    const end = new Date(Date.UTC(y, m, 0, 12));
    const today = parseCalendarDay(dayOf(now()), 'hoy', fail);
    return end > today ? today : end;
  };

  async function getConfigDoc(tenantId) {
    return (await configOf(tenantId).findOne({})) ?? { accounts: {}, years: {} };
  }

  async function requireAccounts(tenantId) {
    const config = await getConfigDoc(tenantId);
    const missing = Object.keys(ACCOUNT_KEYS).filter((k) => !config.accounts?.[k]);
    if (missing.length) fail(`faltan las cuentas de nómina: ${missing.join(', ')}`, 'SETTINGS_INCOMPLETE');
    return config.accounts;
  }

  const presentEmployee = (e) => e;


  const api = {
    // ---- Configuración ----

    /** Las cuentas contables de nómina, o el error que dice cuáles faltan. Las usan las prestaciones sociales. */
    requiredAccounts: (tenantId) => requireAccounts(tenantId),

    async getConfig(tenantId) {
      const config = await getConfigDoc(tenantId);
      return { accounts: config.accounts ?? {}, years: config.years ?? {}, requiredAccounts: ACCOUNT_KEYS };
    },

    /** Guarda las cuentas contables de nómina (reemplaza las que se envían). */
    async saveAccounts(tenantId, input, ctx = {}) {
      const next = {};
      const chart = new Map((await accounts.list(tenantId)).map((a) => [a.code, a]));
      for (const [key, value] of Object.entries(input.accounts ?? {})) {
        if (!ACCOUNT_KEYS[key]) fail(`la cuenta «${key}» no existe en la nómina`);
        const code = String(value ?? '').trim();
        if (!/^[0-9]{1,12}$/.test(code)) fail(`${key}: indica el código de la cuenta`);
        const account = chart.get(code);
        if (!account) fail(`${key}: la cuenta ${code} no existe`);
        if (!account.postable || !account.active) fail(`${key}: la cuenta ${code} no recibe asientos`);
        const wanted = ACCOUNT_KEYS[key];
        if (wanted === 'liability' ? account.type !== 'liability' : !['expense', 'cost'].includes(account.type)) fail(`${key}: la cuenta ${code} debe ser de ${wanted === 'liability' ? 'pasivo' : 'gasto o costo'}`);
        next[key] = code;
      }
      if (!Object.keys(next).length) fail('no hay cuentas que guardar');
      const config = await getConfigDoc(tenantId);
      await configOf(tenantId).updateOne({}, { $set: { accounts: { ...(config.accounts ?? {}), ...next }, updatedAt: now() } }, { upsert: true });
      await ctx.auditTx?.(undefined, { action: 'payroll.accounts', details: { keys: Object.keys(next).length } });
      return api.getConfig(tenantId);
    },

    /** Guarda los parámetros de un año (salario mínimo, auxilio de transporte, UVT y, si se quiere, tarifas). */
    async saveParams(tenantId, year, input, ctx = {}) {
      if (!/^\d{4}$/.test(String(year))) fail('el año debe tener cuatro cifras');
      const params = input.params ?? {};
      for (const key of ['smmlv', 'transportAid', 'uvt']) assertMinorUnits(params[key], key);
      try {
        resolveParams(params);
      } catch (err) {
        if (err instanceof PayrollCalcError) fail(err.message);
        throw err;
      }
      for (const [name, rate] of Object.entries(params.rates ?? {})) if (!Number.isInteger(rate) || rate < 0 || rate > 10_000) fail(`la tarifa ${name} va de 0 a 10000 puntos básicos`);
      if (params.arl && (!Array.isArray(params.arl) || params.arl.length !== 5 || params.arl.some((r) => !Number.isInteger(r) || r < 0 || r > 100_000))) fail('la ARL lleva cinco tarifas (niveles I a V) en cienmilésimas');
      await configOf(tenantId).updateOne({}, { $set: { [`years.${year}`]: { ...params, updatedAt: now() }, updatedAt: now() } }, { upsert: true });
      await ctx.auditTx?.(undefined, { action: 'payroll.params', details: { year } });
      return api.getConfig(tenantId);
    },

    // ---- Empleados ----

    async createEmployee(tenantId, input, ctx = {}) {
      const documentType = DOC_TYPES.includes(input.documentType) ? input.documentType : fail('el tipo de documento no es válido');
      const documentNumber = text(input.documentNumber, 'el número de documento', { required: true, max: 20 });
      const name = text(input.name, 'el nombre', { required: true, max: 200 });
      const hireDate = parseDay(input.hireDate, 'la fecha de ingreso');
      if (hireDate.getTime() > now().getTime() + 62 * DAY_MS) fail('la fecha de ingreso es demasiado lejana');
      const endDate = input.endDate ? parseDay(input.endDate, 'la fecha de retiro') : undefined;
      if (endDate && endDate < hireDate) fail('el retiro no puede ser anterior al ingreso');
      const baseSalary = assertMinorUnits(input.baseSalary, 'el salario');
      if (baseSalary <= 0) fail('el salario debe ser mayor que cero');
      const costCenter = normalizeCenter(input.costCenter);
      if (costCenter && !(await db.collection(COLLECTIONS.costCenters).findOne({ tenantId, code: costCenter, active: true }))) fail(`el centro de costo ${costCenter} no existe o está inactivo`);
      const doc = {
        documentType,
        documentNumber,
        name,
        hireDate,
        ...(endDate ? { endDate } : {}),
        contractType: CONTRACTS.includes(input.contractType) ? input.contractType : 'indefinite',
        salaryType: SALARY_TYPES.includes(input.salaryType) ? input.salaryType : 'ordinary',
        baseSalary,
        transportAid: input.transportAid !== false,
        arlRiskLevel: [1, 2, 3, 4, 5].includes(input.arlRiskLevel) ? input.arlRiskLevel : 1,
        ...(costCenter ? { costCenter } : {}),
        ...(text(input.position, 'el cargo', { max: 100 }) ? { position: text(input.position, 'el cargo', { max: 100 }) } : {}),
        ...(text(input.email, 'el correo', { max: 200 }) ? { email: text(input.email, 'el correo', { max: 200 }) } : {}),
        active: true,
        createdBy: ctx.userId ?? null,
        createdAt: now(),
      };
      try {
        const { insertedId } = await employeesOf(tenantId).insertOne({ ...doc });
        await ctx.auditTx?.(undefined, { action: 'employee.create', target: insertedId, details: { documentNumber } });
        return presentEmployee({ ...doc, _id: insertedId, tenantId });
      } catch (err) {
        if (isDuplicate(err, 'tenant_employee_document')) fail(`ya existe un empleado con el documento ${documentType} ${documentNumber}`, 'DUPLICATE');
        throw err;
      }
    },

    async getEmployee(tenantId, id) {
      return presentEmployee(await employeesOf(tenantId).findOne({ _id: objectId(id, 'el empleado') }));
    },

    async listEmployees(tenantId, { active, limit = 25, cursor } = {}) {
      const size = Math.min(Math.max(Number(limit) || 25, 1), MAX_PAGE);
      const filter = { ...(active === undefined ? {} : { active: active === true || active === 'true' }), ...(cursor ? { _id: { $lt: objectId(cursor, 'el cursor') } } : {}) };
      const rows = await employeesOf(tenantId).find(filter, { sort: { _id: -1 }, limit: size + 1 }).toArray();
      const hasMore = rows.length > size;
      const items = hasMore ? rows.slice(0, size) : rows;
      return { items: items.map(presentEmployee), nextCursor: hasMore ? items[items.length - 1]._id.toHexString() : null };
    },

    /** Cambia datos del empleado. El nuevo salario rige para las corridas que se hagan desde ahora; lo liquidado no cambia. */
    async updateEmployee(tenantId, id, input, ctx = {}) {
      const employee = await employeesOf(tenantId).findOne({ _id: objectId(id, 'el empleado') });
      if (!employee) fail('el empleado no existe', 'NOT_FOUND');
      const set = {};
      const unset = {};
      if (input.name !== undefined) set.name = text(input.name, 'el nombre', { required: true, max: 200 });
      if (input.baseSalary !== undefined) {
        set.baseSalary = assertMinorUnits(input.baseSalary, 'el salario');
        if (set.baseSalary <= 0) fail('el salario debe ser mayor que cero');
      }
      if (input.salaryType !== undefined) set.salaryType = SALARY_TYPES.includes(input.salaryType) ? input.salaryType : fail('el tipo de salario no es válido');
      if (input.contractType !== undefined) set.contractType = CONTRACTS.includes(input.contractType) ? input.contractType : fail('el tipo de contrato no es válido');
      if (input.transportAid !== undefined) set.transportAid = Boolean(input.transportAid);
      if (input.arlRiskLevel !== undefined) set.arlRiskLevel = [1, 2, 3, 4, 5].includes(input.arlRiskLevel) ? input.arlRiskLevel : fail('el nivel de riesgo va de 1 a 5');
      if (input.active !== undefined) set.active = Boolean(input.active);
      if (input.endDate !== undefined) {
        if (input.endDate === '') unset.endDate = '';
        else {
          const endDate = parseDay(input.endDate, 'la fecha de retiro');
          if (endDate < employee.hireDate) fail('el retiro no puede ser anterior al ingreso');
          set.endDate = endDate;
        }
      }
      if (input.costCenter !== undefined) {
        const c = normalizeCenter(input.costCenter);
        if (c) {
          if (!(await db.collection(COLLECTIONS.costCenters).findOne({ tenantId, code: c, active: true }))) fail(`el centro de costo ${c} no existe o está inactivo`);
          set.costCenter = c;
        } else unset.costCenter = '';
      }
      for (const key of ['position', 'email']) {
        if (input[key] === undefined) continue;
        const v = text(input[key], key === 'email' ? 'el correo' : 'el cargo', { max: 200 });
        if (v) set[key] = v;
        else unset[key] = '';
      }
      if (!Object.keys(set).length && !Object.keys(unset).length) fail('no hay nada que cambiar');
      await employeesOf(tenantId).updateOne({ _id: employee._id }, { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) });
      await ctx.auditTx?.(undefined, { action: 'employee.update', target: employee._id, details: { fields: [...Object.keys(set), ...Object.keys(unset)] } });
      return api.getEmployee(tenantId, id);
    },

    // ---- Corridas ----

    /** Calcula la nómina de un mes sin guardarla: los renglones, los totales y los empleados con problemas. */
    async preview(tenantId, { period, novelties = [] }) {
      if (!PERIOD.test(String(period ?? ''))) fail('el período debe tener el formato AAAA-MM');
      const config = await getConfigDoc(tenantId);
      let params;
      try {
        params = resolveParams(config.years?.[period.slice(0, 4)]);
      } catch (err) {
        if (err instanceof PayrollCalcError) fail(`${err.message} (configúrelos en Nómina → Parámetros)`, 'SETTINGS_INCOMPLETE');
        throw err;
      }
      const byEmployee = new Map();
      for (const n of novelties) {
        const id = String(n?.employeeId ?? '');
        if (!/^[a-f0-9]{24}$/.test(id)) fail('una novedad trae un empleado inválido');
        if (byEmployee.has(id)) fail('un empleado trae dos novedades');
        byEmployee.set(id, n);
      }
      const employees = await employeesOf(tenantId).find({ active: true }, { sort: { name: 1 }, limit: MAX_EMPLOYEES_PER_RUN + 1 }).toArray();
      if (employees.length > MAX_EMPLOYEES_PER_RUN) fail(`la corrida admite hasta ${MAX_EMPLOYEES_PER_RUN} empleados`);
      for (const id of byEmployee.keys()) if (!employees.some((e) => String(e._id) === id)) fail('una novedad es de un empleado que no existe o está inactivo');
      const items = [];
      const problems = [];
      for (const e of employees) {
        try {
          const calc = calculateEmployee(e, byEmployee.get(String(e._id)), params, period);
          items.push({ employeeId: e._id, name: e.name, documentType: e.documentType, documentNumber: e.documentNumber, ...(e.costCenter ? { costCenter: e.costCenter } : {}), baseSalary: e.baseSalary, salaryType: e.salaryType, ...calc });
        } catch (err) {
          if (!(err instanceof PayrollCalcError)) throw err;
          // Quien no estaba vinculado ese mes simplemente no entra.
          if (!/no estaba vinculado/.test(err.message)) problems.push({ employeeId: e._id, name: e.name, message: err.message });
        }
      }
      const totals = {
        employees: items.length,
        gross: sum(items, (i) => i.gross),
        salary: sum(items, (i) => i.salaryEarned + i.salaryExtras),
        nonSalary: sum(items, (i) => i.nonSalaryExtras),
        transportAid: sum(items, (i) => i.transportAid),
        health: sum(items, (i) => i.employee.health),
        pension: sum(items, (i) => i.employee.pension),
        solidarity: sum(items, (i) => i.employee.solidarity),
        withholding: sum(items, (i) => i.employee.withholding),
        otherDeductions: sum(items, (i) => i.employee.otherDeductions),
        deductions: sum(items, (i) => i.deductions),
        net: sum(items, (i) => i.net),
        employer: Object.fromEntries(['health', 'pension', 'arl', 'caja', 'sena', 'icbf'].map((k) => [k, sum(items, (i) => i.employer[k])])),
        employerTotal: sum(items, (i) => i.employerTotal),
        provisions: Object.fromEntries(['cesantias', 'cesantiasInterest', 'prima', 'vacations'].map((k) => [k, sum(items, (i) => i.provisions[k])])),
        provisionsTotal: sum(items, (i) => i.provisionsTotal),
      };
      return { period, items, totals, problems };
    },

    /** Liquida y asienta la nómina de un mes. Una corrida por mes; repetir la clave devuelve la misma. */
    async createRun(tenantId, input, ctx = {}) {
      const { idempotencyKey, userId } = ctx;
      if (!idempotencyKey?.trim()) fail('falta la clave de idempotencia');
      const previous = await runsOf(tenantId).findOne({ idempotencyKey });
      if (previous) return { run: previous, replayed: true };
      const { period } = input;
      if (!PERIOD.test(String(period ?? ''))) fail('el período debe tener el formato AAAA-MM');
      if (period > dayOf(now()).slice(0, 7)) fail('no se liquida un período futuro');
      if (await runsOf(tenantId).findOne({ period, status: 'posted' })) fail(`la nómina de ${period} ya está liquidada`, 'DUPLICATE');
      const acc = await requireAccounts(tenantId);
      const calc = await api.preview(tenantId, input);
      if (calc.problems.length) fail(`hay empleados con problemas: ${calc.problems.map((p) => `${p.name} (${p.message})`).join('; ')}`);
      if (!calc.items.length) fail('no hay empleados vinculados en ese mes');
      const { currency } = await tenantInfo(tenantId);
      const t = calc.totals;

      // Gastos agrupados por cuenta y centro de costo.
      const debits = new Map();
      const addDebit = (accountId, amount, costCenter) => {
        if (amount <= 0) return;
        const key = `${accountId}|${costCenter ?? ''}`;
        const cur = debits.get(key) ?? { accountId, amount: 0, costCenter };
        cur.amount += amount;
        debits.set(key, cur);
      };
      for (const i of calc.items) {
        addDebit(acc.salaryExpense, i.salaryEarned + i.salaryExtras, i.costCenter);
        addDebit(acc.nonSalaryExpense, i.nonSalaryExtras, i.costCenter);
        addDebit(acc.transportExpense, i.transportAid, i.costCenter);
        addDebit(acc.employerHealthExpense, i.employer.health, i.costCenter);
        addDebit(acc.employerPensionExpense, i.employer.pension, i.costCenter);
        addDebit(acc.arlExpense, i.employer.arl, i.costCenter);
        addDebit(acc.cajaExpense, i.employer.caja, i.costCenter);
        addDebit(acc.senaExpense, i.employer.sena, i.costCenter);
        addDebit(acc.icbfExpense, i.employer.icbf, i.costCenter);
        addDebit(acc.cesantiasExpense, i.provisions.cesantias, i.costCenter);
        addDebit(acc.cesantiasInterestExpense, i.provisions.cesantiasInterest, i.costCenter);
        addDebit(acc.primaExpense, i.provisions.prima, i.costCenter);
        addDebit(acc.vacationsExpense, i.provisions.vacations, i.costCenter);
      }
      const credits = new Map();
      const addCredit = (accountId, amount) => {
        if (amount > 0) credits.set(accountId, (credits.get(accountId) ?? 0) + amount);
      };
      addCredit(acc.payrollPayable, t.net);
      addCredit(acc.healthPayable, t.health + t.employer.health);
      addCredit(acc.pensionPayable, t.pension + t.solidarity + t.employer.pension);
      addCredit(acc.arlPayable, t.employer.arl);
      addCredit(acc.cajaPayable, t.employer.caja);
      addCredit(acc.senaPayable, t.employer.sena);
      addCredit(acc.icbfPayable, t.employer.icbf);
      addCredit(acc.withholdingPayable, t.withholding);
      addCredit(acc.deductionsPayable, t.otherDeductions);
      addCredit(acc.cesantiasPayable, t.provisions.cesantias);
      addCredit(acc.cesantiasInterestPayable, t.provisions.cesantiasInterest);
      addCredit(acc.primaPayable, t.provisions.prima);
      addCredit(acc.vacationsPayable, t.provisions.vacations);
      const lines = [
        ...[...debits.values()].map((d) => ({ accountId: d.accountId, debit: d.amount, ...(d.costCenter ? { costCenter: d.costCenter } : {}) })),
        ...[...credits].map(([accountId, credit]) => ({ accountId, credit })),
      ];

      const runId = new ObjectId();
      try {
        const posted = await ledger.postJournal(
          tenantId,
          { docType: 'NM', date: lastDayOf(period), currency, idempotencyKey: `payroll-${idempotencyKey}`, description: `Nómina de ${period}`, source: { kind: 'payroll', id: String(runId) }, lines },
          {
            inTx: async (session, { journal }) => {
              await runsOf(tenantId).insertOne(
                { _id: runId, idempotencyKey, period, status: 'posted', currency, items: calc.items, totals: t, journalId: journal._id, document: `NM${journal.number}`, createdBy: userId ?? null, createdAt: now() },
                session,
              );
              await ctx.auditTx?.(session, { action: 'payroll.run', target: runId, details: { period, employees: calc.items.length, net: t.net } });
            },
          },
        );
        if (posted.replayed) return { run: await runsOf(tenantId).findOne({ idempotencyKey }), replayed: true };
      } catch (err) {
        if (isDuplicate(err, 'tenant_payroll_period')) fail(`la nómina de ${period} ya está liquidada`, 'DUPLICATE');
        if (isDuplicate(err, 'tenant_payroll_idempotency')) return { run: await runsOf(tenantId).findOne({ idempotencyKey }), replayed: true };
        throw err;
      }
      return { run: await runsOf(tenantId).findOne({ _id: runId }), replayed: false };
    },

    async getRun(tenantId, id) {
      return runsOf(tenantId).findOne({ _id: objectId(id, 'la corrida') });
    },

    async listRuns(tenantId, { limit = 25, cursor } = {}) {
      const size = Math.min(Math.max(Number(limit) || 25, 1), MAX_PAGE);
      const rows = await runsOf(tenantId)
        .find({ ...(cursor ? { _id: { $lt: objectId(cursor, 'el cursor') } } : {}) }, { sort: { _id: -1 }, limit: size + 1, projection: { items: 0 } })
        .toArray();
      const hasMore = rows.length > size;
      const items = hasMore ? rows.slice(0, size) : rows;
      return { items, nextCursor: hasMore ? items[items.length - 1]._id.toHexString() : null };
    },

    /** Anula una corrida que no se ha pagado: reversa su asiento. */
    async voidRun(tenantId, id, ctx = {}) {
      const run = await runsOf(tenantId).findOne({ _id: objectId(id, 'la corrida') });
      if (!run) fail('la corrida no existe', 'NOT_FOUND');
      if (run.status === 'void') return { run, replayed: true };
      if (run.payment || run.contributionsPayment) fail('la corrida tiene pagos: anúlalos primero', 'INVALID_STATE');
      if (await db.collection(COLLECTIONS.payrollTerminations).findOne({ tenantId, status: 'posted', period: run.period })) fail('hay liquidaciones de contrato de ese mes: anúlalas primero', 'INVALID_STATE');
      if (await db.collection(COLLECTIONS.payrollBenefits).findOne({ tenantId, status: 'posted', fromPeriod: { $lte: run.period }, toPeriod: { $gte: run.period } })) fail('la nómina ya entró en una liquidación de prima o cesantías', 'INVALID_STATE');
      await ledger.reverseJournal(
        tenantId,
        run.journalId,
        { idempotencyKey: `payroll-void-${run._id}`, date: lastDayOf(run.period), description: `Anulación de la nómina de ${run.period}` },
        {
          inTx: async (session, { journal }) => {
            const res = await runsOf(tenantId).updateOne(
              { _id: run._id, status: 'posted', payment: { $exists: false }, contributionsPayment: { $exists: false } },
              { $set: { status: 'void', voidJournalId: journal._id, voidedAt: now(), voidedBy: ctx.userId ?? null } },
              { session },
            );
            if (res.matchedCount === 0) fail('la corrida cambió mientras se anulaba: revisa sus pagos', 'INVALID_STATE');
            await ctx.auditTx?.(session, { action: 'payroll.void', target: run._id, details: { period: run.period } });
          },
        },
      );
      return { run: await runsOf(tenantId).findOne({ _id: run._id }), replayed: false };
    },

    /** Paga el neto de la corrida con una sola salida de caja o bancos. */
    async pay(tenantId, id, input, ctx = {}) {
      return payCommon(tenantId, id, input, ctx, {
        field: 'payment',
        docType: 'PN',
        action: 'payroll.pay',
        label: 'el pago de la nómina',
        amounts: (run, acc) => [{ accountId: acc.payrollPayable, amount: run.totals.net }],
        description: (run) => `Pago de la nómina de ${run.period}`,
      });
    },

    /** Paga los aportes de seguridad social y parafiscales de la corrida (salud, pensión, ARL, caja, SENA e ICBF). */
    async payContributions(tenantId, id, input, ctx = {}) {
      return payCommon(tenantId, id, input, ctx, {
        field: 'contributionsPayment',
        docType: 'PA',
        action: 'payroll.pay_contributions',
        label: 'el pago de aportes',
        amounts: (run, acc) => {
          const t = run.totals;
          return [
            { accountId: acc.healthPayable, amount: t.health + t.employer.health },
            { accountId: acc.pensionPayable, amount: t.pension + t.solidarity + t.employer.pension },
            { accountId: acc.arlPayable, amount: t.employer.arl },
            { accountId: acc.cajaPayable, amount: t.employer.caja },
            { accountId: acc.senaPayable, amount: t.employer.sena },
            { accountId: acc.icbfPayable, amount: t.employer.icbf },
          ];
        },
        description: (run) => `Pago de aportes de la nómina de ${run.period}`,
      });
    },
  };

  async function payCommon(tenantId, id, input, ctx, cfg) {
    const run = await runsOf(tenantId).findOne({ _id: objectId(id, 'la corrida') });
    if (!run) fail('la corrida no existe', 'NOT_FOUND');
    if (run.status !== 'posted') fail('la corrida está anulada', 'INVALID_STATE');
    if (run[cfg.field]) fail(`${cfg.label} ya se hizo`, 'INVALID_STATE');
    const date = parseDay(input.date, 'la fecha del pago');
    if (date.getTime() > now().getTime() + DAY_MS) fail('la fecha del pago no puede ser futura');
    const account = String(input.account ?? '').trim();
    if (!/^[0-9]{1,12}$/.test(account)) fail('indica la cuenta de caja o bancos de donde sale el dinero');
    const problems = await accounts.postingProblems(tenantId, [account]);
    if (problems.length) fail(problems.join('; '));
    if ((await accounts.get(tenantId, account)).type !== 'asset') fail('el dinero sale de una cuenta de activo: caja o bancos');
    const acc = await requireAccounts(tenantId);
    const parts = cfg.amounts(run, acc).filter((p) => p.amount > 0);
    const total = sum(parts, (p) => p.amount);
    if (total <= 0) fail('no hay nada que pagar');
    const lines = [...parts.map((p) => ({ accountId: p.accountId, debit: p.amount })), { accountId: account, credit: total }];
    await ledger.postJournal(
      tenantId,
      { docType: cfg.docType, date, currency: run.currency, idempotencyKey: `payroll-${cfg.field}-${run._id}`, description: cfg.description(run), source: { kind: `payroll_${cfg.field}`, id: String(run._id) }, lines },
      {
        inTx: async (session, { journal }) => {
          const res = await runsOf(tenantId).updateOne(
            { _id: run._id, status: 'posted', [cfg.field]: { $exists: false } },
            { $set: { [cfg.field]: { date, account, total, journalId: journal._id, document: `${cfg.docType}${journal.number}`, by: ctx.userId ?? null, at: now() } } },
            { session },
          );
          if (res.matchedCount === 0) fail(`${cfg.label} ya se hizo o la corrida cambió`, 'INVALID_STATE');
          await ctx.auditTx?.(session, { action: cfg.action, target: run._id, details: { period: run.period, total } });
        },
      },
    );
    return { run: await runsOf(tenantId).findOne({ _id: run._id }) };
  }

  return api;
}
