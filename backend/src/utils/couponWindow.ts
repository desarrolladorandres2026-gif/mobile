import { localClock, localInstant } from './businessHours';

/**
 * Cuándo sirve un cupón, decidido en un solo sitio.
 *
 * `validate()` ya comprobaba día y horario antes de aplicar un descuento,
 * pero `getPublic()` —la consulta que alimenta la pestaña de Descuentos— no
 * sabía nada de eso: un cupón de 11 a 13 h aparecía en la lista a las 3 de
 * la madrugada y solo se descubría que no servía al intentar pagar. Con la
 * regla aquí, la pantalla y el cobro dicen lo mismo, y de paso la franja se
 * puede anunciar en vez de esconderse.
 */

/** Por qué un cupón se puede usar ahora, o por qué no. */
export type CouponState =
  /** Utilizable en este momento. */
  | 'active'
  /** Vigente, pero fuera de su franja: vuelve a abrir en `nextOpensAt`. */
  | 'scheduled'
  /** Ya no va a volver: caducado, agotado o apagado. */
  | 'exhausted';

/** La franja horaria de un cupón, tal y como se anuncia. */
export interface CouponWindow {
  /** `HH:mm` en la zona horaria de operación. */
  from: string;
  to: string;
  /** Días de la semana (0 = domingo). Vacío significa todos. */
  days: number[];
}

export interface CouponAvailability {
  state: CouponState;
  /** Solo en los cupones que tienen franja horaria. */
  window?: CouponWindow;
  /** Cuándo vuelve a abrir. Solo cuando `state` es `scheduled`. */
  nextOpensAt?: string;
  /** Cuándo se cierra la franja de hoy. Solo cuando `state` es `active`. */
  closesAt?: string;
}

/** Lo mínimo que hace falta saber de un cupón para situarlo en el tiempo. */
export interface CouponTiming {
  isActive: boolean;
  validFrom: Date;
  validUntil: Date;
  usageLimit: number;
  usedCount: number;
  budgetLimit: number;
  budgetSpent: number;
  validDays: number[];
  validFromTime?: string;
  validUntilTime?: string;
}

/** `"09:30"` → `570`. `null` si no es una hora escribible. */
function toMinutes(hhmm: string | undefined): number | null {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

/** Si un cupón se puede pedir hoy, mirando solo el día de la semana. */
function runsOnDay(days: number[], day: number): boolean {
  return days.length === 0 || days.includes(day);
}

/**
 * La próxima vez que la franja abre, buscando día a día.
 *
 * Ocho vueltas y no siete: si hoy la franja ya cerró, la siguiente puede ser
 * dentro de exactamente una semana, y con siete la última candidata sería
 * hoy mismo a una hora ya pasada.
 */
function nextOpening(
  timing: CouponTiming,
  now: Date,
  timeZone: string,
  openMinutes: number
): Date | null {
  const { day } = localClock(now, timeZone);

  for (let ahead = 0; ahead <= 7; ahead += 1) {
    const candidateDay = (day + ahead) % 7;
    if (!runsOnDay(timing.validDays, candidateDay)) continue;

    const at = localInstant(now, timeZone, ahead, openMinutes);
    if (at > now && at <= timing.validUntil) return at;
  }

  return null;
}

/**
 * En qué estado está un cupón ahora mismo.
 *
 * No mira nada del usuario ni del carrito a propósito: así la respuesta es
 * la misma para todo el mundo y `/offers` puede seguir sirviéndose desde la
 * caché compartida. Lo que depende de quién pregunta vive en
 * `couponService.eligibility()`.
 */
export function couponAvailability(
  timing: CouponTiming,
  now: Date,
  timeZone: string
): CouponAvailability {
  const exhausted =
    !timing.isActive ||
    timing.validUntil < now ||
    (timing.usageLimit > 0 && timing.usedCount >= timing.usageLimit) ||
    (timing.budgetLimit > 0 && timing.budgetSpent >= timing.budgetLimit);

  if (exhausted) return { state: 'exhausted' };

  // Todavía no ha empezado: es una promoción anunciada, no una agotada.
  if (timing.validFrom > now) {
    return { state: 'scheduled', nextOpensAt: timing.validFrom.toISOString() };
  }

  const open = toMinutes(timing.validFromTime);
  const close = toMinutes(timing.validUntilTime);
  const hasWindow = open !== null && close !== null;

  const window: CouponWindow | undefined = hasWindow
    ? { from: timing.validFromTime!, to: timing.validUntilTime!, days: timing.validDays }
    : undefined;

  // El día se lee en la zona de operación, no en la del servidor. Con
  // `getDay()` a secas, un servidor en UTC creía que ya era sábado a las
  // siete de la tarde del viernes y rechazaba el cupón de los viernes justo
  // a la hora de más pedidos.
  const { day, minutes } = localClock(now, timeZone);

  // Una franja que cruza medianoche (22:00–02:00) nunca da por abierta.
  // Es el mismo comportamiento que `validate()` tenía antes de extraer esta
  // función, así que aquí no cambia nada; pero conviene saber que un cupón
  // así se anuncia siempre como `scheduled` y no se puede usar nunca. Si
  // algún día hace falta, `isOpenAt` de `businessHours.ts` ya resuelve el
  // cruce y sirve de modelo — y habrá que tocar también `validate()`, que
  // es quien decide dinero.
  const openToday =
    runsOnDay(timing.validDays, day) &&
    (!hasWindow || (minutes >= open! && minutes <= close!));

  if (openToday) {
    return {
      state: 'active',
      window,
      closesAt: hasWindow
        ? localInstant(now, timeZone, 0, close!).toISOString()
        : undefined,
    };
  }

  // Sin franja horaria, "cerrado" solo puede significar que hoy no es su
  // día: la siguiente apertura es el próximo día hábil a medianoche.
  const next = nextOpening(timing, now, timeZone, hasWindow ? open! : 0);

  // Una franja que ya no vuelve a caer antes de que el cupón caduque está
  // agotada en la práctica, aunque `validUntil` siga en el futuro.
  if (!next) return { state: 'exhausted', window };

  return { state: 'scheduled', window, nextOpensAt: next.toISOString() };
}
