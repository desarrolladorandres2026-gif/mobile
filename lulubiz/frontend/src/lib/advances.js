import { formatAmount, parseAmount } from './money.js';

const isDay = (text) => /^\d{4}-\d{2}-\d{2}$/.test(text);

/** Formulario de un anticipo: tercero, fecha, importe y la cuenta de caja o bancos por donde se mueve el dinero. */
export function validateAdvance({ partyId, date, amount, account, currency }, { customer }) {
  const errors = {};
  if (!partyId) errors.partyId = customer ? 'Elige el cliente.' : 'Elige el proveedor.';
  if (!isDay(date)) errors.date = 'Elige la fecha.';
  const minor = parseAmount(amount, currency);
  if (minor === null || amount.trim() === '' || minor <= 0) errors.amount = 'Importe no válido. Ejemplo: 500.000';
  if (!/^\d{1,12}$/.test(account.trim())) errors.account = customer ? 'Indica la cuenta de caja o bancos donde entra el dinero.' : 'Indica la cuenta de caja o bancos de donde sale el dinero.';
  const ok = Object.keys(errors).length === 0;
  return { ok, errors, body: ok ? { partyId, date, amount: minor, account: account.trim() } : null };
}

/**
 * Reparte lo que queda del anticipo entre los documentos abiertos, en el orden que vienen (los que vencen antes
 * primero), sin pasarse del saldo de cada uno. Devuelve el texto de cada importe, listo para los campos.
 */
export function suggestAllocations(available, documents, currency) {
  const out = {};
  let left = available;
  for (const doc of documents) {
    if (left <= 0) break;
    const take = Math.min(left, doc.balance);
    if (take > 0) out[doc._id] = formatAmount(take, currency).replace(/\./g, '').replace(',', ',');
    left -= Math.max(take, 0);
  }
  return out;
}

/** Aplicación de un anticipo: lo escrito en cada documento, sin pasarse del saldo del documento ni del anticipo. */
export function validateApplication({ date, amounts, documents, available, currency }) {
  const errors = { form: [], documents: {} };
  if (!isDay(date)) errors.form.push('Elige la fecha.');
  const allocations = [];
  let total = 0;
  for (const doc of documents) {
    const text = (amounts[doc._id] ?? '').trim();
    if (!text) continue;
    const minor = parseAmount(text, currency);
    if (minor === null || minor <= 0) errors.documents[doc._id] = 'Importe no válido.';
    else if (minor > doc.balance) errors.documents[doc._id] = `Solo debe ${formatAmount(doc.balance, currency)}.`;
    else {
      allocations.push({ documentId: doc._id, amount: minor });
      total += minor;
    }
  }
  if (allocations.length === 0 && Object.keys(errors.documents).length === 0) errors.form.push('Escribe cuánto aplicar al menos a un documento.');
  if (total > available) errors.form.push(`Se aplican ${formatAmount(total, currency)} y el anticipo solo tiene ${formatAmount(available, currency)} disponibles.`);
  const ok = errors.form.length === 0 && Object.keys(errors.documents).length === 0;
  return { ok, errors, total, remaining: available - total, body: ok ? { date, allocations } : null };
}
