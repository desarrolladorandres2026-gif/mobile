import api from '../services/api';

/**
 * Soporte del comercio: tipos, catálogos y reglas que comparten la lista, el
 * formulario, el hilo y el Centro de ayuda.
 *
 * El servidor es quien decide tipo legal, prioridad, categoría y medio de pago
 * de un caso; estos catálogos solo dicen qué se le ofrece al comercio. Si
 * cambian los motivos, hay que tocar también `PQRS_REASONS` en
 * `backend/src/services/pqrs.service.ts` (el repo no tiene paquete compartido).
 */

export type CaseType = 'petition' | 'complaint' | 'claim' | 'suggestion';
export type Status = 'received' | 'in_review' | 'answered' | 'closed';
/** Los cinco estados que ve el comercio; el servidor los deriva de los cuatro que guarda. */
export type DisplayStatus = 'open' | 'in_review' | 'waiting_business' | 'resolved' | 'closed';
export type Category = 'operational' | 'technical' | 'financial';
export type PaymentMethod = 'online' | 'cash_on_delivery';
export type RefundStatus = 'pending' | 'done' | 'rejected';

export type Reason =
  | 'driver_no_show' | 'driver_issue' | 'order_issue' | 'preparation_issue' | 'order_status_error' | 'customer_unreachable'
  | 'order_payment_cancel' | 'settlement_difference' | 'wrong_commission' | 'unidentified_payment'
  | 'cancelled_order_adjustment' | 'refund_question'
  | 'panel_issue' | 'account'
  | 'contact_customer_claim' | 'contact_customer_warranty' | 'contact_customer_clarification'
  // Anterior a los motivos financieros específicos: ya no se ofrece, pero hay casos guardados con él.
  | 'payment';

export interface Message {
  message: string;
  from?: 'staff' | 'requester';
  createdAt: string;
}

export interface Ticket {
  _id: string;
  /** SOP-000123: el número que se dice por teléfono. */
  code: string;
  type: CaseType;
  reason?: Reason | null;
  category?: Category | null;
  subject: string;
  detail: string;
  status: Status;
  displayStatus: DisplayStatus;
  createdAt: string;
  updatedAt: string;
  responses?: Message[];
  statusHistory?: Array<{ status: Status; at: string; actor: 'requester' | 'staff' | 'system'; resolved?: boolean }>;
  /** Hasta cuándo se promete responder. Solo viene mientras el caso espera respuesta. */
  respondBy?: string | null;
  legalDueAt?: string | null;
  /** Del reembolso que pidió Soporte a Finanzas solo se conoce el estado. */
  refundStatus?: RefundStatus | null;
  /** El servidor ya aplicó la ventana de 7 días y el tope de reaperturas. */
  canReopen?: boolean;
  resolvedByRequester?: boolean;
  paymentMethod?: PaymentMethod | null;
  /** Del pedido citado solo se conoce cómo ubicarlo: nada de montos ni del cliente. */
  order?: { orderNumber: string; status: string; paymentMethod?: PaymentMethod } | null;
  /** De la liquidación citada solo se conoce su periodo. */
  settlement?: { periodStart: string; periodEnd: string } | null;
  evidence?: Array<{ _id: string; name: string; uploadedAt: string }>;
  /** Solo en la vista del local: quién lo abrió y si es de quien mira. */
  openedBy?: string;
  mine?: boolean;
}

export const CATEGORY_LABEL: Record<Category, string> = {
  operational: 'Operativo',
  technical: 'Técnico y cuenta',
  financial: 'Financiero',
};

export interface ReasonOption {
  key: Reason;
  category: Category;
  label: string;
  /** Para el asunto sugerido y el listado. */
  short: string;
  /** Qué contar; sale como ayuda del campo de descripción. */
  hint: string;
  needsOrder: boolean;
  /** Ofrece escoger una liquidación del local. */
  settlement?: boolean;
  /**
   * Contacto intermediado con el cliente de un pedido cerrado. Solo se ofrece
   * con `customers:contact`; el servidor lo vuelve a exigir.
   */
  contact?: boolean;
}

/**
 * Lo que el comercio elige al pedir ayuda. El servidor decide el tipo legal
 * (petición, queja, reclamo) y la prioridad a partir del motivo y del pedido:
 * quien abre el caso describe qué pasó, no cómo se clasifica.
 */
export const REASONS: ReasonOption[] = [
  { key: 'driver_no_show', category: 'operational', label: 'El domiciliario no llegó', short: 'Domiciliario no llegó', hint: 'Cuéntanos hace cuánto lo esperas y si intentaste contactarlo.', needsOrder: true },
  { key: 'driver_issue', category: 'operational', label: 'Otro problema con el domiciliario', short: 'Problema con el domiciliario', hint: 'Qué pasó con el domiciliario al recoger o al entregar.', needsOrder: true },
  { key: 'order_issue', category: 'operational', label: 'El pedido tiene inconsistencias', short: 'Inconsistencia en el pedido', hint: 'Faltante, mal armado o dañado: qué pasó y con qué producto.', needsOrder: true },
  { key: 'preparation_issue', category: 'operational', label: 'Inconveniente durante la preparación', short: 'Inconveniente en la preparación', hint: 'Qué impidió preparar el pedido a tiempo o como estaba pedido.', needsOrder: true },
  { key: 'order_status_error', category: 'operational', label: 'El estado del pedido está mal', short: 'Error en el estado del pedido', hint: 'Qué estado muestra el panel y cuál debería mostrar.', needsOrder: true },
  { key: 'customer_unreachable', category: 'operational', label: 'El cliente no responde', short: 'Cliente no responde', hint: 'Cuántas veces lo intentaste y por qué medio.', needsOrder: true },
  { key: 'order_payment_cancel', category: 'financial', label: 'Pago o cancelación de un pedido', short: 'Pago o cancelación del pedido', hint: 'Qué pasó con el pago o con la cancelación y qué esperabas.', needsOrder: true },
  { key: 'settlement_difference', category: 'financial', label: 'Diferencia en una liquidación', short: 'Diferencia en liquidación', hint: 'Qué monto esperabas, cuál recibiste y de qué semana es.', needsOrder: false, settlement: true },
  { key: 'wrong_commission', category: 'financial', label: 'Comisión incorrecta', short: 'Comisión incorrecta', hint: 'Qué comisión te cobraron y cuál crees que correspondía.', needsOrder: false, settlement: true },
  { key: 'unidentified_payment', category: 'financial', label: 'Un pago que no identifico', short: 'Pago no identificado', hint: 'Fecha, monto y por dónde lo recibiste.', needsOrder: false, settlement: true },
  { key: 'cancelled_order_adjustment', category: 'financial', label: 'Pedido cancelado con posible ajuste', short: 'Ajuste por pedido cancelado', hint: 'Qué ajuste esperas y por qué.', needsOrder: true },
  { key: 'refund_question', category: 'financial', label: 'Duda sobre un reembolso', short: 'Duda sobre reembolso', hint: 'Qué quieres saber del reembolso de este pedido.', needsOrder: true },
  { key: 'panel_issue', category: 'technical', label: 'Algo falla en el panel o la app', short: 'Falla técnica', hint: 'Qué pantalla, qué hacías y qué mensaje apareció.', needsOrder: false },
  { key: 'account', category: 'technical', label: 'Mi cuenta o mi local', short: 'Cuenta o local', hint: 'Qué intentas hacer y qué te lo impide.', needsOrder: false },
  // ZIPP habla con el cliente de un pedido ya entregado o cancelado: el
  // historial no guarda su número para el local (decisión 2026-10-17).
  { key: 'contact_customer_claim', category: 'operational', label: 'Atender un reclamo del cliente', short: 'Contactar al cliente: reclamo', hint: 'Qué reclamó el cliente y qué le quieres proponer. ZIPP se lo transmite.', needsOrder: true, contact: true },
  { key: 'contact_customer_warranty', category: 'operational', label: 'Una garantía de un producto', short: 'Contactar al cliente: garantía', hint: 'Qué producto, qué falla y cómo la resolverías (cambio, devolución, visita).', needsOrder: true, contact: true },
  { key: 'contact_customer_clarification', category: 'operational', label: 'Aclarar algo del pedido con el cliente', short: 'Contactar al cliente: aclaración', hint: 'Qué necesitas aclarar y qué le debemos preguntar.', needsOrder: true, contact: true },
];

/** Título del grupo de contacto en el formulario. */
export const CONTACT_GROUP_LABEL = 'Hablar con un cliente por medio de ZIPP';

/** Para nombrar casos que ya no se ofrecen (`payment`) o que se abrieron eligiendo el tipo. */
export function reasonLabel(ticket: Pick<Ticket, 'reason' | 'type'>): string {
  if (ticket.reason === 'payment') return 'Un cobro o una liquidación';
  const found = REASONS.find((r) => r.key === ticket.reason);
  return found ? found.short : TYPE_LABEL[ticket.type];
}

export const TYPE_LABEL: Record<CaseType, string> = {
  petition: 'Petición',
  complaint: 'Queja',
  claim: 'Reclamo',
  suggestion: 'Sugerencia',
};

export const DISPLAY_STATUS: Record<DisplayStatus, { label: string; dot: string }> = {
  open: { label: 'Abierto', dot: 'bg-[var(--color-warning)]' },
  in_review: { label: 'En revisión', dot: 'bg-[var(--color-primary-light)]' },
  waiting_business: { label: 'Esperando respuesta del negocio', dot: 'bg-[var(--color-primary)]' },
  resolved: { label: 'Resuelto', dot: 'bg-[var(--color-success)]' },
  closed: { label: 'Cerrado', dot: 'bg-[var(--color-border)]' },
};

/** La etiqueta de un paso del historial, que guarda el estado interno y no el que se muestra. */
export function historyLabel(entry: { status: Status; resolved?: boolean }): string {
  if (entry.status === 'received') return DISPLAY_STATUS.open.label;
  if (entry.status === 'in_review') return DISPLAY_STATUS.in_review.label;
  if (entry.status === 'answered') return DISPLAY_STATUS.waiting_business.label;
  return entry.resolved ? DISPLAY_STATUS.resolved.label : DISPLAY_STATUS.closed.label;
}

export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  online: 'Pago en línea',
  cash_on_delivery: 'Pago en efectivo',
};

export const REFUND_LABEL: Record<RefundStatus, string> = {
  pending: 'en revisión con Finanzas',
  done: 'atendido por Finanzas',
  rejected: 'no aprobado por Finanzas',
};

/** "1 oct – 7 oct" para el periodo de una liquidación. */
export function periodLabel(start: string, end: string): string {
  const fmt = (iso: string) => new Date(iso).toLocaleDateString('es-CO', { day: 'numeric', month: 'short' });
  return `${fmt(start)} – ${fmt(end)}`;
}

export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const ATTACHMENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

/** Lo que se puede comprobar antes de subir; los bytes los verifica el servidor. */
export function attachmentError(file: File): string {
  if (!ATTACHMENT_TYPES.includes(file.type)) return 'Sube una imagen JPG, PNG o WEBP, o un PDF.';
  if (file.size > MAX_ATTACHMENT_BYTES) return 'El archivo pesa más de 5 MB.';
  return '';
}

export function uploadEvidence(ticketId: string, file: File) {
  const form = new FormData();
  form.append('file', file, file.name);
  // Sin Content-Type explícito axios mandaría el FormData como JSON (ver BusinessImageField).
  return api.post(`/pqrs/${ticketId}/evidence`, form, { headers: { 'Content-Type': undefined } });
}

// ── Centro de ayuda ──────────────────────────────────────────────────

export type HelpCategory =
  | 'orders' | 'products' | 'drivers' | 'payments' | 'commissions' | 'promotions' | 'cancellations' | 'refunds' | 'account';

export interface HelpArticle {
  _id: string;
  category: HelpCategory;
  question: string;
  answer: string;
  /** Posición que le dio Soporte; el servidor ya entrega la lista ordenada. */
  sortOrder: number;
}

export const HELP_CATEGORIES: Array<{ key: HelpCategory; label: string }> = [
  { key: 'orders', label: 'Pedidos' },
  { key: 'products', label: 'Productos e inventario' },
  { key: 'drivers', label: 'Domiciliarios' },
  { key: 'payments', label: 'Pagos y liquidaciones' },
  { key: 'commissions', label: 'Comisiones' },
  { key: 'promotions', label: 'Promociones' },
  { key: 'cancellations', label: 'Cancelaciones' },
  { key: 'refunds', label: 'Reembolsos' },
  { key: 'account', label: 'Administración de la cuenta' },
];

/** Minúsculas y sin tildes: "liquidacion" encuentra "Liquidación". */
export const normalizeText = (text: string): string =>
  text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Qué se puede hacer desde cada tema, además de leer. `links` son secciones
 * reales del panel (se ocultan a quien no tiene permiso para verlas) y
 * `reports` los motivos con los que se abre un caso ya encaminado.
 */
export const TOPIC_ACTIONS: Record<HelpCategory, { links: Array<{ label: string; to: string }>; reports: Reason[] }> = {
  orders: {
    links: [{ label: 'Pedidos', to: '/orders' }, { label: 'Pedidos programados', to: '/scheduled' }],
    reports: ['order_issue', 'preparation_issue', 'order_status_error'],
  },
  products: {
    links: [{ label: 'Menú y catálogo', to: '/menu' }],
    reports: ['panel_issue'],
  },
  drivers: {
    links: [{ label: 'Pedidos', to: '/orders' }],
    reports: ['driver_no_show', 'driver_issue'],
  },
  payments: {
    links: [{ label: 'Liquidaciones', to: '/settlements' }],
    reports: ['settlement_difference', 'unidentified_payment', 'order_payment_cancel'],
  },
  commissions: {
    links: [{ label: 'Liquidaciones', to: '/settlements' }],
    reports: ['wrong_commission'],
  },
  promotions: {
    links: [{ label: 'Promociones', to: '/promotions' }, { label: 'Publicidad', to: '/advertising' }],
    reports: ['panel_issue'],
  },
  cancellations: {
    links: [{ label: 'Pedidos', to: '/orders' }],
    reports: ['order_payment_cancel', 'cancelled_order_adjustment'],
  },
  refunds: {
    links: [{ label: 'Pedidos', to: '/orders' }],
    reports: ['refund_question'],
  },
  account: {
    links: [{ label: 'Personalización del local', to: '/settings' }, { label: 'Documentos', to: '/documents' }, { label: 'Equipo', to: '/staff' }],
    reports: ['account', 'panel_issue'],
  },
};
