/**
 * Las claves de react-query del panel, todas colgando del negocio.
 *
 * Todo lo de un negocio empieza por `['business', id]`: cambiar de
 * establecimiento o invalidar "lo de este negocio" es un solo prefijo, y
 * nada de un negocio puede quedarse pintado en la pantalla de otro.
 */
export const qk = {
  business: (id: string | undefined) => ['business', id] as const,
  activeOrders: (id: string | undefined) => ['business', id, 'orders', 'active'] as const,
  orders: (id: string | undefined, ...params: unknown[]) => ['business', id, 'orders', ...params] as const,
  dailySummary: (id: string | undefined, date: string) => ['business', id, 'daily-summary', date] as const,
  statement: (id: string | undefined) => ['business', id, 'statement'] as const,
  documents: (id: string | undefined) => ['business', id, 'documents'] as const,
  statementLines: (id: string | undefined, ...params: unknown[]) => ['business', id, 'statement-lines', ...params] as const,
  menu: (id: string | undefined) => ['business', id, 'menu'] as const,
  reviews: (id: string | undefined, ...params: unknown[]) => ['business', id, 'reviews', ...params] as const,
  promotions: (id: string | undefined) => ['business', id, 'promotions'] as const,
  advertising: (id: string | undefined) => ['business', id, 'advertising'] as const,
  staff: (id: string | undefined) => ['business', id, 'staff'] as const,
  settings: (id: string | undefined) => ['business', id, 'settings'] as const,
  // De la persona y no del local: no cuelgan de `['business', id]`.
  accountSessions: () => ['account', 'sessions'] as const,
  accountNotifications: () => ['account', 'notifications'] as const,
};
