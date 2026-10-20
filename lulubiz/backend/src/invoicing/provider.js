import { createHash } from 'node:crypto';
import { computeLine, computeTotals } from './tax.js';

/**
 * Proveedor tecnológico de facturación electrónica: quien firma el documento, lo envía a la autoridad
 * tributaria y devuelve su validación. Lulubiz NO calcula ni inventa ningún código de validación: un
 * documento solo cuenta como emitido si el proveedor lo acepta y devuelve el suyo.
 *
 * Contrato de un adaptador (el contrato lo comprueban las pruebas de `provider.test.js`):
 *
 *   name:    string
 *   sandbox: boolean — `true` si sus documentos NO tienen validez ante la autoridad
 *   issue({ kind, reference, document }) → Promise<
 *       { status: 'accepted', cufe, qr, validatedAt: Date, reference }
 *     | { status: 'rejected', code, message } >
 *       - `kind` es 'invoice' o 'credit_note'; `reference` identifica el documento y vuelve a enviarse igual
 *         en cada reintento: el proveedor debe ser idempotente por `reference` (el mismo documento no se
 *         emite dos veces).
 *       - Lanza `ProviderUnavailableError` si no pudo saber el resultado (red, tiempo de espera). El documento
 *         queda pendiente y se reintenta; nunca se da por rechazado ni por aceptado.
 *   status(reference) → Promise<{ status: 'accepted', ...} | { status: 'unknown' }>
 */
export class ProviderUnavailableError extends Error {
  constructor(message = 'el proveedor de facturación no respondió') {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}

export function assertProvider(provider) {
  for (const key of ['issue', 'status']) {
    if (typeof provider?.[key] !== 'function') throw new Error(`el proveedor de facturación debe implementar ${key}()`);
  }
  if (!provider.name || typeof provider.sandbox !== 'boolean') {
    throw new Error('el proveedor de facturación debe declarar `name` y `sandbox`');
  }
  return provider;
}

/**
 * Simulador para desarrollo y pruebas. NO valida nada ante ninguna autoridad: sus «CUFE» son falsos y
 * empiezan por `SANDBOX-`. Comprueba lo mismo que comprobaría un proveedor (identificaciones, líneas, totales
 * recalculados) para que los errores de integración aparezcan antes de usar uno real.
 *
 * Comportamientos para probar casos límite: un cliente cuyo nombre contenga `RECHAZAR` provoca un rechazo, y
 * uno que contenga `TIMEOUT` provoca una caída de red en el primer envío (el documento sí queda procesado,
 * como en un proveedor real, y el reintento lo devuelve aceptado).
 */
export function createSandboxProvider({ now = () => new Date() } = {}) {
  const accepted = new Map();
  const timedOut = new Set();

  const accept = (reference, document) => {
    if (accepted.has(reference)) return accepted.get(reference);
    const cufe = `SANDBOX-${createHash('sha384').update(`${reference}|${document.number.fullNumber}|${document.totals.total}`).digest('hex').slice(0, 48)}`;
    const receipt = { status: 'accepted', cufe, qr: `SANDBOX-QR:${cufe}`, validatedAt: now(), reference };
    accepted.set(reference, receipt);
    return receipt;
  };

  const problems = (document) => {
    const found = [];
    if (!document.issuer?.taxId) found.push('falta la identificación del emisor');
    if (!document.customer?.taxId) found.push('falta la identificación del adquirente');
    if (!document.lines?.length) found.push('el documento no tiene líneas');
    try {
      // Una factura se recalcula desde cantidad, precio, descuento e IVA. Una nota crédito lleva partes proporcionales
      // de una factura ya emitida: se comprueba que sus importes sumen lo declarado.
      const recomputed = document.kind === 'credit_note' ? document.lines : document.lines.map((l) => ({ ...l, ...computeLine(l) }));
      const totals = computeTotals(recomputed.map((l) => ({ discount: 0, ...l })));
      if (totals.total !== document.totals.total || totals.tax !== document.totals.tax || totals.subtotal !== document.totals.subtotal) {
        found.push(`los totales no coinciden con las líneas (recalculado ${totals.total}, recibido ${document.totals.total})`);
      }
    } catch (error) {
      found.push(`líneas inválidas: ${error.message}`);
    }
    return found;
  };

  return {
    name: 'sandbox',
    sandbox: true,

    async issue({ reference, document }) {
      if (accepted.has(reference)) return accepted.get(reference);
      const found = problems(document);
      if (found.length) return { status: 'rejected', code: 'SANDBOX_VALIDATION', message: found.join('; ') };
      const name = document.customer.name ?? '';
      if (name.includes('RECHAZAR')) return { status: 'rejected', code: 'SANDBOX_REJECTED', message: 'Rechazo simulado por el proveedor de pruebas.' };
      if (name.includes('TIMEOUT') && !timedOut.has(reference)) {
        timedOut.add(reference);
        accept(reference, document); // el proveedor procesó el documento aunque la respuesta no llegó
        throw new ProviderUnavailableError('tiempo de espera agotado (simulado)');
      }
      return accept(reference, document);
    },

    async status(reference) {
      return accepted.get(reference) ?? { status: 'unknown' };
    },
  };
}
