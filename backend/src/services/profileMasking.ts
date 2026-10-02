/**
 * Enmascarado compartido por las fichas del panel admin (cliente, domiciliario,
 * pedido, comercio) y la búsqueda global.
 *
 * Todo se enmascara en el SERVIDOR: `PermissionGate` en el panel es solo
 * experiencia de uso, nunca la barrera.
 */
import { maskPhone, maskEmail } from '../utils/mask';

// `maskPhone` (`***4567`) y `maskEmail` (`c***@t***.co`) ya existían en
// `utils/mask.ts` para los logs; se reexportan aquí para que las fichas
// importen todo el enmascarado de un solo sitio.
export { maskPhone, maskEmail };

/** Lista blanca de `finance` para quien no ve comisiones: solo lo que el cliente ya pagó/vio. */
export const CUSTOMER_FINANCE_FIELDS = [
  'productSubtotal',
  'customerServiceFee',
  'deliveryCustomerFee',
  'tip',
  'merchantFundedDiscount',
  'platformFundedDiscount',
  'customerTotal',
  'currency',
] as const;

/**
 * Lista blanca de `evidence` de una alerta de fraude para la vista enmascarada:
 * solo magnitudes. Sin IP, deviceId, accountIds ni coordenadas.
 */
export const MASKED_EVIDENCE_FIELDS = [
  'accountCount',
  'distanceKm',
  'speedKmH',
  'timeDiffSeconds',
  'avgInterval',
  'stdDev',
  'requestCount',
  'isMocked',
] as const;

/** Lista blanca de `metadata` de una acción auditada para la vista enmascarada. */
export const MASKED_ACTION_METADATA_FIELDS = [
  'previousRole',
  'newRole',
  'previousStatus',
  'status',
  'method',
  'route',
  'permission',
] as const;

/** Copia solo los campos listados que existan. `undefined` si `source` no es un objeto. */
export function pick(source: unknown, fields: readonly string[]): Record<string, unknown> | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = (source as Record<string, unknown>)[f];
    if (v !== undefined) out[f] = v;
  }
  return out;
}

/** `finance` de un pedido tal como lo vio el cliente (sin comisiones ni margen). */
export function customerFinanceView(finance: unknown): Record<string, unknown> | undefined {
  return pick(finance, CUSTOMER_FINANCE_FIELDS);
}

/**
 * Lista blanca de `finance` para el personal de un comercio (encargado y
 * mostrador). Lo que el cliente vio más lo que el propio comercio cobra por
 * el pedido. La comisión se queda porque ya se deduce de `businessPayout`
 * (subtotal − descuento del comercio − comisión): quitarla no escondería nada
 * y el panel la pintaría como $0. Fuera: el pago al domiciliario y todo el
 * margen de ZIPP (ingreso bruto y neto, margen del envío, gasto de promoción,
 * descuentos de Pro).
 */
export const MERCHANT_STAFF_FINANCE_FIELDS = [
  ...CUSTOMER_FINANCE_FIELDS,
  'merchantCommission',
  'businessPayout',
] as const;

/**
 * El pedido tal como lo recibe el personal de un comercio (dueño aparte):
 * por socket al anunciarlo, y por API en lista, detalle y cambio de estado.
 *
 * `terminal` recorta más: el historial cerrado (entregado o cancelado) no
 * es asunto operativo, así que ahí se enmascara el teléfono del cliente y
 * se quita la ubicación exacta de entrega y el teléfono de quien recibió.
 * Sin esto, cualquier empleado con `orders:view` podía paginar el historial
 * entero y llevarse la base de clientes con teléfono y dirección (hallazgo
 * ALTO 4, auditoría 2026-10-01). Un pedido en curso sí los necesita: la
 * cocina puede tener que llamar al cliente.
 */
export function merchantStaffOrderView<T extends object>(order: T, opts: { terminal?: boolean } = {}): T {
  const plain: Record<string, unknown> =
    typeof (order as { toObject?: () => unknown }).toObject === 'function'
      ? ((order as { toObject: () => Record<string, unknown> }).toObject())
      : { ...(order as Record<string, unknown>) };
  plain.finance = pick(plain.finance, MERCHANT_STAFF_FINANCE_FIELDS);
  delete plain.driverPayout;

  if (opts.terminal) {
    const client = plain.clientId;
    if (client && typeof client === 'object') {
      (client as Record<string, unknown>).phone = maskPhone((client as Record<string, unknown>).phone as string);
    }
    delete plain.deliveryLocation;
    const recipient = plain.recipient;
    if (recipient && typeof recipient === 'object') {
      delete (recipient as Record<string, unknown>).phone;
    }
  }

  return plain as T;
}

/** Últimos 4 caracteres (cédula, NIT, cuenta, referencia); `null` si no hay valor. */
export function maskLast4(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  return String(value).slice(-4);
}

/**
 * Correo para resultados de búsqueda: primera letra del usuario, dominio
 * completo. `juan@gmail.com` → `j***@gmail.com`. Distinto de `maskEmail`, que
 * también recorta el dominio y sirve para logs.
 */
export function maskEmailKeepDomain(email: string | null | undefined): string | null {
  if (!email || !email.includes('@')) return null;
  const [local, ...rest] = email.split('@');
  return `${local.slice(0, 1)}***@${rest.join('@')}`;
}

/** Teléfono para resultados de búsqueda: `***4567`, o `null` si no hay. */
export function maskPhoneOrNull(phone: string | null | undefined): string | null {
  return phone ? maskPhone(phone) : null;
}
