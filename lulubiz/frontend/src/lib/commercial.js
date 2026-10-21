import { computeLine, computeTotals, parsePercent, parseQuantity } from './invoicing.js';
import { parseAmount } from './money.js';

export const FREQUENCIES = [
  { value: 'weekly', label: 'Cada semana' },
  { value: 'monthly', label: 'Cada mes' },
  { value: 'quarterly', label: 'Cada trimestre' },
  { value: 'yearly', label: 'Cada año' },
];

export const QUOTE_STATUS = { open: 'Abierta', accepted: 'Aceptada', rejected: 'Rechazada', invoicing: 'Facturando', invoiced: 'Facturada', void: 'Anulada' };
export const ORDER_STATUS = { open: 'Abierta', receiving: 'Recibiendo', received: 'Recibida', void: 'Anulada' };

export const blankLine = (vatBps = 0) => ({ description: '', quantity: '1', unitPrice: '', discount: '', vatBps, accountId: '', itemText: '', item: null, costCenter: '' });

const isBlank = (line) => !line.description.trim() && !line.unitPrice.trim() && line.quantity.trim() === '1' && !(line.itemText ?? '').trim() && !line.accountId.trim();

/**
 * Valida las líneas de una cotización, una orden de compra o una plantilla recurrente y las deja listas para enviar.
 * Es la misma aritmética de la factura (enteros, mismo redondeo), así que el total de la pantalla es el que guarda el servidor.
 * `requireAccount`: la orden de compra necesita una cuenta de gasto, costo o activo, o un artículo, en cada línea.
 */
export function validateDocLines(lines, { currency, requireAccount = false }) {
  const errors = { form: [], lines: [] };
  const prepared = [];
  const computed = [];
  lines.forEach((line, i) => {
    const e = {};
    errors.lines[i] = e;
    if (isBlank(line)) return;
    const typed = (line.itemText ?? '').trim();
    if (typed && !line.item) e.item = 'Elige un código de la lista o borra el campo.';
    if (!line.description.trim()) e.description = 'Escribe la descripción.';
    const quantity = parseQuantity(line.quantity);
    if (quantity === null) e.quantity = 'Cantidad no válida (hasta 3 decimales).';
    const unitPrice = parseAmount(line.unitPrice, currency);
    if (unitPrice === null || line.unitPrice.trim() === '') e.unitPrice = 'Precio no válido. Ejemplo: 1.250.000,50';
    const discountBps = parsePercent(line.discount);
    if (discountBps === null) e.discount = 'Descuento entre 0 y 100.';
    const account = line.accountId.trim();
    if (account && !/^\d{1,12}$/.test(account)) e.accountId = 'Código de cuenta numérico.';
    if (requireAccount && !account && !line.item) e.accountId = 'Indica la cuenta o elige un artículo.';
    if (Object.keys(e).length) return;
    const result = computeLine({ quantity, unitPrice, discountBps, vatBps: line.vatBps });
    if (!result) {
      e.unitPrice = 'El importe es demasiado grande.';
      return;
    }
    computed.push({ vatBps: line.vatBps, ...result });
    prepared.push({
      description: line.description.trim(),
      quantity,
      unitPrice,
      ...(discountBps ? { discountBps } : {}),
      vatBps: line.vatBps,
      ...(account && !line.item ? { accountId: account } : {}),
      ...(line.item ? { itemId: line.item._id } : {}),
      ...(line.costCenter ? { costCenter: line.costCenter } : {}),
    });
  });
  if (prepared.length === 0) errors.form.push('Agrega al menos una línea.');
  const totals = computeTotals(computed);
  if (prepared.length && totals.total <= 0) errors.form.push('El total debe ser mayor que cero.');
  const hasLineErrors = errors.lines.some((e) => Object.keys(e).length);
  return { ok: !errors.form.length && !hasLineErrors, errors, prepared, totals };
}

/** Suma `days` días a una fecha `AAAA-MM-DD`. */
export function addDays(day, days) {
  const date = new Date(`${day}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Valida la plantilla de una factura recurrente (sin sus líneas) y arma el cuerpo. */
export function validateRecurring({ name, customerId, frequency, startDate, endDate, paymentMethod, dueDays, notes }) {
  const errors = [];
  if (!name.trim()) errors.push('Escribe el nombre de la plantilla.');
  if (!customerId) errors.push('Elige el cliente.');
  if (!startDate) errors.push('Elige la fecha de la primera factura.');
  if (endDate && startDate && endDate < startDate) errors.push('La fecha final no puede ser anterior a la primera factura.');
  const days = Number(String(dueDays).trim() === '' ? 0 : dueDays);
  if (!Number.isInteger(days) || days < 0 || days > 365) errors.push('Los días de plazo son un número de 0 a 365.');
  else if (paymentMethod === 'credit' && days === 0) errors.push('Una venta a crédito necesita días de plazo.');
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    body: {
      name: name.trim(),
      customerId,
      frequency,
      startDate,
      ...(endDate ? { endDate } : {}),
      paymentMethod,
      ...(paymentMethod === 'credit' ? { dueDays: days } : {}),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
    },
  };
}

/** Resumen de lo que dejó una generación de facturas recurrentes. */
export function runSummary({ generated, failed }) {
  if (!generated.length && !failed.length) return 'No había facturas vencidas por generar.';
  const parts = [];
  if (generated.length) parts.push(`Se emitieron ${generated.length} ${generated.length === 1 ? 'factura' : 'facturas'}`);
  if (failed.length) parts.push(`${failed.length} ${failed.length === 1 ? 'plantilla falló' : 'plantillas fallaron'}`);
  return `${parts.join(' y ')}.`;
}
