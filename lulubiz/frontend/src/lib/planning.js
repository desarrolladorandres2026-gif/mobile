import { parseAmount } from './money.js';

export const MONTH_LABELS = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
export const SECTION_LABELS = { operating: 'Actividades de operación', investing: 'Actividades de inversión', financing: 'Actividades de financiación' };

export const blankBudgetLine = () => ({ accountId: '', costCenter: '', months: Array(12).fill('') });

/** Convierte las líneas del servidor (importes en unidades menores) en las del formulario (texto). */
export function toForm(lines, format) {
  return lines.map((l) => ({ accountId: l.accountId, costCenter: l.costCenter ?? '', months: l.months.map((m) => (m ? format(m) : '')) }));
}

/**
 * Valida las líneas del formulario de presupuesto y arma el cuerpo. Una línea vacía se ignora; un mes vacío es 0. Los
 * importes no pueden ser negativos y la misma cuenta con el mismo centro no se repite.
 */
export function validateBudget(lines, currency, resultCodes) {
  const errors = [];
  const seen = new Set();
  const prepared = [];
  lines.forEach((line, i) => {
    const blank = !line.accountId.trim() && line.months.every((m) => !m.trim());
    if (blank) return;
    const where = `Línea ${i + 1}`;
    const accountId = line.accountId.trim();
    if (!/^\d{1,12}$/.test(accountId)) errors.push(`${where}: indica la cuenta.`);
    else if (resultCodes && !resultCodes.has(accountId)) errors.push(`${where}: la cuenta ${accountId} no es de ingresos, costos o gastos.`);
    const key = `${accountId}|${line.costCenter}`;
    if (accountId && seen.has(key)) errors.push(`${where}: la cuenta ${accountId}${line.costCenter ? ` con el centro ${line.costCenter}` : ''} se repite.`);
    seen.add(key);
    const months = line.months.map((text, k) => {
      const value = parseAmount(text, currency);
      if (value === null || value < 0) {
        errors.push(`${where}, ${MONTH_LABELS[k]}: importe no válido.`);
        return 0;
      }
      return value;
    });
    prepared.push({ accountId, ...(line.costCenter ? { costCenter: line.costCenter } : {}), months });
  });
  if (!prepared.length && !errors.length) errors.push('Agrega al menos una línea con importes.');
  return errors.length ? { ok: false, errors } : { ok: true, body: { lines: prepared } };
}

/** Reparte un importe anual en doce partes iguales (el residuo, centavo a centavo, a los primeros meses). */
export function spreadYear(total, currency) {
  const amount = parseAmount(total, currency);
  if (amount === null || amount < 0) return null;
  const base = Math.floor(amount / 12);
  const rest = amount - base * 12;
  return Array.from({ length: 12 }, (_, k) => base + (k < rest ? 1 : 0));
}

/** Porcentaje de diferencia contra el presupuesto: 500 puntos básicos es «5,00 %». `null` si no había presupuesto. */
export function pctText(bps) {
  if (bps === null || bps === undefined) return '—';
  const sign = bps > 0 ? '+' : '';
  return `${sign}${(bps / 100).toFixed(1).replace('.', ',')} %`;
}

/** Si la diferencia contra el presupuesto es buena (verde), mala (rojo) o neutra, según el tipo de cuenta. */
export function varianceTone(type, variance) {
  if (variance === 0) return 'neutral';
  const better = type === 'income' ? variance > 0 : variance < 0;
  return better ? 'good' : 'bad';
}

/** Rango de meses del año en curso hasta el mes actual, para pedir la ejecución. */
export function ytdRange(today) {
  return { from: `${today.slice(0, 4)}-01`, to: today.slice(0, 7) };
}
