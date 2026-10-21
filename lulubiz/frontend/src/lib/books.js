export const REPORTS = [
  { value: 'sales-book', label: 'Libro de ventas', needsParty: null },
  { value: 'purchases-book', label: 'Libro de compras', needsParty: null },
  { value: 'customer-statement', label: 'Estado de cuenta de un cliente', needsParty: 'customer' },
  { value: 'supplier-statement', label: 'Estado de cuenta de un proveedor', needsParty: 'supplier' },
  { value: 'sales-by-customer', label: 'Ventas netas por cliente', needsParty: null },
  { value: 'sales-by-month', label: 'Ventas netas por mes', needsParty: null },
  { value: 'cost-center-result', label: 'Resultado por centro de costo', needsParty: null, monthly: true },
  { value: 'party-ledger', label: 'Auxiliar de un tercero', needsParty: 'any', monthly: true },
];

export const KIND_LABELS = {
  invoice: 'Factura',
  credit_note: 'Nota crédito',
  purchase: 'Compra',
  supplier_note: 'Nota de proveedor',
  receipt: 'Recibo de caja',
  payment: 'Pago',
  advance: 'Anticipo',
};

/** Primer y último día del mes de `today` (AAAA-MM-DD): el rango con el que se suelen presentar los libros. */
export function monthRange(today) {
  const [y, m] = today.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const pad = (n) => String(n).padStart(2, '0');
  return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(last)}` };
}

/** Ruta y consulta de un informe, o los errores que impiden pedirlo. */
export function buildQuery({ report, from, to, currency, partyId, ...rest }) {
  const errors = [];
  const kind = REPORTS.find((r) => r.value === report);
  if (!kind) errors.push('Elige el informe.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(to ?? '')) errors.push('Elige las dos fechas.');
  else if (from > to) errors.push('La fecha inicial no puede ser posterior a la final.');
  if (!/^[A-Za-z]{3}$/.test((currency ?? '').trim())) errors.push('La moneda es un código de tres letras, por ejemplo COP.');
  if (kind?.needsParty && !partyId) errors.push({ customer: 'Elige el cliente.', supplier: 'Elige el proveedor.', any: 'Elige el tercero.' }[kind.needsParty]);
  if (errors.length) return { ok: false, errors };
  // Estos informes se piden por mes completo: el servidor recibe AAAA-MM.
  const params = { from: kind.monthly ? from.slice(0, 7) : from, to: kind.monthly ? to.slice(0, 7) : to, currency: currency.trim().toUpperCase() };
  let path = report;
  if (report === 'sales-by-customer' || report === 'sales-by-month') {
    path = 'sales-summary';
    params.by = report === 'sales-by-customer' ? 'customer' : 'month';
  }
  if (kind.needsParty) params.partyId = partyId;
  void rest;
  return { ok: true, path: `reports/${path}`, query: new URLSearchParams(params).toString() };
}

export const rateLabel = (bps) => `${bps % 100 === 0 ? bps / 100 : (bps / 100).toFixed(2).replace('.', ',')} %`;
