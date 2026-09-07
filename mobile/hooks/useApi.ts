import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { businessesApi, productsApi, ordersApi, driverApi, addressApi, couponsApi, zonesApi, categoriesApi, notificationsApi, paymentsApi, bannersApi, homeCategoriesApi, orderFlowApi } from '../services/endpoints';
import type { PromoBanner, HomeCategory } from '../services/endpoints';

// ── Businesses ──
export const useBusinesses = (params?: Record<string, any>) =>
  useQuery({ queryKey: ['businesses', params], queryFn: () => businessesApi.getAll(params) });

export const useBusiness = (id: string) =>
  useQuery({ queryKey: ['business', id], queryFn: () => businessesApi.getById(id), enabled: !!id });

export const useNearbyBusinesses = (lat: number, lng: number) =>
  useQuery({
    queryKey: ['businesses', 'nearby', lat, lng],
    queryFn: () => businessesApi.getNearby(lat, lng),
    enabled: !!lat && !!lng,
  });

/** Secciones del menú de un negocio: Entradas, Hamburguesas, Bebidas… */
export const useBusinessCategories = (businessId: string) =>
  useQuery({
    queryKey: ['categories', businessId],
    queryFn: () => categoriesApi.getByBusiness(businessId),
    enabled: !!businessId,
  });

// ── Products ──
export const useBusinessProducts = (businessId: string, categoryId?: string) =>
  useQuery({
    queryKey: ['products', businessId, categoryId],
    queryFn: () => productsApi.getByBusiness(businessId, categoryId),
    enabled: !!businessId,
  });

// ── Orders ──
export const useMyOrders = (page = 1) =>
  useQuery({ queryKey: ['orders', 'my', page], queryFn: () => ordersApi.getMyOrders(page) });

export const useOrder = (id: string) =>
  useQuery({ queryKey: ['order', id], queryFn: () => ordersApi.getById(id), enabled: !!id });

export const useCreateOrder = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ordersApi.create,
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['orders'] }); },
  });
};

export const useUpdateOrderStatus = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status, reason }: { id: string; status: string; reason?: string }) =>
      ordersApi.updateStatus(id, status, reason),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['orders'] }); },
  });
};

// ── Traspaso físico del pedido ──────────────────────────────────────

/**
 * Estado agregado del flujo: códigos, evidencias, chat y llamada.
 *
 * `refetchInterval` es la red de seguridad, no el mecanismo principal — la
 * app se refresca de verdad por el socket (`useOrderFlowRealtime` invalida
 * esta misma key). Sin el polling, un evento perdido por una reconexión
 * dejaría la pantalla congelada hasta el próximo cambio; con solo polling
 * a 20s, un código bloqueado por intentos fallidos tardaría hasta 20
 * segundos en reflejarse. Juntos, el uno cubre el hueco del otro.
 */
export const useOrderFlow = (orderId: string | undefined) =>
  useQuery({
    queryKey: ['orderFlow', orderId],
    queryFn: () => orderFlowApi.getState(orderId!),
    enabled: !!orderId,
    refetchInterval: 20_000,
  });

export const useOrderArrive = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, stage, coords }: {
      orderId: string; stage: 'pickup' | 'delivery'; coords?: { latitude: number; longitude: number };
    }) => orderFlowApi.arrive(orderId, stage, coords),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['orderFlow', vars.orderId] });
    },
  });
};

export const useUploadOrderEvidence = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, stage, uri, coords }: {
      orderId: string; stage: 'pickup' | 'delivery'; uri: string; coords?: { latitude: number; longitude: number };
    }) => orderFlowApi.uploadEvidence(orderId, stage, uri, coords),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['orderFlow', vars.orderId] });
    },
  });
};

/**
 * Valida el código de recogida o de entrega.
 *
 * Al tener éxito invalida `order` además de `orderFlow`: el backend, no
 * esta mutación, es quien acaba de mover el pedido a "recogido" o
 * "entregado" — la app solo se pone al día con lo que ya pasó del lado
 * del servidor.
 */
export const useVerifyOrderCode = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, stage, code, coords }: {
      orderId: string; stage: 'pickup' | 'delivery'; code: string; coords?: { latitude: number; longitude: number };
    }) => orderFlowApi.verify(orderId, stage, code, coords),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['orderFlow', vars.orderId] });
      queryClient.invalidateQueries({ queryKey: ['order', vars.orderId] });
      queryClient.invalidateQueries({ queryKey: ['orders'] });
    },
  });
};

/**
 * Declara si el efectivo llegó a manos del domiciliario.
 *
 * Al terminar invalida el pedido además del flujo: lo que cambia es el
 * estado del cobro, que vive en `order`, no en `orderFlow`. Sin esa
 * invalidación la tarjeta seguiría preguntando por un efectivo que ya se
 * confirmó hasta que alguien saliera y volviera a entrar.
 */
export const useConfirmCash = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, received, note }: {
      orderId: string; received: boolean; note?: string;
    }) => orderFlowApi.confirmCash(orderId, received, note),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['order', vars.orderId] });
      queryClient.invalidateQueries({ queryKey: ['orderFlow', vars.orderId] });
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      // El saldo pendiente y las ganancias del domiciliario acaban de
      // moverse: las dos cuelgan de la clave `driver`.
      queryClient.invalidateQueries({ queryKey: ['driver'] });
    },
  });
};

export const useOrderChat = (orderId: string | undefined) =>
  useQuery({
    queryKey: ['orderChat', orderId],
    queryFn: () => orderFlowApi.messages(orderId!),
    enabled: !!orderId,
  });

export const useSendOrderMessage = (orderId: string) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (message: string) => orderFlowApi.sendMessage(orderId, message),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['orderChat', orderId] });
      queryClient.invalidateQueries({ queryKey: ['orderFlow', orderId] });
    },
  });
};

export const useMarkOrderChatRead = (orderId: string) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => orderFlowApi.markRead(orderId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['orderChat', orderId] });
      queryClient.invalidateQueries({ queryKey: ['orderFlow', orderId] });
    },
  });
};

/**
 * Sesión de llamada del pedido.
 *
 * Hoy es solo eso — una sesión: quién llamó, a quién, cuándo se contestó
 * y cuánto duró. No transporta audio; avisa en la app y dentro del
 * pedido, sin exponer el teléfono de nadie. Es la base sobre la que se
 * conecta un transporte de voz real (WebRTC o un puente telefónico) el
 * día que ZIPP lo decida, sin tocar nada de lo que hay aquí.
 */
export const useStartCall = (orderId: string) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => orderFlowApi.startCall(orderId),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['orderFlow', orderId] }); },
  });
};

export const useAnswerCall = (orderId: string) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (callId: string) => orderFlowApi.answerCall(orderId, callId),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['orderFlow', orderId] }); },
  });
};

export const useEndCall = (orderId: string) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ callId, reason }: { callId: string; reason?: string }) =>
      orderFlowApi.endCall(orderId, callId, reason),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['orderFlow', orderId] }); },
  });
};

// ── Driver ──
export const useDriverProfile = () =>
  useQuery({ queryKey: ['driver', 'profile'], queryFn: driverApi.getProfile });

export const useDriverEarnings = (date?: string) =>
  useQuery({ queryKey: ['driver', 'earnings', date], queryFn: () => driverApi.getEarnings(date) });

export const useDriverDebts = () =>
  useQuery({ queryKey: ['driver', 'debts'], queryFn: driverApi.getDebts });

export const useUpdateDriverStatus = () =>
  useMutation({ mutationFn: driverApi.updateStatus });

/**
 * Declares a cash remittance. Does not settle the balance — ZIPP verifies
 * it first — so the UI must not tell the courier they are square.
 */
export const useReportCash = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ reference, ids }: { reference: string; ids?: string[] }) =>
      driverApi.reportCash(reference, ids ?? []),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['driver'] }); },
  });
};

/** Starts the gateway charge for an order and returns the intent. */
export const usePayOrder = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, redirectUrl }: { orderId: string; redirectUrl?: string }) =>
      paymentsApi.pay(orderId, redirectUrl),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['orders'] }); },
  });
};

/**
 * Polls a payment until Wompi (or whatever gateway is active) settles it.
 *
 * `transactionId` here is really the payment's reference — the id
 * `usePayOrder` hands back — since a redirect-based gateway has nothing
 * else to track the payment by until its own webhook lands on the backend.
 * Polling stops itself once the status is no longer 'pending'.
 */
export const usePaymentStatus = (transactionId: string | undefined, enabled = true) =>
  useQuery({
    queryKey: ['payments', 'status', transactionId],
    queryFn: () => paymentsApi.getStatus(transactionId!),
    enabled: !!transactionId && enabled,
    refetchInterval: (query) => (query.state.data?.status === 'pending' ? 3000 : false),
  });

export const useAvailableOrders = (page = 1) =>
  useQuery({ queryKey: ['orders', 'available', page], queryFn: () => ordersApi.getAvailableOrders(page) });

export const useDriverOrders = (page = 1) =>
  useQuery({ queryKey: ['orders', 'driver', page], queryFn: () => ordersApi.getDriverOrders(page) });

export const useAssignDriver = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, driverId }: { orderId: string; driverId: string }) => ordersApi.assignDriver(orderId, driverId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      queryClient.invalidateQueries({ queryKey: ['driver'] });
    },
  });
};

// ── Checkout pricing ──

export interface OrderQuote {
  subtotal: number;
  deliveryFee: number;
  deliveryDistanceKm: number;
  zoneName: string | null;
  discount: number;
  coupon: {
    code: string;
    title: string;
    type: string;
    fundedBy: 'platform' | 'business';
    scope: 'product' | 'delivery' | 'service_fee';
    productDiscount: number;
    deliveryDiscount: number;
    serviceFeeDiscount: number;
    totalDiscount: number;
  } | null;
  tip: number;
  tax: number;
  total: number;
  currency: string;
  minOrder: number;

  /** Charged to the customer, shown as its own line. */
  customerServiceFee: number;
  /** What the courier is guaranteed for the trip, before tip. */
  driverDeliveryPayout: number;
  /** deliveryFee − driverDeliveryPayout. Informational. */
  deliveryMargin: number;
  merchantFundedDiscount: number;
  platformFundedDiscount: number;
  /** Cash the courier would have to remit. 0 for online orders. */
  cashToRemit: number;
  pricingConfigVersion: number;
}

export interface PaymentMethods {
  /** False when no gateway is configured: online payment must be hidden. */
  online: boolean;
  cashOnDelivery: boolean;
  cashOnDeliveryMaxAmount: number;
}

/**
 * Which payment methods checkout may offer.
 *
 * Asked of the server rather than hardcoded, because both answers are
 * operational state: online depends on a configured gateway, and cash is an
 * admin switch that stays off until reconciliation is running. Showing an
 * option the server will reject is how customers end up with orders that
 * were never actually paid.
 */
export const usePaymentMethods = () =>
  useQuery<PaymentMethods>({
    queryKey: ['payments', 'methods'],
    queryFn: paymentsApi.getMethods,
    staleTime: 5 * 60_000,
  });

/**
 * Live price breakdown for the cart. Every input that can change the total
 * is part of the query key, so the displayed total is always the server's
 * answer for exactly what the customer has selected.
 */
export const useOrderQuote = (
  input: Parameters<typeof ordersApi.quote>[0] | null
) =>
  useQuery<OrderQuote>({
    queryKey: ['orderQuote', input],
    queryFn: () => ordersApi.quote(input!),
    enabled: !!input && input.items.length > 0,
    // Keep the previous breakdown visible while re-pricing, so the total
    // doesn't flash empty every time a quantity changes.
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 30_000,
  });

// ── Coupons & coverage ──
export const usePublicCoupons = (params?: { city?: string; businessId?: string }) =>
  useQuery({
    queryKey: ['coupons', 'public', params],
    queryFn: () => couponsApi.getPublic(params),
    staleTime: 5 * 60_000,
  });

export const useCoverageCheck = (lat?: number, lng?: number, businessId?: string) =>
  useQuery({
    queryKey: ['coverage', lat, lng, businessId],
    queryFn: () => zonesApi.checkCoverage(lat!, lng!, businessId),
    enabled: typeof lat === 'number' && typeof lng === 'number',
  });

// ── Notifications ──
export const useNotifications = () =>
  useQuery({ queryKey: ['notifications'], queryFn: () => notificationsApi.getAll() });

/**
 * Contador de no leídas para el punto rojo de la campana. Se mantiene al
 * día por socket (`useNotificationsRealtime`), así que un intervalo largo
 * basta como red de seguridad si el socket estuvo caído.
 */
export const useUnreadCount = () =>
  useQuery({
    queryKey: ['notifications', 'unread'],
    queryFn: () => notificationsApi.getUnreadCount(),
    refetchInterval: 5 * 60_000,
    select: (d: any) => d?.unreadCount ?? 0,
  });

export const useMarkAllRead = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: notificationsApi.markAllAsRead,
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['notifications'] }); },
  });
};

export const useMarkRead = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: notificationsApi.markAsRead,
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['notifications'] }); },
  });
};

// ── Addresses ──
export const useAddresses = () =>
  useQuery({ queryKey: ['addresses'], queryFn: addressApi.getAll });

export const useCreateAddress = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: addressApi.create,
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['addresses'] }); },
  });
};

export const useDeleteAddress = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: addressApi.delete,
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['addresses'] }); },
  });
};

export const useSetDefaultAddress = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: addressApi.setDefault,
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['addresses'] }); },
  });
};

// ── Banners promocionales ──
/**
 * Los banners de la pantalla inicial.
 *
 * `staleTime` de 5 minutos porque un banner es contenido editorial, no
 * estado del pedido: refetchear en cada foco solo gastaría datos del
 * cliente. `retry: false` para que una API caída no deje al carrusel
 * girando en "cargando" — devuelve error y la pantalla sigue sin él.
 *
 * El arreglo vacío por defecto hace que "sin banners", "sin conexión" y
 * "API caída" terminen en el mismo lugar: el componente no se dibuja.
 */
export const useHomeBanners = () =>
  useQuery<PromoBanner[]>({
    queryKey: ['banners', 'home'],
    queryFn: bannersApi.getHome,
    retry: false,
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
  });

// ── Categorías de Home ──
/**
 * Las categorías tal como las configuró el admin, sin resolver todavía el
 * fallback local: eso lo hace `useHomeCategories` en un hook propio, para que
 * quien solo necesite los datos crudos (o testee el fallback) no tenga que
 * pasar por ahí.
 */
export const useHomeCategoriesQuery = () =>
  useQuery<HomeCategory[]>({
    queryKey: ['homeCategories'],
    queryFn: homeCategoriesApi.getAll,
    retry: false,
    // Cambian poco: el admin no reordena categorías todos los días.
    staleTime: 10 * 60_000,
    gcTime: 60 * 60_000,
  });
