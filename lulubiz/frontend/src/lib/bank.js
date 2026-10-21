import { mapColumns } from './csv.js';
import { parseAmount } from './money.js';

/** Columnas de un extracto en CSV, con los nombres que suelen traer los bancos. */
export const STATEMENT_COLUMNS = {
  fecha: ['date', 'fecha_de_operacion', 'fecha_movimiento', 'fecha_de_movimiento', 'fecha_transaccion'],
  detalle: ['descripcion', 'concepto', 'description', 'detalle_del_movimiento', 'descripcion_del_movimiento', 'movimiento'],
  referencia: ['reference', 'documento', 'numero_de_documento', 'nro_documento', 'comprobante', 'referencia_1'],
  valor: ['monto', 'importe', 'amount', 'valor_movimiento', 'valor_del_movimiento'],
  // Desde el punto de vista del banco: un débito o cargo es dinero que sale de la cuenta; un crédito o abono, dinero que entra.
  sale: ['debito', 'debitos', 'egreso', 'egresos', 'retiro', 'retiros', 'cargo', 'cargos', 'salida', 'salidas'],
  entra: ['credito', 'creditos', 'ingreso', 'ingresos', 'deposito', 'depositos', 'abono', 'abonos', 'consignacion', 'consignaciones', 'entrada', 'entradas'],
};

export const DECIMALS = [
  { value: 'comma', label: '1.234,56 (coma decimal)' },
  { value: 'dot', label: '1,234.56 (punto decimal)' },
];

export const CHUNK = 500;

/**
 * Importe con signo de una celda de extracto → unidades menores, o `null` si no se entiende. Acepta «-», paréntesis o
 * «CR/DB» al final; un texto vacío es `0` (para columnas de ingreso y egreso por separado).
 */
export function parseSignedAmount(text, currency, decimal = 'comma') {
  let raw = String(text ?? '').trim().replace(/[$\s]/g, '');
  if (raw === '') return 0;
  let negative = false;
  if (/^\(.*\)$/.test(raw)) {
    negative = true;
    raw = raw.slice(1, -1);
  }
  if (/^-/.test(raw)) {
    negative = !negative;
    raw = raw.slice(1);
  }
  if (/-$/.test(raw)) {
    negative = !negative;
    raw = raw.slice(0, -1);
  }
  if (/^\+/.test(raw)) raw = raw.slice(1);
  if (decimal === 'dot') raw = raw.replace(/,/g, '').replace('.', ',');
  const minor = parseAmount(raw, currency);
  if (minor === null) return null;
  return negative ? 0 - minor : minor;
}

/** Fecha de un extracto → `AAAA-MM-DD`, o `null`. Acepta AAAA-MM-DD, DD/MM/AAAA y DD-MM-AAAA (día primero, como en Colombia). */
export function parseStatementDate(text) {
  const raw = String(text ?? '').trim();
  let y;
  let m;
  let d;
  let match = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (match) [, y, m, d] = match;
  else if ((match = raw.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/))) [, d, m, y] = match;
  else return null;
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const date = new Date(`${iso}T12:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso ? null : iso;
}

/**
 * Convierte las filas de un CSV en líneas de extracto. Devuelve `{ lines, errors, missing, unknown }`: las líneas listas
 * para enviar, los errores por fila del archivo y las columnas que faltan. Hace falta fecha, detalle y un importe: o una
 * columna con signo, o dos (entra y sale).
 */
export function parseStatement(header, rows, { currency, decimal = 'comma' }) {
  const { objects, unknown, missing } = mapColumns(header, rows, STATEMENT_COLUMNS, ['fecha', 'detalle']);
  const hasValue = objects.length === 0 || 'valor' in objects[0].values;
  const hasSplit = objects.length === 0 || ('sale' in objects[0].values && 'entra' in objects[0].values);
  const problems = [...missing];
  if (!hasValue && !hasSplit) problems.push('valor (o las dos columnas entra y sale)');
  if (problems.length) return { lines: [], errors: [], missing: problems, unknown };

  const lines = [];
  const errors = [];
  for (const { line, values } of objects) {
    const date = parseStatementDate(values.fecha);
    if (!date) {
      errors.push({ line, message: `La fecha «${values.fecha}» no es válida (usa AAAA-MM-DD o DD/MM/AAAA).` });
      continue;
    }
    let amount;
    if (hasValue) amount = parseSignedAmount(values.valor, currency, decimal);
    else {
      const out = parseSignedAmount(values.sale, currency, decimal);
      const inn = parseSignedAmount(values.entra, currency, decimal);
      amount = out === null || inn === null ? null : Math.abs(inn) - Math.abs(out);
    }
    if (amount === null) {
      errors.push({ line, message: 'El importe no es válido.' });
      continue;
    }
    if (amount === 0) {
      errors.push({ line, message: 'El importe es cero.' });
      continue;
    }
    if (!values.detalle.trim()) {
      errors.push({ line, message: 'Falta el detalle.' });
      continue;
    }
    lines.push({ date, description: values.detalle.trim().slice(0, 200), ...(values.referencia?.trim() ? { reference: values.referencia.trim().slice(0, 60) } : {}), amount });
  }
  return { lines, errors, missing: [], unknown };
}

/** Parte las líneas en lotes del tamaño que admite el servidor. */
export function chunk(list, size = CHUNK) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Texto de la diferencia de una conciliación: qué falta para que cuadre. */
export function differenceText(difference, format) {
  if (difference === 0) return 'La conciliación cuadra.';
  return `No cuadra: diferencia de ${format(Math.abs(difference))}. ${difference > 0 ? 'El extracto más lo pendiente del libro supera al libro más lo pendiente del banco.' : 'El libro más lo pendiente del banco supera al extracto más lo pendiente del libro.'}`;
}
