/**
 * Las formas que devuelve la API, escritas una vez.
 *
 * Estaban como `any` repartido por doce pantallas. `any` no significa
 *"todavía no sé la forma": significa"compilador, no mires", y lo que
 * dejaba pasar aquí eran erratas silenciosas — `stats?.todayComission`
 * con una eme compila igual de bien que la correcta y pinta un hueco en
 * el panel sin que nada avise, ni en desarrollo ni en producción.
 *
 * Solo están los campos que el panel lee de verdad. El backend manda más
 * y eso no es un problema: un tipo parcial verifica lo que se usa, que es
 * exactamente para lo que sirve. Ampliarlo cuesta una línea.
 */

/** Un usuario tal y como lo devuelven los listados del panel. */
export interface AdminUser {
 _id: string;
 name?: string;
 phone?: string;
 email?: string;
 role?: string;
 avatar?: string;
}

/** Tarjetas de cabecera del dashboard. */
/** Resultado de la plataforma según el libro mayor: la única definición de"ingreso". */
export interface PlatformResult {
 grossRevenue: number;
 promotionExpense: number;
 cashShortageExpense: number;
 driverFeeAbsorbed: number;
 badDebt: number;
 netBeforeGatewayCosts: number;
 /** Comisión estimada de Wompi asentada en el libro (0 si la tarifa está sin configurar). */
 processingExpense?: number;
 netAfterGatewayCosts?: number;
 incomplete: boolean;
 incompleteReason: string;
}

/** Un canje de cupón, con usuario y pedido poblados. */
export interface CouponRedemption {
 _id: string;
 discountAmount: number;
 createdAt: string;
 userId?: AdminUser | null;
 orderId?: { _id?: string; orderNumber?: string } | null;
}

export interface CouponHistory {
 redemptions: CouponRedemption[];
 usedCount: number;
 totalDiscounted: number;
 budgetSpent: number;
}

/** Una PQRS en la bandeja legal. */
export interface PqrsItem {
 _id: string;
 type: string;
 subject: string;
 status: string;
 createdAt?: string;
}

/** Una solicitud de habeas data. */
export interface DataRequest {
 _id: string;
 kind?: string;
 type?: string;
 status: string;
 detail?: string;
 createdAt?: string;
}

/** Posición en vivo que llega por socket desde la flota. */
export interface DriverLocationUpdate {
 driverId?: string;
 location?: { lat: number; lng: number };
 heading?: number | null;
}

/** Búsqueda global: `GET /admin/search`. Cada lista solo llega si el permiso lo permite. */
export interface SearchOrderHit {
 _id: string;
 orderNumber: string;
 status: string;
 kind?: 'delivery' | 'errand';
 createdAt: string;
 businessName?: string;
}

export interface SearchUserHit {
 _id: string;
 name: string;
 role: string;
 phoneMasked?: string;
 emailMasked?: string;
 isActive: boolean;
}

export interface SearchBusinessHit {
 _id: string;
 name: string;
 city?: string;
 isApproved: boolean;
 isSuspended?: boolean;
 isArchived?: boolean;
}

export interface SearchDriverHit {
 _id: string;
 name: string;
 licensePlate?: string;
 status?: string;
 isApproved: boolean;
}

export interface SearchCouponHit {
 _id: string;
 code: string;
 isActive: boolean;
 validUntil?: string | null;
 businessId?: string | null;
}

export interface AdminSearchResults {
 orders?: SearchOrderHit[];
 users?: SearchUserHit[];
 businesses?: SearchBusinessHit[];
 drivers?: SearchDriverHit[];
 coupons?: SearchCouponHit[];
}

/** Bandeja de alertas: `GET /admin/alerts`. */
export type AlertSeverity = 'critical' | 'high' | 'medium';

export interface AdminAlertItem {
 /** `kind:id:stage`: estable mientras dure la alerta; una escalada cambia el `stage`. */
 key: string;
 kind: string;
 severity: AlertSeverity;
 title: string;
 detail: string;
 at: string;
 links: {
 orderId?: string;
 userId?: string;
 businessId?: string;
 driverId?: string;
 };
 seen: boolean;
}

export interface AdminAlertsResponse {
 items: AdminAlertItem[];
 unseen: number;
 generatedAt: string;
 truncated: boolean;
}
