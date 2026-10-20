/**
 * Cálculo de la factura en la interfaz: es el mismo del servidor (enteros y BigInt, redondeo medio hacia
 * arriba por línea) para que la vista previa coincida al centavo con lo que el servidor guarda y envía al
 * proveedor. Una prueba compara las dos implementaciones con miles de combinaciones.
 *
 *  - Cantidad en milésimas (1500 = 1,5), precio en unidades menores, descuento e IVA en puntos básicos.
 */
const roundDiv = (numerator, denominator) => (numerator * 2n + denominator) / (denominator * 2n);

export function computeLine({ quantity, unitPrice, discountBps = 0, vatBps = 0 }) {
  const gross = roundDiv(BigInt(unitPrice) * BigInt(quantity), 1000n);
  const discount = roundDiv(gross * BigInt(discountBps), 10_000n);
  const net = gross - discount;
  const tax = roundDiv(net * BigInt(vatBps), 10_000n);
  const toNumber = (value) => {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : null;
  };
  const result = { gross: toNumber(gross), discount: toNumber(discount), net: toNumber(net), tax: toNumber(tax), total: toNumber(net + tax) };
  return Object.values(result).some((v) => v === null) ? null : result;
}

export function computeTotals(lines) {
  let subtotal = 0n;
  let tax = 0n;
  const byRate = new Map();
  for (const line of lines) {
    subtotal += BigInt(line.net);
    tax += BigInt(line.tax);
    const entry = byRate.get(line.vatBps) ?? { vatBps: line.vatBps, base: 0n, tax: 0n };
    entry.base += BigInt(line.net);
    entry.tax += BigInt(line.tax);
    byRate.set(line.vatBps, entry);
  }
  const toNumber = (value) => Number(value);
  return {
    subtotal: toNumber(subtotal),
    tax: toNumber(tax),
    total: toNumber(subtotal + tax),
    taxByRate: [...byRate.values()].sort((a, b) => a.vatBps - b.vatBps).map((e) => ({ vatBps: e.vatBps, base: toNumber(e.base), tax: toNumber(e.tax) })),
  };
}

/** Cantidad escrita como «1,5» → 1500 (milésimas). `null` si no es válida o tiene más de 3 decimales. */
export function parseQuantity(text) {
  const raw = String(text ?? '').trim().replace(/\s+/g, '');
  if (!/^\d+(,\d{1,3})?$/.test(raw)) return null;
  const [whole, fraction = ''] = raw.split(',');
  const milli = Number(whole + fraction.padEnd(3, '0'));
  return Number.isSafeInteger(milli) && milli > 0 ? milli : null;
}

export function formatQuantity(milli) {
  const whole = Math.floor(milli / 1000);
  const fraction = String(milli % 1000).padStart(3, '0').replace(/0+$/, '');
  return fraction ? `${whole},${fraction}` : String(whole);
}

/** Porcentaje escrito como «12,5» → 1250 (puntos básicos). Vacío es 0. `null` si no es válido o pasa de 100. */
export function parsePercent(text) {
  const raw = String(text ?? '').trim().replace(/\s+/g, '').replace(/%$/, '');
  if (raw === '') return 0;
  if (!/^\d+(,\d{1,2})?$/.test(raw)) return null;
  const [whole, fraction = ''] = raw.split(',');
  const bps = Number(whole + fraction.padEnd(2, '0'));
  return bps <= 10_000 ? bps : null;
}

export const formatPercent = (bps) => `${bps % 100 === 0 ? bps / 100 : (bps / 100).toFixed(2).replace('.', ',')} %`;
