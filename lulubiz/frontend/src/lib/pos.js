import { computeLine, computeTotals, parseQuantity } from './invoicing.js';
import { parseAmount } from './money.js';

export const PAYMENT_LABELS = { cash: 'Efectivo', card: 'Tarjeta', transfer: 'Transferencia' };

/** Una línea nueva del carrito: de un artículo del inventario o un concepto libre. */
export const cartLine = ({ item = null, vatBps = 1900 } = {}) => ({
  key: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  item,
  description: item?.name ?? '',
  quantity: '1',
  // El precio de un artículo sale de su ficha; si no tiene, se escribe. El de un concepto libre siempre se escribe.
  unitPrice: item?.price === undefined ? '' : String(item.price),
  priceFromItem: Boolean(item) && item.price !== undefined,
  vatBps: item?.vatBps ?? vatBps,
});

/** Precio unitario de una línea en unidades menores: el de la ficha del artículo o el que se escribió. */
function unitPriceOf(line, currency) {
  if (line.priceFromItem) return Number.isSafeInteger(Number(line.unitPrice)) ? Number(line.unitPrice) : null;
  return line.unitPrice.trim() === '' ? null : parseAmount(line.unitPrice, currency);
}

/** Importes de una línea para mostrarlos mientras se arma la venta; `null` si todavía no se puede calcular. */
export function linePreview(line, currency) {
  const quantity = parseQuantity(line.quantity);
  const unitPrice = unitPriceOf(line, currency);
  if (quantity === null || unitPrice === null) return null;
  return computeLine({ quantity, unitPrice, vatBps: line.vatBps });
}

/**
 * Validación de la venta de mostrador: errores por línea y de la venta, el cuerpo listo para enviar, los totales y el
 * reparto de pagos. El efectivo es lo que falta después de tarjeta y transferencia; el efectivo recibido solo sirve
 * para calcular el cambio.
 */
export function validateSale({ lines, cardText = '', transferText = '', tenderedText = '', currency, accepts = { card: true, transfer: true } }) {
  const errors = { form: [], lines: [] };
  const prepared = [];
  const computed = [];

  lines.forEach((line, i) => {
    const e = {};
    errors.lines[i] = e;
    if (!line.description.trim()) e.description = 'Escribe qué se vende.';
    const quantity = parseQuantity(line.quantity);
    if (quantity === null) e.quantity = 'Cantidad no válida (hasta 3 decimales).';
    const unitPrice = unitPriceOf(line, currency);
    if (unitPrice === null) e.unitPrice = 'Precio no válido. Ejemplo: 12.500,50';
    if (Object.keys(e).length) return;
    const result = computeLine({ quantity, unitPrice, vatBps: line.vatBps });
    if (!result) {
      e.unitPrice = 'El importe es demasiado grande.';
      return;
    }
    computed.push({ vatBps: line.vatBps, ...result });
    prepared.push({
      description: line.description.trim(),
      quantity,
      unitPrice,
      vatBps: line.vatBps,
      ...(line.item ? { itemId: line.item._id } : {}),
    });
  });
  if (lines.length === 0) errors.form.push('Agrega al menos un artículo o concepto.');
  const totals = computeTotals(computed);
  const lineErrors = errors.lines.some((e) => Object.keys(e).length);

  const card = accepts.card ? parseAmount(cardText, currency) : 0;
  const transfer = accepts.transfer ? parseAmount(transferText, currency) : 0;
  if (card === null) errors.form.push('El pago con tarjeta no es un importe válido.');
  if (transfer === null) errors.form.push('El pago por transferencia no es un importe válido.');
  const others = (card ?? 0) + (transfer ?? 0);
  if (card !== null && transfer !== null && others > totals.total) errors.form.push('Tarjeta y transferencia suman más que el total.');
  const cash = Math.max(totals.total - others, 0);

  const tendered = tenderedText.trim() ? parseAmount(tenderedText, currency) : undefined;
  if (tendered === null) errors.form.push('El efectivo recibido no es un importe válido.');
  else if (tendered !== undefined && cash > 0 && tendered < cash) errors.form.push('El efectivo recibido es menor que lo que se cobra en efectivo.');
  const change = tendered !== undefined && tendered !== null && cash > 0 && tendered >= cash ? tendered - cash : 0;

  if (prepared.length && totals.total <= 0) errors.form.push('El total debe ser mayor que cero.');

  const payments = [
    ...(cash > 0 ? [{ method: 'cash', amount: cash }] : []),
    ...(card ? [{ method: 'card', amount: card }] : []),
    ...(transfer ? [{ method: 'transfer', amount: transfer }] : []),
  ];
  const ok = !errors.form.length && !lineErrors && prepared.length > 0;
  return {
    ok,
    errors,
    totals,
    cash,
    change,
    body: ok ? { lines: prepared, payments, ...(tendered !== undefined && cash > 0 ? { cashTendered: tendered } : {}) } : null,
  };
}

/** Diferencia del cierre: contado menos esperado. Negativa es faltante; positiva, sobrante. */
export function validateClose({ countedText, expectedCash, currency }) {
  const counted = countedText.trim() === '' ? null : parseAmount(countedText, currency);
  if (counted === null) return { ok: false, error: 'Escribe el efectivo contado. Ejemplo: 150.000', counted: null, difference: 0 };
  return { ok: true, error: null, counted, difference: counted - expectedCash };
}

export const differenceLabel = (difference) => (difference === 0 ? 'Cuadra' : difference < 0 ? 'Faltante' : 'Sobrante');
