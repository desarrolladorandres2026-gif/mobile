import { describe, expect, it } from 'vitest';
import { safeNext } from './redirect';

describe('safeNext', () => {
  it('acepta rutas internas', () => {
    expect(safeNext('/pedidos')).toBe('/pedidos');
    expect(safeNext('/comercios?categoria=cafe')).toBe('/comercios?categoria=cafe');
  });

  it('rechaza destinos externos y devuelve el de reserva', () => {
    expect(safeNext('//evil.com')).toBe('/');
    expect(safeNext('/\\evil.com')).toBe('/');
    expect(safeNext('https://evil.com')).toBe('/');
    expect(safeNext('/\t/evil.com')).toBe('/');
    expect(safeNext('javascript:alert(1)')).toBe('/');
    expect(safeNext('')).toBe('/');
    expect(safeNext('/	/evil.com')).toBe('/');
    expect(safeNext(null, '/cuenta')).toBe('/cuenta');
  });
});
