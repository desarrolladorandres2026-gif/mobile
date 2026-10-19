/**
 * Enmascarado compartido por las fichas del panel admin (cliente, domiciliario,
 * pedido, comercio) y la búsqueda global.
 *
 * Todo se enmascara en el SERVIDOR: `PermissionGate` en el panel es solo
 * experiencia de uso, nunca la barrera.
 */
import { maskPhone, maskEmail } from '../utils/mask';
import { config } from '../config';
import { OrderStatus } from '../types';

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
 * Lista blanca de `finance` para el personal de un comercio (administrador,
 * empleado): solo lo que el cliente vio y pagó. Decisión 2026-10-09:
 * la comisión de ZIPP y el neto del comercio son la capa financiera
 * (`financial:view`, solo del propietario), igual que en su resumen del día.
 * Antes se dejaban `merchantCommission` y `businessPayout` para que el panel
 * no pintara $0; ahora el panel esconde el bloque entero a quien no tiene
 * `financial:view`. Fuera también el pago al domiciliario y todo el margen
 * de ZIPP.
 */
export const MERCHANT_STAFF_FINANCE_FIELDS = CUSTOMER_FINANCE_FIELDS;

/**
 * Lista blanca de `finance` para el PROPIETARIO: lo del personal más su capa
 * financiera — la comisión que le cobra ZIPP, la tasa aplicada, su neto y el
 * desglose de lo que él mismo financió. Decisión 2026-10-17: el dueño ya no
 * recibe el margen de ZIPP sobre el domicilio, sus ingresos, su gasto en
 * promociones, el IVA que ZIPP declara ni el pago al domiciliario. Antes le
 * llegaba `finance` entero en lista, detalle, cambio de estado y socket, y
 * con eso cualquier comercio reconstruía la economía de la plataforma.
 */
export const MERCHANT_OWNER_FINANCE_FIELDS = [
  ...CUSTOMER_FINANCE_FIELDS,
  'merchantCommission',
  'appliedCommissionBps',
  'businessPayout',
  'freeDeliveryDiscount',
  'autoPromotionDiscount',
] as const;

/**
 * De dónde sale la fecha que cuenta el plazo de datos personales de un pedido.
 *
 *  · `delivered_at` / `cancelled_at`: la fecha real registrada. Es la única que se usa cuando existe.
 *  · `created_at_fallback`: el pedido está cerrado (entregado o cancelado) pero NO guardó la fecha
 *    —pedidos anteriores al registro, migrados, o con la escritura caída a medias—. No se inventa
 *    una entrega: se cuenta desde la creación, que es siempre anterior o igual al cierre real. Así
 *    el plazo solo puede vencer ANTES, nunca después, y la falta de dato nunca amplía el acceso.
 *  · `open`: el pedido sigue en curso; la ausencia de fecha de cierre es lo normal.
 *  · `unknown`: no hay ninguna fecha utilizable; se trata como vencido (restricción segura).
 */
export type OrderClosureSource = 'delivered_at' | 'cancelled_at' | 'created_at_fallback' | 'open' | 'unknown';

const CLOSED_STATUSES: readonly string[] = [OrderStatus.DELIVERED, OrderStatus.CANCELLED];
const DAY_MS = 86_400_000;
/**
 * Un pedido en curso con más antigüedad que esto (el plazo + los 7 días máximos de un pedido
 * programado, `MAX_SCHEDULE_AHEAD_MS` en `order.service`) está atascado, no «en curso»: tampoco
 * da acceso indefinido.
 */
const OPEN_ORDER_SCHEDULE_HORIZON_DAYS = 7;

const validDate = (value: unknown, now: Date): Date | null => {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value as string | number | Date);
  if (Number.isNaN(date.getTime())) return null;
  // Una fecha de cierre en el futuro es un dato corrupto: aceptarla alargaría el acceso hasta entonces.
  if (date.getTime() > now.getTime() + DAY_MS) return null;
  return date;
};

/**
 * Cuándo se cerró un pedido para efectos del plazo de datos personales y de dónde sale esa fecha.
 * `terminal: true` fuerza a tratarlo como cerrado aunque el objeto no traiga `status` (los historiales
 * del comercio solo muestran pedidos cerrados).
 */
export function orderClosure(
  order: object,
  opts: { now?: Date; terminal?: boolean } = {}
): { at: Date | null; source: OrderClosureSource } {
  const o = order as { status?: string; deliveredAt?: unknown; cancelledAt?: unknown; createdAt?: unknown };
  const now = opts.now ?? new Date();
  const delivered = validDate(o.deliveredAt, now);
  if (delivered) return { at: delivered, source: 'delivered_at' };
  const cancelled = validDate(o.cancelledAt, now);
  if (cancelled) return { at: cancelled, source: 'cancelled_at' };

  const closed = opts.terminal === true || (typeof o.status === 'string' && CLOSED_STATUSES.includes(o.status));
  const created = validDate(o.createdAt, now);
  if (closed) return created ? { at: created, source: 'created_at_fallback' } : { at: null, source: 'unknown' };
  return { at: null, source: 'open' };
}

/**
 * Cuándo se cerró un pedido para efectos del plazo de datos personales: la entrega, o la
 * cancelación si nunca se entregó; en un pedido cerrado sin ninguna de las dos, la creación
 * (ver `OrderClosureSource`). `null` si sigue en curso o no hay ninguna fecha.
 */
export function orderClosedAt(order: object, opts: { now?: Date; terminal?: boolean } = {}): Date | null {
  return orderClosure(order, opts).at;
}

/**
 * ¿Ya pasaron los días calendario del plazo para pedir contacto con el cliente?
 * El plazo cuenta días calendario en la zona horaria de liquidación desde el
 * cierre: un pedido entregado el lunes a cualquier hora vence el lunes siguiente
 * a las 23:59 si el plazo es de 7 días.
 *
 * Un pedido cerrado sin fecha de cierre cuenta desde su creación; sin ninguna fecha, está
 * vencido: la falta de dato NUNCA da acceso indefinido (Auditoría 2026-10-19). Los casos
 * excepcionales —garantías, reclamos, obligaciones legales— pasan por la solicitud de contacto
 * con justificación y autorización de soporte (`decideContactException`), que queda auditada.
 * Un pedido en curso no vence, salvo que esté atascado más allá de lo que dura un pedido.
 */
export function contactWindowExpired(
  order: object,
  opts: { now?: Date; windowDays?: number; terminal?: boolean } = {}
): boolean {
  const now = opts.now ?? new Date();
  const windowDays = opts.windowDays ?? config.privacy.contactWindowDays;
  const day = (d: Date) => {
    const local = new Date(d.toLocaleString('en-US', { timeZone: config.settlement.timezone }));
    return Date.UTC(local.getFullYear(), local.getMonth(), local.getDate());
  };
  const { at, source } = orderClosure(order, { now, terminal: opts.terminal });
  if (source === 'unknown') return true;
  if (source === 'open') {
    const created = validDate((order as { createdAt?: unknown }).createdAt, now);
    return !!created && (day(now) - day(created)) / DAY_MS > windowDays + OPEN_ORDER_SCHEDULE_HORIZON_DAYS;
  }
  return (day(now) - day(at!)) / DAY_MS > windowDays;
}

/** «María Fernanda Gómez» → «María G.»: lo justo para reconocer al cliente en un reporte, no para ubicarlo. */
function reduceName(name: unknown): string {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

/**
 * El pedido tal como lo recibe un comercio: por socket al anunciarlo, y por
 * API en lista, detalle y cambio de estado. Es la única forma en que un
 * pedido sale hacia un comercio; quien llama decide `owner` con
 * `businessStaffService.accessFor` (rol `owner`), nunca con lo que mande el
 * navegador.
 *
 * - `finance` va por lista blanca (dueño o personal) y se borran los espejos
 *   de la raíz: sin eso, la lista blanca se saltaría por el costado.
 * - `dispatch` (a qué domiciliarios se ofreció y quién rechazó) es maquinaria
 *   interna de ZIPP y no sale nunca.
 * - `terminal` recorta más, PARA TODOS LOS PAPELES (dueño incluido desde el
 *   2026-10-17): el historial cerrado conserva lo operativo y lo financiero,
 *   pero enmascara el teléfono del cliente y el del domiciliario, quita la
 *   ubicación exacta de entrega y el teléfono de quien recibió. Para hablar
 *   con un cliente de un pedido pasado está el contacto intermediado por
 *   ZIPP (PQRS `contact_customer_*`), que no revela el número. Los datos
 *   siguen en la base para liquidaciones, reclamos y obligaciones legales;
 *   lo que cambia es lo que viaja al panel.
 */
export function merchantOrderView<T extends object>(
  order: T,
  opts: { owner?: boolean; terminal?: boolean; now?: Date } = {}
): T {
  const plain = plainOrder(order);
  plain.finance = pick(plain.finance, opts.owner ? MERCHANT_OWNER_FINANCE_FIELDS : MERCHANT_STAFF_FINANCE_FIELDS);
  delete plain.driverPayout;
  delete plain.tax;
  delete plain.dispatch;
  delete plain.fundHoldReleasePending;
  delete plain.driverCancelPay;
  if (!opts.owner) {
    delete plain.platformCommission;
    delete plain.businessPayout;
  }

  if (opts.terminal) {
    // `toObject()` comparte los subdocumentos poblados con el documento de
    // Mongoose: se copian antes de tocarlos para no reescribir el original
    // (el mismo pedido puede salir después con otra forma, p. ej. al admin).
    const client = plain.clientId;
    if (client && typeof client === 'object' && 'phone' in client) {
      const copy = { ...(client as Record<string, unknown>) };
      copy.phone = maskPhone(copy.phone as string);
      plain.clientId = copy;
    }
    const driver = plain.driverId as Record<string, unknown> | null | undefined;
    const driverUser = driver && typeof driver === 'object' ? (driver.userId as Record<string, unknown> | undefined) : undefined;
    if (driverUser && typeof driverUser === 'object' && 'phone' in driverUser) {
      plain.driverId = { ...driver, userId: { ...driverUser, phone: maskPhone(driverUser.phone as string) } };
    }
    delete plain.deliveryLocation;
    const recipient = plain.recipient;
    if (recipient && typeof recipient === 'object') {
      const copy = { ...(recipient as Record<string, unknown>) };
      delete copy.phone;
      plain.recipient = copy;
    }

    // Vencido el plazo de contacto (2026-10-19), el historial deja de servir como
    // libreta de clientes: sin dirección ni detalle de entrega, con el nombre
    // reducido y sin quien recibió. Lo operativo, lo financiero y la auditoría
    // siguen intactos y la base conserva todo; solo cambia lo que viaja al panel.
    // Pedir contacto pasado el plazo es una excepción con autorización de ZIPP.
    if (contactWindowExpired(plain, { now: opts.now, terminal: true })) {
      const holder = plain.clientId;
      if (holder && typeof holder === 'object') {
        const copy = { ...(holder as Record<string, unknown>) };
        if ('name' in copy) copy.name = reduceName(copy.name);
        delete copy.email;
        delete copy.avatar;
        plain.clientId = copy;
      }
      plain.deliveryAddress = '';
      delete plain.deliveryDetails;
      delete plain.recipient;
      plain.personalDataProtected = true;
    }
  }

  return plain as T;
}

/**
 * El pedido como lo serializaría `res.json`: `toJSON()` y no `toObject()`,
 * porque los poblados (`clientId`, `driverId`) llevan virtuals como `id` que
 * solo `toJSON` incluye. Con `toObject` el recorte se llevaba campos que nadie
 * pidió quitar (lo detectó apiContract.test.ts).
 */
function plainOrder(order: object): Record<string, unknown> {
  const doc = order as { toJSON?: () => unknown; toObject?: () => unknown };
  if (typeof doc.toJSON === 'function') return doc.toJSON() as Record<string, unknown>;
  if (typeof doc.toObject === 'function') return doc.toObject() as Record<string, unknown>;
  return { ...(order as Record<string, unknown>) };
}

/**
 * El pedido para el cliente que lo hizo: lo que vio y pagó (`tax` incluido,
 * que es lo que mostró la cotización), nada de lo que ZIPP cobra o paga a
 * los demás. Auditoría 2026-10-17: crear, "mis pedidos" y el detalle le
 * devolvían `finance` entero.
 */
export function customerOrderView<T extends object>(order: T): T {
  const plain = plainOrder(order);
  plain.finance = customerFinanceView(plain.finance);
  delete plain.driverPayout;
  delete plain.platformCommission;
  delete plain.businessPayout;
  delete plain.dispatch;
  delete plain.fundHoldReleasePending;
  delete plain.driverCancelPay;
  return plain as T;
}

/**
 * Lista blanca de la cotización que ve el cliente en el checkout (Auditoría
 * 2026-10-19). `POST /orders/quote` devolvía el `Quote` interno entero —margen
 * del domicilio, pago al domiciliario, comisión e ingreso bruto de ZIPP, gasto
 * en promociones, versión de tarifa—, de modo que cualquier cuenta de cliente
 * reconstruía la economía de la plataforma con solo cotizar un carrito. Aquí
 * sale lo que el checkout pinta y suma, y nada más. El modelo interno
 * (`pricingService.quote`) no cambia: la creación del pedido lo sigue usando
 * completo para congelar `finance`.
 *
 * Los alias heredados (`subtotal`, `deliveryFee`, `discount`, `tax`, `total`)
 * se conservan: la app instalada los lee.
 */
export const CUSTOMER_QUOTE_FIELDS = [
  'subtotal',
  'deliveryFee',
  'deliveryPayable',
  'freeDeliveryApplied',
  'freeDeliveryDiscount',
  'proDeliveryDiscount',
  'proServiceFeeDiscount',
  'customerServiceFee',
  'productSubtotal',
  'promotionDiscount',
  'discount',
  'tip',
  'tax',
  'total',
  'customerTotal',
  'currency',
  'minOrder',
  'etaMinutesMin',
  'etaMinutesMax',
  'deliveryDistanceKm',
  'zoneName',
  'requiresAgeVerification',
  // Alias de presentación ya calculados por el servidor (todos valores que el
  // cliente puede ver en pantalla; no llevan subsidios).
  'precioOriginal',
  'descuentoEnvio',
  'totalUsuario',
] as const;

const CUSTOMER_QUOTE_ITEM_FIELDS = ['productId', 'productName', 'quantity', 'unitPrice', 'totalPrice', 'selectedExtras', 'notes'] as const;
const CUSTOMER_QUOTE_EXTRA_FIELDS = ['name', 'price', 'quantity', 'groupId', 'groupName', 'optionId'] as const;
/** Del cupón aplicado, lo que el cliente ve: nada de `couponId`, lo que absorbe cada financiador ni el piso de margen. */
const CUSTOMER_QUOTE_COUPON_FIELDS = [
  'code', 'title', 'type', 'fundedBy', 'scope',
  'productDiscount', 'deliveryDiscount', 'serviceFeeDiscount', 'totalDiscount',
] as const;
/** Del aviso de Pro, la frase y qué se quitó; los márgenes con y sin beneficio son de ZIPP. */
const CUSTOMER_QUOTE_PRO_NOTICE_FIELDS = ['code', 'skipped', 'message'] as const;

export function customerQuoteView(quote: unknown): Record<string, unknown> {
  const q = (quote ?? {}) as Record<string, unknown>;
  const out = pick(q, CUSTOMER_QUOTE_FIELDS) ?? {};

  out.items = Array.isArray(q.items)
    ? q.items.map((item) => {
        const view = pick(item, CUSTOMER_QUOTE_ITEM_FIELDS) ?? {};
        if (Array.isArray(view.selectedExtras)) {
          view.selectedExtras = view.selectedExtras.map((e) => pick(e, CUSTOMER_QUOTE_EXTRA_FIELDS));
        }
        return view;
      })
    : [];

  out.coupon = q.coupon ? pick(q.coupon, CUSTOMER_QUOTE_COUPON_FIELDS) : null;
  out.suggestedCoupon = q.suggestedCoupon ? pick(q.suggestedCoupon, ['code', 'title', 'discount']) : null;
  if (q.proBenefitNotice) out.proBenefitNotice = pick(q.proBenefitNotice, CUSTOMER_QUOTE_PRO_NOTICE_FIELDS);
  else if (q.proBenefitNotice === null) out.proBenefitNotice = null;
  return out;
}

/** Lo del cliente más lo que le toca al domiciliario: su pago y la propina. */
export const DRIVER_FINANCE_FIELDS = [...CUSTOMER_FINANCE_FIELDS, 'driverDeliveryPayout', 'driverPayout'] as const;

/**
 * El pedido para un domiciliario (asignado o al que se le ofrece). Sin la
 * comisión del comercio ni el margen de ZIPP, y sin `dispatch`: a quién más se
 * le ofreció y quién lo rechazó no es asunto de otro repartidor.
 */
export function driverOrderView<T extends object>(order: T): T {
  const plain = plainOrder(order);
  plain.finance = pick(plain.finance, DRIVER_FINANCE_FIELDS);
  delete plain.platformCommission;
  delete plain.businessPayout;
  delete plain.tax;
  delete plain.dispatch;
  delete plain.fundHoldReleasePending;
  delete plain.driverCancelPay;
  return plain as T;
}

/** El personal (encargado, mostrador): `merchantOrderView` sin la capa financiera. */
export function merchantStaffOrderView<T extends object>(order: T, opts: { terminal?: boolean } = {}): T {
  return merchantOrderView(order, { owner: false, terminal: opts.terminal });
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
