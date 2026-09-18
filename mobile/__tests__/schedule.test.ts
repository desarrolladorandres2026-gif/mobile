import { isOpenAt } from '../lib/business';
import { scheduleDays, slotLabel, SCHEDULE_DAYS } from '../lib/schedule';

/**
 * Programar un pedido para cuando el negocio está cerrado era posible: el
 * servidor solo miraba el margen de tiempo. Estas reglas son la mitad del
 * teléfono; el backend repite la misma al crear el pedido.
 */

const weekdays = (open: string, close: string) => ({
  sunday: { isOpen: false },
  monday: { open, close },
  tuesday: { open, close },
  wednesday: { open, close },
  thursday: { open, close },
  friday: { open, close },
  saturday: { open, close },
});

// Miércoles 16 de septiembre de 2026, hora local.
const at = (day: number, hour: number, minute = 0) => new Date(2026, 8, day, hour, minute);

describe('isOpenAt', () => {
  const almuerzo = weekdays('11:00', '15:00');

  it('abierto dentro de la ventana del día, cerrado fuera', () => {
    expect(isOpenAt(almuerzo, at(16, 12))).toBe(true);
    expect(isOpenAt(almuerzo, at(16, 10, 30))).toBe(false);
    // El cierre no cuenta como abierto: a las 3 en punto ya no se atiende.
    expect(isOpenAt(almuerzo, at(16, 15))).toBe(false);
  });

  it('respeta el día marcado como cerrado', () => {
    expect(isOpenAt(almuerzo, at(20, 12))).toBe(false); // domingo
  });

  it('un local que cruza medianoche sigue abierto de madrugada', () => {
    const bar = weekdays('18:00', '02:00');

    expect(isOpenAt(bar, at(16, 23))).toBe(true);
    // La 1 a. m. del jueves es la cola del miércoles. `openState` solo mira
    // el día en curso y aquí se equivocaba.
    expect(isOpenAt(bar, at(17, 1))).toBe(true);
    expect(isOpenAt(bar, at(17, 3))).toBe(false);
  });

  it('la madrugada del lunes no hereda nada de un domingo cerrado', () => {
    const bar = weekdays('18:00', '02:00');
    expect(isOpenAt(bar, at(21, 1))).toBe(false);
  });

  it('sin horario se deja pedir', () => {
    expect(isOpenAt(undefined, at(16, 4))).toBe(true);
  });
});

describe('scheduleDays', () => {
  const almuerzo = weekdays('11:00', '15:00');

  it('solo ofrece franjas con el negocio abierto', () => {
    const days = scheduleDays(almuerzo, at(16, 8));
    const allSlots = days.flatMap((d) => d.slots);

    expect(allSlots.every((slot) => slot.getHours() >= 11 && slot.getHours() < 15)).toBe(true);
    // El domingo está cerrado: ni siquiera aparece como día.
    expect(days.some((d) => d.slots[0].getDay() === 0)).toBe(false);
  });

  it('la primera franja respeta la antelación', () => {
    const days = scheduleDays(almuerzo, at(16, 12, 10));

    expect(days[0].label).toBe('Hoy');
    // 12:10 + 1 h = 13:10 → la primera franja redonda es la de 13:30.
    expect(slotLabel(days[0].slots[0])).toBe('1:30 p. m.');
  });

  it('nombra hoy, mañana y luego el día de la semana', () => {
    const days = scheduleDays(almuerzo, at(16, 8));

    expect(days[0].label).toBe('Hoy');
    expect(days[1].label).toBe('Mañana');
    expect(days[2].label).toBe('vie 18');
  });

  it('no pasa de una semana', () => {
    const days = scheduleDays(undefined, at(16, 8));
    const lastDay = days[days.length - 1].slots;
    const last = lastDay[lastDay.length - 1];

    expect(days.length).toBeLessThanOrEqual(SCHEDULE_DAYS);
    expect(last.getTime() - at(16, 8).getTime()).toBeLessThanOrEqual(7 * 24 * 60 * 60_000);
  });
});
