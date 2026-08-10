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

  updateStatus: (id: string, status: string, cancellationReason?: string) =>
    api.patch(`/orders/${id}/status`, { status, cancellationReason }).then((r) => r.data.data),

  getAvailableOrders: (page = 1, limit = 20) =>
    api.get('/orders/driver/available', { params: { page, limit } }).then((r) => r.data.data),

  getDriverOrders: (page = 1, limit = 20) =>
    api.get('/orders/driver/my', { params: { page, limit } }).then((r) => r.data.data),

  assignDriver: (orderId: string, driverId: string) =>
    api.patch(`/orders/${orderId}/assign-driver`, { driverId }).then((r) => r.data.data),
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

  register: (data: { name: string; phone: string; password: string; role?: string }) =>
    api.post('/auth/register', data).then((r) => r.data.data),

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
};

export const couponsApi = {
  /** Promotions shown in the home carousel. */
  getPublic: (params?: { city?: string; businessId?: string }) =>
    api.get('/coupons/public', { params }).then((r) => r.data.data),

  validate: (data: { code: string; businessId: string; subtotal: number; deliveryFee?: number }) =>
    api.post('/coupons/validate', data).then((r) => r.data.data),
};

export const notificationsApi = {
  getAll: (page = 1, limit = 30) =>
    api.get('/notifications', { params: { page, limit } }).then((r) => r.data.data),

  getUnreadCount: () =>
    api.get('/notifications/unread-count').then((r) => r.data.data),

  markAsRead: (id: string) =>
    api.patch(`/notifications/${id}/read`).then((r) => r.data.data),

  markAllAsRead: () =>
    api.patch('/notifications/read-all').then((r) => r.data.data),

  remove: (id: string) =>
    api.delete(`/notifications/${id}`).then((r) => r.data.data),
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
};
