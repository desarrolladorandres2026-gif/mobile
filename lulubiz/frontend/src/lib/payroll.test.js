import { describe, expect, it } from 'vitest';
import { ALL_ACCOUNT_KEYS, blankEmployee, blankNovelty, obligationsOf, parseNovelties, previousMonth, validateEmployee, validateYearParams } from './payroll.js';

describe('ficha de un empleado', () => {
  const ok = { ...blankEmployee(), documentNumber: '1075000001', name: ' Ana Pérez ', hireDate: '2026-01-15', baseSalary: '2.500.000,00' };

  it('arma el cuerpo con el salario en unidades menores', () => {
    expect(validateEmployee(ok, 'COP')).toEqual({
      ok: true,
      body: { documentType: 'CC', documentNumber: '1075000001', name: 'Ana Pérez', hireDate: '2026-01-15', baseSalary: 250_000_000, salaryType: 'ordinary', contractType: 'indefinite', transportAid: true, arlRiskLevel: 1 },
    });
    expect(validateEmployee({ ...ok, costCenter: 'VENTAS', position: 'Cajera', email: 'a@b.co', salaryType: 'integral', arlRiskLevel: '3' }, 'COP').body).toMatchObject({ costCenter: 'VENTAS', position: 'Cajera', email: 'a@b.co', salaryType: 'integral', arlRiskLevel: 3 });
  });

  it('señala cada campo inválido', () => {
    const r = validateEmployee({ ...blankEmployee(), baseSalary: '0', email: 'x' }, 'COP');
    expect(Object.keys(r.errors).sort()).toEqual(['baseSalary', 'documentNumber', 'email', 'hireDate', 'name']);
  });
});

describe('parámetros del año', () => {
  it('piden los tres importes del año', () => {
    expect(validateYearParams({ smmlv: '1.423.500', transportAid: '200.000', uvt: '49.799', exonerated: true, withholding: true }, 'COP')).toEqual({
      ok: true,
      body: { params: { smmlv: 142_350_000, transportAid: 20_000_000, uvt: 4_979_900, exonerated: true, withholding: true } },
    });
    expect(Object.keys(validateYearParams({ smmlv: '', transportAid: 'x', uvt: '0', exonerated: true, withholding: true }, 'COP').errors)).toEqual(['smmlv', 'transportAid', 'uvt']);
  });
});

describe('novedades', () => {
  const employee = { _id: 'e1', name: 'Ana Pérez' };

  it('omite filas vacías y convierte lo escrito', () => {
    expect(parseNovelties([blankNovelty(employee)], 'COP')).toEqual({ ok: true, novelties: [] });
    const row = { ...blankNovelty(employee), daysWorked: '15', salaryExtras: '300.000,00', otherDeductions: '50.000', withholding: '0' };
    expect(parseNovelties([row], 'COP')).toEqual({ ok: true, novelties: [{ employeeId: 'e1', daysWorked: 15, salaryExtras: 30_000_000, otherDeductions: 5_000_000, withholding: 0 }] });
  });

  it('señala días e importes inválidos con el nombre del empleado', () => {
    const r = parseNovelties([{ ...blankNovelty(employee), daysWorked: '31', salaryExtras: 'abc', nonSalaryExtras: '-5' }], 'COP');
    expect(r.errors).toEqual(['Ana Pérez: los días trabajados van de 0 a 30.', 'Ana Pérez: extras salariales no válido.', 'Ana Pérez: extras no salariales no válido.']);
  });
});

describe('obligaciones de una corrida', () => {
  it('suma lo de empleado y empleador y omite lo que está en cero', () => {
    const totals = { net: 100, health: 10, solidarity: 1, pension: 10, withholding: 0, otherDeductions: 0, employer: { health: 5, pension: 20, arl: 2, caja: 8, sena: 0, icbf: 0 } };
    expect(obligationsOf(totals).map((o) => [o.key, o.amount])).toEqual([['net', 100], ['health', 15], ['pension', 31], ['arl', 2], ['caja', 8]]);
  });
});

describe('utilidades', () => {
  it('trae el mes anterior, también en enero', () => {
    expect(previousMonth('2026-10-22')).toBe('2026-09');
    expect(previousMonth('2027-01-03')).toBe('2026-12');
  });

  it('las cuentas de nómina son las veintiséis que pide el servidor', () => {
    expect(ALL_ACCOUNT_KEYS).toHaveLength(26);
    expect(new Set(ALL_ACCOUNT_KEYS).size).toBe(26);
  });
});

describe('prestaciones', () => {
  it('sugiere el último semestre cerrado y el año anterior', async () => {
    const { defaultBenefitLabel, validateBenefitLabel } = await import('./payroll.js');
    expect(defaultBenefitLabel('prima', '2026-10-22')).toBe('2026-1');
    expect(defaultBenefitLabel('prima', '2026-03-10')).toBe('2025-2');
    expect(defaultBenefitLabel('cesantias', '2026-10-22')).toBe('2025');
    expect(validateBenefitLabel('prima', '2026-1')).toBeNull();
    expect(validateBenefitLabel('prima', '2026')).toMatch(/semestre/);
    expect(validateBenefitLabel('cesantias', '2025')).toBeNull();
    expect(validateBenefitLabel('cesantias', '2025-1')).toMatch(/año/);
  });
});
