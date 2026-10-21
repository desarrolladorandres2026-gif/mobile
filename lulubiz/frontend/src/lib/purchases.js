import { computeLine, computeTotals, parsePercent, parseQuantity } from './invoicing.js';
import { parseAmount } from './money.js';

/** Retención sobre una base: `rateBps` en puntos básicos, medio hacia arriba. Misma aritmética que el servidor. */
export function withholdingAmount(base, rateBps) {
  if (!Number.isSafeInteger(base) || base < 0 || !Number.isSafeInteger(rateBps) || rateBps < 1 || rateBps > 10_000) return null;
  const numerator = BigInt(base) * BigInt(rateBps);
  const value = (numerator * 2n + 10_000n) / 20_000n;
  return Number.isSafeInteger(Number(value)) ? Number(value) : null;
}

export const WITHHOLDING_BASES = [
  { value: 'subtotal', label: 'Subtotal' },
  { value: 'vat', label: 'IVA' },
];

/**
 * Validación del formulario de factura de compra: errores por campo, el cuerpo listo para enviar y la vista previa
 * de importes (subtotal, IVA, retenciones y lo que se le debe al proveedor).
 */
export function validatePurchase({ supplierId, supplierDocNumber, issueDate, dueDate, lines, withholdings, currency, warehouseId = '' }) {
  const errors = { form: [], lines: [], withholdings: [] };
  if (!supplierId) errors.form.push('Elige el proveedor.');
  if (!supplierDocNumber.trim()) errors.form.push('Escribe el número de la factura del proveedor.');
  if (!issueDate) errors.form.push('Elige la fecha de la factura.');
  if (dueDate && issueDate && dueDate < issueDate) errors.form.push('El vencimiento no puede ser anterior a la fecha de la factura.');

  const prepared = [];
  const computed = [];
  lines.forEach((line, i) => {
    const e = {};
    errors.lines[i] = e;
    const typed = (line.itemText ?? '').trim();
    const blank = !line.description.trim() && !line.unitPrice.trim() && line.quantity.trim() === '1' && !line.accountId.trim() && !typed;
    if (blank) return;
    if (typed && !line.item) e.item = 'Elige un código de la lista o borra el campo.';
    if (!line.description.trim()) e.description = 'Escribe qué se compra.';
    const quantity = parseQuantity(line.quantity);
    if (quantity === null) e.quantity = 'Cantidad no válida (hasta 3 decimales).';
    const unitPrice = parseAmount(line.unitPrice, currency);
    if (unitPrice === null || line.unitPrice.trim() === '') e.unitPrice = 'Precio no válido. Ejemplo: 1.250.000,50';
    const discountBps = parsePercent(line.discount);
    if (discountBps === null) e.discount = 'Descuento entre 0 y 100.';
    // Un bien del inventario trae su propia cuenta; las demás líneas la piden.
    if (!line.item && !/^\d{1,12}$/.test(line.accountId.trim())) e.accountId = 'Indica la cuenta del gasto, costo o activo.';
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
      ...(line.item ? { itemId: line.item._id, ...(warehouseId ? { warehouseId } : {}) } : { accountId: line.accountId.trim() }),
    });
  });
  if (prepared.length === 0) errors.form.push('Agrega al menos una línea.');
  const totals = computeTotals(computed);
  if (prepared.length && totals.total <= 0) errors.form.push('El total debe ser mayor que cero.');

  const withheldList = [];
  let withheld = 0;
  withholdings.forEach((w, i) => {
    const e = {};
    errors.withholdings[i] = e;
    if (!w.name.trim() && !w.accountId.trim() && !w.rate.trim()) return;
    if (!w.name.trim()) e.name = 'Escribe el nombre de la retención.';
    if (!/^\d{1,12}$/.test(w.accountId.trim())) e.accountId = 'Indica la cuenta de la retención por pagar.';
    const rateBps = parsePercent(w.rate);
    if (rateBps === null || rateBps === 0 || !w.rate.trim()) e.rate = 'Tarifa entre 0,01 y 100.';
    if (Object.keys(e).length) return;
    const base = w.basis === 'vat' ? totals.tax : totals.subtotal;
    const amount = withholdingAmount(base, rateBps);
    withheld += amount;
    withheldList.push({ name: w.name.trim(), accountId: w.accountId.trim(), basis: w.basis, rateBps, base, amount });
  });
  const payable = totals.total - withheld;
  if (prepared.length && totals.total > 0 && payable <= 0) errors.form.push('Las retenciones no pueden dejar la factura sin valor por pagar.');

  const hasFieldErrors = errors.lines.some((e) => Object.keys(e).length) || errors.withholdings.some((e) => Object.keys(e).length);
  return { ok: !errors.form.length && !hasFieldErrors, errors, prepared, withholdings: withheldList, totals, withheld, payable };
}
