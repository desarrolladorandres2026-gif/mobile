/** Rango por omisión de los informes de impuestos: el bimestre en curso (los meses pares cierran el bimestre del IVA). */
export function currentBimester(today) {
  const [y, m] = today.split('-').map(Number);
  const startMonth = m % 2 === 0 ? m - 1 : m;
  const endMonth = startMonth + 1;
  const last = new Date(Date.UTC(y, endMonth, 0)).getUTCDate();
  const pad = (n) => String(n).padStart(2, '0');
  return { from: `${y}-${pad(startMonth)}-01`, to: `${y}-${pad(endMonth)}-${pad(last)}` };
}

/** Qué dice el neto del IVA: a pagar, a favor o en cero. */
export function vatVerdict(net) {
  if (net > 0) return { kind: 'payable', text: 'IVA por pagar' };
  if (net < 0) return { kind: 'credit', text: 'Saldo a favor' };
  return { kind: 'zero', text: 'Sin saldo' };
}

/** Valida el cierre de IVA: según el resultado pide la cuenta de IVA por pagar o la de saldo a favor. */
export function validateVatClose({ from, to, dueAccount, creditAccount }, net) {
  const errors = [];
  if (!from || !to) errors.push('Elige las dos fechas.');
  else if (from > to) errors.push('La fecha inicial no puede ser posterior a la final.');
  if (net > 0 && !/^\d{1,12}$/.test(dueAccount.trim())) errors.push('Indica la cuenta de IVA por pagar a la DIAN.');
  if (net < 0 && !/^\d{1,12}$/.test(creditAccount.trim())) errors.push('Indica la cuenta de saldo a favor de IVA.');
  if (errors.length) return { ok: false, errors };
  return { ok: true, body: { from, to, ...(net > 0 ? { dueAccount: dueAccount.trim() } : {}), ...(net < 0 ? { creditAccount: creditAccount.trim() } : {}) } };
}

/** Tarifa del ICA escrita por mil ("9,66") a partes por millón (9660), que es lo que entiende el servidor. Hasta tres decimales y 100 por mil. */
export function parsePerMil(text) {
  const match = /^(\d{1,3})(?:[.,](\d{1,3}))?$/.exec(String(text ?? '').trim());
  if (!match) return null;
  const ppm = Number(match[1]) * 1000 + Number((match[2] ?? '').padEnd(3, '0'));
  return ppm <= 100_000 ? ppm : null;
}

/** El inverso: 9660 → "9,66". */
export function formatPerMil(ppm) {
  const whole = Math.floor(ppm / 1000);
  const frac = String(ppm % 1000).padStart(3, '0').replace(/0+$/, '');
  return frac ? `${whole},${frac}` : String(whole);
}

/** Códigos de cuenta separados por coma o espacio, sin repetidos; `null` si alguno no es un código numérico. */
export function parseAccountList(text) {
  const parts = String(text ?? '').split(/[\s,;]+/).filter(Boolean);
  if (parts.some((p) => !/^\d{1,12}$/.test(p))) return null;
  return [...new Set(parts)];
}
