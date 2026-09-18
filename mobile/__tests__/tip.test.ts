import { TIP_MAX, TIP_MIN, TIP_PRESETS, tipFromParam, tipInputError, validTip } from '../lib/tip';

describe('validTip', () => {
  it('acepta los montos fijos', () => {
    for (const amount of TIP_PRESETS) expect(validTip(amount)).toBe(amount);
  });

  it('acepta los extremos y rechaza lo que se sale', () => {
    expect(validTip(TIP_MIN)).toBe(TIP_MIN);
    expect(validTip(TIP_MAX)).toBe(TIP_MAX);
    expect(validTip(TIP_MIN - 1)).toBeNull();
    expect(validTip(TIP_MAX + 1)).toBeNull();
  });

  it('rechaza lo que no es un monto', () => {
    expect(validTip(null)).toBeNull();
    expect(validTip(undefined)).toBeNull();
    expect(validTip(NaN)).toBeNull();
    expect(validTip(Infinity)).toBeNull();
    expect(validTip(-1000)).toBeNull();
  });
});

describe('tipInputError', () => {
  it('no protesta por un campo vacío ni por un valor bueno', () => {
    expect(tipInputError('')).toBeUndefined();
    expect(tipInputError('2500')).toBeUndefined();
  });

  it('explica el mínimo y el máximo', () => {
    expect(tipInputError('100')).toMatch(/mínimo/);
    expect(tipInputError('999999')).toMatch(/máximo/);
  });
});

describe('tipFromParam', () => {
  it('lee un monto válido de la URL', () => {
    expect(tipFromParam('3000')).toBe(3000);
    expect(tipFromParam(['5000'])).toBe(5000);
  });

  it('toma cualquier cosa ilegible o fuera de rango como sin propina', () => {
    expect(tipFromParam(undefined)).toBe(0);
    expect(tipFromParam('')).toBe(0);
    expect(tipFromParam('abc')).toBe(0);
    expect(tipFromParam('-2000')).toBe(0);
    expect(tipFromParam('2000.5')).toBe(0);
    expect(tipFromParam('50000')).toBe(0);
  });
});
