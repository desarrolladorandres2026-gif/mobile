/**
 * Dígito de verificación del NIT colombiano, para rellenarlo mientras se escribe el número.
 * Es el mismo cálculo que valida el servidor, que es quien decide: esto solo ahorra el viaje.
 */
const WEIGHTS = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71];

export function nitCheckDigit(nit) {
  const digits = String(nit);
  if (!/^[0-9]{1,15}$/.test(digits)) return null;
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) sum += Number(digits[digits.length - 1 - i]) * WEIGHTS[i];
  const remainder = sum % 11;
  return remainder > 1 ? 11 - remainder : remainder;
}

/** Tipos de documento que acepta el servidor para cada país con reglas propias. */
export const TAX_ID_TYPES = {
  CO: [
    { value: 'NIT', label: 'NIT' },
    { value: 'CC', label: 'Cédula de ciudadanía' },
    { value: 'CE', label: 'Cédula de extranjería' },
    { value: 'TI', label: 'Tarjeta de identidad' },
    { value: 'PASSPORT', label: 'Pasaporte' },
    { value: 'FOREIGN_ID', label: 'Documento extranjero' },
  ],
  DEFAULT: [
    { value: 'TAX_ID', label: 'Identificación tributaria' },
    { value: 'NATIONAL_ID', label: 'Documento nacional' },
    { value: 'PASSPORT', label: 'Pasaporte' },
    { value: 'OTHER', label: 'Otro' },
  ],
};

export const taxIdTypesFor = (country) => TAX_ID_TYPES[country] ?? TAX_ID_TYPES.DEFAULT;
