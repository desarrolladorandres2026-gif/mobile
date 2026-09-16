export enum UserRole {
  CLIENT = 'client',
  DRIVER = 'driver',
  BUSINESS = 'business',
  ADMIN = 'admin',
}

export enum BusinessCategory {
  RESTAURANT = 'restaurant',
  FAST_FOOD = 'fast_food',
  PHARMACY = 'pharmacy',
  CAFE = 'cafe',
  SUPERMARKET = 'supermarket',
}

export enum OrderStatus {
  PENDING = 'pending',
  ACCEPTED = 'accepted',
  PREPARING = 'preparing',
  READY = 'ready',
  PICKED_UP = 'picked_up',
  ON_WAY = 'on_way',
  DELIVERED = 'delivered',
  CANCELLED = 'cancelled',
}

/**
 * Cómo paga el cliente. Son los dos únicos métodos del sistema y este es
 * su único sitio de definición: ni el checkout, ni los paneles, ni el
 * backend escriben la cadena a mano.
 *
 * `CASH_ON_DELIVERY` *es* el método "efectivo" de la interfaz. El nombre
 * largo se conserva porque su valor está persistido en cada pedido y pago
 * ya creado, viaja en los metadatos de Wompi y lo leen las tres apps:
 * renombrarlo a 'cash' obligaría a migrar datos históricos a cambio de
 * nada funcional. La etiqueta que ve el usuario vive en la interfaz.
 */
/**
 * Por qué se canceló un pedido.
 *
 * Un texto libre no se puede contar. Con motivos cerrados se puede
 * responder la pregunta que de verdad importa —¿cancelamos por falta de
 * repartidores o porque los negocios no dan abasto?— y esa respuesta
 * cambia qué hay que arreglar.
 *
 * Los motivos van agrupados por quién cancela, porque las consecuencias no
 * son las mismas: que un cliente se arrepienta y que un negocio no tenga el
 * producto son dos problemas distintos aunque el pedido acabe igual.
 */
export enum CancellationReason {
  // Cliente
  CLIENT_CHANGED_MIND = 'client_changed_mind',
  CLIENT_ORDERED_BY_MISTAKE = 'client_ordered_by_mistake',
  CLIENT_TOO_SLOW = 'client_too_slow',
  CLIENT_WRONG_ADDRESS = 'client_wrong_address',

  // Comercio
  BUSINESS_OUT_OF_STOCK = 'business_out_of_stock',
  BUSINESS_CLOSED = 'business_closed',
  BUSINESS_TOO_BUSY = 'business_too_busy',

  // Operación
  NO_DRIVER_AVAILABLE = 'no_driver_available',
  DRIVER_INCIDENT = 'driver_incident',
  CLIENT_UNREACHABLE = 'client_unreachable',

  // Plataforma
  PAYMENT_FAILED = 'payment_failed',
  SUSPECTED_FRAUD = 'suspected_fraud',
  OTHER = 'other',
}

/** Quién tomó la decisión de cancelar. */
export enum CancelledBy {
  CLIENT = 'client',
  BUSINESS = 'business',
  DRIVER = 'driver',
  ADMIN = 'admin',
  /** El propio sistema, por ejemplo al agotarse los reintentos de reparto. */
  SYSTEM = 'system',
}

/**
 * Qué clase de encargo es.
 *
 * `delivery` es todo lo que ZIPP ha hecho hasta ahora: comprar en un
 * comercio de la plataforma y llevarlo. `errand` es un mandado — recoger
 * algo de un sitio cualquiera y llevarlo a otro, sin catálogo, sin comercio
 * afiliado y sin comisión de venta.
 *
 * Son el mismo objeto `Order` a propósito: todo lo caro de construir —el
 * reparto en cascada, el seguimiento en vivo, los códigos de entrega, la
 * evidencia fotográfica, el chat, la bitácora— sirve igual para los dos, y
 * duplicarlo en un modelo aparte sería duplicar también sus errores.
 */
export enum OrderKind {
  DELIVERY = 'delivery',
  ERRAND = 'errand',
}

export enum PaymentMethod {
  ONLINE = 'online',
  CASH_ON_DELIVERY = 'cash_on_delivery',
}

/**
 * Estado del cobro de un pedido.
 *
 * Los dos métodos recorren caminos distintos y no deben confundirse:
 *
 *   ONLINE:  PENDING → PAID            (lo decide el webhook de Wompi)
 *            PENDING → FAILED
 *
 *   CASH:    PENDING_CASH → CASH_RECEIVED → PAID
 *            PENDING_CASH → CASH_NOT_RECEIVED
 *
 * `PENDING_CASH` existe porque `PENDING` decía dos cosas incompatibles a
 * la vez: "el cliente abandonó la pasarela" y "el domiciliario todavía no
 * ha llegado a cobrar". La primera bloquea el pedido; la segunda es el
 * curso normal. Sin distinguirlas, cualquier informe de impagos mezclaba
 * checkouts abandonados con entregas en curso.
 */
export enum PaymentStatus {
  PENDING = 'pending',
  PAID = 'paid',
  REFUNDED = 'refunded',
  FAILED = 'failed',
  /** Pedido en efectivo aceptado: el dinero se cobra en la puerta. */
  PENDING_CASH = 'pending_cash',
  /** El domiciliario declaró haber recibido el efectivo del cliente. */
  CASH_RECEIVED = 'cash_received',
  /** El domiciliario declaró que NO recibió el efectivo. Es una incidencia. */
  CASH_NOT_RECEIVED = 'cash_not_received',
}

export enum PaymentType {
  ORDER_PAYMENT = 'order_payment',
  BUSINESS_PAYOUT = 'business_payout',
  DRIVER_PAYOUT = 'driver_payout',
  COMMISSION_PAYMENT = 'commission_payment',
}

export enum DriverStatus {
  AVAILABLE = 'available',
  BUSY = 'busy',
  OFFLINE = 'offline',
}

export enum VehicleType {
  MOTORCYCLE = 'motorcycle',
  BICYCLE = 'bicycle',
}

export enum DebtStatus {
  PENDING = 'pending',
  PAID = 'paid',
}

export enum CommissionStatus {
  PENDING = 'pending',
  SETTLED = 'settled',
}

/**
 * Lifecycle of the cash a driver collected on behalf of the platform.
 *
 * A driver may move a reconciliation to REPORTED (declaring they deposited
 * the money); only a verified transaction or a finance admin may take it to
 * VERIFIED and then SETTLED. Self-service settlement is impossible by
 * construction — see CashReconciliationService.
 */
export enum CashReconciliationStatus {
  PENDING = 'pending',
  REPORTED = 'reported',
  VERIFIED = 'verified',
  SETTLED = 'settled',
  OVERDUE = 'overdue',
}

/**
 * Tipo de incidencia sobre un cobro en efectivo.
 *
 * Hay un solo tipo por ahora, y aun así es un enum: el índice único que
 * impide duplicar incidencias es `(orderId, type)`, así que el día que
 * aparezca una segunda clase de disputa —un faltante parcial, un billete
 * falso— no habrá que rehacer el índice ni migrar nada.
 */
export enum CashIncidentType {
  /** El domiciliario declaró que el cliente no le pagó. */
  CASH_NOT_RECEIVED = 'cash_not_received',
}

/**
 * Ciclo de vida de una incidencia de efectivo.
 *
 * Nunca se borra. Una incidencia es la prueba de que alguien declaró un
 * faltante, y borrarla dejaría el saldo del domiciliario modificado sin
 * nada que explique por qué. `REJECTED` es para la declaración que resulta
 * ser falsa; `RESOLVED` para la que se cierra con una decisión, sea cual
 * sea (ver `CashIncidentResolution`).
 */
export enum CashIncidentStatus {
  OPEN = 'open',
  UNDER_REVIEW = 'under_review',
  RESOLVED = 'resolved',
  REJECTED = 'rejected',
}

/**
 * Cómo cierra finanzas una incidencia. Es lo que decide qué pasa con el
 * dinero, así que se guarda aparte del estado: "resuelta" no dice si el
 * domiciliario acabó debiendo o no.
 */
/**
 * Motivos cerrados de una calificación baja, agrupados por relación.
 *
 * Igual que `CancellationReason`: un `comment` libre no se puede contar, y
 * la pregunta que de verdad importa —¿los negocios entregan tarde o los
 * domiciliarios se demoran en recoger?— solo se responde con motivos
 * cerrados. Nunca son obligatorios en un rating alto: solo tienen sentido
 * cuando algo salió mal.
 */
export enum ReviewReasonClientToBusiness {
  PRODUCT_QUALITY = 'product_quality',
  MISSING_ITEM = 'missing_item',
  WRONG_ITEM = 'wrong_item',
  BAD_CONDITION = 'bad_condition',
  PREPARATION_DELAY = 'preparation_delay',
  OTHER = 'other',
}

export enum ReviewReasonClientToDriver {
  LATE_DELIVERY = 'late_delivery',
  POOR_TREATMENT = 'poor_treatment',
  DID_NOT_FOLLOW_INSTRUCTIONS = 'did_not_follow_instructions',
  DELIVERY_PROBLEM = 'delivery_problem',
  OTHER = 'other',
}

export enum ReviewReasonDriverToBusiness {
  ORDER_NOT_READY = 'order_not_ready',
  WAITING_TIME = 'waiting_time',
  POOR_TREATMENT = 'poor_treatment',
  ORDER_PREPARATION_PROBLEM = 'order_preparation_problem',
  OTHER = 'other',
}

export enum ReviewReasonDriverToClient {
  WRONG_ADDRESS = 'wrong_address',
  COMMUNICATION_PROBLEM = 'communication_problem',
  LONG_WAIT = 'long_wait',
  POOR_TREATMENT = 'poor_treatment',
  OTHER = 'other',
}

export enum ReviewReasonBusinessToDriver {
  LATE_PICKUP = 'late_pickup',
  POOR_TREATMENT = 'poor_treatment',
  DELIVERY_PROBLEM = 'delivery_problem',
  ORDER_HANDLING = 'order_handling',
  OTHER = 'other',
}

/**
 * El negocio calificando al cliente no estaba en la lista original de
 * relaciones pedidas, pero el campo `clientRatingByBusiness` ya existía:
 * reusa los mismos motivos que el domiciliario, que describen el mismo
 * problema (dirección, trato, espera) desde el otro lado del mostrador.
 */
export const ReviewReasonBusinessToClient = ReviewReasonDriverToClient;
export type ReviewReasonBusinessToClient = ReviewReasonDriverToClient;

/** Estado de moderación de una reseña — reemplaza el booleano `isHidden`. */
export enum ReviewModerationStatus {
  ACTIVE = 'active',
  HIDDEN = 'hidden',
  REMOVED = 'removed',
}

export enum CashIncidentResolution {
  /** Se le cree: no recibió el dinero y no debe la comisión. */
  DRIVER_FAVOR = 'driver_favor',
  /** La deuda se mantiene: el domiciliario responde por ese efectivo. */
  DEBT_CONFIRMED = 'debt_confirmed',
  /** Cierre administrativo sin efecto sobre el saldo (acuerdo aparte). */
  CLOSED = 'closed',
}

/** Who absorbs the cost of a promotion. */
export enum CouponFundedBy {
  PLATFORM = 'platform',
  BUSINESS = 'business',
}

/** Which line of the order a coupon discounts. */
export enum CouponScope {
  PRODUCT = 'product',
  DELIVERY = 'delivery',
  SERVICE_FEE = 'service_fee',
}

/**
 * Chart of accounts for the order ledger.
 *
 * Every order produces a balanced set of entries across these accounts.
 * Asset/expense accounts increase on DEBIT; liability/revenue accounts
 * increase on CREDIT.
 */
export enum LedgerAccount {
  /** Money actually received through the gateway. */
  CUSTOMER_PAYMENT = 'customer_payment',
  /** Money owed by the customer but not yet collected (cash in transit). */
  RECEIVABLE = 'receivable',
  /** Cash the driver holds on the platform's behalf. */
  CASH_IN_TRANSIT = 'cash_in_transit',
  /** Liability: what we owe the merchant. */
  MERCHANT_PAYABLE = 'merchant_payable',
  /** Liability: what we owe the driver. */
  DRIVER_PAYABLE = 'driver_payable',
  /** Revenue: commission charged to the merchant. */
  COMMISSION_REVENUE = 'commission_revenue',
  /** Revenue: service fee charged to the customer. */
  SERVICE_FEE_REVENUE = 'service_fee_revenue',
  /** Revenue: spread between what the customer pays and the driver earns. */
  DELIVERY_MARGIN_REVENUE = 'delivery_margin_revenue',
  /** Liability: tax collected on behalf of the tax authority. */
  TAX_PAYABLE = 'tax_payable',
  /** Expense: discounts funded by the platform. */
  PROMOTION_EXPENSE = 'promotion_expense',
  /**
   * Gasto: efectivo que el domiciliario tenía que rendir y que finanzas
   * dio por perdido tras revisar el faltante.
   *
   * Es una cuenta propia y no `PROMOTION_EXPENSE` porque responde a otra
   * pregunta de negocio: una promoción es un coste que ZIPP decide pagar,
   * un faltante es dinero que se perdió. Mezclarlos haría imposible saber
   * cuánto cuesta operar en efectivo, que es justo lo que hay que vigilar
   * para decidir si el método se mantiene.
   */
  CASH_SHORTAGE_EXPENSE = 'cash_shortage_expense',
  /**
   * Pasivo: puntos emitidos que el cliente todavía puede canjear.
   *
   * Un punto no es un contador en el perfil de nadie: es una promesa de
   * descuento futuro, y por tanto dinero que ZIPP debe. Tenerlo en el libro
   * es lo que permite responder cuánto vale el programa de fidelización
   * antes de que la factura llegue sola.
   */
  LOYALTY_PAYABLE = 'loyalty_payable',
  /**
   * Pasivo: dinero de compras de mandados que ZIPP ya cobró y todavía debe.
   *
   * En un mandado el cliente paga por adelantado algo que aún no ha
   * comprado nadie. Ese dinero no es ingreso ni es del comercio —no hay
   * comercio—: es una obligación de ZIPP con quien acabe poniéndolo de su
   * bolsillo, que en esta operación es el domiciliario.
   *
   * Es una cuenta propia y no `DRIVER_PAYABLE` porque responde a otra
   * pregunta: cuánto dinero de terceros hay comprometido en compras ahora
   * mismo. Mezclado con las tarifas de reparto, esa exposición —la única
   * cifra que dice si el producto de mandados es sostenible— quedaría
   * invisible dentro de un saldo que sube y baja por otros motivos.
   */
  ERRAND_ADVANCE_PAYABLE = 'errand_advance_payable',
  /** Contra-revenue: money returned to the customer. */
  REFUND = 'refund',
  /** Contra-revenue: forced reversal by the gateway. */
  CHARGEBACK = 'chargeback',
}

export enum LedgerDirection {
  DEBIT = 'debit',
  CREDIT = 'credit',
}

/** What produced a batch of ledger entries. */
export enum LedgerEventType {
  ORDER_PLACED = 'order_placed',
  PAYMENT_CAPTURED = 'payment_captured',
  ORDER_DELIVERED = 'order_delivered',
  ORDER_CANCELLED = 'order_cancelled',
  REFUND_ISSUED = 'refund_issued',
  CHARGEBACK_RECEIVED = 'chargeback_received',
  CASH_SETTLED = 'cash_settled',
  PAYOUT_SETTLED = 'payout_settled',
  /** Finanzas resolvió un faltante a favor del domiciliario: se da de baja. */
  CASH_SHORTAGE_WRITTEN_OFF = 'cash_shortage_written_off',
  /** Se emitieron puntos por una compra: nace el pasivo. */
  LOYALTY_EARNED = 'loyalty_earned',
  /** El cliente cambió sus puntos por un cupón: se extingue el pasivo. */
  LOYALTY_REDEEMED = 'loyalty_redeemed',
  /** Los puntos caducaron sin canjearse: se libera la provisión. */
  LOYALTY_EXPIRED = 'loyalty_expired',
  /** El domiciliario declaró lo que costó de verdad la compra del mandado. */
  ERRAND_COST_ADJUSTED = 'errand_cost_adjusted',
  /** Se le devolvió al domiciliario el dinero que adelantó. */
  ERRAND_ADVANCE_REIMBURSED = 'errand_advance_reimbursed',
}

/** Lifecycle of an amount the platform owes a merchant or a driver. */
export enum PayoutStatus {
  /** Accrued but not yet eligible (order not delivered / not paid). */
  ACCRUED = 'accrued',
  /** Eligible and waiting for the next settlement run. */
  PAYABLE = 'payable',
  /** Included in a settlement batch. */
  SETTLED = 'settled',
  /** Reversed by a cancellation, refund or chargeback. */
  REVERSED = 'reversed',
}

export enum PayoutBeneficiary {
  BUSINESS = 'business',
  DRIVER = 'driver',
}

export enum RefundStatus {
  PENDING = 'pending',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

export enum RefundKind {
  FULL = 'full',
  PARTIAL = 'partial',
  CHARGEBACK = 'chargeback',
}

export enum NotificationType {
  ORDER = 'order',
  PAYMENT = 'payment',
  PROMO = 'promo',
  SYSTEM = 'system',
}

export enum CouponType {
  /** Percentage off the products subtotal, optionally capped by maxDiscount. */
  PERCENTAGE = 'percentage',
  /** Flat amount off the products subtotal. */
  FIXED = 'fixed',
  /** Removes the delivery fee entirely. */
  FREE_DELIVERY = 'free_delivery',
}

export interface GeoPoint {
  type: 'Point';
  coordinates: [number, number]; // [longitude, latitude]
}

export interface DaySchedule {
  open: string;   // "08:00"
  close: string;  // "22:00"
  isOpen: boolean;
}

export interface WeekSchedule {
  monday: DaySchedule;
  tuesday: DaySchedule;
  wednesday: DaySchedule;
  thursday: DaySchedule;
  friday: DaySchedule;
  saturday: DaySchedule;
  sunday: DaySchedule;
}

export interface ProductExtra {
  name: string;
  price: number;
}

/**
 * Un adicional elegido, tal como queda copiado en el pedido.
 *
 * Los tres campos de arriba son los de siempre: `extras` planos que se
 * eligen por nombre. Los de abajo solo viajan cuando la elección salió de
 * un grupo de modificadores; un pedido antiguo no los tiene y se lee
 * igual.
 */
export interface SelectedExtra {
  name: string;
  price: number;
  quantity: number;
  groupId?: string;
  groupName?: string;
  optionId?: string;
}

/**
 * Una opción dentro de un grupo de modificadores: "Angus", "Sin cebolla",
 * "Leche de almendras". El precio es lo que suma sobre el producto; cero
 * es legítimo (elegir el término de la carne no cuesta).
 */
export interface ModifierOption {
  _id?: string;
  name: string;
  price: number;
  isAvailable: boolean;
}

/**
 * Un grupo de modificadores: "Tipo de carne", "Salsas", "Tamaño".
 *
 * Solo se guardan `minSelect` y `maxSelect`. "Obligatorio" es `min > 0` y
 * "selección única" es `max === 1`: se derivan, no se escriben, para que
 * no pueda existir un grupo "único con máximo 3" ni uno "opcional con
 * mínimo 2".
 */
export interface ModifierGroup {
  _id?: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  sortOrder: number;
  options: ModifierOption[];
}

export interface AddressInfo {
  address: string;
  details?: string;
  location: GeoPoint;
}

// ── Trazabilidad de la entrega ───────────────────────────────────────
// Los dos momentos en que la custodia física del pedido cambia de manos.
// Cada uno exige su propia evidencia y su propio código: reutilizar un
// mismo secreto para ambos permitiría a un domiciliario cerrar la entrega
// con el código que el comercio ya le dio en el mostrador.

/** Momento del traspaso que documenta una fotografía. */
export enum OrderEvidenceType {
  /** COMERCIO → REPARTIDOR. El domiciliario recibe el pedido. */
  PICKUP = 'pickup_evidence',
  /** REPARTIDOR → CLIENTE. El domiciliario entrega el pedido. */
  DELIVERY = 'delivery_evidence',
}

/** Cuál de los dos secretos de un pedido. */
export enum OrderCodeKind {
  PICKUP = 'pickup',
  DELIVERY = 'delivery',
}

/**
 * Estado de un código. Solo `PENDING` puede consumirse, y el paso a
 * `USED` es la operación atómica que impide el doble uso.
 */
export enum OrderCodeStatus {
  PENDING = 'pending',
  USED = 'used',
  EXPIRED = 'expired',
  /** Demasiados intentos fallidos: bloqueado hasta que expire el castigo. */
  BLOCKED = 'blocked',
  /** El pedido se canceló: el código ya no sirve para nada. */
  VOID = 'void',
}

/** Ciclo de vida de una llamada entre cliente y domiciliario. */
export enum OrderCallStatus {
  RINGING = 'ringing',
  ACTIVE = 'active',
  ENDED = 'ended',
  REJECTED = 'rejected',
  MISSED = 'missed',
  FAILED = 'failed',
}

/**
 * Vocabulario único de la línea de tiempo de un pedido.
 *
 * Los `OrderEvent` se escriben desde sitios muy distintos —el servicio de
 * pedidos, el controlador del traspaso, la asignación de domiciliario— y
 * se leen desde tres aplicaciones. Con las cadenas escritas a mano en
 * cada sitio, renombrar un hito significaba partir la línea de tiempo de
 * los pedidos ya cerrados sin que nada fallara.
 *
 * Los valores son exactamente los que ya se estaban escribiendo, así que
 * los eventos históricos siguen encajando.
 */
export enum OrderTimelineAction {
  CREATED = 'order_created',
  ACCEPTED = 'order_accepted',
  PREPARING = 'order_preparing',
  READY = 'order_ready',
  DRIVER_ASSIGNED = 'driver_assigned',
  /** Se le quitó el pedido: aceptó y no llegó a recogerlo. */
  DRIVER_UNASSIGNED = 'driver_unassigned',
  ARRIVED_PICKUP = 'arrived_pickup',
  EVIDENCE_PICKUP = 'evidence_pickup_evidence',
  CODE_VERIFIED_PICKUP = 'code_verified_pickup',
  CODE_FAILED_PICKUP = 'code_failed_pickup',
  PICKED_UP = 'order_picked_up',
  ON_WAY = 'order_on_way',
  ARRIVED_DELIVERY = 'arrived_delivery',
  EVIDENCE_DELIVERY = 'evidence_delivery_evidence',
  CODE_VERIFIED_DELIVERY = 'code_verified_delivery',
  CODE_FAILED_DELIVERY = 'code_failed_delivery',
  DELIVERED = 'order_delivered',
  CANCELLED = 'order_cancelled',
  /** El domiciliario confirmó que recibió el efectivo del cliente. */
  CASH_CONFIRMED = 'cash_confirmed',
  /** El domiciliario declaró que no lo recibió: queda como incidencia. */
  CASH_NOT_RECEIVED = 'cash_not_received',
}
