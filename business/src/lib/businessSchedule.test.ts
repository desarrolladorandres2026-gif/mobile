import { describe, it, expect } from 'vitest';
import {
  DAY_KEYS, applyPreset, copyHoursToOpenDays, dayProblem, profileChecklist, referenceHours,
} from './businessSchedule';
import type { Schedule } from '../pages/profile/InfoTab';

/**
 * El servidor decide con el horario si la tienda está abierta: los atajos solo
 * pueden reescribir `isOpen`, `open` y `close`, y no pueden dejar un día a medias.
 */

const openKeys = (s: Schedule) => DAY_KEYS.filter((k) => s[k]?.isOpen);

describe('applyPreset', () => {
  it('abre solo los días del atajo y cierra los demás', () => {
    const weekdays = applyPreset({}, 'weekdays');
    expect(openKeys(weekdays)).toEqual(['monday', 'tuesday', 'wednesday', 'thursday', 'friday']);
    expect(weekdays.saturday.isOpen).toBe(false);

    const all = applyPreset(weekdays, 'all');
    expect(openKeys(all)).toHaveLength(7);

    const monsat = applyPreset(all, 'monsat');
    expect(openKeys(monsat)).toHaveLength(6);
    expect(monsat.sunday.isOpen).toBe(false);
  });

  it('un día que ya estaba abierto conserva sus horas; uno nuevo estrena las del negocio', () => {
    const start: Schedule = {
      monday: { isOpen: true, open: '10:00', close: '18:00' },
      friday: { isOpen: true, open: '12:00', close: '23:00' },
    };
    const next = applyPreset(start, 'weekdays');
    expect(next.friday).toMatchObject({ open: '12:00', close: '23:00' });
    // «Las del negocio» son las del primer día abierto, el lunes.
    expect(next.tuesday).toMatchObject({ isOpen: true, open: '10:00', close: '18:00' });
  });

  it('sin horario previo abre con 08:00 a 20:00 y no toca el original', () => {
    const start: Schedule = {};
    const next = applyPreset(start, 'all');
    expect(next.monday).toMatchObject({ open: '08:00', close: '20:00' });
    expect(start).toEqual({});
  });
});

describe('copyHoursToOpenDays', () => {
  it('copia las horas del primer día abierto solo a los días abiertos', () => {
    const next = copyHoursToOpenDays({
      monday: { isOpen: true, open: '09:00', close: '17:00' },
      wednesday: { isOpen: true, open: '11:00', close: '22:00' },
      thursday: { isOpen: false, open: '01:00', close: '02:00' },
    });
    expect(next.wednesday).toMatchObject({ open: '09:00', close: '17:00' });
    expect(next.thursday).toMatchObject({ isOpen: false, open: '01:00', close: '02:00' });
  });
});

describe('referenceHours / dayProblem', () => {
  it('toma el primer día abierto o los valores de siempre', () => {
    expect(referenceHours({})).toEqual({ open: '08:00', close: '20:00' });
    expect(referenceHours({ tuesday: { isOpen: true, open: '07:00', close: '15:00' } })).toEqual({ open: '07:00', close: '15:00' });
  });

  it('avisa si cierra antes de abrir o a la misma hora, y no dice nada de un día cerrado', () => {
    expect(dayProblem({ isOpen: true, open: '20:00', close: '08:00' })).not.toBe('');
    expect(dayProblem({ isOpen: true, open: '08:00', close: '08:00' })).not.toBe('');
    expect(dayProblem({ isOpen: true, open: '08:00', close: '20:00' })).toBe('');
    expect(dayProblem({ isOpen: false, open: '20:00', close: '08:00' })).toBe('');
    expect(dayProblem(undefined)).toBe('');
  });
});

describe('profileChecklist', () => {
  const full = {
    description: 'Hamburguesas', phone: '300', address: 'Calle 1', hasLocation: true,
    schedule: { monday: { isOpen: true } } as Schedule, hasLogo: true, hasCover: true,
  };

  it('una ficha completa marca todo', () => {
    expect(profileChecklist(full).every((i) => i.done)).toBe(true);
  });

  it('el espacio en blanco no cuenta como dato y un horario sin días abiertos tampoco', () => {
    const missing = profileChecklist({ ...full, description: '   ', phone: '', schedule: {}, hasLocation: false })
      .filter((i) => !i.done)
      .map((i) => i.id);
    expect(missing).toEqual(['description', 'phone', 'location', 'schedule']);
  });
});
