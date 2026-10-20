import { formatAmount, parseAmount } from './money.js';

/**
 * Valida un pago antes de enviarlo. `purchases` son las facturas de compra abiertas del proveedor y `amounts` el
 * texto que se escribió por factura (clave: id). Una factura sin texto no se paga. Nada se redondea.
 */
export function validatePayment({ partyId, date, paymentAccount, purchases, amounts, currency }) {
  const form = [];
  const rows = {};
  if (!partyId) form.push('Elige el proveedor.');
  if (!date) form.push('Elige la fecha del pago.');
  if (!/^\d{1,12}$/.test(String(paymentAccount ?? ''))) form.push('Indica la cuenta de caja o bancos de donde sale el dinero.');

  const allocations = [];
  let total = 0;
  for (const purchase of purchases) {
    const text = String(amounts[purchase._id] ?? '').trim();
    if (!text) continue;
    const amount = parseAmount(text, currency);
    if (amount === null) rows[purchase._id] = 'Importe no válido.';
    else if (amount <= 0) rows[purchase._id] = 'El importe debe ser mayor que cero.';
    else if (amount > purchase.balance) rows[purchase._id] = `Supera el saldo de ${formatAmount(purchase.balance, currency)}.`;
    else {
      allocations.push({ purchaseId: purchase._id, amount });
      total += amount;
    }
  }
  if (!Object.keys(rows).length && allocations.length === 0) form.push('Indica cuánto se paga en al menos una factura.');
  return { ok: form.length === 0 && Object.keys(rows).length === 0, errors: { form, rows }, allocations, total };
}

export const amountText = (minor, currency) => formatAmount(minor, currency);

/** Encabezados y orden de las edades de cartera. */
export { AGING_COLUMNS } from './receivables.js';
