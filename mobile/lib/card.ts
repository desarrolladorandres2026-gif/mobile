/**
 * Utilidades de tarjeta para el formulario de pago.
 *
 * Todo aquí es **cortesía, no autoridad**. Detectar la marca, validar Luhn
 * o comprobar el vencimiento solo sirve para avisar del error antes de
 * mandar nada; quien decide si la tarjeta vale es Wompi al tokenizar, y
 * luego el banco al cobrar. Por eso nada de esto bloquea en silencio: cada
 * función devuelve un motivo que la pantalla puede mostrar.
 */

export type CardBrand = 'VISA' | 'MASTERCARD' | 'AMEX' | 'DINERS' | 'UNKNOWN';

/** Nombre para mostrar. */
export const BRAND_LABEL: Record<CardBrand, string> = {
  VISA: 'Visa',
  MASTERCARD: 'Mastercard',
  AMEX: 'American Express',
  DINERS: 'Diners Club',
  UNKNOWN: 'Tarjeta',
};

export function onlyDigits(value: string): string {
  return value.replace(/\D/g, '');
}

/** Marca por BIN. Basta con los primeros dígitos; se afina según se escribe. */
export function detectBrand(rawNumber: string): CardBrand {
  const n = onlyDigits(rawNumber);
  if (/^4/.test(n)) return 'VISA';
  if (/^3[47]/.test(n)) return 'AMEX';
  if (/^(36|38|30[0-5])/.test(n)) return 'DINERS';
  // Mastercard: 51–55 y el rango 2221–2720.
  if (/^5[1-5]/.test(n)) return 'MASTERCARD';
  const four = Number(n.slice(0, 4));
  if (n.length >= 4 && four >= 2221 && four <= 2720) return 'MASTERCARD';
  return 'UNKNOWN';
}

/** Cuántos dígitos puede tener el número de cada marca. */
function lengthsFor(brand: CardBrand): number[] {
  switch (brand) {
    case 'AMEX':
      return [15];
    case 'DINERS':
      return [14, 16];
    case 'VISA':
      return [13, 16, 19];
    default:
      return [16];
  }
}

export function maxLengthFor(brand: CardBrand): number {
  return Math.max(...lengthsFor(brand), 16);
}

export function cvcLengthFor(brand: CardBrand): number {
  return brand === 'AMEX' ? 4 : 3;
}

/**
 * Número agrupado para leerlo: 4-6-5 en American Express y de a cuatro en
 * el resto, que es como viene impreso en el plástico.
 */
export function formatCardNumber(rawNumber: string): string {
  const brand = detectBrand(rawNumber);
  const n = onlyDigits(rawNumber).slice(0, maxLengthFor(brand));

  if (brand === 'AMEX') {
    return [n.slice(0, 4), n.slice(4, 10), n.slice(10, 15)].filter(Boolean).join(' ');
  }
  return n.replace(/(.{4})/g, '$1 ').trim();
}

/** Algoritmo de Luhn: atrapa un dígito mal copiado antes de llamar a nadie. */
export function passesLuhn(rawNumber: string): boolean {
  const n = onlyDigits(rawNumber);
  if (n.length < 12) return false;

  let sum = 0;
  let double = false;
  for (let i = n.length - 1; i >= 0; i -= 1) {
    let digit = Number(n[i]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/** "MMAA" mientras se escribe → "MM/AA". */
export function formatExpiry(raw: string): string {
  const n = onlyDigits(raw).slice(0, 4);
  if (n.length <= 2) return n;
  return `${n.slice(0, 2)}/${n.slice(2)}`;
}

/** Mes y año en dos dígitos, como los espera Wompi, o `null` si no se puede. */
export function parseExpiry(raw: string): { month: string; year: string } | null {
  const n = onlyDigits(raw);
  if (n.length !== 4) return null;
  const month = n.slice(0, 2);
  const year = n.slice(2, 4);
  const m = Number(month);
  if (m < 1 || m > 12) return null;
  return { month, year };
}

/**
 * ¿La tarjeta ya venció? Una tarjeta vale **hasta el último día** de su
 * mes de vencimiento, no hasta el primero: "08/29" sigue sirviendo el 31
 * de agosto de 2029.
 */
export function isExpired(month: string, year: string, now: Date = new Date()): boolean {
  const fullYear = 2000 + Number(year);
  // Día 0 del mes siguiente = último día del mes de vencimiento.
  const lastValidDay = new Date(fullYear, Number(month), 0, 23, 59, 59);
  return lastValidDay.getTime() < now.getTime();
}

export interface CardFormValues {
  number: string;
  expiry: string;
  cvc: string;
  holder: string;
}

export type CardFormErrors = Partial<Record<keyof CardFormValues, string>>;

/**
 * Los errores que se pueden detectar sin preguntarle a nadie, campo por
 * campo, con un texto que la persona entiende.
 */
export function validateCardForm(values: CardFormValues, now: Date = new Date()): CardFormErrors {
  const errors: CardFormErrors = {};
  const brand = detectBrand(values.number);
  const digits = onlyDigits(values.number);

  if (!digits) {
    errors.number = 'Escribe el número de la tarjeta';
  } else if (!lengthsFor(brand).includes(digits.length) || !passesLuhn(digits)) {
    errors.number = 'Revisa el número: parece que falta o sobra un dígito';
  }

  const expiry = parseExpiry(values.expiry);
  if (!onlyDigits(values.expiry)) {
    errors.expiry = 'Escribe el vencimiento';
  } else if (!expiry) {
    errors.expiry = 'Usa el formato MM/AA';
  } else if (isExpired(expiry.month, expiry.year, now)) {
    errors.expiry = 'Esta tarjeta ya venció';
  }

  const cvcDigits = onlyDigits(values.cvc);
  if (!cvcDigits) {
    errors.cvc = 'Escribe el código de seguridad';
  } else if (cvcDigits.length !== cvcLengthFor(brand)) {
    errors.cvc =
      brand === 'AMEX' ? 'En American Express son 4 dígitos, al frente' : 'Son los 3 dígitos del reverso';
  }

  if (values.holder.trim().length < 3) {
    errors.holder = 'Escribe el nombre como aparece en la tarjeta';
  }

  return errors;
}
