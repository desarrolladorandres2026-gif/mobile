/**
 * Dinero en la interfaz: el servidor guarda enteros en unidades menores (centavos) y aquí se
 * convierten de y a texto sin pasar nunca por números decimales, que pierden exactitud.
 * Formato de entrada y de salida: es-CO, con punto para los miles y coma para los decimales.
 */
export const CURRENCY_EXPONENT = { COP: 2, USD: 2, EUR: 2, MXN: 2, PEN: 2, CLP: 0 };

export const exponentOf = (currency) => CURRENCY_EXPONENT[currency] ?? 2;

const GROUPED = /^\d{1,3}(\.\d{3})*(,\d+)?$/;
const PLAIN = /^\d+(,\d+)?$/;

/**
 * Convierte "1.190.000,50" en 119000050 (centavos). Devuelve `null` si el texto no es un importe
 * válido: miles mal agrupados, más decimales de los que admite la moneda, o fuera del rango seguro.
 * Un texto vacío es 0, para que una línea con solo débito o solo crédito no obligue a escribir un cero.
 */
export function parseAmount(text, currency) {
  const raw = String(text ?? '').trim().replace(/\s+/g, '');
  if (raw === '') return 0;
  if (!GROUPED.test(raw) && !PLAIN.test(raw)) return null;
  const [whole, fraction = ''] = raw.replace(/\./g, '').split(',');
  const exponent = exponentOf(currency);
  if (fraction.length > exponent) return null;
  const minor = Number(whole + fraction.padEnd(exponent, '0'));
  return Number.isSafeInteger(minor) ? minor : null;
}

/** Convierte 119000050 en "1.190.000,50". Los enteros se formatean con BigInt: sin errores de redondeo. */
export function formatAmount(minor, currency) {
  if (!Number.isSafeInteger(minor)) return '—';
  const exponent = exponentOf(currency);
  const negative = minor < 0;
  const digits = BigInt(Math.abs(minor)).toString().padStart(exponent + 1, '0');
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = exponent ? digits.slice(-exponent) : '';
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${negative ? '-' : ''}${grouped}${exponent ? `,${fraction}` : ''}`;
}
