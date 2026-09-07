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

  updateStatus: (id: string, status: string, cancellationReason?: string) =>
    api.patch(`/orders/${id}/status`, { status, cancellationReason }).then((r) => r.data.data),

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

export const orderFlowApi = {
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


export const driverApi = {
  getProfile: () =>
    api.get('/drivers/profile').then((r) => r.data.data),

  updateStatus: (status: string) =>
    api.patch('/drivers/status', { status }).then((r) => r.data.data),

  updateLocation: (lat: number, lng: number) =>
    api.patch('/drivers/location', { lat, lng }).then((r) => r.data.data),

  getEarnings: (date?: string) =>
    api.get('/drivers/earnings', { params: { date } }).then((r) => r.data.data),

  getDebts: () =>
    api.get('/drivers/debts').then((r) => r.data.data),

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

  register: (data: { name: string; phone: string; password: string; role?: string }) =>
    api.post('/auth/register', data).then((r) => r.data.data),

  refreshToken: (refreshToken: string) =>
    api.post('/auth/refresh-token', { refreshToken }).then((r) => r.data.data),

  sendOtp: (phone: string) =>
    api.post('/auth/send-otp', { phone }).then((r) => r.data),

  verifyOtp: (phone: string, otpCode: string) =>
    api.post('/auth/verify-otp', { phone, otpCode }).then((r) => r.data.data),

  sendEmailOtp: (email: string) =>
    api.post('/auth/send-email-otp', { email }).then((r) => r.data),

  verifyEmailOtp: (email: string, otpCode: string) =>
    api.post('/auth/verify-email-otp', { email, otpCode }).then((r) => r.data.data),

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

  create: (data: { label: string; address: string; details?: string; longitude?: number; latitude?: number; isDefault?: boolean }) =>
    api.post('/addresses', data).then((r) => r.data.data),

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
};

export interface GeocodedPlace {
  address: string;
  neighborhood?: string;
  city?: string;
  full: string;
  /** 'address' trae número de casa; 'street' solo la vía; 'area' ni eso. */
  precision: 'address' | 'street' | 'area';
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
export type BannerActionType = 'none' | 'url' | 'business' | 'category' | 'screen';

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
  /** Los banners vigentes de la pantalla inicial, ya en el orden de aparición. */
  getHome: (): Promise<PromoBanner[]> =>
    api
      .get('/promotion-banners/active', { params: { placement: 'home' } })
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
