import { describe, expect, it } from 'vitest';
import { accumulatedAfter, firstInstallment, validateAsset, validateDisposal } from './fixedAssets.js';

const form = (patch = {}) => ({ code: 'eq-1', name: 'Portátil', description: '', acquisitionDate: '2026-10-05', cost: '12.000,00', salvageValue: '', usefulLifeMonths: '12', depreciationStart: '', costCenter: '', asset: '152405', accumulated: '159205', expense: '516005', ...patch });

describe('depreciación en línea recta', () => {
  it('reparte exacto: la suma de las cuotas es el valor depreciable', () => {
    expect(accumulatedAfter(100, 3, 1)).toBe(33);
    expect(accumulatedAfter(100, 3, 3)).toBe(100);
    expect(accumulatedAfter(100, 3, 9)).toBe(100);
    expect(firstInstallment(1_200_000, 0, 12)).toBe(100_000);
    expect(firstInstallment(1_000_000, 100_000, 7)).toBe(128_571);
  });
});

describe('ficha de un activo', () => {
  it('arma el cuerpo con el código en mayúsculas', () => {
    expect(validateAsset(form(), 'COP')).toEqual({
      ok: true,
      body: { code: 'EQ-1', name: 'Portátil', acquisitionDate: '2026-10-05', cost: 1_200_000, usefulLifeMonths: 12, accounts: { asset: '152405', accumulated: '159205', expense: '516005' } },
    });
    expect(validateAsset(form({ salvageValue: '2.000,00', depreciationStart: '2026-11', costCenter: 'NORTE', description: ' x ' }), 'COP').body).toMatchObject({ salvageValue: 200_000, depreciationStart: '2026-11', costCenter: 'NORTE', description: 'x' });
  });

  it('señala cada campo inválido', () => {
    const r = validateAsset(form({ code: 'a b', name: '', cost: '0', usefulLifeMonths: '0', asset: '', depreciationStart: '2026-09' }), 'COP');
    expect(Object.keys(r.errors).sort()).toEqual(['asset', 'code', 'cost', 'depreciationStart', 'name', 'usefulLifeMonths']);
    expect(validateAsset(form({ salvageValue: '12.000,00' }), 'COP').errors.salvageValue).toMatch(/menor/);
    expect(validateAsset(form({ expense: '152405' }), 'COP').errors.expense).toMatch(/distintas/);
  });
});

describe('baja de un activo', () => {
  const base = { date: '2026-10-20', proceeds: '', proceedsAccount: '', gainAccount: '', lossAccount: '' };

  it('una baja sin precio es pérdida por todo el valor en libros', () => {
    expect(validateDisposal(base, 900_000, 'COP').errors).toEqual(['La baja deja pérdida: indica la cuenta de la pérdida.']);
    expect(validateDisposal({ ...base, lossAccount: '539595' }, 900_000, 'COP')).toMatchObject({ ok: true, difference: -900_000, body: { date: '2026-10-20', lossAccount: '539595' } });
  });

  it('una venta pide la cuenta del dinero y la de utilidad o pérdida según corresponda', () => {
    expect(validateDisposal({ ...base, proceeds: '10.000,00' }, 900_000, 'COP').errors).toEqual(['Indica la cuenta donde entra el dinero de la venta.', 'La venta deja utilidad: indica la cuenta de la utilidad.']);
    const ok = validateDisposal({ ...base, proceeds: '10.000,00', proceedsAccount: '111005', gainAccount: '429581' }, 900_000, 'COP');
    expect(ok).toMatchObject({ ok: true, difference: 100_000, body: { proceeds: 1_000_000, proceedsAccount: '111005', gainAccount: '429581' } });
    expect(ok.body.lossAccount).toBeUndefined();
  });

  it('si el precio iguala el valor en libros no hay utilidad ni pérdida', () => {
    expect(validateDisposal({ ...base, proceeds: '9.000,00', proceedsAccount: '111005' }, 900_000, 'COP')).toMatchObject({ ok: true, difference: 0 });
  });
});
