/**
 * El vocabulario del pedido, en un solo sitio.
 *
 * Antes vivía repetido: `Dashboard.tsx` tenía su escalera de `if` para las
 * etiquetas y `Orders.tsx` un `statusMap` propio, y ya habían divergido —
 * el mismo pedido en estado `ready` se llamaba "Listo para Recoger" en una
 * pantalla y "Listo" en la otra, con colores distintos. Un vocabulario
 * duplicado no se rompe de golpe; se desincroniza poco a poco hasta que
 * dos pantallas del mismo panel describen cosas distintas.
 *
 * Los colores se nombran con los tokens del sistema, nunca con hex: son
 * los únicos que tienen valor en los dos temas.
 */

export type OrderStatus =
  | 'pending'
  | 'accepted'
  | 'preparing'
  | 'ready'
  | 'picked_up'
  | 'on_way'
  | 'delivered'
  | 'cancelled';

export interface StatusStyle {
  /** Cómo se llama en la cocina, no en la base de datos. */
  label: string;
  /** Clases de la pastilla: fondo, borde y tinta. */
  chip: string;
  /** Color del punto que la acompaña. */
  dot: string;
}

/**
 * Espejo del esquema `orderStatus` de mobile/theme/tokens.ts: espera y
 * cocina en ámbar, aceptado y listo en oro claro, en camino en oro,
 * entregado en esmeralda, cancelado en coral.
 */
export const ORDER_STATUS: Record<OrderStatus, StatusStyle> = {
  pending: {
    label: 'Pendiente',
    chip: 'bg-[var(--color-warning-bg)] border-[var(--color-warning)]/40 text-[var(--color-warning)]',
    dot: 'bg-[var(--color-warning)]',
  },
  accepted: {
    label: 'Aceptado',
    chip: 'bg-[var(--color-primary-bg)] border-[var(--color-primary-light)]/40 text-[var(--color-primary)]',
    dot: 'bg-[var(--color-primary-light)]',
  },
  preparing: {
    label: 'En cocina',
    chip: 'bg-[var(--color-warning-bg)] border-[var(--color-warning)]/40 text-[var(--color-warning)]',
    dot: 'bg-[var(--color-warning)]',
  },
  ready: {
    label: 'Listo para recoger',
    chip: 'bg-[var(--color-primary-bg)] border-[var(--color-primary-light)]/40 text-[var(--color-primary)]',
    dot: 'bg-[var(--color-primary-light)]',
  },
  picked_up: {
    label: 'Recogido',
    chip: 'bg-[var(--color-primary-bg)] border-[var(--color-primary)]/40 text-[var(--color-primary-dark)]',
    dot: 'bg-[var(--color-primary)]',
  },
  on_way: {
    label: 'En camino',
    chip: 'bg-[var(--color-primary-bg)] border-[var(--color-primary)]/40 text-[var(--color-primary-dark)]',
    dot: 'bg-[var(--color-primary)]',
  },
  delivered: {
    label: 'Entregado',
    chip: 'bg-[var(--color-success-bg)] border-[var(--color-success)]/40 text-[var(--color-success)]',
    dot: 'bg-[var(--color-success)]',
  },
  cancelled: {
    label: 'Cancelado',
    chip: 'bg-[var(--color-danger-bg)] border-[var(--color-danger)]/40 text-[var(--color-danger)]',
    dot: 'bg-[var(--color-danger)]',
  },
};

const UNKNOWN_STATUS: StatusStyle = {
  label: 'Desconocido',
  chip: 'bg-[var(--color-bg-alt)] border-[var(--color-border)] text-[var(--color-text-secondary)]',
  dot: 'bg-[var(--color-text-muted)]',
};

export const statusStyle = (status: string): StatusStyle =>
  ORDER_STATUS[status as OrderStatus] ?? UNKNOWN_STATUS;

/** Estados en los que el comercio todavía tiene algo que hacer. */
export const ACTIVE_STATUSES: OrderStatus[] = ['pending', 'accepted', 'preparing', 'ready'];

/** Estados en los que el pedido ya salió del local pero sigue vivo. */
export const IN_TRANSIT_STATUSES: OrderStatus[] = ['picked_up', 'on_way'];

export const isActive = (status: string) => ACTIVE_STATUSES.includes(status as OrderStatus);
export const isInTransit = (status: string) => IN_TRANSIT_STATUSES.includes(status as OrderStatus);

/**
 * El siguiente paso que le toca al comercio, o `null` si le toca a otro.
 *
 * Devolver `null` es lo que impide pintar un botón que el backend va a
 * rechazar: las transiciones válidas las decide `order.service.ts` y aquí
 * solo se refleja la parte que corresponde a este rol.
 */
export function nextBusinessStep(
  status: string
): { status: OrderStatus; label: string } | null {
  switch (status) {
    case 'pending':
      return { status: 'accepted', label: 'Aceptar' };
    case 'accepted':
      return { status: 'preparing', label: 'Empezar cocina' };
    case 'preparing':
      return { status: 'ready', label: 'Marcar listo' };
    default:
      // A partir de "listo" manda el domiciliario, y solo con su código.
      return null;
  }
}

// ── Línea de tiempo ──────────────────────────────────────────────────

/**
 * Motivos de rechazo.
 *
 * Cerrados y no un campo libre: el motivo alimenta las estadísticas de
 * incidencias, y "no habia" / "sin stock" / "agotado" escritos a mano son
 * tres motivos distintos para cualquier informe. El texto libre queda
 * como detalle opcional dentro de la nota.
 */
export const REJECTION_REASONS = [
  { value: 'out_of_stock', label: 'Producto agotado' },
  { value: 'store_closed', label: 'El local está cerrado' },
  { value: 'too_busy', label: 'Cocina saturada, no alcanzamos' },
  { value: 'address_out_of_range', label: 'Dirección fuera de cobertura' },
  { value: 'customer_request', label: 'El cliente pidió cancelarlo' },
  { value: 'other', label: 'Otro motivo' },
] as const;

/** Pesos en COP, siempre enteros: aquí no hay centavos. */
export const money = (value: number | null | undefined): string =>
  `$${Math.round(value ?? 0).toLocaleString('es-CO')}`;

/** Igual que `money`, pero anteponiendo el signo de una resta. */
export const signedMoney = (value: number | null | undefined): string => {
  const amount = value ?? 0;
  return `${amount < 0 ? '−' : ''}${money(Math.abs(amount))}`;
};

export const shortId = (id: string): string => `#${id.slice(-8).toUpperCase()}`;

export const dateTime = (value: string | Date | null | undefined): string => {
  if (!value) return '—';
  return new Date(value).toLocaleString('es-CO', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
};

export const clock = (value: string | Date | null | undefined): string => {
  if (!value) return '—';
  return new Date(value).toLocaleTimeString('es-CO', {
    hour: '2-digit',
    minute: '2-digit',
  });
};

// ── La forma del pedido que llega del backend ────────────────────────
//
// Estaba escrita como `any` en cinco sitios: el panel de pedidos, el del
// dashboard, la ficha, el traspaso y el diálogo de rechazo. `any` no es
// "todavía no lo he tipado": es una promesa al compilador de que no
// compruebe nada, y aquí eso significaba que `order.finance.buinessPayout`
// —con la errata— compilaba y pintaba `$NaN` en la liquidación del
// comercio. Estos campos son los que el panel lee de verdad; el backend
// manda más, y añadirlos aquí es tan barato como escribirlos.

/** Referencias que el backend puede mandar pobladas o como id suelto. */
export interface PopulatedUser {
  _id?: string;
  name?: string;
  phone?: string;
  avatar?: string;
}

/**
 * Los endpoints que alimentan este panel pueblan siempre `clientId` y
 * `driverId.userId` (ver `OrderService.getBusinessOrders`), así que el
 * tipo dice eso y no `string | PopulatedUser`. Una union que en la
 * práctica nunca toma la rama `string` solo obliga a escribir guardas
 * muertas en cada pantalla.
 */
export interface PopulatedDriver {
  _id?: string;
  userId?: PopulatedUser | null;
  vehicleType?: string;
  licensePlate?: string;
  status?: string;
}

export interface OrderItemExtra {
  name: string;
  price: number;
  quantity?: number;
  /** Solo cuando la elección salió de un grupo de modificadores. */
  groupId?: string;
  groupName?: string;
  optionId?: string;
}

/**
 * Los adicionales de una línea como los lee la cocina: "Tipo de carne:
 * Angus · Salsas: BBQ, Chipotle · 2× Queso extra".
 *
 * Las opciones van agrupadas bajo la pregunta que respondió el cliente;
 * los extras planos, con su cantidad, al final como siempre.
 */
export function describeExtras(extras: OrderItemExtra[] | null | undefined): string {
  if (!extras?.length) return '';
  const byGroup = new Map<string, string[]>();
  const flat: string[] = [];
  for (const e of extras) {
    if (e.optionId && e.groupName) {
      const list = byGroup.get(e.groupName) ?? [];
      list.push(e.name);
      byGroup.set(e.groupName, list);
    } else {
      flat.push(`${e.quantity ?? 1}× ${e.name}`);
    }
  }
  const grouped = [...byGroup.entries()].map(([group, names]) => `${group}: ${names.join(', ')}`);
  return [...grouped, ...flat].join(' · ');
}

export interface OrderItem {
  _id?: string;
  productId?: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  selectedExtras?: OrderItemExtra[];
  notes?: string;
}

/**
 * El corte financiero congelado del pedido.
 *
 * Opcional entero porque los pedidos anteriores a la migración de
 * monetización no lo traen — por eso el panel cae en `subtotal` y
 * `platformCommission` cuando falta.
 */
export interface OrderFinance {
  productSubtotal: number;
  merchantCommission: number;
  merchantFundedDiscount: number;
  businessPayout: number;
}

export interface BusinessOrder {
  _id: string;
  orderNumber: string;
  status: OrderStatus;
  createdAt: string;
  clientId?: PopulatedUser | null;
  driverId?: PopulatedDriver | null;
  items: OrderItem[];
  deliveryAddress?: string;
  deliveryDetails?: string;
  notes?: string;
  paymentMethod?: 'online' | 'cash_on_delivery';
  subtotal: number;
  total: number;
  platformCommission?: number;
  businessPayout?: number;
  finance?: OrderFinance;
}

// ── El estado del traspaso físico ───────────────────────────────────
//
// Lo devuelve `GET /orders/:id/flow`. Vivía copiado en la ficha del
// pedido y como `any` en la tarjeta de recogida, que es la peor de las
// dos combinaciones: la copia se desincroniza y el `any` ni siquiera
// avisa. Un solo sitio, como el resto del vocabulario del pedido.

export interface HandoffEvidence {
  url: string;
  uploadedAt: string;
}

export interface FlowState {
  status: string;
  pickup: {
    arrivedAt: string | null;
    codeStatus: string | null;
    attempts: number;
    lockedUntil: string | null;
    verifiedAt: string | null;
    code: string | null;
    evidence: HandoffEvidence | null;
  };
  delivery: {
    arrivedAt: string | null;
    codeStatus: string | null;
    verifiedAt: string | null;
    evidence: HandoffEvidence | null;
  };
}
