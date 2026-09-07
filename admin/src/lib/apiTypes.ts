/**
 * Las formas que devuelve la API, escritas una vez.
 *
 * Estaban como `any` repartido por doce pantallas. `any` no significa
 * "todavía no sé la forma": significa "compilador, no mires", y lo que
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
export interface DashboardStats {
  totalOrders?: number;
  todayOrders?: number;
  weekOrders?: number;
  activeOrders?: number;
  todayRevenue?: number;
  todayCommission?: number;
  totalBusinesses?: number;
  activeBusinesses?: number;
  totalDrivers?: number;
  approvedDrivers?: number;
}

export interface DashboardFinancials {
  totalRevenue?: number;
  platformEarnings?: number;
}

/** Una barra del gráfico de ingresos. */
export interface RevenuePoint {
  /** Cubo de fecha del `$group` del backend, en formato `YYYY-MM-DD`. */
  _id?: string;
  date?: string;
  label?: string;
  revenue?: number;
  commission?: number;
  orders?: number;
}

/** Fila de la tabla "últimos pedidos". */
export interface RecentOrder {
  _id: string;
  orderNumber?: string;
  /** Obligatorio: la tabla lo usa para la pastilla de estado sin guarda. */
  status: string;
  paymentMethod?: 'online' | 'cash_on_delivery';
  total?: number;
  createdAt?: string;
  // El listado del dashboard llega con las dos referencias pobladas
  // (`AdminService.dashboard`), así que el tipo no las declara como
  // union con `string`: una rama que nunca se toma solo obliga a
  // escribir guardas muertas en la tabla.
  clientId?: AdminUser | null;
  businessId?: { _id?: string; name?: string } | null;
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
