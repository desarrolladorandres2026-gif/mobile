/**
 * Aritmética de líneas de factura, con enteros y BigInt: nunca decimales.
 *
 *  - `quantity` va en milésimas (1500 = 1,5 unidades): admite hasta 3 decimales.
 *  - `unitPrice` va en unidades menores de la moneda (centavos).
 *  - `discountBps` y `vatBps` van en puntos básicos (10 000 = 100 %; 1 900 = 19 %).
 *
 * Cada importe se redondea por línea, medio hacia arriba, y los totales son la suma de las líneas ya
 * redondeadas: así lo que ve el cliente suma exactamente lo que la autoridad tributaria recalcula.
 */
export class TaxError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TaxError';
  }
}

/** División entera redondeada medio hacia arriba, para numeradores no negativos. */
export const roundDiv = (numerator, denominator) => (numerator * 2n + denominator) / (denominator * 2n);

const toSafe = (value, label) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new TaxError(`${label} se sale del rango seguro`);
  return n;
};

const requireInt = (value, label, { min, max }) => {
  if (!Number.isSafeInteger(value) || value < min || (max !== undefined && value > max)) {
    throw new TaxError(`${label} debe ser un entero${max !== undefined ? ` entre ${min} y ${max}` : ` mayor o igual a ${min}`}`);
  }
  return value;
};

export function computeLine({ quantity, unitPrice, discountBps = 0, vatBps = 0 }) {
  requireInt(quantity, 'la cantidad', { min: 1 });
  requireInt(unitPrice, 'el precio unitario', { min: 0 });
  requireInt(discountBps, 'el descuento', { min: 0, max: 10_000 });
  requireInt(vatBps, 'la tarifa de IVA', { min: 0, max: 10_000 });

  const gross = roundDiv(BigInt(unitPrice) * BigInt(quantity), 1000n);
  const discount = roundDiv(gross * BigInt(discountBps), 10_000n);
  const net = gross - discount;
  const tax = roundDiv(net * BigInt(vatBps), 10_000n);
  return {
    gross: toSafe(gross, 'el valor bruto'),
    discount: toSafe(discount, 'el descuento'),
    net: toSafe(net, 'el valor neto'),
    tax: toSafe(tax, 'el impuesto'),
    total: toSafe(net + tax, 'el total de la línea'),
  };
}

/** Totales del documento y base e impuesto agrupados por tarifa. `lines` ya trae el resultado de `computeLine`. */
export function computeTotals(lines) {
  let subtotal = 0n;
  let discount = 0n;
  let tax = 0n;
  const byRate = new Map();
  for (const line of lines) {
    subtotal += BigInt(line.net);
    discount += BigInt(line.discount);
    tax += BigInt(line.tax);
    const entry = byRate.get(line.vatBps) ?? { vatBps: line.vatBps, base: 0n, tax: 0n };
    entry.base += BigInt(line.net);
    entry.tax += BigInt(line.tax);
    byRate.set(line.vatBps, entry);
  }
  return {
    subtotal: toSafe(subtotal, 'el subtotal'),
    discount: toSafe(discount, 'el descuento total'),
    tax: toSafe(tax, 'el impuesto total'),
    total: toSafe(subtotal + tax, 'el total'),
    taxByRate: [...byRate.values()]
      .sort((a, b) => a.vatBps - b.vatBps)
      .map((e) => ({ vatBps: e.vatBps, base: toSafe(e.base, 'la base'), tax: toSafe(e.tax, 'el impuesto') })),
  };
}

/**
 * Parte proporcional de una línea para una nota crédito. Si se acredita todo lo que queda de la línea,
 * se usa la diferencia exacta (lo facturado menos lo ya acreditado) para que la suma de notas parciales
 * no se aparte ni un centavo de la factura.
 */
export function proportionalShare(line, { quantity, creditedQuantity = 0, creditedNet = 0, creditedTax = 0 }) {
  requireInt(quantity, 'la cantidad a acreditar', { min: 1 });
  const remaining = line.quantity - creditedQuantity;
  if (quantity > remaining) throw new TaxError('no se puede acreditar más de lo facturado');
  if (quantity === remaining) {
    const net = line.net - creditedNet;
    const tax = line.tax - creditedTax;
    return { net, tax, total: net + tax };
  }
  const net = toSafe(roundDiv(BigInt(line.net) * BigInt(quantity), BigInt(line.quantity)), 'el valor neto');
  const tax = toSafe(roundDiv(BigInt(line.tax) * BigInt(quantity), BigInt(line.quantity)), 'el impuesto');
  return { net, tax, total: net + tax };
}
