/** Nivel de sangría de cada fila: cuántas otras cuentas de la lista son prefijo de su código. */
export function withDepth(rows) {
  const codes = rows.map((r) => r.code);
  return rows.map((r) => ({ ...r, depth: codes.filter((c) => c !== r.code && r.code.startsWith(c)).length }));
}

/** Filas del libro auxiliar de una página: saldo inicial (primera página), asientos y saldo final (última). */
export function ledgerRows(page, { first, last }) {
  const rows = [];
  if (first && page.opening) rows.push({ kind: 'opening', debit: page.opening.debit, credit: page.opening.credit, balance: page.opening.balance });
  for (const item of page.items) rows.push({ kind: 'entry', ...item });
  if (last && page.closing) rows.push({ kind: 'closing', debit: page.closing.debit, credit: page.closing.credit, balance: page.closing.balance });
  return rows;
}

/** Texto del resultado de la comprobación contable de un informe. */
export function balanceNotice(report) {
  if (report.balanced) return { kind: 'success', text: 'El informe cuadra.' };
  return { kind: 'error', text: 'El informe no cuadra. No lo uses hasta revisar los asientos: avisa a soporte con el rango consultado.' };
}
