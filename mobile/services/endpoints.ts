import api from './api';

export const categoriesApi = {
  getByBusiness: (businessId: string) =>
    api.get(`/categories/business/${businessId}`).then((r) => r.data.data),
};

export const businessesApi = {
  getAll: (params?: Record<string, any>) =>
    api.get('/businesses', { params }).then((r) => r.data.data),

  getById: (id: string) =>
    api.get(`/businesses/${id}`).then((r) => r.data.data),


  getBySlug: (slug: string) =>
    api.get(`/businesses/slug/${slug}`).then((r) => r.data.data),

  getNearby: (lat: number, lng: number, maxDistance = 5000) =>
    api.get('/businesses', { params: { lat, lng, maxDistance } }).then((r) => r.data.data),
};

export const productsApi = {
  getByBusiness: (businessId: string, categoryId?: string) =>
    api.get(`/products/business/${businessId}`, { params: { categoryId } }).then((r) => r.data.data),

  getById: (id: string) =>
    api.get(`/products/${id}`).then((r) => r.data.data),
};

export const productSentimentApi = {
  /** Pulgares por plato de un negocio: `{ productId: { likes, total } }`. */
  forBusiness: (businessId: string): Promise<Record<string, { likes: number; total: number }>> =>
    api.get(`/products/business/${businessId}/sentiment`).then((r) => r.data.data),
};

export const topSellersApi = {
  /** Los más pedidos de un negocio, según pedidos entregados de verdad. */
  forBusiness: (businessId: string, limit = 5) =>
    api
      .get(`/products/business/${businessId}/top`, { params: { limit } })
      .then((r) => r.data.data),
};

/**
 * Motivos de cancelación que le corresponden al cliente.
 *
 * El catálogo del servidor tiene 14 y va agrupado por quién cancela. Aquí
 * solo están los del grupo del cliente más `other`: dejarle marcar
 * "el negocio no tenía el producto" sería pedirle que juzgue algo que no
 * puede ver, y ensuciaría justo la métrica que el catálogo existe para
 * proteger.
 */
export type CancellationCode =
  | 'client_changed_mind'
  | 'client_ordered_by_mistake'
  | 'client_too_slow'
  | 'client_wrong_address'
  | 'other';

export const ordersApi = {
  create: (data: any) =>
    api.post('/orders', data).then((r) => r.data.data),

  /**
   * Server-computed price breakdown for the current cart.
   * The app never calculates money itself — this is the only source.
   */
  quote: (data: {
    businessId: string;
    items: Array<{ productId: string; quantity: number; selectedExtras?: Array<{ name: string; quantity: number }>; notes?: string }>;
    paymentMethod: string;
    deliveryLatitude: number;
    deliveryLongitude: number;
    couponCode?: string;
    tip?: number;
  }) => api.post('/orders/quote', data).then((r) => r.data.data),

  getMyOrders: (page = 1, limit = 20) =>
    api.get('/orders/my', { params: { page, limit } }).then((r) => r.data),

  getById: (id: string) =>
    api.get(`/orders/${id}`).then((r) => r.data.data),

  getReceipt: (id: string) => api.get(`/orders/${id}/receipt`).then((r) => r.data.data),

  /**
   * Cambia el estado del pedido.
   *
   * `cancellationCode` es del catálogo cerrado del servidor y es lo único
   * que se puede contar y agrupar después: distinguir "no había repartidor"
   * de "el negocio no daba abasto" es la pregunta que decide si el problema
   * es de flota o de comercios. Antes solo se enviaba el texto libre, así
   * que esa pregunta no se podía responder con datos de cliente.
   */
  updateStatus: (
    id: string,
    status: string,
    cancellationReason?: string,
    cancellationCode?: CancellationCode,
  ) =>
    api
      .patch(`/orders/${id}/status`, { status, cancellationReason, cancellationCode })
      .then((r) => r.data.data),

  getAvailableOrders: (page = 1, limit = 20) =>
    api.get('/orders/driver/available', { params: { page, limit } }).then((r) => r.data.data),

  getDriverOrders: (page = 1, limit = 20) =>
    api.get('/orders/driver/my', { params: { page, limit } }).then((r) => r.data.data),

  /** Cambia el método de pago mientras el comercio no haya aceptado. */
  changePaymentMethod: (orderId: string, paymentMethod: 'online' | 'cash_on_delivery') =>
    api
      .patch(`/orders/${orderId}/payment-method`, { paymentMethod })
      .then((r) => r.data.data),

  assignDriver: (orderId: string, driverId: string) =>
    api.patch(`/orders/${orderId}/assign-driver`, { driverId }).then((r) => r.data.data),

  /**
   * Rechazar una oferta de reparto.
   *
   * Decir que no explícitamente libera el pedido en el acto, en vez de
   * dejar a la ronda entera esperando a que venza el reloj.
   *
   * El motivo es opcional. Cuando lo dan, es lo único que distingue "está
   * lejos" de "no me compensa lo que paga" — dos problemas que se
   * arreglan de maneras distintas y que sin esto se ven exactamente igual
   * desde operaciones.
   */
  declineOffer: (orderId: string, reason?: DeclineReason) =>
    api.post(`/orders/${orderId}/decline`, reason ? { reason } : undefined).then((r) => r.data.data),
};


// ── Traspaso físico del pedido ───────────────────────────────────────

/** Estado de un código, tal como lo nombra el backend. */
export type OrderCodeStatus = 'pending' | 'used' | 'expired' | 'blocked' | 'void';

export interface OrderEvidenceView {
  id: string;
  type: 'pickup_evidence' | 'delivery_evidence';
  url: string;
  uploadedAt: string;
  metadata: { bytes: number; format: string; checksum: string };
}

/** Una de las dos etapas del traspaso, ya resuelta para quien pregunta. */
export interface OrderStageState {
  arrivedAt: string | null;
  codeStatus: OrderCodeStatus | null;
  attempts: number;
  lockedUntil: string | null;
  verifiedAt: string | null;
  /**
   * El código en claro — o `null`.
   *
   * Quién lo recibe lo decide el servidor: el comercio ve el de recogida,
   * el cliente el de entrega, y el domiciliario ninguno. La app nunca
   * oculta un código que le llegó; si llegó, es porque le toca mostrarlo.
   */
  code: string | null;
  evidence: OrderEvidenceView | null;
}

export interface OrderCallView {
  id: string;
  orderId: string;
  status: 'ringing' | 'active' | 'ended' | 'rejected' | 'missed' | 'failed';
  caller: { userId: string; name: string; avatar: string | null; role: string };
  receiver: { userId: string; name: string; avatar: string | null; role: string };
  startedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  durationSeconds: number;
  channel: string;
}

export interface OrderFlowState {
  orderId: string;
  orderNumber: string;
  status: string;
  participant: 'client' | 'driver' | 'business' | 'admin';
  pickup: OrderStageState;
  delivery: OrderStageState;
  chat: { available: boolean; unread: number };
  call: { available: boolean; active: OrderCallView | null };
  counterpart: { userId: string; name: string; avatar: string | null; role: string } | null;
}

export interface OrderChatMessage {
  id: string;
  orderId: string;
  senderId: string;
  senderRole: 'client' | 'driver';
  message: string;
  mine: boolean;
  readAt: string | null;
  createdAt: string;
}

export interface CashConfirmationResult {
  orderId: string;
  orderNumber: string;
  paymentStatus: string;
  amount: number;
  currency: string;
  confirmedAt: string | null;
  /** `false` cuando la confirmación ya estaba hecha (reintento de red). */
  changed: boolean;
}

export interface OrderTimelineEntry {
  action: string;
  label: string;
  at: string;
  actor: { id: string | null; name: string | null; role: string } | null;
  /** Se dedujo de una marca de tiempo del pedido, sin bitácora propia. */
  derived: boolean;
  incident: boolean;
}

export const orderFlowApi = {
  /**
   * La cronología real, con quién hizo qué y cuándo.
   *
   * `GET /orders/:id/timeline` servía 20 hitos etiquetados con actor desde
   * hacía tiempo y ninguna pantalla lo pedía: la app deducía su propia
   * barra de cinco pasos a partir de `order.status`, sin poder decir nunca
   * "aceptado a las 7:42".
   */
  getTimeline: (orderId: string): Promise<OrderTimelineEntry[]> =>
    api.get(`/orders/${orderId}/timeline`).then((r) => r.data.data),


  /** Todo lo que la pantalla del pedido necesita, en una llamada. */
  getState: (orderId: string): Promise<OrderFlowState> =>
    api.get(`/orders/${orderId}/flow`).then((r) => r.data.data),

  arrive: (orderId: string, stage: 'pickup' | 'delivery', coords?: { latitude: number; longitude: number }) =>
    api.post(`/orders/${orderId}/${stage}/arrive`, coords ?? {}).then((r) => r.data.data),

  /**
   * Sube la evidencia fotográfica.
   *
   * `uri` es la foto ya comprimida en el dispositivo — el backend valida
   * de nuevo tamaño, MIME y los bytes reales del archivo, así que esto es
   * una cortesía con los datos del usuario, no un control de seguridad.
   */
  uploadEvidence: (
    orderId: string,
    stage: 'pickup' | 'delivery',
    uri: string,
    coords?: { latitude: number; longitude: number }
  ): Promise<OrderEvidenceView> => {
    const form = new FormData();
    form.append('photo', { uri, name: `${stage}.jpg`, type: 'image/jpeg' } as unknown as Blob);
    if (coords) {
      form.append('latitude', String(coords.latitude));
      form.append('longitude', String(coords.longitude));
    }
    return api
      .post(`/orders/${orderId}/${stage}/evidence`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      .then((r) => r.data.data);
  },

  /**
   * Envía el código al backend, que es quien decide.
   *
   * La app no compara nada: no conoce el código correcto y no debe
   * conocerlo. Lo único que hace con la respuesta es pintar el resultado.
   */
  verify: (
    orderId: string,
    stage: 'pickup' | 'delivery',
    code: string,
    coords?: { latitude: number; longitude: number }
  ) =>
    api
      .post(`/orders/${orderId}/${stage}/verify`, { code, ...(coords ?? {}) })
      .then((r) => r.data.data),

  evidence: (orderId: string): Promise<OrderEvidenceView[]> =>
    api.get(`/orders/${orderId}/evidence`).then((r) => r.data.data),

  /**
   * "¿Recibiste el efectivo?" — la declaración del domiciliario.
   *
   * No lleva monto, y no es un olvido: el importe lo pone el servidor a
   * partir del pedido. Si viajara desde aquí, sería negociable.
   */
  confirmCash: (
    orderId: string,
    received: boolean,
    note?: string
  ): Promise<CashConfirmationResult> =>
    api
      .post(`/orders/${orderId}/cash/confirm`, { received, ...(note ? { note } : {}) })
      .then((r) => r.data.data),

  // ── Chat ──
  messages: (orderId: string, page = 1, limit = 50): Promise<OrderChatMessage[]> =>
    api.get(`/orders/${orderId}/chat`, { params: { page, limit } }).then((r) => r.data.data),

  sendMessage: (orderId: string, message: string): Promise<OrderChatMessage> =>
    api.post(`/orders/${orderId}/chat/messages`, { message }).then((r) => r.data.data),

  markRead: (orderId: string) =>
    api.post(`/orders/${orderId}/chat/read`).then((r) => r.data.data),

  // ── Llamadas ──
  startCall: (orderId: string): Promise<OrderCallView> =>
    api.post(`/orders/${orderId}/call`).then((r) => r.data.data),

  answerCall: (orderId: string, callId: string): Promise<OrderCallView> =>
    api.post(`/orders/${orderId}/call/${callId}/answer`).then((r) => r.data.data),

  endCall: (orderId: string, callId: string, reason?: string): Promise<OrderCallView> =>
    api.post(`/orders/${orderId}/call/${callId}/end`, { reason }).then((r) => r.data.data),

  calls: (orderId: string): Promise<OrderCallView[]> =>
    api.get(`/orders/${orderId}/calls`).then((r) => r.data.data),
};


/** Un producto tal como lo devuelve la búsqueda: con su negocio dentro. */
export interface ProductSearchHit {
  _id: string;
  name: string;
  description?: string;
  price: number;
  discountPrice?: number;
  /** Solo lo manda `/offers`: el porcentaje ya calculado y redondeado. */
  discountPercent?: number;
  image?: string;
  imageAsset?: Record<string, unknown>;
  businessId: string;
  businessName: string;
  /** Clave de categoría del negocio (`restaurant`, `pharmacy`…). La usa la
   *  mini-ilustración de respaldo cuando el producto no tiene foto. */
  businessCategory?: string;
  businessRating?: number;
  businessDeliveryTime?: number;
}

export type SearchSort = 'relevance' | 'distance' | 'rating' | 'deliveryTime';

export interface SearchParams {
  q: string;
  page?: number;
  limit?: number;
  lat?: number;
  lng?: number;
  sort?: SearchSort;
}

export interface SearchResults {
  businesses: any[];
  products: ProductSearchHit[];
  strategy: 'text' | 'prefix' | 'corrected';
  /** El término que se buscó en realidad, si hubo que corregir un error. */
  suggestedTerm?: string;
  hasMore: boolean;
}

export interface SearchSuggestion {
  type: 'term' | 'business' | 'product';
  /** El negocio al que llevar. En un plato, el suyo. */
  id?: string;
  label: string;
  sublabel?: string;
  image?: string | null;
}

export const searchApi = {
  /**
   * Busca negocios y productos a la vez.
   *
   * Pública: buscar es lo primero que hace alguien que aún no se registró,
   * y el servidor no exige sesión para responder.
   */
  query: (params: SearchParams): Promise<SearchResults> =>
    api.get('/search', { params }).then((r) => r.data.data),

  /**
   * Sugerencias mientras se escribe: etiquetas, no fichas completas.
   *
   * Acepta `signal` porque es la única consulta de la app con debounce lo
   * bastante corto (150 ms) para dejar varias peticiones en vuelo a la vez:
   * escribir "hamburguesa" mandaba ~7 sin abortar, y pintaba la que ganara
   * la carrera de vuelta, no la última. React Query ya trae el `signal`
   * hecho — antes simplemente no se reenviaba a axios.
   */
  suggest: (q: string, signal?: AbortSignal): Promise<SearchSuggestion[]> =>
    api.get('/search/suggest', { params: { q }, signal }).then((r) => r.data.data),

  /** Términos reales del catálogo, en vez de una lista escrita a mano. */
  popular: (): Promise<string[]> =>
    api.get('/search/popular').then((r) => r.data.data),

  /**
   * Registra una búsqueda que el usuario confirmó.
   *
   * Se dispara y se olvida, y se traga cualquier fallo a propósito: es una
   * estadística. Que no se pueda registrar no puede estropearle la búsqueda
   * a nadie ni pintar un error en pantalla.
   */
  log: (input: { term: string; resultCount: number; suggestedTerm?: string }): void => {
    api.post('/search/log', input).catch(() => undefined);
  },
};

export interface PendingRating {
  _id: string;
  orderNumber: string;
  businessId: { _id: string; name: string } | string;
  driverId?: string | null;
  deliveredAt: string;
  /** Los platos del pedido, para poder opinar de cada uno. */
  items?: Array<{ productId: string; productName: string; quantity: number }>;
}

export const reviewsApi = {
  /** Pedidos entregados que este cliente aún no ha calificado. */
  pending: (): Promise<PendingRating[]> =>
    api.get('/reviews/pending').then((r) => r.data.data),

  create: (input: {
    orderId: string;
    businessId: string;
    driverId?: string;
    businessRating: number;
    driverRating?: number;
    comment?: string;
    productFeedback?: Array<{ productId: string; liked: boolean }>;
  }) => api.post('/reviews', input).then((r) => r.data.data),

  byBusiness: (businessId: string) =>
    api.get(`/reviews/business/${businessId}`).then((r) => r.data.data),
};

export type FavoriteKind = 'business' | 'product';

export const favoritesApi = {
  /** La lista con su contenido, para la pantalla de favoritos. */
  list: (): Promise<{ businesses: any[]; products: any[] }> =>
    api.get('/favorites').then((r) => r.data.data),

  /** Solo los ids: lo que necesita una lista para pintar el corazón lleno. */
  ids: (): Promise<{ businesses: string[]; products: string[] }> =>
    api.get('/favorites/ids').then((r) => r.data.data),

  add: (kind: FavoriteKind, targetId: string) =>
    api.post('/favorites', { kind, targetId }).then((r) => r.data.data),

  remove: (kind: FavoriteKind, targetId: string) =>
    api.delete(`/favorites/${kind}/${targetId}`).then((r) => r.data.data),

  /** Sube de una vez lo que la app guardaba en el teléfono. */
  importLocal: (items: Array<{ kind: FavoriteKind; targetId: string }>) =>
    api.post('/favorites/import', { items }).then((r) => r.data.data),
};

export interface LoyaltyMovement {
  _id: string;
  kind: 'earned' | 'redeemed' | 'expired' | 'reversed' | 'adjusted';
  points: number;
  description: string;
  createdAt: string;
  expiresAt?: string | null;
}

export const loyaltyApi = {
  /**
   * Saldo y movimientos.
   *
   * Los puntos ya no se derivan del historial local: viven en el servidor,
   * así que sobreviven a cambiar de teléfono y son los mismos que ZIPP
   * tiene anotados como deuda.
   */
  mine: (): Promise<{ balance: number; history: LoyaltyMovement[] }> =>
    api.get('/loyalty').then((r) => r.data.data),

  /** Cambia puntos por un cupón nominal. Devuelve el cupón entero. */
  redeem: (points: number) =>
    api.post('/loyalty/redeem', { points }).then((r) => r.data.data),
};

export const errandsApi = {
  /**
   * Crea un mandado: un pedido sin comercio detrás.
   *
   * El tope es obligatorio y no es un detalle burocrático — es lo que el
   * domiciliario va a adelantar de su bolsillo, así que el cliente tiene
   * que ponerle un número antes de que nadie salga a la calle.
   */
  create: (data: {
    description: string;
    pickupAddress: string;
    pickupLatitude: number;
    pickupLongitude: number;
    deliveryAddress: string;
    deliveryLatitude: number;
    deliveryLongitude: number;
    estimatedCost: number;
    maxCost: number;
    notes?: string;
  }) => api.post('/errands', data).then((r) => r.data.data),

  /** El domiciliario declara lo que costó, con foto del recibo. */
  declareCost: (orderId: string, actualCost: number, receiptUrl: string) =>
    api.post(`/errands/${orderId}/cost`, { actualCost, receiptUrl }).then((r) => r.data.data),
};

export const sosApi = {
  /**
   * Botón de pánico.
   *
   * Sin reintentos silenciosos ni cola offline: si no hay red, hay que
   * decírselo a la persona para que llame al 123 en vez de creer que ya
   * avisó a alguien.
   */
  trigger: (lat: number, lng: number, note?: string) =>
    api.post('/sos', { lat, lng, note }).then((r) => r.data.data),
};

export type DriverDocumentType =
  | 'identity'
  | 'license'
  | 'soat'
  | 'technical_review'
  | 'vehicle_registration';

/** Por qué se rechaza una oferta. Los mismos que acepta el servidor. */
export type DeclineReason = 'too_far' | 'busy' | 'low_pay' | 'other';

export interface DriverMetrics {
  days: number;
  offers: {
    accepted: number;
    declined: number;
    expired: number;
    /** Se la quedó otro. No cuenta en la tasa. */
    takenByOther: number;
    total: number;
  };
  /** `null` mientras no haya ofertas: un 0 % sería una calumnia. */
  acceptanceRate: number | null;
  avgResponseSeconds: number | null;
  deliveries: { completed: number; cancelled: number };
  rating: number;
  totalDeliveries: number;
  /** Lo dice el servidor, no la pantalla. Ver `getPerformance`. */
  affectsDispatch: boolean;
}

export interface DriverEarningsDay {
  /** `YYYY-MM-DD` en la zona del servidor, no en UTC. */
  date: string;
  orders: number;
  guaranteedFees: number;
  tips: number;
  total: number;
}

export interface DriverEarningsRange {
  from: string;
  to: string;
  series: DriverEarningsDay[];
  totals: {
    orders: number;
    guaranteedFees: number;
    tips: number;
    total: number;
    /** Días con al menos una entrega. Un domingo libre no es un mal día. */
    workedDays: number;
    perDay: number;
    perOrder: number;
  };
}

export interface DriverDocumentRecord {
  /** La foto que subió el domiciliario. Ausente en registros antiguos. */
  imageUrl?: string;
  _id: string;
  type: DriverDocumentType;
  reference: string;
  expiresAt?: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
}

export const driverApi = {
  getProfile: () =>
    api.get('/drivers/profile').then((r) => r.data.data),

  updateStatus: (status: string) =>
    api.patch('/drivers/status', { status }).then((r) => r.data.data),

  updateLocation: (lat: number, lng: number) =>
    api.patch('/drivers/location', { lat, lng }).then((r) => r.data.data),

  getEarnings: (date?: string) =>
    api.get('/drivers/earnings', { params: { date } }).then((r) => r.data.data),

  /**
   * Varios días a la vez.
   *
   * "Cuánto llevo hoy" es la pregunta de las seis de la tarde. La otra
   * —"¿me compensa este trabajo?"— solo se contesta mirando la semana, y
   * hasta ahora la app no tenía forma de preguntarla: el endpoint diario
   * aceptaba una fecha y nadie se la pasaba nunca.
   */
  getEarningsRange: (from?: string, to?: string): Promise<DriverEarningsRange> =>
    api.get('/drivers/earnings/range', { params: { from, to } }).then((r) => r.data.data),

  /** Aceptación, tiempo de respuesta y entregas. No afecta al reparto. */
  getMetrics: (days = 30): Promise<DriverMetrics> =>
    api.get('/drivers/metrics', { params: { days } }).then((r) => r.data.data),

  getDebts: () =>
    api.get('/drivers/debts').then((r) => r.data.data),

  /** A quién avisar si algo va mal. Requisito previo del botón de pánico. */
  setEmergencyContact: (contact: { name: string; phone: string; relationship?: string }) =>
    api.put('/drivers/emergency-contact', contact).then((r) => r.data.data),

  /**
   * Documentos del domiciliario: cédula, licencia, SOAT, tecnomecánica,
   * tarjeta de propiedad.
   *
   * Van con foto. Durante un tiempo esto solo mandaba `reference` —el
   * número—, que es un dato y no una prueba: nadie podía comprobar que la
   * cédula fuera de quien la teclea ni que la póliza existiera, y la cola
   * de revisión del admin era un trámite de aprobar números.
   */
  getDocuments: (): Promise<DriverDocumentRecord[]> =>
    api.get('/drivers/documents').then((r) => r.data.data),

  /**
   * Manda el documento con su foto, en multipart.
   *
   * `imageUri` es opcional solo para corregir un dígito mal escrito en un
   * documento que ya tiene foto; el servidor rechaza un envío nuevo sin
   * ella. Sin esa excepción, arreglar una errata obligaría a volver a
   * fotografiar la cédula.
   */
  submitDocument: (input: {
    type: DriverDocumentType;
    reference: string;
    expiresAt?: string;
    imageUri?: string;
  }) => {
    const form = new FormData();
    form.append('type', input.type);
    form.append('reference', input.reference);
    if (input.expiresAt) form.append('expiresAt', input.expiresAt);
    if (input.imageUri) {
      form.append('image', {
        uri: input.imageUri,
        name: `${input.type}.jpg`,
        type: 'image/jpeg',
      } as unknown as Blob);
    }
    return api
      .post('/drivers/documents', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      .then((r) => r.data.data);
  },

  /** Verificaciones de identidad: las pedidas, las enviadas y las revisadas. */
  getVerifications: () =>
    api.get('/drivers/verifications').then((r) => r.data.data),

  /**
   * Responde a una verificación con la selfie recién tomada.
   *
   * Va como multipart, igual que la evidencia de entrega: el teléfono no
   * tiene dónde alojar la foto, así que la manda entera y el servidor
   * decide dónde guardarla.
   */
  submitVerification: (uri: string, type = 'random_selfie') => {
    const form = new FormData();
    form.append('selfie', { uri, name: 'selfie.jpg', type: 'image/jpeg' } as unknown as Blob);
    form.append('type', type);
    return api
      .post('/drivers/verifications', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      .then((r) => r.data.data);
  },

  /**
   * Declares that the courier remitted collected cash.
   *
   * Replaces `payDebts`, which used to clear the balance outright with no
   * money attached. This only records the claim; ZIPP still has to verify
   * it before the balance closes.
   */
  reportCash: (reference: string, ids: string[] = []) =>
    api.post('/drivers/cash/report', { reference, ids }).then((r) => r.data.data),
};

/**
 * Seguimiento en vivo: mapas, posiciones y rutas.
 *
 * El grueso del seguimiento viaja por socket; esto es el arranque y el
 * respaldo. Abrir la pantalla de un pedido pide `getOrder` una vez para
 * tener algo que dibujar de inmediato — esperar al primer evento del
 * socket sería medio minuto de mapa en blanco si el repartidor está
 * parado en un semáforo.
 */
export const trackingApi = {
  /** Token y estilos de Mapbox. Requiere sesión. */
  getConfig: () =>
    api.get('/tracking/config').then((r) => r.data.data),

  /** Posición del repartidor, ruta y ETA de un pedido. */
  getOrder: (orderId: string, includeTrail = false) =>
    api
      .get(`/tracking/orders/${orderId}`, { params: { trail: includeTrail || undefined } })
      .then((r) => r.data.data),

  /**
   * Ruta óptima hacia el destino de la etapa en curso.
   *
   * Mandar la posición actual es opcional pero conviene: sin ella el
   * servidor rutea desde la última posición que le llegó, que en un
   * recálculo tras un desvío es justo la que ya no sirve.
   */
  getRoute: (orderId: string, from?: { lat: number; lng: number }) =>
    api.post(`/tracking/orders/${orderId}/route`, from ?? {}).then((r) => r.data.data),

  /**
   * Respaldo REST para reportar posición.
   *
   * Lo usa la tarea en segundo plano: cuando Android duerme la app, el
   * socket está cerrado y esta es la única vía que queda.
   */
  ping: (payload: {
    lat: number;
    lng: number;
    accuracy?: number;
    heading?: number;
    speed?: number;
    batteryLevel?: number;
    isMocked?: boolean;
    recordedAt?: string;
  }) => api.post('/tracking/ping', payload).then((r) => r.data.data),
};

export const paymentsApi = {
  getMethods: () =>
    api.get('/payments/methods').then((r) => r.data.data),

  /** Starts the gateway charge for an order. */
  pay: (orderId: string, redirectUrl?: string) =>
    api.post(`/payments/orders/${orderId}/pay`, { redirectUrl }).then((r) => r.data.data),

  getStatus: (transactionId: string) =>
    api.get(`/payments/status/${transactionId}`).then((r) => r.data.data),
};

export const authApi = {
  login: (phone: string, password: string) =>
    api.post('/auth/login', { phone, password }).then((r) => r.data.data),

  google: (idToken: string) =>
    api.post('/auth/google', { idToken }).then((r) => r.data.data),

  /**
   * Entrada única: el celular decide entre login y registro. Una llamada
   * barata y de solo lectura, aparte de `registerSendOtp` a propósito — esa
   * sí manda un WhatsApp real y vive detrás de un límite mucho más estricto.
   */
  checkPhone: (phone: string): Promise<{ exists: boolean }> =>
    api.post('/auth/phone-status', { phone }).then((r) => r.data.data),

  /**
   * Registro en 3 pasos al estilo Rappi: el celular se confirma por OTP
   * antes de pedir nombre y contraseña, así que va en tres llamadas en vez
   * de una. `registerComplete` ya no manda a la pantalla de OTP porque el
   * celular quedó verificado en el paso anterior.
   */
  registerSendOtp: (phone: string) =>
    api.post('/auth/register/send-otp', { phone }).then((r) => r.data),

  registerVerifyOtp: (phone: string, otpCode: string) =>
    api.post('/auth/register/verify-otp', { phone, otpCode }).then((r) => r.data),

  registerComplete: (data: { phone: string; name: string; password: string }) =>
    api.post('/auth/register/complete', data).then((r) => r.data.data),

  refreshToken: (refreshToken: string) =>
    api.post('/auth/refresh-token', { refreshToken }).then((r) => r.data.data),

  sendOtp: (phone: string) =>
    api.post('/auth/send-otp', { phone }).then((r) => r.data),

  verifyOtp: (phone: string, otpCode: string) =>
    api.post('/auth/verify-otp', { phone, otpCode }).then((r) => r.data.data),

  resetPassword: (data: { phone: string; otpCode: string; password: string }) =>
    api.post('/auth/reset-password', data).then((r) => r.data.data),

  updateProfile: (data: { name?: string; email?: string; phone?: string }) =>
    api.patch('/auth/profile', data).then((r) => r.data.data),

  /**
   * Sube una foto de perfil ya comprimida en el dispositivo. `uri` es la
   * ruta local que devuelve expo-image-manipulator; el backend la reenvía
   * a Cloudinary y responde con el usuario actualizado.
   */
  uploadAvatar: (uri: string) => {
    const form = new FormData();
    form.append('avatar', {
      uri,
      name: 'avatar.jpg',
      type: 'image/jpeg',
    } as unknown as Blob);
    return api
      .post('/auth/profile/avatar', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      .then((r) => r.data.data);
  },
};

export const couponsApi = {
  /** Promotions shown in the home carousel. */
  getPublic: (params?: { city?: string; businessId?: string }) =>
    api.get('/coupons/public', { params }).then((r) => r.data.data),

  validate: (data: { code: string; businessId: string; subtotal: number; deliveryFee?: number }) =>
    // The authoritative validation is ordersApi.quote; never send prices to
    // a coupon endpoint as a source of truth.
    Promise.reject(new Error('Usa ordersApi.quote para validar promociones')),
};

/** Por qué un negocio aparece en la pestaña de Descuentos. */
export interface OfferBusiness {
  _id: string;
  name: string;
  category: string;
  rating: number;
  deliveryTime: number;
  logo?: string | null;
  coverImage?: string | null;
  minOrder?: number;
  schedule?: Record<string, { open?: string; close?: string; isOpen?: boolean }>;
  distanceMeters?: number;
  freeDeliveryThreshold?: number;
  offer: { kind: 'discount' | 'free_delivery'; label: string };
}

export interface OffersResult {
  coupons: any[];
  products: ProductSearchHit[];
  businesses: OfferBusiness[];
}

export interface ReferralStats {
  /** El código propio de este usuario, el que se comparte. */
  code: string;
  /** Cuánta gente ha entrado con él. */
  invited: number;
  /** De esa gente, cuántos ya compraron — que es cuando se paga el premio. */
  rewarded: number;
  pointsPerReferral: number;
}

/**
 * Invitaciones.
 *
 * El backend lleva desde el Bloque 7 con código propio por usuario,
 * detección de abuso y recompensa pagada cuando el invitado **compra**. La
 * app seguía compartiendo por WhatsApp un cupón fijo escrito a mano,
 * `BIENVENIDO`, sin atribución ni premio para quien invitaba.
 */
export const referralsApi = {
  getStats: (): Promise<ReferralStats> =>
    api.get('/referrals').then((r) => r.data.data),

  apply: (code: string) =>
    api.post('/referrals/apply', { code }).then((r) => r.data),
};

export const offersApi = {
  /** Todo lo que está en oferta cerca de un punto: cupones, platos y negocios. */
  get: (params?: { lat?: number; lng?: number; maxDistance?: number; city?: string }): Promise<OffersResult> =>
    api.get('/offers', { params }).then((r) => r.data.data),
};

export const notificationsApi = {
  registerDevice: (token: string, platform: string) =>
    api.post('/notifications/devices', { token, platform }).then((r) => r.data.data),

  unregisterDevice: (token: string) =>
    api.delete('/notifications/devices', { data: { token } }).then((r) => r.data.data),
};

export const zonesApi = {
  checkCoverage: (lat: number, lng: number, businessId?: string) =>
    api.get('/zones/coverage', { params: { lat, lng, businessId } }).then((r) => r.data.data),
};

export const addressApi = {
  getAll: () =>
    api.get('/addresses').then((r) => r.data.data),

  create: (data: AddressInput) =>
    api.post('/addresses', data).then((r) => r.data.data),

  update: ({ id, ...data }: { id: string } & Partial<AddressInput>) =>
    api.patch(`/addresses/${id}`, data).then((r) => r.data.data),

  delete: (id: string) =>
    api.delete(`/addresses/${id}`).then((r) => r.data.data),

  setDefault: (id: string) =>
    api.patch(`/addresses/${id}/default`).then((r) => r.data.data),

  /**
   * Qué dirección hay en un punto del mapa.
   *
   * Devuelve `null` cuando ahí no hay nada cartografiado, que no es un
   * error: la coordenada sigue sirviendo para cobrar el envío y para que
   * el repartidor llegue. Solo falta el nombre de la calle.
   */
  reverseGeocode: (point: { lat: number; lng: number }): Promise<GeocodedPlace | null> =>
    api.get('/addresses/reverse-geocode', { params: point }).then((r) => r.data.data ?? null),

  /**
   * Direcciones que coinciden con un texto.
   *
   * `near` sesga los resultados hacia el usuario para que "calle 5"
   * devuelva primero la de su barrio. Devuelve `[]` cuando no hay nada:
   * buscar es un atajo para llenar el formulario, no un requisito.
   */
  search: (q: string, near?: { lat: number; lng: number }): Promise<PlaceSuggestion[]> =>
    api
      .get('/addresses/search', { params: { q, lat: near?.lat, lng: near?.lng } })
      .then((r) => r.data.data ?? []),
};

export interface AddressInput {
  label: string;
  address: string;
  /** Piso, apartamento, torre. Lo único que el mapa no puede saber. */
  apartment?: string;
  neighborhood?: string;
  city?: string;
  details?: string;
  longitude?: number;
  latitude?: number;
  isDefault?: boolean;
}

export interface GeocodedPlace {
  address: string;
  neighborhood?: string;
  city?: string;
  full: string;
  /** 'address' trae número de casa; 'street' solo la vía; 'area' ni eso. */
  precision: 'address' | 'street' | 'area';
}

/** Un resultado del buscador: como el geocodificado, pero con su punto. */
export interface PlaceSuggestion extends GeocodedPlace {
  lat: number;
  lng: number;
}

export const legalApi = {
  documents: () => api.get('/legal/documents').then((r) => r.data.data),
  accept: (id: string) => api.post(`/legal/documents/${id}/accept`).then((r) => r.data.data),
  dataRequests: () => api.get('/legal/data-requests').then((r) => r.data.data),
  createDataRequest: (type: string, detail: string) => api.post('/legal/data-requests', { type, detail }).then((r) => r.data.data),
};

export const pqrsApi = {
  mine: () => api.get('/pqrs/my').then((r) => r.data.data),
  create: (type: string, subject: string, detail: string) => api.post('/pqrs', { type, subject, detail }).then((r) => r.data.data),
};

export interface ActiveAd {
  id: string;
  campaignName: string;
  flyerUrl: string;
  actionType: 'none' | 'business';
  businessId: string | null;
  /** Segundos que la pantalla de carga debe mostrarla antes de continuar sola. */
  durationSeconds: number;
}

export const adsApi = {
  /**
   * La única campaña, si hay alguna, que debe mostrarse en la pantalla de
   * carga. Timeout propio y corto: el arranque de la app no puede esperar
   * los 15 s por defecto del resto de la API por algo que es puramente
   * decorativo.
   */
  getActive: (): Promise<ActiveAd | null> =>
    api.get('/advertisements/active', { timeout: 2500 }).then((r) => r.data.data),

  /** Se llama solo cuando el flyer ya se pintó en pantalla, no al recibirlo. */
  registerImpression: (id: string, deviceId: string) =>
    api.post(`/advertisements/${id}/impression`, { deviceId }).then((r) => r.data),

  registerClick: (id: string, deviceId: string) =>
    api.post(`/advertisements/${id}/click`, { deviceId }).then((r) => r.data),
};

// ── Banners promocionales de inicio ──

/** Tipos de acción que un banner puede llevar. Los define el backend. */
export type BannerActionType = 'none' | 'url' | 'business' | 'category' | 'screen' | 'search';

/**
 * Un banner tal como llega a la app.
 *
 * Nada aquí decide si el banner se muestra: eso ya lo resolvió el servidor.
 * No hay fechas ni `isActive` porque la app no tiene que —ni puede—
 * re-evaluar la vigencia.
 */
export interface PromoBanner {
  id: string;
  imageUrl: string;
  title: string;
  description: string;
  buttonText: string;
  actionType: BannerActionType;
  actionValue: string;
  /** Segundos que la tarjeta queda al frente antes de rotar. */
  durationSeconds: number;
}

export const bannersApi = {
  /** Los banners vigentes de una superficie, ya en el orden de aparición. */
  getActive: (placement: 'home' | 'offers' = 'home'): Promise<PromoBanner[]> =>
    api
      .get('/promotion-banners/active', { params: { placement } })
      .then((r) => r.data.data ?? []),
};

// ── Categorías de Home (panel del admin) ──

/**
 * Una categoría de negocio tal como la configura el admin.
 *
 * `imageUrl` es opcional: mientras el admin no suba una imagen para esa
 * categoría, la app cae en su ilustración local (ver
 * `components/illustrations`).
 */
export interface HomeCategory {
  _id: string;
  key: string;
  name: string;
  imageUrl?: string;
  status: 'active' | 'inactive';
  order: number;
}

export const homeCategoriesApi = {
  /** Ya viene ordenada por `order` y filtrada a `status: 'active'`. */
  getAll: (): Promise<HomeCategory[]> =>
    api.get('/home-categories').then((r) => r.data.data ?? []),
};
