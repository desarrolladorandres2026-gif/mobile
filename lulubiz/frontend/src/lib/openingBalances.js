import { mapColumns } from './csv.js';
import { parseAmount } from './money.js';

/** Un solo asiento lleva como máximo 500 líneas (límite del servidor). */
export const MAX_OPENING_LINES = 500;

/** Columnas del archivo de saldos iniciales, con los nombres alternativos que se aceptan. */
export const OPENING_COLUMNS = {
  cuenta: ['codigo_cuenta', 'codigo', 'account', 'cuenta_contable'],
  tercero: ['documento', 'nit', 'identificacion', 'tax_id', 'documento_tercero'],
  centro: ['centro_de_costo', 'cost_center'],
  debito: ['debe', 'debit'],
  credito: ['haber', 'credit'],
  detalle: ['descripcion', 'concepto', 'description'],
};

/** El documento de un tercero sin puntos, espacios ni dígito de verificación («890.903.938-8» → «890903938»). */
export const normalizeDocument = (raw) => String(raw ?? '').replace(/[.\s]/g, '').replace(/-\d$/, '').toUpperCase();

/** Los documentos distintos que trae el archivo, para buscarlos en el servidor antes de armar el asiento. */
export function documentsIn(objects) {
  return [...new Set(objects.map((o) => normalizeDocument(o.values.tercero)).filter(Boolean))];
}

/**
 * Arma el asiento de saldos iniciales desde las filas del archivo. `accountsByCode`: cuentas que admiten asientos;
 * `partyByDocument`: documento normalizado → id del tercero; `centerCodes`: centros de costo activos.
 * Devuelve `{ lines, errors: [{ line, error }], debits, credits, difference }`; el asiento solo se envía si no hay errores.
 */
export function buildOpeningEntry(objects, { currency, accountsByCode, partyByDocument, centerCodes }) {
  const errors = [];
  const lines = [];
  let debits = 0;
  let credits = 0;
  for (const { line, values: v } of objects) {
    const account = (v.cuenta ?? '').trim();
    const blank = !account && !(v.debito ?? '').trim() && !(v.credito ?? '').trim() && !(v.tercero ?? '').trim();
    if (blank) continue;
    const fail = (error) => errors.push({ line, error });
    if (!accountsByCode.has(account)) {
      fail(`La cuenta «${account}» no existe o no admite asientos.`);
      continue;
    }
    const debit = parseAmount(v.debito, currency);
    const credit = parseAmount(v.credito, currency);
    if (debit === null || credit === null) {
      fail('Importe no válido. Ejemplo: 1.250.000,50.');
      continue;
    }
    if (debit > 0 === credit > 0) {
      fail('Escribe débito o crédito, no ambos ni ninguno.');
      continue;
    }
    const document = normalizeDocument(v.tercero);
    let partyId;
    if (document) {
      partyId = partyByDocument.get(document);
      if (!partyId) {
        fail(`El tercero «${v.tercero.trim()}» no existe. Impórtalo primero en «Importar».`);
        continue;
      }
    }
    const center = (v.centro ?? '').trim();
    if (center && !centerCodes.has(center)) {
      fail(`El centro de costo «${center}» no existe o está inactivo.`);
      continue;
    }
    debits += debit;
    credits += credit;
    lines.push({
      accountId: account,
      ...(debit ? { debit } : { credit }),
      ...((v.detalle ?? '').trim() ? { description: v.detalle.trim().slice(0, 200) } : {}),
      ...(center ? { costCenter: center } : {}),
      ...(partyId ? { partyId } : {}),
    });
  }
  if (lines.length > MAX_OPENING_LINES) errors.push({ line: 0, error: `El asiento admite ${MAX_OPENING_LINES} líneas y el archivo trae ${lines.length}. Divide el archivo por cuentas: cada parte debe cuadrar por sí sola.` });
  if (lines.length < 2 && !errors.length) errors.push({ line: 0, error: 'El archivo necesita al menos dos líneas con importe.' });
  return { lines, errors, debits, credits, difference: debits - credits };
}

/** Lee el encabezado y devuelve las filas ya mapeadas; exige `cuenta` y al menos una de `debito` o `credito`. */
export function mapOpening(header, rows) {
  const mapped = mapColumns(header, rows, OPENING_COLUMNS, ['cuenta']);
  const keys = Object.keys(mapped.objects[0]?.values ?? {});
  if (mapped.objects.length && !mapped.missing.length && !keys.includes('debito') && !keys.includes('credito')) mapped.missing.push('debito o credito');
  return mapped;
}
