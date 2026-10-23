import { api } from './http';

// ── Direcciones ────────────────────────────────────────────────────────────

export interface Address {
  _id: string;
  label: string;
  address: string;
  apartment?: string;
  neighborhood?: string;
  city?: string;
  details?: string;
  isDefault?: boolean;
  location?: { coordinates: [number, number] };
}

export interface AddressInput {
  label: string;
  address: string;
  apartment?: string;
  neighborhood?: string;
  city?: string;
  details?: string;
  longitude: number;
  latitude: number;
  isDefault?: boolean;
}

export interface PlaceSuggestion {
  address: string;
  neighborhood?: string;
  city?: string;
  full: string;
  precision: 'address' | 'street' | 'area';
  lat: number;
  lng: number;
}

export const ADDRESSES_KEY = ['addresses'] as const;

export const addressApi = {
  list: () => api<Address[]>('/addresses', { auth: true }),
  create: (data: AddressInput) => api<Address>('/addresses', { method: 'POST', body: data, auth: true }),
  remove: (id: string) => api(`/addresses/${encodeURIComponent(id)}`, { method: 'DELETE', auth: true }),
  setDefault: (id: string) => api(`/addresses/${encodeURIComponent(id)}/default`, { method: 'PATCH', auth: true }),
  search: (q: string, near?: { lat: number; lng: number }) => {
    const params = new URLSearchParams({ q });
    if (near) {
      params.set('lat', String(near.lat));
      params.set('lng', String(near.lng));
    }
    return api<PlaceSuggestion[]>(`/addresses/search?${params}`, { auth: true });
  },
  reverse: (point: { lat: number; lng: number }) =>
    api<PlaceSuggestion | null>(`/addresses/reverse-geocode?lat=${point.lat}&lng=${point.lng}`, { auth: true }),
};

/** Coordenadas de una dirección guardada, como [lat, lng], o null si no tiene punto. */
export function addressPoint(a: Address): { lat: number; lng: number } | null {
  const c = a.location?.coordinates;
  if (!c || c.length < 2 || (c[0] === 0 && c[1] === 0)) return null;
  return { lng: c[0], lat: c[1] };
}

// ── Cotización y pedido ────────────────────────────────────────────────────

export type PaymentMethod = 'online' | 'cash_on_delivery';

export interface QuoteItemInput {
  productId: string;
  quantity: number;
  selectedExtras: Array<{ name: string; quantity: number; groupId?: string; optionId?: string }>;
  notes: string;
}

export interface QuoteInput {
  businessId: string;
  items: QuoteItemInput[];
  paymentMethod: PaymentMethod;
  deliveryLatitude: number;
  deliveryLongitude: number;
  couponCode?: string;
  tip?: number;
}

export interface QuoteExtra { name: string; price: number; quantity?: number; groupName?: string; optionId?: string }

export interface QuoteItem {
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  selectedExtras?: QuoteExtra[];
  notes?: string;
}

/** Lo que el servidor deja ver al cliente de su cotización (`customerQuoteView`). */
export interface Quote {
  items: QuoteItem[];
  productSubtotal: number;
  deliveryFee: number;
  deliveryPayable: number;
  freeDeliveryApplied?: boolean;
  customerServiceFee: number;
  discount: number;
  promotionDiscount?: number;
  proDeliveryDiscount?: number;
  proServiceFeeDiscount?: number;
  tip: number;
  tax?: number;
  total: number;
  minOrder: number;
  etaMinutesMin: number;
  etaMinutesMax: number;
  deliveryDistanceKm?: number;
  zoneName?: string | null;
  requiresAgeVerification?: boolean;
  coupon: { code: string; title?: string; totalDiscount?: number } | null;
  suggestedCoupon: { code: string; title?: string; discount?: number } | null;
  proBenefitNotice?: { message?: string } | null;
}

export interface CreateOrderInput extends QuoteInput {
  deliveryAddress: string;
  deliveryDetails?: string;
  notes?: string;
  /** El total que la persona está viendo: si cambió, el servidor responde `PRICE_CHANGED`. */
  expectedTotal: number;
  cashPayment?: { needsChange: boolean; payingWith?: number };
  recipient?: { name: string; phone: string; note?: string };
  scheduledFor?: string;
  idempotencyKey: string;
}

export interface Order {
  _id: string;
  orderNumber?: string;
  status: string;
  paymentMethod: PaymentMethod;
  paymentStatus?: string;
  businessId?: { _id: string; name: string; slug?: string; logo?: string } | string;
  items: QuoteItem[];
  deliveryAddress?: string;
  estimatedDelivery?: string;
  createdAt: string;
  cancellationReason?: string;
  /** Vista del cliente: solo lo que él paga (`customerOrderView`). */
  finance?: { customerTotal?: number; productSubtotal?: number; deliveryCustomerFee?: number; customerServiceFee?: number; tip?: number };
}

export const orderApi = {
  quote: (input: QuoteInput) => api<Quote>('/orders/quote', { method: 'POST', body: input, auth: true }),
  create: (input: CreateOrderInput) => api<Order>('/orders', { method: 'POST', body: input, auth: true, timeoutMs: 30_000 }),
  mine: (page = 1, limit = 20) => api<Order[]>(`/orders/my?page=${page}&limit=${limit}`, { auth: true }),
  get: (id: string) => api<Order>(`/orders/${encodeURIComponent(id)}`, { auth: true }),
  cancel: (id: string, cancellationCode: string, cancellationReason?: string) =>
    api<Order>(`/orders/${encodeURIComponent(id)}/status`, {
      method: 'PATCH',
      body: { status: 'cancelled', cancellationCode, cancellationReason },
      auth: true,
    }),
};

// ── Pago ───────────────────────────────────────────────────────────────────

export interface PaymentIntent {
  checkoutUrl?: string;
  transactionId?: string;
  status?: string;
}

export interface PaymentStatus {
  status: string;
  declineReason?: string;
  asyncPaymentUrl?: string;
}

export const paymentApi = {
  /** Web Checkout de Wompi: devuelve la URL a la que se manda a la persona a pagar. */
  pay: (orderId: string, redirectUrl: string) =>
    api<PaymentIntent>(`/payments/orders/${encodeURIComponent(orderId)}/pay`, {
      method: 'POST',
      body: { redirectUrl },
      auth: true,
    }),
  status: (transactionId: string) =>
    api<PaymentStatus>(`/payments/status/${encodeURIComponent(transactionId)}`, { auth: true }),
};
