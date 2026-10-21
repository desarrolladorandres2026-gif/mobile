import { PUC_COLOMBIA_BORRADOR } from './co/puc.js';
import { CO_TAX_ID_TYPES, validateColombianTaxId } from './co/taxId.js';

/**
 * Registro de paquetes de país. El núcleo no conoce ningún régimen fiscal: consulta aquí.
 * Un país sin paquete usa la validación genérica.
 */
export const COUNTRY_PACKS = {
  CO: {
    taxIdTypes: CO_TAX_ID_TYPES,
    validateTaxId: validateColombianTaxId,
    /** Plan de cuentas inicial. Borrador hasta que lo valide un contador. */
    defaultChart: PUC_COLOMBIA_BORRADOR,
    defaultChartIsDraft: true,
    /** Tarifas de IVA en puntos básicos (1 900 = 19 %). */
    vatRatesBps: [0, 500, 1900],
    /** Motivos de nota crédito de la DIAN. `returnsGoods`: los bienes acreditados vuelven al inventario. */
    creditNoteReasons: [
      { code: '1', label: 'Devolución parcial de los bienes o no aceptación parcial del servicio', returnsGoods: true },
      { code: '2', label: 'Anulación de la factura electrónica', returnsGoods: true },
      { code: '3', label: 'Rebaja o descuento parcial o total' },
      { code: '4', label: 'Ajuste de precio' },
      { code: '5', label: 'Otros' },
    ],
  },
};

export const GENERIC_TAX_ID_TYPES = ['TAX_ID', 'NATIONAL_ID', 'PASSPORT', 'OTHER'];

export function taxIdTypesFor(country) {
  return COUNTRY_PACKS[country]?.taxIdTypes ?? GENERIC_TAX_ID_TYPES;
}

export function validateTaxIdFor(country, parts) {
  const pack = COUNTRY_PACKS[country];
  if (pack) return pack.validateTaxId(parts);
  if (!GENERIC_TAX_ID_TYPES.includes(parts.taxIdType)) return [`tipo de documento no válido: ${parts.taxIdType}`];
  return /^[A-Za-z0-9-]{3,30}$/.test(parts.taxId) ? [] : ['el documento debe ser alfanumérico, de 3 a 30 caracteres'];
}

/** Tarifas de IVA permitidas del país, o `null` si no hay paquete (entonces vale cualquier tarifa válida). */
export const vatRatesFor = (country) => COUNTRY_PACKS[country]?.vatRatesBps ?? null;

export const GENERIC_CREDIT_NOTE_REASONS = [{ code: 'OTHER', label: 'Otros' }];
export const creditNoteReasonsFor = (country) => COUNTRY_PACKS[country]?.creditNoteReasons ?? GENERIC_CREDIT_NOTE_REASONS;
