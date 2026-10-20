import { formatAmount, parseAmount } from './money.js';

/**
 * Valida un cobro antes de enviarlo. `invoices` son las facturas abiertas del cliente y `amounts` el texto que
 * se escribió por factura (clave: id). Una factura sin texto no se cobra. Nada se redondea: un importe con más
 * decimales de los que admite la moneda es un error, no un cobro de otro valor.
 */
export function validateReceipt({ partyId, date, depositAccount, invoices, amounts, currency }) {
  const form = [];
  const rows = {};
  if (!partyId) form.push('Elige el cliente.');
  if (!date) form.push('Elige la fecha del cobro.');
  if (!/^\d{1,12}$/.test(String(depositAccount ?? ''))) form.push('Indica la cuenta de caja o bancos donde entra el dinero.');

  const allocations = [];
  let total = 0;
  for (const invoice of invoices) {
    const text = String(amounts[invoice._id] ?? '').trim();
    if (!text) continue;
    const amount = parseAmount(text, currency);
    if (amount === null) rows[invoice._id] = 'Importe no válido.';
    else if (amount <= 0) rows[invoice._id] = 'El importe debe ser mayor que cero.';
    else if (amount > invoice.balance) rows[invoice._id] = `Supera el saldo de ${formatAmount(invoice.balance, currency)}.`;
    else {
      allocations.push({ invoiceId: invoice._id, amount });
      total += amount;
    }
  }
  if (!Object.keys(rows).length && allocations.length === 0) form.push('Indica cuánto se cobra en al menos una factura.');
  return { ok: form.length === 0 && Object.keys(rows).length === 0, errors: { form, rows }, allocations, total };
}

/** Texto de un importe en unidades menores para rellenar un campo: "1.190.000,50". */
export const amountText = (minor, currency) => formatAmount(minor, currency);

/** Encabezados y orden de las edades de cartera. */
export const AGING_COLUMNS = [
  ['current', 'Vigente'],
  ['d1_30', '1-30 días'],
  ['d31_60', '31-60 días'],
  ['d61_90', '61-90 días'],
  ['d90plus', 'Más de 90'],
];
