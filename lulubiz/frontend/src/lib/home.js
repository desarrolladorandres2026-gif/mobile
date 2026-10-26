import { formatAmount } from './money.js';

/** Importe en unidades enteras, sin el «,00» de los centavos: en la pantalla de inicio importa el orden de magnitud. */
export const wholeAmount = (minor, currency) => formatAmount(minor, currency).replace(/,0+$/, '');

/** Día local como AAAA-MM-DD. `toISOString` daría el día UTC, que de noche en Colombia ya es el siguiente. */
export const localDay = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

const MONTHS = 6;

/** Rangos que consulta el inicio: año en curso (flujo y mejores clientes) y los últimos seis meses (ventas). */
export function homeRanges(now = new Date()) {
  const first = new Date(now.getFullYear(), now.getMonth() - (MONTHS - 1), 1);
  const monthKeys = Array.from({ length: MONTHS }, (_, i) => {
    const d = new Date(first.getFullYear(), first.getMonth() + i, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });
  return { today: localDay(now), yearStart: `${now.getFullYear()}-01-01`, monthsFrom: localDay(first), monthKeys };
}

/** Una fila por mes del rango, con ceros en los meses sin ventas, para que la serie no tenga huecos. */
export function fillMonths(monthKeys, rows) {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return monthKeys.map((key) => ({ key, invoices: byKey.get(key)?.invoices ?? 0, subtotal: byKey.get(key)?.subtotal ?? 0 }));
}

export function monthLabel(key) {
  const [year, month] = key.split('-').map(Number);
  const text = new Intl.DateTimeFormat('es-CO', { month: 'long', year: 'numeric' }).format(new Date(year, month - 1, 1));
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Porcentaje entero de `part` sobre `total`; 0 si no hay total. Se usa para el ancho de las barras y la participación. */
export const share = (part, total) => (total > 0 && part > 0 ? Math.round((part / total) * 100) : 0);

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * Lo que pide atención hoy, de más a menos urgente. Cada bloque llega `null` si el usuario no puede verlo o no cargó:
 * en ese caso no se inventa nada, simplemente no aparece.
 * `overdue` = lo que ya pasó de su vencimiento (todo menos el tramo «al día»).
 */
export function attentionItems({ onboarding, receivables, payables, lowStock }, currency) {
  const items = [];
  if (onboarding && onboarding.requiredPending > 0) {
    items.push({ key: 'setup', text: `Faltan ${plural(onboarding.requiredPending, 'paso obligatorio', 'pasos obligatorios')} de configuración`, detail: 'Hasta completarlos no se puede facturar de verdad.', path: 'primeros-pasos', action: 'Completar' });
  }
  if (onboarding?.sandbox) {
    items.push({ key: 'sandbox', text: 'La facturación está en modo de pruebas', detail: 'Los documentos no tienen validez ante la DIAN.', path: 'facturacion', action: 'Configurar' });
  }
  for (const [key, data, noun, verb, path] of [
    ['receivables', receivables, 'por cobrar', 'cobrar', 'cartera'],
    ['payables', payables, 'por pagar', 'pagar', 'por-pagar'],
  ]) {
    if (!data) continue;
    const overdue = data.totals.total - data.totals.current;
    if (overdue <= 0) continue;
    const old = data.totals.d90plus;
    items.push({
      key,
      text: `${wholeAmount(overdue, currency)} vencidos ${noun}`,
      detail: `De ${wholeAmount(data.totals.total, currency)} en total${old > 0 ? `; ${wholeAmount(old, currency)} llevan más de 90 días sin ${verb === 'cobrar' ? 'cobrarse' : 'pagarse'}` : ''}.`,
      path,
      action: verb === 'cobrar' ? 'Cobrar' : 'Pagar',
    });
  }
  if (lowStock && lowStock.length > 0) {
    items.push({ key: 'stock', text: `${plural(lowStock.length, 'artículo bajo', 'artículos bajo')} su mínimo de existencias`, detail: lowStock.slice(0, 3).map((i) => i.name).join(', ') + (lowStock.length > 3 ? ' y otros.' : '.'), path: 'existencias', action: 'Revisar' });
  }
  return items;
}
