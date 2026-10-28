import { describe, expect, it } from 'vitest';
import { calendarToday, dayOf, parseDay } from './dates.js';

describe('calendarToday (día de calendario de Bogotá)', () => {
  it('antes de las 7 p. m. de Bogotá coincide con el día UTC', () => {
    expect(dayOf(calendarToday(new Date('2026-04-01T15:00:00Z')))).toBe('2026-04-01');
  });

  it('entre las 7 p. m. y la medianoche de Bogotá sigue siendo el día de Bogotá, no el siguiente en UTC', () => {
    expect(dayOf(calendarToday(new Date('2026-04-01T03:00:00Z')))).toBe('2026-03-31'); // 10 p. m. del 31 de marzo en Bogotá
    expect(dayOf(calendarToday(new Date('2026-04-01T04:59:59Z')))).toBe('2026-03-31');
    expect(dayOf(calendarToday(new Date('2026-04-01T05:00:00Z')))).toBe('2026-04-01');
  });

  it('cruza el fin de año y de mes sin saltarse el período', () => {
    expect(dayOf(calendarToday(new Date('2027-01-01T02:00:00Z')))).toBe('2026-12-31');
    expect(calendarToday(new Date('2027-01-01T02:00:00Z')).getUTCMonth()).toBe(11);
  });

  it('devuelve mediodía UTC, igual que parseDay', () => {
    const fail = (m) => {
      throw new Error(m);
    };
    expect(calendarToday(new Date('2026-04-01T03:00:00Z')).getTime()).toBe(parseDay('2026-03-31', 'x', fail).getTime());
  });
});
