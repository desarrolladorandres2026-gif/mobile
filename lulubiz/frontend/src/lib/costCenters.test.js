import { describe, expect, it } from 'vitest';
import { normalizeCenterCode } from './costCenters.js';

describe('código de centro de costo', () => {
  it('pasa a mayúsculas y quita lo que el servidor rechaza', () => {
    expect(normalizeCenterCode('sede norte')).toBe('SEDENORTE');
    expect(normalizeCenterCode('proy-1_a')).toBe('PROY-1_A');
    expect(normalizeCenterCode('ñandú!')).toBe('AND');
  });

  it('no empieza por guion ni pasa de diez caracteres', () => {
    expect(normalizeCenterCode('-_A')).toBe('A');
    expect(normalizeCenterCode('ABCDEFGHIJKLM')).toBe('ABCDEFGHIJ');
    expect(normalizeCenterCode(undefined)).toBe('');
  });
});
