import { describe, it, expect } from 'vitest';
import { couponAvailability, localInstant, localClock, CouponTiming } from '../utils';

/**
 * Cuándo sirve un cupón, sin base de datos de por medio.
 *
 * La regla vivía escrita dentro de `validate()` y la pantalla de Descuentos
 * no la conocía: un cupón de 11 a 13 h se anunciaba a cualquier hora y solo
 * fallaba al pagar. Estas pruebas fijan la regla en un sitio para que las
 * dos caras digan lo mismo.
 */

const BOGOTA = 'America/Bogota';

/** Un instante concreto en hora de Colombia, escrito en UTC (−5, sin cambio de hora). */
function bogota(day: string, hhmm: string): Date {
  return new Date(`${day}T${hhmm}:00-05:00`);
}

function timing(overrides: Partial<CouponTiming> = {}): CouponTiming {
  return {
    isActive: true,
    validFrom: new Date('2020-01-01'),
    validUntil: new Date('2030-01-01'),
    usageLimit: 0,
    usedCount: 0,
    budgetLimit: 0,
    budgetSpent: 0,
    validDays: [],
    ...overrides,
  };
}

describe('localInstant', () => {
  it('convierte una hora de pared a un instante real', () => {
    // 2026-09-19 es sábado. Las 11:00 en Bogotá son las 16:00 UTC.
    const at = localInstant(bogota('2026-09-19', '03:00'), BOGOTA, 0, 11 * 60);
    expect(at.toISOString()).toBe('2026-09-19T16:00:00.000Z');
  });

  it('cuenta los días en el calendario local, no en el del servidor', () => {
    // A las 21:00 de Bogotá ya es el día siguiente en UTC: si los días se
    // contaran ahí, "mañana a las 11" caería un día de más.
    const at = localInstant(bogota('2026-09-19', '21:00'), BOGOTA, 1, 11 * 60);
    expect(at.toISOString()).toBe('2026-09-20T16:00:00.000Z');
  });
});

describe('couponAvailability', () => {
  it('sin franja ni días, está activo', () => {
    const state = couponAvailability(timing(), bogota('2026-09-19', '03:00'), BOGOTA);
    expect(state.state).toBe('active');
    expect(state.window).toBeUndefined();
  });

  it('dentro de su franja, está activo y dice cuándo cierra', () => {
    const state = couponAvailability(
      timing({ validFromTime: '11:00', validUntilTime: '13:00' }),
      bogota('2026-09-19', '12:00'),
      BOGOTA
    );

    expect(state.state).toBe('active');
    expect(state.window).toEqual({ from: '11:00', to: '13:00', days: [] });
    expect(state.closesAt).toBe('2026-09-19T18:00:00.000Z');
  });

  it('fuera de su franja está programado, no agotado', () => {
    const state = couponAvailability(
      timing({ validFromTime: '11:00', validUntilTime: '13:00' }),
      bogota('2026-09-19', '03:00'),
      BOGOTA
    );

    expect(state.state).toBe('scheduled');
    expect(state.nextOpensAt).toBe('2026-09-19T16:00:00.000Z');
    // La franja se sigue anunciando aunque esté cerrada: es lo que la hace
    // apetecible mañana.
    expect(state.window).toEqual({ from: '11:00', to: '13:00', days: [] });
  });

  it('pasada la franja de hoy, abre mañana', () => {
    const state = couponAvailability(
      timing({ validFromTime: '11:00', validUntilTime: '13:00' }),
      bogota('2026-09-19', '20:00'),
      BOGOTA
    );

    expect(state.state).toBe('scheduled');
    expect(state.nextOpensAt).toBe('2026-09-20T16:00:00.000Z');
  });

  it('el día se lee en Colombia y no en la zona del servidor', () => {
    // Viernes 18 a las 19:00 de Bogotá ya es sábado en UTC. Con `getDay()`
    // el cupón de los viernes se apagaba justo a la hora de más pedidos.
    const friday = bogota('2026-09-18', '19:00');
    expect(localClock(friday, BOGOTA).day).toBe(5);

    const state = couponAvailability(timing({ validDays: [5] }), friday, BOGOTA);
    expect(state.state).toBe('active');
  });

  it('un día que no es el suyo queda programado para el siguiente que sí', () => {
    // Sábado, cupón de lunes: abre el lunes a medianoche.
    const state = couponAvailability(
      timing({ validDays: [1] }),
      bogota('2026-09-19', '10:00'),
      BOGOTA
    );

    expect(state.state).toBe('scheduled');
    expect(state.nextOpensAt).toBe('2026-09-21T05:00:00.000Z');
  });

  it('caducado, apagado, sin cupo o sin presupuesto: agotado', () => {
    const now = bogota('2026-09-19', '12:00');
    const cases: Partial<CouponTiming>[] = [
      { validUntil: new Date('2020-01-01') },
      { isActive: false },
      { usageLimit: 10, usedCount: 10 },
      { budgetLimit: 50_000, budgetSpent: 50_000 },
    ];

    for (const override of cases) {
      expect(couponAvailability(timing(override), now, BOGOTA).state).toBe('exhausted');
    }
  });

  it('una franja que ya no vuelve antes de caducar está agotada', () => {
    // Cupón de lunes que caduca el domingo: no queda ni un lunes por delante.
    const state = couponAvailability(
      timing({ validDays: [1], validUntil: bogota('2026-09-20', '23:59') }),
      bogota('2026-09-19', '10:00'),
      BOGOTA
    );

    expect(state.state).toBe('exhausted');
  });

  it('todavía no vigente es una promoción anunciada, no una agotada', () => {
    const validFrom = bogota('2026-10-01', '00:00');
    const state = couponAvailability(
      timing({ validFrom }),
      bogota('2026-09-19', '10:00'),
      BOGOTA
    );

    expect(state.state).toBe('scheduled');
    expect(state.nextOpensAt).toBe(validFrom.toISOString());
  });
});
