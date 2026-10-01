/**
 * Contrato de las fichas de la Fase 2 (docs de diseño §1 y §2).
 *
 * Las formas de `order` y `notes` vienen literales del diseño. Las secciones
 * cuyo detalle el diseño solo describe (comercio, y las nuevas del cliente y
 * del domiciliario) llevan sus campos como opcionales: el panel los lee con
 * tolerancia, y una sección que el servidor omite (por permiso o porque aún
 * no existe) simplemente no se pinta. Cuando el backend congele la forma
 * exacta, aquí es donde se aprieta.
 *
 * Todas las fechas llegan como texto ISO.
 */

// ── Notas internas ──────────────────────────────────────────────────────

export type NoteEntityType = 'order' | 'business' | 'driver' | 'user' | 'pqrs';

export interface NoteView {
 _id: string;
 entityType: NoteEntityType;
 entityId: string;
 body: string;
 author: { _id: string; name: string };
 createdAt: string;
 /** Solo la ve el Super Administrador: las eliminadas no viajan al resto. */
 deletedAt: string | null;
 canDelete: boolean;
}

export interface NotesPage {
 items: NoteView[];
 /** ISO de la nota más antigua de la página, o null si no hay más. */
 nextBefore: string | null;
}

// ── Ficha del pedido ────────────────────────────────────────────────────

export interface TimelineEntry {
 action: string;
 label: string;
 at: string;
 actor: { id: string | null; name: string | null; role: string } | null;
 derived: boolean;
 incident: boolean;
}

export interface CodeStatusView {
 status: string;
 attempts: number;
 issuedAt: string;
 expiresAt: string | null;
 usedAt: string | null;
 verifiedBy: string | null;
 verifiedRole: string | null;
 lockedUntil: string | null;
 arrivedAt: string | null;
}

/** 'masked' por defecto; 'full' solo con `?view=full` y `users:view_sensitive`. */
export type ProfileView = 'masked' | 'full';

export interface OrderFinanceView {
 productSubtotal?: number;
 customerServiceFee?: number;
 deliveryCustomerFee?: number;
 tip?: number;
 merchantFundedDiscount?: number;
 platformFundedDiscount?: number;
 customerTotal?: number;
 // Solo con `commissions:view`.
 merchantCommission?: number;
 platformNetRevenue?: number;
 appliedCommissionBps?: number;
}

/** Resumen interno de dinero del pedido; lo arma el servidor según el método real. */
export interface OrderMoneySummary {
 kind: 'cash' | 'online';
 provider: string | null;
 rail: string | null;
 railRaw: string | null;
 paymentStatus?: string;
 customerTotal: number | null;
 driverPayout: number | null;
 /** ¿Entró dinero de verdad? Efectivo recibido o cobro capturado. */
 collected?: boolean;
 gatewayFee: number;
 gatewayFeeApplies: boolean;
 /** 0 = no reembolsable, 10000 = toda, intermedio = parcial; null = sin definir. */
 gatewayFeeRefundBps?: number | null;
 // Solo con `commissions:view`.
 merchantCommission?: number | null;
 merchantNet?: number | null;
 platformGross?: number | null;
 /** Del libro mayor (misma definición que Resumen diario y Finanzas); null = sin asientos. */
 platformResult?: number | null;
}

export interface OrderProfile360ItemExtra {
 name: string;
 price: number;
 quantity: number;
}

export interface OrderProfile360Item {
 name: string;
 quantity: number;
 price?: number;
 /** Total real del item (incluye adicionales); fuente de verdad para el subtotal mostrado. */
 totalPrice?: number;
 extras?: OrderProfile360ItemExtra[];
 notes?: string;
}

export interface OrderProfile360Data {
 order: {
 _id: string;
 orderNumber?: string;
 kind?: 'delivery' | 'errand';
 status: string;
 createdAt: string;
 scheduledFor?: string | null;
 acceptedAt?: string | null;
 deliveredAt?: string | null;
 cancellationCode?: string | null;
 cancellationReason?: string | null;
 cancelledBy?: string | null;
 paymentMethod?: string;
 paymentStatus?: string;
 items?: OrderProfile360Item[];
 errand?: {
 description?: string;
 pickupAddress?: string;
 estimatedCost?: number;
 maxCost?: number;
 actualCost?: number;
 } | null;
 city?: string;
 zoneId?: string | null;
 /**"Barrio, ciudad" si la dirección exacta no se puede ver. */
 deliveryAddress?: { address?: string; notes?: string } | string | null;
 finance?: OrderFinanceView | null;
 };
 parties: {
 client: { _id: string; name: string; phoneMasked?: string } | null;
 business: { _id: string; name: string } | null;
 driver: { _id: string; userId?: string; name: string } | null;
 };
 timeline: TimelineEntry[];
 dispatch: {
 round?: number;
 cycle?: number;
 expiresAt?: string | null;
 offers: Array<{
 driverId: string;
 driverName?: string;
 round?: number;
 outcome: string;
 reason?: string | null;
 offeredAt?: string;
 respondedAt?: string | null;
 }>;
 };
 conversation: { messages: number; calls: number };
 /** null sin `evidences:view`. Nunca lleva códigos, solo su estado. */
 handoff: {
 pickup: CodeStatusView | null;
 delivery: CodeStatusView | null;
 evidences: number;
 } | null;
 /** null sin `finance:view`. */
 money: {
 summary?: OrderMoneySummary | null;
 payments: Array<{
 _id: string;
 amount: number;
 status: string;
 method?: string;
 paymentMethodType?: string | null;
 createdAt: string;
 gatewayFee?: {
 total: number;
 source: 'ledger' | 'estimate' | 'unconfigured';
 percentage: number | null;
 fixed: number | null;
 vat: number | null;
 } | null;
 netReceived?: number | null;
 }>;
 refunds?: Array<{ _id: string; amount: number; status: string; kind?: string; reason?: string; createdAt: string }>;
 payouts: Array<{ _id: string; beneficiary?: string; amount?: number; netAmount?: number; status: string; createdAt?: string }>;
 ledgerHref?: string;
 } | null;
 after: {
 review: { _id?: string; rating: number; comment?: string; createdAt?: string } | null;
 pqrs: Array<{ _id: string; subject?: string; status: string; createdAt: string }>;
 cashIncidents?: Array<{ _id: string; status: string; amount?: number; createdAt: string }>;
 sos?: Array<{ _id: string; status: string; createdAt: string; note?: string }>;
 };
 notes: NoteView[];
 allowedActions: {
 assign: boolean;
 unassign: boolean;
 cancel: boolean;
 refund: boolean;
 notify: boolean;
 note: boolean;
 };
 masked: {
 commissions: boolean;
 finance: boolean;
 evidences: boolean;
 sensitive: boolean;
 };
}

export type NotifyAudience = 'client' | 'business' | 'driver';
export type NotifyTemplate = 'status' | 'driver_assigned' | 'delayed';

// ── Ficha del comercio ──────────────────────────────────────────────────

export interface BusinessDocumentRow {
 _id: string;
 type: string;
 status: string;
 expiresAt?: string | null;
 reviewedAt?: string | null;
 reviewedBy?: { _id?: string; name?: string } | string | null;
 rejectionReason?: string | null;
}

export interface BusinessProfile360Data {
 business: {
 _id: string;
 name: string;
 category?: string;
 city?: string;
 address?: string;
 phone?: string;
 isApproved: boolean;
 isActive?: boolean;
 isSuspended: boolean;
 suspensionReason?: string | null;
 suspendedAt?: string | null;
 suspendedBy?: { _id: string; name: string } | null;
 isArchived?: boolean;
 archivedReason?: string | null;
 createdAt?: string;
 rating?: number;
 totalReviews?: number;
 /** Clave AUSENTE sin `commissions:view`. Punto base: 1000 = 10 %. */
 commissionRateBps?: number | null;
 };
 owner: { _id: string; name: string } | null;
 legal?: {
 legalName?: string | null;
 documentType?: string | null;
 nitMasked?: string | null;
 taxRegime?: string | null;
 complete?: boolean;
 } | null;
 /** null sin `finance:view`. */
 payoutAccount?: {
 status?: 'pendingVerification' | 'verified' | 'none';
 method?: string | null;
 bankName?: string | null;
 accountType?: string | null;
 last4?: string | null;
 verifiedAt?: string | null;
 } | null;
 documents?: BusinessDocumentRow[];
 team?: Array<{ _id: string; name: string; role?: string; isActive?: boolean; createdAt?: string; phone?: string | null }>;
 menu?: { products: number; available: number };
 /** null sin `ads:view`. */
 ads?: {
 advertisements: Array<{ _id: string; title?: string; status?: string; isActive?: boolean; startDate?: string; endDate?: string }>;
 invoices: Array<{ _id: string; amount?: number; status?: 'settled' | 'pending' | string; createdAt?: string }>;
 outstanding?: number;
 } | null;
 /** null sin `coupons:view`; `cost30d` null sin `finance:view`. */
 promotions?: {
 coupons: Array<{ _id: string; code: string; isActive?: boolean; validUntil?: string | null }>;
 cost30d?: number | null;
 } | null;
 /** null sin `reviews:view`. */
 reputation?: {
 rating?: number;
 totalReviews?: number;
 reviews: Array<{ _id: string; rating: number; comment?: string; createdAt: string }>;
 } | null;
 /** null sin `support:view`. */
 support?: Array<{ _id: string; subject?: string; status: string; createdAt: string }> | null;
 history?: Array<{ _id: string; action: string; description?: string; createdAt: string; actorName?: string; metadata?: unknown }>;
 notes?: NoteView[];
 masked?: { commissions?: boolean; finance?: boolean; sensitive?: boolean };
}

/** `GET /businesses/:id/analytics` (BusinessAnalytics). */
export interface BusinessAnalyticsData {
 range: { from: string; to: string; days: number };
 totals: {
 orders: number;
 delivered: number;
 cancelled: number;
 revenue: number;
 averageTicket: number;
 cancellationRate: number;
 };
 previous: { orders: number; revenue: number };
 byDay: Array<{ date: string; orders: number; revenue: number }>;
 byHour: Array<{ hour: number; orders: number }>;
}

/** `GET /businesses/:id/statement` (merchantStatement). */
export interface StatementTotalsData {
 orderCount: number;
 productSubtotal: number;
 merchantCommission: number;
 merchantFundedDiscount: number;
 reversedAmount: number;
 netAmount: number;
}

export interface BusinessStatementData {
 outstanding: number;
 accrued: number;
 payable: number;
 settled: number;
 nextSettlement: StatementTotalsData;
 weeks: Array<StatementTotalsData & { periodStart: string; periodEnd: string }>;
 settlements: unknown[];
}

// ── Secciones nuevas de la ficha del cliente ────────────────────────────

export interface UserProfileExtras {
 /** 'masked' por defecto; 'full' solo con `?view=full` y `users:view_sensitive`. */
 view: 'masked' | 'full';
 addresses?: Array<{
 _id: string;
 label?: string;
 neighborhood?: string;
 city?: string;
 isDefault?: boolean;
 /** Solo en la vista completa. */
 address?: string;
 apartment?: string;
 }>;
 savedCards?: Array<{
 _id: string;
 brand?: string;
 last4?: string;
 expMonth?: number | string;
 expYear?: number | string;
 lastUsedAt?: string | null;
 }>;
 pro?: {
 status?: string;
 plan?: string;
 startedAt?: string;
 currentPeriodEnd?: string | null;
 cancelledAt?: string | null;
 autoRenew?: boolean;
 } | null;
 consents?: {
 marketingConsent?: boolean | null;
 marketingConsentAt?: string | null;
 legal?: Array<{ type: string; version?: string; acceptedAt?: string }>;
 } | null;
 /** null sin `legal:view`. */
 dataRequests?: Array<{ _id: string; type?: string; status: string; createdAt: string; dueAt?: string | null }> | null;
 actionsOnUser?: Array<{ _id: string; action: string; description?: string; createdAt: string; actorName?: string; metadata?: unknown }>;
 /** null sin `refunds:view`. */
 refunds?: Array<{
 _id: string;
 orderId?: string;
 amount: number;
 status: string;
 kind?: string;
 reason?: string;
 createdAt: string;
 }> | null;
 couponRedemptions?: Array<{
 _id: string;
 code?: string;
 couponId?: string;
 discount?: number;
 orderId?: string;
 createdAt: string;
 }>;
 /** null sin permiso de notas. */
 notes?: NoteView[] | null;
}
