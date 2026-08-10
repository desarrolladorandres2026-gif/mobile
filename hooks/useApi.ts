import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { businessesApi, productsApi, ordersApi, driverApi, addressApi, couponsApi, zonesApi, categoriesApi, notificationsApi, paymentsApi } from '../services/endpoints';

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

