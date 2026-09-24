import { describe, it, expect } from 'vitest';
import { nationalHolidays, addBusinessDays, businessDaysUntil } from '../utils/businessDays';

/**
 * Días hábiles en Colombia (Ley 51 de 1983 — Ley Emiliani).
 *
 * Las fechas de 2026 se verificaron contra el calendario oficial publicado
 * de festivos de Colombia. Las de 2027 se derivan del mismo algoritmo
 * (fijos, trasladables al lunes y dependientes de Pascua) sin verificación
 * externa adicional — si alguna resulta errónea, revisar primero la Pascua
 * de ese año (domingo 28 de marzo de 2027 por Meeus/Jones/Butcher).
 */
describe('Días hábiles colombianos', () => {
  it('calcula los festivos nacionales de 2026 contra el calendario oficial', () => {
    const holidays = nationalHolidays(2026);
    const expected = [
      '2026-1-1', '2026-1-12', '2026-3-23', '2026-4-2', '2026-4-3',
      '2026-5-1', '2026-5-18', '2026-6-8', '2026-6-15', '2026-6-29',
      '2026-7-20', '2026-8-7', '2026-8-17', '2026-10-12', '2026-11-2',
      '2026-11-16', '2026-12-8', '2026-12-25',
    ];
    expect([...holidays].sort()).toEqual(expected.sort());
  });

  it('traslada Reyes Magos (6 de enero) al lunes siguiente cuando no cae en lunes', () => {
    // 6 de enero de 2026 es martes → se traslada al lunes 12.
    const holidays = nationalHolidays(2026);
    expect(holidays.has('2026-1-6')).toBe(false);
    expect(holidays.has('2026-1-12')).toBe(true);
  });

  it('no traslada Jueves y Viernes Santo', () => {
    const holidays = nationalHolidays(2026);
    expect(holidays.has('2026-4-2')).toBe(true); // Jueves Santo
    expect(holidays.has('2026-4-3')).toBe(true); // Viernes Santo
  });

  it('salta sábados, domingos y festivos al sumar días hábiles', () => {
    // Viernes 1 de enero de 2027 es festivo (Año Nuevo); el 2 es sábado y
    // el 3 domingo. Sumar 1 día hábil desde el 31 de diciembre de 2026
    // (jueves) debe caer en el lunes 4 de enero de 2027.
    const from = new Date('2026-12-31T12:00:00Z');
    const due = addBusinessDays(from, 1);
    expect(due.getUTCFullYear()).toBe(2027);
    expect(due.getUTCMonth()).toBe(0);
    // El resultado es 23:59:59.999 hora Bogotá = 04:59:59.999 UTC del día siguiente.
    expect([4, 5]).toContain(due.getUTCDate());
  });

  it('devuelve el final del día hábil en hora Bogotá, no medianoche UTC', () => {
    const due = addBusinessDays(new Date('2026-09-23T15:00:00Z'), 1);
    // 23:59:59.999 Bogotá == 04:59:59.999 UTC del día siguiente.
    expect(due.getUTCHours()).toBe(4);
    expect(due.getUTCMinutes()).toBe(59);
  });

  it('businessDaysUntil da negativo cuando el plazo ya venció', () => {
    const past = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    expect(businessDaysUntil(past)).toBeLessThanOrEqual(0);
  });
});
