/**
 * Identificación tributaria de Colombia.
 * El dígito de verificación (DV) del NIT se calcula con los pesos de la DIAN sobre cada dígito,
 * de derecha a izquierda, módulo 11.
 */
const NIT_WEIGHTS = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71];

export const CO_TAX_ID_TYPES = ['NIT', 'CC', 'CE', 'TI', 'PASSPORT', 'FOREIGN_ID'];

export function computeNitCheckDigit(nit) {
  const digits = String(nit);
  if (!/^[0-9]{1,15}$/.test(digits)) throw new Error('el NIT debe tener solo dígitos, hasta 15');
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    sum += Number(digits[digits.length - 1 - i]) * NIT_WEIGHTS[i];
  }
  const remainder = sum % 11;
  return remainder > 1 ? 11 - remainder : remainder;
}

/** Devuelve la lista de problemas de una identificación colombiana; vacía si es válida. */
export function validateColombianTaxId({ taxIdType, taxId, checkDigit }) {
  if (!CO_TAX_ID_TYPES.includes(taxIdType)) return [`tipo de documento no válido para Colombia: ${taxIdType}`];
  if (taxIdType === 'NIT') {
    if (!/^[0-9]{6,10}$/.test(taxId)) return ['el NIT debe tener entre 6 y 10 dígitos'];
    if (checkDigit === undefined || checkDigit === null) return ['el NIT necesita su dígito de verificación'];
    const expected = computeNitCheckDigit(taxId);
    if (Number(checkDigit) !== expected) return [`dígito de verificación incorrecto: el NIT ${taxId} lleva ${expected}`];
    return [];
  }
  if (taxIdType === 'CC' || taxIdType === 'TI') {
    return /^[0-9]{5,10}$/.test(taxId) ? [] : [`el documento ${taxIdType} debe tener entre 5 y 10 dígitos`];
  }
  return /^[A-Za-z0-9]{3,20}$/.test(taxId) ? [] : ['el documento debe ser alfanumérico, de 3 a 20 caracteres'];
}
