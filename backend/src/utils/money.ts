/**
 * Integer money arithmetic for COP.
 *
 * Colombian pesos have no minor unit in practice, so every amount in the
 * platform is a whole number of pesos held in a JS number (safe up to
 * 2^53, i.e. ~9 quadrillion COP — far beyond any order).
 *
 * Rates are expressed in **basis points**: 1 bps = 0.01%, so 10% = 1000 bps
 * and 100% = 10000 bps. Floats are never used for money: `0.1 * 30000`
 * evaluates to 3000.0000000000005, and that drift accumulates into ledger
 * imbalances once it is summed over thousands of orders.
 */

export const BPS_DENOMINATOR = 10_000;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/** Throws unless `value` is a whole, finite, non-negative number of pesos. */
export function assertMoney(value: number, label = 'monto'): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new MoneyError(`El ${label} no es un número válido`);
  }
  if (!Number.isInteger(value)) {
    throw new MoneyError(`El ${label} debe ser un entero en COP (recibido ${value})`);
  }
  if (value < 0) {
    throw new MoneyError(`El ${label} no puede ser negativo (recibido ${value})`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`El ${label} excede el rango entero seguro`);
  }
  return value;
}

/** Throws unless `bps` is a whole number of basis points in [0, 10000]. */
export function assertBps(bps: number, label = 'tasa'): number {
  if (typeof bps !== 'number' || !Number.isInteger(bps)) {
    throw new MoneyError(`La ${label} debe expresarse en basis points enteros`);
  }
  if (bps < 0 || bps > BPS_DENOMINATOR) {
    throw new MoneyError(`La ${label} debe estar entre 0 y ${BPS_DENOMINATOR} bps`);
  }
  return bps;
}

/**
 * Applies a basis-point rate to an integer amount.
 *
 * Rounds half away from zero so a 50%-of-an-odd-peso split never silently
 * loses the peso. Inputs are integers, so the intermediate product is exact
 * for any realistic order value.
 */
export function applyBps(amount: number, bps: number): number {
  assertMoney(amount);
  assertBps(bps);
  return Math.round((amount * bps) / BPS_DENOMINATOR);
}

/** Converts a legacy decimal rate (0.10) to basis points (1000). */
export function rateToBps(rate: number): number {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) {
    throw new MoneyError('La tasa decimal no es válida');
  }
  return Math.round(rate * BPS_DENOMINATOR);
}

/** Converts basis points (1000) to a decimal rate (0.10). Display only. */
export function bpsToRate(bps: number): number {
  return bps / BPS_DENOMINATOR;
}

/** Clamps an integer amount into [min, max]. */
export function clampMoney(amount: number, min: number, max: number): number {
  if (min > max) {
    throw new MoneyError(`Rango inválido: mínimo ${min} supera el máximo ${max}`);
  }
  return Math.min(Math.max(amount, min), max);
}

/** Sums integer amounts, validating each one. */
export function sumMoney(...amounts: number[]): number {
  return amounts.reduce<number>((total, amount) => total + assertMoney(amount), 0);
}

/** Subtraction that refuses to produce a negative result. */
export function subtractMoney(minuend: number, subtrahend: number, label = 'monto'): number {
  const result = assertMoney(minuend, label) - assertMoney(subtrahend, label);
  if (result < 0) {
    throw new MoneyError(
      `El ${label} resultante sería negativo (${minuend} − ${subtrahend})`
    );
  }
  return result;
}

/** Subtraction floored at zero, for values where a shortfall is expected. */
export function subtractToZero(minuend: number, subtrahend: number): number {
  return Math.max(0, assertMoney(minuend) - assertMoney(subtrahend));
}
