import { roundDiv } from '../invoicing/tax.js';

/*
 * Cálculo de la nómina mensual colombiana de un empleado. Todo en enteros (unidades menores) con BigInt y redondeo medio
 * hacia arriba; las tarifas en puntos básicos. Los valores que cambian cada año por decreto (salario mínimo, auxilio de
 * transporte, UVT) NO están en el código: los trae la configuración de la empresa. Las tarifas de ley se cargan por omisión y
 * se pueden ajustar. Es un borrador que debe validar el contador: la retención en la fuente usa el procedimiento 1
 * simplificado (sin dependientes, intereses de vivienda ni medicina prepagada) y se puede reemplazar por empleado.
 */

export const DEFAULT_RATES = {
  employeeHealth: 400,
  employeePension: 400,
  employerHealth: 850,
  employerPension: 1200,
  caja: 400,
  sena: 200,
  icbf: 300,
  cesantias: 833,
  cesantiasInterest: 100,
  prima: 833,
  vacations: 417,
};
/** Tarifas de ARL por nivel de riesgo (I a V) en cienmilésimas: 522 es 0,522 %. */
export const DEFAULT_ARL = [522, 1044, 2436, 4350, 6960];
export const DEFAULT_SOLIDARITY = [
  { fromSmmlv: 4, rateBps: 100 },
  { fromSmmlv: 16, rateBps: 120 },
  { fromSmmlv: 17, rateBps: 140 },
  { fromSmmlv: 18, rateBps: 160 },
  { fromSmmlv: 19, rateBps: 180 },
  { fromSmmlv: 20, rateBps: 200 },
];
/** Procedimiento 1 del artículo 383 del Estatuto Tributario, en UVT: [desde, tarifa en puntos básicos, UVT que se suman]. */
export const WITHHOLDING_TABLE = [
  [0, 0, 0],
  [95, 1900, 0],
  [150, 2800, 10],
  [360, 3300, 69],
  [640, 3500, 162],
  [945, 3700, 268],
  [2300, 3900, 770],
];
export const EXEMPT_RATE_BPS = 2500;
export const EXEMPT_CAP_UVT_YEAR = 790;

export class PayrollCalcError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PayrollCalcError';
    this.code = 'VALIDATION';
  }
}

/** Porcentaje en puntos básicos de un importe entero, medio hacia arriba. */
export const pct = (amount, bps) => Number(roundDiv(BigInt(amount) * BigInt(bps), 10_000n));
const ratio = (amount, numerator, denominator) => Number(roundDiv(BigInt(amount) * BigInt(numerator), BigInt(denominator)));

/** Completa los parámetros de un año con las tarifas por omisión. Los importes del año (SMMLV, auxilio, UVT) son obligatorios. */
export function resolveParams(raw) {
  if (!raw) throw new PayrollCalcError('faltan los parámetros de nómina de este año');
  for (const key of ['smmlv', 'transportAid', 'uvt']) {
    if (!Number.isSafeInteger(raw[key]) || raw[key] <= 0) throw new PayrollCalcError(`falta ${{ smmlv: 'el salario mínimo', transportAid: 'el auxilio de transporte', uvt: 'el valor de la UVT' }[key]} del año`);
  }
  return {
    smmlv: raw.smmlv,
    transportAid: raw.transportAid,
    uvt: raw.uvt,
    exonerated: raw.exonerated !== false,
    withholding: raw.withholding !== false,
    aidLimitSmmlv: raw.aidLimitSmmlv ?? 2,
    ibcMaxSmmlv: raw.ibcMaxSmmlv ?? 25,
    integralMinSmmlv: raw.integralMinSmmlv ?? 13,
    rates: { ...DEFAULT_RATES, ...(raw.rates ?? {}) },
    arl: raw.arl ?? DEFAULT_ARL,
    solidarity: raw.solidarity ?? DEFAULT_SOLIDARITY,
  };
}

/** Días trabajados del mes con la convención de 30 días, según el ingreso y el retiro. `null` si no estuvo vinculado en el mes. */
export function daysInMonth(employee, period) {
  const [y, m] = period.split('-').map(Number);
  const monthStart = new Date(Date.UTC(y, m - 1, 1));
  const nextMonth = new Date(Date.UTC(y, m, 1));
  const hire = new Date(employee.hireDate);
  const end = employee.endDate ? new Date(employee.endDate) : null;
  if (hire >= nextMonth || (end && end < monthStart)) return null;
  const from = hire >= monthStart ? Math.min(30, hire.getUTCDate()) : 1;
  const to = end && end < nextMonth ? Math.min(30, end.getUTCDate()) : 30;
  return Math.max(0, to - from + 1);
}

/** Retención en la fuente mensual por salarios (procedimiento 1 simplificado), redondeada al millar. */
export function monthlyWithholding({ income, mandatory, uvt, exponent = 2 }) {
  const net = income - mandatory;
  if (net <= 0) return 0;
  const exempt = Math.min(pct(net, EXEMPT_RATE_BPS), ratio(EXEMPT_CAP_UVT_YEAR * uvt, 1, 12));
  const taxable = net - exempt;
  let tax = 0;
  for (let i = WITHHOLDING_TABLE.length - 1; i >= 0; i -= 1) {
    const [from, rate, add] = WITHHOLDING_TABLE[i];
    if (taxable > from * uvt) {
      tax = pct(taxable - from * uvt, rate) + add * uvt;
      break;
    }
  }
  const step = 1000 * 10 ** exponent;
  return Math.round(tax / step) * step;
}

/**
 * Liquida a un empleado en un mes. `novelty`: `daysWorked` (por omisión los del mes), `salaryExtras` (horas extras,
 * comisiones: base de aportes y prestaciones), `nonSalaryExtras` (bonos no salariales), `otherDeductions` (préstamos,
 * embargos) y `withholding` (reemplaza el cálculo). Devuelve todos los renglones, que se guardan con la corrida.
 */
export function calculateEmployee(employee, novelty, params, period) {
  const monthDays = daysInMonth(employee, period);
  if (monthDays === null) throw new PayrollCalcError(`${employee.name} no estaba vinculado en ${period}`);
  const days = novelty?.daysWorked ?? monthDays;
  if (!Number.isInteger(days) || days < 0 || days > 30) throw new PayrollCalcError(`${employee.name}: los días trabajados van de 0 a 30`);
  const money = (value, label) => {
    const v = value ?? 0;
    if (!Number.isSafeInteger(v) || v < 0) throw new PayrollCalcError(`${employee.name}: ${label} debe ser un entero no negativo`);
    return v;
  };
  const salaryExtras = money(novelty?.salaryExtras, 'los extras salariales');
  const nonSalaryExtras = money(novelty?.nonSalaryExtras, 'los extras no salariales');
  const otherDeductions = money(novelty?.otherDeductions, 'las otras deducciones');
  const integral = employee.salaryType === 'integral';
  const salaryEarned = ratio(employee.baseSalary, days, 30);
  const aid = !integral && days > 0 && employee.transportAid !== false && employee.baseSalary <= params.aidLimitSmmlv * params.smmlv ? ratio(params.transportAid, days, 30) : 0;

  // Base de aportes: el salario devengado más los extras salariales (el integral cotiza sobre el 70 %).
  const salaryBase = salaryEarned + salaryExtras;
  const contribBase = integral ? pct(salaryBase, 7000) : salaryBase;
  const ibcMin = ratio(params.smmlv, days, 30);
  const ibcMax = params.ibcMaxSmmlv * params.smmlv;
  const ibc = days === 0 ? 0 : Math.min(Math.max(contribBase, ibcMin), ibcMax);

  const r = params.rates;
  const health = pct(ibc, r.employeeHealth);
  const pension = pct(ibc, r.employeePension);
  const solidarityRate = [...params.solidarity].reverse().find((s) => ibc >= s.fromSmmlv * params.smmlv)?.rateBps ?? 0;
  const solidarity = pct(ibc, solidarityRate);
  const gross = salaryBase + nonSalaryExtras + aid;
  const withholding = novelty?.withholding !== undefined ? money(novelty.withholding, 'la retención') : params.withholding ? monthlyWithholding({ income: gross, mandatory: health + pension + solidarity, uvt: params.uvt }) : 0;
  const deductions = health + pension + solidarity + withholding + otherDeductions;
  const net = gross - deductions;
  if (net < 0) throw new PayrollCalcError(`${employee.name}: las deducciones superan lo devengado`);

  const exonerated = params.exonerated && ibc < 10 * params.smmlv;
  const employer = {
    health: exonerated ? 0 : pct(ibc, r.employerHealth),
    pension: pct(ibc, r.employerPension),
    arl: ratio(ibc, params.arl[(employee.arlRiskLevel ?? 1) - 1], 100_000),
    caja: pct(contribBase, r.caja),
    sena: exonerated ? 0 : pct(contribBase, r.sena),
    icbf: exonerated ? 0 : pct(contribBase, r.icbf),
  };
  const prestationsBase = integral ? 0 : salaryBase + aid;
  const provisions = {
    cesantias: pct(prestationsBase, r.cesantias),
    cesantiasInterest: pct(prestationsBase, r.cesantiasInterest),
    prima: pct(prestationsBase, r.prima),
    vacations: pct(salaryBase, r.vacations),
  };
  return {
    days,
    salaryEarned,
    salaryExtras,
    nonSalaryExtras,
    transportAid: aid,
    gross,
    ibc,
    employee: { health, pension, solidarity, withholding, otherDeductions },
    deductions,
    net,
    employer,
    employerTotal: Object.values(employer).reduce((a, b) => a + b, 0),
    provisions,
    provisionsTotal: Object.values(provisions).reduce((a, b) => a + b, 0),
    exonerated,
  };
}
