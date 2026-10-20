/**
 * Dinero: entero en unidades menores más código de moneda ISO 4217.
 * Nunca números de punto flotante. Una suma que se salga del rango seguro lanza error
 * en vez de perder precisión en silencio.
 */

/** Decimales de la unidad menor según ISO 4217. */
export const CURRENCY_EXPONENT = {
  COP: 2,
  USD: 2,
  EUR: 2,
  MXN: 2,
  PEN: 2,
  CLP: 0,
};

export class MoneyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MoneyError';
  }
}

/** Un importe en unidades menores. Siempre entero y dentro del rango seguro. */
export function assertMinorUnits(value, label = 'importe') {
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`${label} debe ser un entero seguro en unidades menores, recibido ${value}`);
  }
  return value;
}

export function assertCurrency(code) {
  if (!Object.hasOwn(CURRENCY_EXPONENT, code)) {
    throw new MoneyError(`moneda no soportada: ${code}`);
  }
  return code;
}

/** Suma enteros y falla si el resultado deja de ser exacto. */
export function addMinor(a, b) {
  return assertMinorUnits(a + b, 'suma');
}
