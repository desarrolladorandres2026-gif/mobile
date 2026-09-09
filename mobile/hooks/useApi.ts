import { useQuery, useMutation, useQueryClient, useInfiniteQuery, keepPreviousData } from '@tanstack/react-query';
import { businessesApi, productsApi, ordersApi, driverApi, addressApi, couponsApi, zonesApi, categoriesApi, paymentsApi, bannersApi, homeCategoriesApi, orderFlowApi, searchApi, reviewsApi, topSellersApi, productSentimentApi, loyaltyApi, errandsApi, offersApi, referralsApi } from '../services/endpoints';
import type { PromoBanner, HomeCategory, SearchSort, CancellationCode } from '../services/endpoints';

// ── Businesses ──
/**
 * El catálogo de negocios.
 *
 * `ready` existe para no descargarlo dos veces en cada arranque en frío.
 *
 * El problema: las coordenadas salen de `useDeliveryCoords`, que devuelve
 * `undefined` hasta que responde `GET /addresses`. Como las coordenadas
 * entran en la clave de caché, la consulta se disparaba **una vez sin ellas
 * y otra con ellas** — dos claves distintas, dos descargas completas del
 * catálogo del pueblo, en cada apertura de la app.
 *
 * Esperar a que las direcciones se resuelvan cuesta unos milisegundos y
 * ahorra una descarga entera. Quien no tenga direcciones guardadas sigue
 * viendo el catálogo: `ready` se vuelve `true` igualmente cuando la consulta
 * termina, con o sin resultados.
 */
export const useBusinesses = (params?: Record<string, any>, ready = true) =>
  useQuery({
    queryKey: ['businesses', params],
    queryFn: () => businessesApi.getAll(params),
    enabled: ready,
  });

/**
 * Coordenadas desde las que medir la distancia a los negocios.
 *
 * Se usa la dirección de entrega y no el GPS del momento. Parece menos
 * preciso y es más correcto: el domicilio se cobra desde donde se va a
 * entregar, así que enseñar "300 m" porque el cliente está pasando por el
 * centro sería prometerle un envío que no le van a cobrar.
 *
 * Devuelve además `ready`: si las direcciones todavía no han llegado, las
 * coordenadas que faltan **no** significan "este usuario no tiene dirección",
 * significan "todavía no lo sabemos". Confundir las dos cosas es lo que
 * duplicaba la descarga del catálogo.
 */
export const useDeliveryCoords = () => {
  const { data: addresses = [], isPending } = useAddresses();
  const preferred = addresses.find((a: any) => a.isDefault) ?? addresses[0];
  const coords = preferred?.location?.coordinates;

  const value =
    Array.isArray(coords) && coords.length === 2
      ? { lng: coords[0] as number, lat: coords[1] as number }
      : undefined;

  return { coords: value, ready: !isPending };
};

export const useBusiness = (id: string) =>
  useQuery({ queryKey: ['business', id], queryFn: () => businessesApi.getById(id), enabled: !!id });

/**
 * Negocios ordenados por cercanía real.
 *
 * Sin usar todavía: la lista y las tarjetas muestran rating y minutos, nunca
 * distancia. Se consume al pintar los km en `BusinessRow`/`BusinessFeatured`
 * — `Business.location` ya tiene índice 2dsphere, el trabajo es de UI.
 */
export const useNearbyBusinesses = (lat: number, lng: number) =>
  useQuery({
    queryKey: ['businesses', 'nearby', lat, lng],
    queryFn: () => businessesApi.getNearby(lat, lng),
    enabled: !!lat && !!lng,
  });

/**
 * Búsqueda de catálogo: negocios y productos en una sola consulta.
 *
 * Sustituye a filtrar la lista de negocios por nombre, que no encontraba un
 * plato si el local no se llamaba como él.
 */
export const useSearch = (
  term: string,
  params: { lat?: number; lng?: number; sort?: SearchSort } = {}
) =>
  useInfiniteQuery({
    queryKey: ['search', term, params],
    queryFn: ({ pageParam }) => searchApi.query({ q: term, page: pageParam, ...params }),
    initialPageParam: 1,
    // `hasMore` lo decide el servidor, que es el único que sabe cuántos
    // candidatos había antes de recortar la página.
    getNextPageParam: (last, pages) => (last.hasMore ? pages.length + 1 : undefined),
    enabled: term.trim().length >= 2,
    staleTime: 60_000,
  });

/**
 * Sugerencias mientras se escribe.
 *
 * `keepPreviousData` evita el parpadeo: sin él la lista se vacía entre una
 * tecla y la siguiente, y lo que el usuario ve es un desplegable que
 * aparece y desaparece mientras escribe.
 */
export const useSearchSuggestions = (term: string) =>
  useQuery({
    queryKey: ['search', 'suggest', term],
    queryFn: ({ signal }) => searchApi.suggest(term, signal),
    enabled: term.trim().length >= 2,
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
  });

/** Lo que más se busca de verdad, según el catálogo. */
export const usePopularSearches = () =>
  useQuery({
    queryKey: ['search', 'popular'],
    queryFn: () => searchApi.popular(),
    staleTime: 30 * 60_000,
  });

// ── Calificaciones ──

/**
 * Lo que el cliente tiene pendiente de calificar.
 *
 * El backend de reseñas existía completo desde hacía tiempo, pero la app no
 * tenía ninguna pantalla para calificar: la nota que se muestra en cada
 * tarjeta de negocio nunca se movía de la que dejó el sembrado inicial.
 */
export const usePendingRatings = () =>
  useQuery({
    queryKey: ['reviews', 'pending'],
    queryFn: () => reviewsApi.pending(),
    staleTime: 60_000,
  });

export const useCreateReview = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: reviewsApi.create,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['reviews'] });
      // La nota del negocio acaba de cambiar: las listas que la muestran
      // tienen que volver a pedirla.
      qc.invalidateQueries({ queryKey: ['businesses'] });
      qc.invalidateQueries({ queryKey: ['business'] });
    },
  });
};

/**
 * Los más pedidos de un negocio.
 *
 * Distinto de `isFeatured`: aquello es lo que el negocio quiere vender,
 * esto es lo que la gente compra.
 */
export const useTopSellers = (businessId: string) =>
  useQuery({
    queryKey: ['products', 'top', businessId],
    queryFn: () => topSellersApi.forBusiness(businessId),
    enabled: !!businessId,
    staleTime: 10 * 60_000,
  });

// ── Puntos ZIPP ──

/**
 * Saldo real de puntos, del servidor.
 *
 * Sustituye a `useZippStats().points`, que los derivaba del historial local
 * del teléfono: cambiaban de dispositivo a dispositivo y desaparecían al
 * reinstalar, porque no existían en ninguna parte.
 */
export const useLoyalty = () =>
  useQuery({
    queryKey: ['loyalty'],
    queryFn: () => loyaltyApi.mine(),
    staleTime: 60_000,
  });

export const useRedeemPoints = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (points: number) => loyaltyApi.redeem(points),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['loyalty'] });
      // El canje genera un cupón: la lista de promociones cambió.
      qc.invalidateQueries({ queryKey: ['coupons'] });
    },
  });
};

/** Pulgares por plato de un negocio, para pintarlos en la carta. */
export const useProductSentiment = (businessId: string) =>
  useQuery({
    queryKey: ['products', 'sentiment', businessId],
    queryFn: () => productSentimentApi.forBusiness(businessId),
    enabled: !!businessId,
    staleTime: 10 * 60_000,
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

/**
 * Cancelar el pedido, desde el cliente.
 *
 * Va aparte de `useUpdateOrderStatus` a propósito: cancelar es el único
 * cambio de estado que el servidor le permite al cliente
 * (`ROLE_ALLOWED_STATUSES[CLIENT]`), y exige el código del catálogo. Con la
 * firma genérica era demasiado fácil llamar sin código y mandar el motivo
 * vacío, que es exactamente lo que venía pasando.
 *
 * Se invalida también `['order', id]`: la pantalla de seguimiento lee esa
 * clave, y sin invalidarla el pedido seguía pintándose en curso después de
 * cancelarlo, hasta el siguiente refetch.
 */
export const useCancelOrder = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, code, note }: { id: string; code: CancellationCode; note?: string }) =>
      ordersApi.updateStatus(id, 'cancelled', note, code),
    onSuccess: (_data, { id }) => {
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      queryClient.invalidateQueries({ queryKey: ['order', id] });
    },
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

/** La cronología completa, solo cuando la pantalla que la enseña está abierta. */
export const useOrderTimeline = (orderId: string | undefined, enabled: boolean) =>
  useQuery({
    queryKey: ['orderTimeline', orderId],
    queryFn: () => orderFlowApi.getTimeline(orderId!),
    enabled: enabled && !!orderId,
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

/**
 * El domiciliario declara lo que costó la compra de un mandado.
 *
 * Mueve el total del pedido —el cliente paga el gasto real, no el tope— y
 * el saldo comprometido del propio domiciliario, así que invalida las tres
 * claves: el pedido, su flujo y el resumen del repartidor.
 */
export const useDeclareErrandCost = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, actualCost, receiptUrl }: {
      orderId: string; actualCost: number; receiptUrl: string;
    }) => errandsApi.declareCost(orderId, actualCost, receiptUrl),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['order', vars.orderId] });
      queryClient.invalidateQueries({ queryKey: ['orderFlow', vars.orderId] });
      queryClient.invalidateQueries({ queryKey: ['orders'] });
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
/** Los documentos que ya subió, para pintar su estado. */
export const useDriverDocuments = () =>
  useQuery({ queryKey: ['driver', 'documents'], queryFn: driverApi.getDocuments });

export const useSubmitDriverDocument = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: driverApi.submitDocument,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['driver', 'documents'] });
    },
  });
};

export const useDriverProfile = () =>
  useQuery({ queryKey: ['driver', 'profile'], queryFn: driverApi.getProfile });

export const useDriverEarnings = (date?: string) =>
  useQuery({ queryKey: ['driver', 'earnings', date], queryFn: () => driverApi.getEarnings(date) });

/** Cómo le está yendo. Es un espejo, no una nota: no cambia el reparto. */
export const useDriverMetrics = (days = 30) =>
  useQuery({ queryKey: ['driver', 'metrics', days], queryFn: () => driverApi.getMetrics(days) });

/** Las ganancias de un periodo. Sin fechas, la última semana. */
export const useDriverEarningsRange = (from?: string, to?: string) =>
  useQuery({
    queryKey: ['driver', 'earnings', 'range', from, to],
    queryFn: () => driverApi.getEarningsRange(from, to),
  });

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
  /**
   * La ventana de entrega, en minutos desde ahora. El extremo alto es el
   * que se le promete al cliente y el que el pedido guarda como
   * `estimatedDelivery`: prometer el optimista sería incumplir a propósito.
   */
  etaMinutesMin: number;
  etaMinutesMax: number;
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

/**
 * Todo lo que está en oferta cerca de la dirección de entrega.
 *
 * `enabled` no depende de las coordenadas: a diferencia de la búsqueda por
 * cercanía, la pantalla de Descuentos también tiene sentido sin ubicación
 * —los cupones públicos no la necesitan— así que la consulta sale igual,
 * solo que sin filtrar por radio.
 */
export const useOffers = (coords?: { lat: number; lng: number } | null) =>
  useQuery({
    queryKey: ['offers', coords],
    queryFn: () => offersApi.get(coords ?? undefined),
    staleTime: 5 * 60_000,
  });

/**
 * ¿Hay cobertura en este punto?
 *
 * Se consulta mientras se guarda una dirección, para avisar ahí mismo en
 * vez de dejar que el usuario descubra en el checkout —carrito lleno y
 * método de pago elegido— que no repartimos en su calle.
 *
 * `retry: false` porque el aviso es informativo: si la consulta falla, se
 * guarda igual y el checkout sigue siendo la red de seguridad. Insistir
 * solo retrasaría el botón de guardar por un dato que no es bloqueante.
 */
export const useCoverageCheck = (lat?: number, lng?: number, businessId?: string) =>
  useQuery({
    queryKey: ['coverage', lat, lng, businessId],
    queryFn: () => zonesApi.checkCoverage(lat!, lng!, businessId),
    enabled: typeof lat === 'number' && typeof lng === 'number',
    retry: false,
    staleTime: 5 * 60_000,
  });

// ── Addresses ──
/** Mi código de invitación y cuánta gente he traído. */
export const useReferrals = () =>
  useQuery({
    queryKey: ['referrals'],
    queryFn: referralsApi.getStats,
    // Cambia solo cuando alguien acepta la invitación: no hace falta
    // preguntarlo cada vez que se abre la pantalla.
    staleTime: 5 * 60_000,
  });

/**
 * El comprobante de un pedido.
 *
 * `ordersApi.getReceipt` estaba definido desde siempre sin un solo
 * llamador: ningún pedido entregado tenía forma de mostrar su comprobante.
 */
export const useReceipt = (orderId: string | undefined) =>
  useQuery({
    queryKey: ['receipt', orderId],
    queryFn: () => ordersApi.getReceipt(orderId!),
    enabled: !!orderId,
    // Un comprobante ya emitido no cambia: no hay razón para volver a
    // pedirlo cada vez que se abre la pantalla.
    staleTime: 60 * 60_000,
  });

export const useAddresses = () =>
  useQuery({ queryKey: ['addresses'], queryFn: addressApi.getAll });

/** Lo justo de una dirección para reordenar la lista sin ir al servidor. */
type CachedAddress = { _id: string; isDefault?: boolean; createdAt?: string };

/**
 * Ordena como lo hace el servidor: principal primero, luego la más nueva.
 *
 * Tiene que ser el mismo criterio que el de `getAll`, porque la lista
 * ordenada aquí se sustituye por la del servidor en cuanto responde. Si
 * los dos órdenes no coinciden, las tarjetas dan un salto visible al
 * llegar la respuesta y el efecto es peor que no haber adelantado nada.
 */
function sortLikeServer<T extends CachedAddress>(addresses: T[]): T[] {
  return [...addresses].sort((a, b) => {
    if (!!a.isDefault !== !!b.isDefault) return a.isDefault ? -1 : 1;
    return (b.createdAt ?? '').localeCompare(a.createdAt ?? '');
  });
}

export const useCreateAddress = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: addressApi.create,
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['addresses'] }); },
  });
};

export const useUpdateAddress = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: addressApi.update,
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

/**
 * Sugerencias de dirección mientras se escribe.
 *
 * El mínimo de tres letras es el mismo que exige el servidor, puesto aquí
 * para que las dos primeras pulsaciones no salgan siquiera del teléfono.
 * `keepPreviousData` evita que la lista parpadee en vacío entre letra y
 * letra, que es cuando el usuario está mirándola.
 */
export const useAddressSearch = (term: string, near?: { lat: number; lng: number }) =>
  useQuery({
    queryKey: ['addresses', 'search', term, near?.lat, near?.lng],
    queryFn: () => addressApi.search(term, near),
    enabled: term.trim().length >= 3,
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 5 * 60_000,
  });

/**
 * Marca una dirección como principal, en el acto.
 *
 * Se actualiza la caché antes de que el servidor conteste. Esperar la
 * respuesta significaba esperar dos viajes —el `PATCH` y el `GET` que lo
 * seguía— con la fila todavía mostrando lo viejo, y en una conexión de
 * pueblo eso es casi un segundo de pantalla que no reacciona al toque.
 *
 * Adelantarse es seguro precisamente aquí: la operación no puede fallar
 * por una razón interesante —es tu propia dirección y solo cambia una
 * bandera—, así que el caso a cubrir es que se caiga la red, y para eso
 * está la reversión en `onError`. No haría lo mismo con nada que mueva
 * dinero: ahí adelantar un resultado es prometer algo que no se sabe.
 */
export const useSetDefaultAddress = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: addressApi.setDefault,

    onMutate: async (id: string) => {
      // Un refetch en vuelo llegaría después con los datos viejos y
      // desharía justo lo que se acaba de pintar.
      await queryClient.cancelQueries({ queryKey: ['addresses'] });

      const previous = queryClient.getQueryData<CachedAddress[]>(['addresses']);

      if (previous) {
        queryClient.setQueryData<CachedAddress[]>(
          ['addresses'],
          sortLikeServer(previous.map((a) => ({ ...a, isDefault: a._id === id })))
        );
      }

      return { previous };
    },

    onError: (_error, _id, context) => {
      // Devuelve la lista exactamente como estaba: si el servidor no aceptó
      // el cambio, dejar la corona puesta sería mentir sobre a dónde va el
      // próximo pedido.
      if (context?.previous) {
        queryClient.setQueryData(['addresses'], context.previous);
      }
    },

    // En los dos casos se vuelve a preguntar: tras un fallo para no
    // quedarse con una suposición, y tras un acierto porque el servidor es
    // quien decide el orden final.
    onSettled: () => { queryClient.invalidateQueries({ queryKey: ['addresses'] }); },
  });
};

// ── Banners promocionales ──
/**
 * Los banners activos de una superficie (inicio, descuentos, ...).
 *
 * `staleTime` de 5 minutos porque un banner es contenido editorial, no
 * estado del pedido: refetchear en cada foco solo gastaría datos del
 * cliente. `retry: false` para que una API caída no deje al carrusel
 * girando en "cargando" — devuelve error y la pantalla sigue sin él.
 *
 * El arreglo vacío por defecto hace que "sin banners", "sin conexión" y
 * "API caída" terminen en el mismo lugar: el componente no se dibuja.
 */
export const useHomeBanners = (placement: 'home' | 'offers' = 'home') =>
  useQuery<PromoBanner[]>({
    queryKey: ['banners', placement],
    queryFn: () => bannersApi.getActive(placement),
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
