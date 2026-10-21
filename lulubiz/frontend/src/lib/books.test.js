import { describe, expect, it } from 'vitest';
import { REPORTS, buildQuery, monthRange, rateLabel } from './books.js';

describe('rango del mes', () => {
  it('va del primer al último día, también en febrero bisiesto y en diciembre', () => {
    expect(monthRange('2026-10-21')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(monthRange('2024-02-10')).toEqual({ from: '2024-02-01', to: '2024-02-29' });
    expect(monthRange('2025-02-10')).toEqual({ from: '2025-02-01', to: '2025-02-28' });
    expect(monthRange('2025-12-31')).toEqual({ from: '2025-12-01', to: '2025-12-31' });
  });
});

describe('consulta de un informe', () => {
  const base = { from: '2026-10-01', to: '2026-10-31', currency: 'cop' };

  it('los libros piden solo fechas y moneda', () => {
    const q = buildQuery({ ...base, report: 'sales-book' });
    expect(q).toEqual({ ok: true, path: 'reports/sales-book', query: 'from=2026-10-01&to=2026-10-31&currency=COP' });
  });

  it('los estados de cuenta piden el tercero', () => {
    expect(buildQuery({ ...base, report: 'customer-statement' })).toEqual({ ok: false, errors: ['Elige el cliente.'] });
    expect(buildQuery({ ...base, report: 'supplier-statement' }).errors).toEqual(['Elige el proveedor.']);
    expect(buildQuery({ ...base, report: 'customer-statement', partyId: 'abc' }).query).toContain('partyId=abc');
  });

  it('las ventas netas usan la ruta de resumen y agrupan por cliente o por mes', () => {
    expect(buildQuery({ ...base, report: 'sales-by-customer' })).toMatchObject({ path: 'reports/sales-summary', query: expect.stringContaining('by=customer') });
    expect(buildQuery({ ...base, report: 'sales-by-month' }).query).toContain('by=month');
  });

  it('señala fechas, moneda e informe inválidos', () => {
    expect(buildQuery({ ...base, report: 'sales-book', from: '2026-11-01' }).errors).toEqual(['La fecha inicial no puede ser posterior a la final.']);
    expect(buildQuery({ ...base, report: 'sales-book', from: '' }).errors).toEqual(['Elige las dos fechas.']);
    expect(buildQuery({ ...base, report: 'sales-book', currency: 'PESOS' }).errors[0]).toMatch(/moneda/);
    expect(buildQuery({ ...base, report: 'otro' }).errors).toContain('Elige el informe.');
  });

  it('los informes por dimensión piden meses completos (AAAA-MM)', () => {
    expect(buildQuery({ ...base, report: 'cost-center-result' })).toEqual({ ok: true, path: 'reports/cost-center-result', query: 'from=2026-10&to=2026-10&currency=COP' });
    expect(buildQuery({ ...base, report: 'party-ledger' })).toEqual({ ok: false, errors: ['Elige el tercero.'] });
    expect(buildQuery({ ...base, report: 'party-ledger', partyId: 'abc', from: '2026-08-15' }).query).toBe('from=2026-08&to=2026-10&currency=COP&partyId=abc');
  });

  it('cada informe del selector es válido', () => {
    for (const r of REPORTS) expect(buildQuery({ ...base, report: r.value, partyId: 'x' }).ok, r.value).toBe(true);
  });
});

describe('tarifas', () => {
  it('se muestran como porcentaje', () => {
    expect([0, 500, 1900, 250].map(rateLabel)).toEqual(['0 %', '5 %', '19 %', '2,50 %']);
  });
});
