import { describe, expect, it } from 'vitest';
import { PayrollCalcError, calculateEmployee, daysInMonth, monthlyWithholding, pct, resolveParams } from './calc.js';

// Importes en unidades menores (centavos): 1.423.500,00 → 142_350_000.
const cop = (pesos) => pesos * 100;
const params = resolveParams({ smmlv: cop(1_423_500), transportAid: cop(200_000), uvt: cop(49_799) });
const employee = (patch = {}) => ({ name: 'Ana Pérez', baseSalary: cop(2_000_000), hireDate: new Date('2024-01-15T12:00:00Z'), arlRiskLevel: 1, salaryType: 'ordinary', ...patch });

describe('parámetros', () => {
  it('exigen los importes que cambian cada año y completan las tarifas de ley', () => {
    expect(() => resolveParams(undefined)).toThrow(/parámetros/);
    expect(() => resolveParams({ smmlv: 1, transportAid: 1 })).toThrow(/UVT/);
    expect(() => resolveParams({ smmlv: 0, transportAid: 1, uvt: 1 })).toThrow(/salario mínimo/);
    expect(params.rates).toMatchObject({ employeeHealth: 400, employerPension: 1200, prima: 833 });
    expect(params.exonerated).toBe(true);
    expect(resolveParams({ smmlv: 1, transportAid: 1, uvt: 1, rates: { caja: 500 }, exonerated: false }).rates).toMatchObject({ caja: 500, sena: 200 });
  });
});

describe('días del mes', () => {
  it('cuenta con la convención de 30 días según el ingreso y el retiro', () => {
    expect(daysInMonth(employee(), '2026-10')).toBe(30);
    expect(daysInMonth(employee({ hireDate: new Date('2026-10-11T12:00:00Z') }), '2026-10')).toBe(20);
    expect(daysInMonth(employee({ hireDate: new Date('2026-10-31T12:00:00Z') }), '2026-10')).toBe(1);
    expect(daysInMonth(employee({ endDate: new Date('2026-10-15T12:00:00Z') }), '2026-10')).toBe(15);
    expect(daysInMonth(employee({ hireDate: new Date('2026-11-01T12:00:00Z') }), '2026-10')).toBeNull();
    expect(daysInMonth(employee({ endDate: new Date('2026-09-30T12:00:00Z') }), '2026-10')).toBeNull();
  });
});

describe('retención en la fuente', () => {
  it('no hay retención por debajo de 95 UVT y se redondea al millar', () => {
    expect(monthlyWithholding({ income: cop(2_200_000), mandatory: cop(160_000), uvt: cop(49_799) })).toBe(0);
    expect(monthlyWithholding({ income: 0, mandatory: 0, uvt: cop(49_799) })).toBe(0);
    const tax = monthlyWithholding({ income: cop(12_000_000), mandatory: cop(1_080_000), uvt: cop(49_799) });
    expect(tax % cop(1000)).toBe(0);
    expect(tax).toBe(cop(700_000));
  });

  it('la renta exenta del 25 % tiene tope mensual de 790 UVT / 12', () => {
    const uvt = cop(49_799);
    const big = monthlyWithholding({ income: cop(60_000_000), mandatory: cop(6_000_000), uvt });
    const taxable = cop(54_000_000) - Math.round((790 * uvt) / 12);
    const expected = Math.round((0.37 * (taxable - 945 * uvt) + 268 * uvt) / cop(1000)) * cop(1000);
    expect(Math.abs(big - expected)).toBeLessThanOrEqual(cop(1000));
  });
});

describe('liquidación de un empleado', () => {
  it('salario bajo: auxilio de transporte, aportes de empleado, patronales exoneradas y provisiones', () => {
    const r = calculateEmployee(employee(), {}, params, '2026-10');
    expect(r).toMatchObject({ days: 30, salaryEarned: cop(2_000_000), transportAid: cop(200_000), gross: cop(2_200_000), ibc: cop(2_000_000), exonerated: true });
    expect(r.employee).toEqual({ health: cop(80_000), pension: cop(80_000), solidarity: 0, withholding: 0, otherDeductions: 0 });
    expect(r.net).toBe(cop(2_040_000));
    expect(r.employer).toEqual({ health: 0, pension: cop(240_000), arl: cop(10_440), caja: cop(80_000), sena: 0, icbf: 0 });
    expect(r.provisions).toEqual({ cesantias: cop(183_260), cesantiasInterest: cop(22_000), prima: cop(183_260), vacations: cop(83_400) });
    // El neto más las deducciones es lo devengado.
    expect(r.net + r.deductions).toBe(r.gross);
  });

  it('salario alto: sin auxilio, con fondo de solidaridad y retención; sin exoneración desde 10 SMMLV', () => {
    const r = calculateEmployee(employee({ baseSalary: cop(12_000_000) }), {}, params, '2026-10');
    expect(r.transportAid).toBe(0);
    expect(r.employee).toMatchObject({ health: cop(480_000), pension: cop(480_000), solidarity: cop(120_000), withholding: cop(700_000) });
    expect(r.exonerated).toBe(true);
    const top = calculateEmployee(employee({ baseSalary: cop(15_000_000) }), {}, params, '2026-10');
    expect(top.exonerated).toBe(false);
    expect(top.employer).toMatchObject({ health: cop(1_275_000), sena: cop(300_000), icbf: cop(450_000), caja: cop(600_000) });
    // Con la exoneración desactivada, un salario bajo también paga salud, SENA e ICBF.
    const noExemption = resolveParams({ smmlv: cop(1_423_500), transportAid: cop(200_000), uvt: cop(49_799), exonerated: false });
    expect(calculateEmployee(employee(), {}, noExemption, '2026-10').employer).toMatchObject({ health: cop(170_000), sena: cop(40_000), icbf: cop(60_000) });
  });

  it('el fondo de solidaridad sube por tramos de salario mínimo', () => {
    const at = (salary) => calculateEmployee(employee({ baseSalary: salary }), { withholding: 0 }, params, '2026-10').employee.solidarity;
    expect(at(cop(5_693_999))).toBe(0);
    expect(at(cop(5_694_000))).toBe(cop(56_940));
    expect(at(cop(22_776_000))).toBe(pct(cop(22_776_000), 120));
    expect(at(cop(40_000_000))).toBe(pct(cop(35_587_500), 200)); // el IBC topa en 25 SMMLV y pasa de 20 SMMLV
  });

  it('el IBC tiene mínimo (un salario mínimo proporcional a los días) y máximo (25 SMMLV)', () => {
    const low = calculateEmployee(employee({ baseSalary: cop(1_000_000), transportAid: false }), { withholding: 0 }, params, '2026-10');
    expect(low.ibc).toBe(cop(1_423_500));
    expect(low.employee.health).toBe(pct(cop(1_423_500), 400));
    const partial = calculateEmployee(employee({ baseSalary: cop(1_000_000) }), { daysWorked: 15, withholding: 0 }, params, '2026-10');
    expect(partial.ibc).toBe(cop(711_750));
    expect(partial.transportAid).toBe(cop(100_000));
    const high = calculateEmployee(employee({ baseSalary: cop(80_000_000) }), { withholding: 0 }, params, '2026-10');
    expect(high.ibc).toBe(cop(35_587_500));
  });

  it('el salario integral cotiza sobre el 70 %, sin auxilio ni cesantías, prima ni sus intereses', () => {
    const r = calculateEmployee(employee({ baseSalary: cop(20_000_000), salaryType: 'integral' }), { withholding: 0 }, params, '2026-10');
    expect(r.transportAid).toBe(0);
    expect(r.ibc).toBe(cop(14_000_000));
    expect(r.provisions).toMatchObject({ cesantias: 0, cesantiasInterest: 0, prima: 0 });
    expect(r.provisions.vacations).toBe(pct(cop(20_000_000), 417));
  });

  it('las novedades suman a la base o restan al neto, y la retención se puede fijar a mano', () => {
    const r = calculateEmployee(employee(), { salaryExtras: cop(300_000), nonSalaryExtras: cop(100_000), otherDeductions: cop(50_000), withholding: cop(10_000) }, params, '2026-10');
    expect(r.ibc).toBe(cop(2_300_000));
    expect(r.gross).toBe(cop(2_600_000));
    expect(r.employee).toMatchObject({ health: cop(92_000), withholding: cop(10_000), otherDeductions: cop(50_000) });
    expect(r.net).toBe(cop(2_600_000) - cop(92_000) * 2 - cop(10_000) - cop(50_000));
    expect(r.provisions.prima).toBe(pct(cop(2_500_000), 833));
  });

  it('un mes parcial prorratea el salario y el auxilio; cero días no cotiza', () => {
    const r = calculateEmployee(employee({ hireDate: new Date('2026-10-11T12:00:00Z') }), {}, params, '2026-10');
    expect(r.days).toBe(20);
    expect(r.salaryEarned).toBe(Math.round((cop(2_000_000) * 20) / 30));
    const none = calculateEmployee(employee(), { daysWorked: 0 }, params, '2026-10');
    expect(none).toMatchObject({ salaryEarned: 0, transportAid: 0, ibc: 0, net: 0 });
  });

  it('rechaza lo que no cuadra', () => {
    expect(() => calculateEmployee(employee(), { daysWorked: 31 }, params, '2026-10')).toThrow(PayrollCalcError);
    expect(() => calculateEmployee(employee(), { salaryExtras: -1 }, params, '2026-10')).toThrow(/entero no negativo/);
    expect(() => calculateEmployee(employee(), { otherDeductions: cop(9_000_000) }, params, '2026-10')).toThrow(/superan/);
    expect(() => calculateEmployee(employee({ hireDate: new Date('2027-01-01T12:00:00Z') }), {}, params, '2026-10')).toThrow(/no estaba vinculado/);
  });
});
