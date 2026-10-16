import { describe, it, expect } from 'vitest';
import { minutesUntilMidnight } from './soldOut';

describe('minutesUntilMidnight', () => {
  it('cuenta los minutos que faltan para que acabe el día', () => {
    expect(minutesUntilMidnight(new Date(2026, 9, 15, 22, 0, 0))).toBe(120);
    expect(minutesUntilMidnight(new Date(2026, 9, 15, 12, 30, 0))).toBe(690);
  });

  it('nunca baja de 5 minutos, el mínimo que acepta el servidor', () => {
    expect(minutesUntilMidnight(new Date(2026, 9, 15, 23, 58, 0))).toBe(5);
  });

  it('nunca pasa de un día', () => {
    expect(minutesUntilMidnight(new Date(2026, 9, 15, 0, 0, 0))).toBeLessThanOrEqual(1440);
  });
});
