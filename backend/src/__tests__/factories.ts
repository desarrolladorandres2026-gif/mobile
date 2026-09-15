import { Types } from 'mongoose';
import {
  User,
  Business,
  Category,
  Product,
  Driver,
  Coupon,
  Zone,
  PlatformPricingConfig,
} from '../models';
import { UserRole, CouponType, CouponFundedBy, CouponScope, OrderCodeKind, OrderEvidenceType, OrderStatus } from '../types';
import { generateAccessToken } from '../utils';
import { sessionManager } from '../security';
import { pricingConfigService } from '../services/pricingConfig.service';

/**
 * Test data builders.
 *
 * Coordinates are around Garzón, Huila — the city Zipp operates in — so
 * distance-based delivery pricing produces realistic numbers.
 */
export const GARZON = { lat: 2.1958, lng: -75.6258 };

/** Roughly 1 km north of a given point (0.009° latitude ≈ 1 km). */
export function offsetKm(base: { lat: number; lng: number }, km: number) {
  return { lat: base.lat + km * 0.009, lng: base.lng };
}

let counter = 0;
const uniquePhone = () => `31${String(10000000 + counter++).padStart(8, '0')}`;

export async function makeUser(overrides: Partial<{
  name: string;
  phone: string;
  password: string;
  role: UserRole;
  isFinanceAdmin: boolean;
}> = {}) {
  const user = await User.create({
    name: overrides.name ?? 'Usuario Prueba',
    phone: overrides.phone ?? uniquePhone(),
    password: overrides.password ?? 'Clave.Segura123',
    role: overrides.role ?? UserRole.CLIENT,
    isFinanceAdmin: overrides.isFinanceAdmin ?? false,
    isActive: true,
    isVerified: true,
  });
  return user;
}

/**
 * Installs a pricing configuration for a test.
 *
 * Defaults reproduce the platform's pre-migration economics (no service
 * fee, no delivery margin), so a test that does not care about the new
 * levers behaves exactly as it did before. Tests that do care pass the
 * specific knob they are exercising.
 *
 * The service caches the current config in module memory, so this also
 * invalidates it — otherwise the second test in a file would silently
 * price against the first test's rates.
 */
export async function makePricingConfig(overrides: Record<string, unknown> = {}) {
  await PlatformPricingConfig.deleteMany({});
  pricingConfigService.invalidate();

  const config = await PlatformPricingConfig.create({
    version: 1,
    isCurrent: true,
    merchantCommissionBps: 1000,
    commissionAfterMerchantDiscount: true,
    driverBaseFee: 4000,
    driverPerKm: 900,
    driverMinFee: 3000,
    freeRadiusMeters: 1000,
    deliveryMarginFixed: 0,
    deliveryMarginBps: 0,
    deliveryMinFee: 3000,
    deliveryMaxFee: 20000,
    deliveryRoundingStep: 100,
    serviceFeeFixed: 0,
    serviceFeeBps: 0,
    serviceFeeMin: 0,
    serviceFeeMax: 10000,
    maxTipBps: 10_000,
    maxRadiusMeters: 12000,
    taxBps: 0,
    couponSubsidyLimit: 0,
    campaignBudgetTotal: 0,
    defaultMinimumContributionMargin: 0,
    cashOnDeliveryEnabled: false,
    cashOnDeliveryMaxAmount: 150000,
    // Sin techo de deuda salvo que la prueba lo pida. Misma convención que
    // el resto de este factory: una palanca nueva no debe cambiar por su
    // cuenta el resultado de las pruebas que no van sobre ella.
    maxDriverCashDebt: 0,
    changeReason: 'Configuración de prueba',
    ...overrides,
  });

  pricingConfigService.invalidate();
  return config;
}

/**
 * Firma un access token con una sesión real detrás.
 *
 * `authenticate` ahora exige que el `sid` del token corresponda a una
 * `Session` activa (ver `middlewares/auth.ts`), así que un token sin sesión
 * se rechaza con 401 — es justo la corrección de A9: revocar una sesión
 * corta también su access token. Las pruebas necesitan la misma sesión que
 * tendría un login real, no un atajo que la sortee.
 */
export async function tokenFor(user: { _id: any; role: string }): Promise<string> {
  const sessionId = new Types.ObjectId();
  const token = generateAccessToken({ id: user._id.toString(), role: user.role as UserRole, sid: sessionId.toString() });
  await sessionManager.createSession({
    userId: user._id.toString(),
    sessionId,
    refreshToken: `test-refresh-${sessionId.toString()}`,
    ip: '127.0.0.1',
    userAgent: 'vitest',
  });
  return token;
}

export async function authHeader(user: { _id: any; role: string }): Promise<{ Authorization: string }> {
  return { Authorization: `Bearer ${await tokenFor(user)}` };
}

export async function makeBusiness(ownerId: any, overrides: Partial<{
  name: string;
  lat: number;
  lng: number;
  minOrder: number;
  /** @deprecated Use commissionRateBps. Converted for compatibility. */
  commissionRate: number;
  commissionRateBps: number;
  isActive: boolean;
  isApproved: boolean;
  category: string;
  city: string;
}> = {}) {
  const bps =
    overrides.commissionRateBps ??
    (overrides.commissionRate !== undefined
      ? Math.round(overrides.commissionRate * 10_000)
      : 1000);

  return Business.create({
    ownerId,
    name: overrides.name ?? `Negocio ${counter++}`,
    description: 'Negocio de prueba',
    category: overrides.category ?? 'fast_food',
    address: 'Cra 10 #5-23, Garzón',
    location: {
      type: 'Point',
      coordinates: [overrides.lng ?? GARZON.lng, overrides.lat ?? GARZON.lat],
    },
    phone: '3151234567',
    minOrder: overrides.minOrder ?? 0,
    commissionRateBps: bps,
    // -1 bps means "no override, use the platform/category rate". The legacy
    // decimal mirror cannot represent that, so it falls back to 0.
    commissionRate: Math.max(0, bps) / 10_000,
    isActive: overrides.isActive ?? true,
    isApproved: overrides.isApproved ?? true,
    city: overrides.city ?? 'Garzón',
  });
}

export async function makeProduct(businessId: any, overrides: Partial<{
  name: string;
  price: number;
  discountPrice: number | null;
  extras: Array<{ name: string; price: number }>;
  modifierGroups: Array<{
    name: string;
    minSelect: number;
    maxSelect: number;
    sortOrder?: number;
    options: Array<{ name: string; price: number; isAvailable?: boolean }>;
  }>;
  isAvailable: boolean;
  stock: number | null;
  requiresAgeVerification: boolean;
}> = {}) {
  const category = await Category.create({
    businessId,
    name: `Categoría ${counter++}`,
    sortOrder: 1,
  });

  return Product.create({
    businessId,
    categoryId: category._id,
    name: overrides.name ?? `Producto ${counter++}`,
    description: 'Producto de prueba',
    price: overrides.price ?? 10000,
    discountPrice: overrides.discountPrice ?? null,
    extras: overrides.extras ?? [],
    modifierGroups: overrides.modifierGroups ?? [],
    isAvailable: overrides.isAvailable ?? true,
    stock: overrides.stock ?? null,
    requiresAgeVerification: overrides.requiresAgeVerification ?? false,
  });
}

/** El grupo y la opción por nombre, para armar una selección en una prueba. */
export function pick(product: any, groupName: string, optionName: string) {
  const group = product.modifierGroups.find((g: any) => g.name === groupName);
  if (!group) throw new Error(`No hay grupo "${groupName}" en ${product.name}`);
  const option = group.options.find((o: any) => o.name === optionName);
  if (!option) throw new Error(`No hay opción "${optionName}" en ${groupName}`);
  return { groupId: group._id.toString(), optionId: option._id.toString() };
}

export async function makeDriver(userId: any, overrides: Partial<{
  currentFund: number;
  isApproved: boolean;
  isActive: boolean;
}> = {}) {
  return Driver.create({
    userId,
    vehicleType: 'motorcycle',
    licensePlate: `AB${counter++}`,
    status: 'available',
    currentLocation: { type: 'Point', coordinates: [GARZON.lng, GARZON.lat] },
    baseFund: 50000,
    currentFund: overrides.currentFund ?? 50000,
    isActive: overrides.isActive ?? true,
    isApproved: overrides.isApproved ?? true,
  });
}

export async function makeCoupon(overrides: Partial<{
  code: string;
  type: CouponType;
  value: number;
  maxDiscount: number;
  maxDiscountAmount: number;
  minOrderAmount: number;
  validFrom: Date;
  validUntil: Date;
  usageLimit: number;
  perUserLimit: number;
  businessId: any;
  city: string;
  firstOrderOnly: boolean;
  isActive: boolean;
  isPublic: boolean;
  fundedBy: CouponFundedBy;
  scope: CouponScope;
  budgetLimit: number;
  budgetSpent: number;
  minimumContributionMargin: number;
  campaignApproved: boolean;
}> = {}) {
  const type = overrides.type ?? CouponType.PERCENTAGE;

  // Free delivery is always delivery-scoped; the model enforces it, so
  // default coherently instead of making every caller restate it.
  const scope =
    overrides.scope ??
    (type === CouponType.FREE_DELIVERY ? CouponScope.DELIVERY : CouponScope.PRODUCT);

  return Coupon.create({
    code: overrides.code ?? `PROMO${counter++}`,
    title: 'Cupón de prueba',
    description: 'Descripción',
    type,
    value: overrides.value ?? 10,
    maxDiscount: overrides.maxDiscount ?? 0,
    maxDiscountAmount: overrides.maxDiscountAmount ?? 0,
    minOrderAmount: overrides.minOrderAmount ?? 0,
    validFrom: overrides.validFrom ?? new Date(Date.now() - 60_000),
    validUntil: overrides.validUntil ?? new Date(Date.now() + 7 * 24 * 3600_000),
    usageLimit: overrides.usageLimit ?? 0,
    perUserLimit: overrides.perUserLimit ?? 0,
    businessId: overrides.businessId ?? null,
    city: overrides.city ?? '',
    firstOrderOnly: overrides.firstOrderOnly ?? false,
    isActive: overrides.isActive ?? true,
    isPublic: overrides.isPublic ?? false,
    fundedBy: overrides.fundedBy ?? CouponFundedBy.PLATFORM,
    scope,
    budgetLimit: overrides.budgetLimit ?? 0,
    budgetSpent: overrides.budgetSpent ?? 0,
    minimumContributionMargin: overrides.minimumContributionMargin ?? -1,
    campaignApproved: overrides.campaignApproved ?? true,
  });
}

/** A square zone centred on a point, `halfSideKm` in each direction. */
export async function makeZone(
  center: { lat: number; lng: number },
  halfSideKm = 3,
  overrides: Partial<{
    name: string;
    baseFee: number | null;
    perKm: number | null;
    surcharge: number;
    minOrder: number;
    priority: number;
    city: string;
    isActive: boolean;
  }> = {}
) {
  const d = halfSideKm * 0.009;
  const ring = [
    [center.lng - d, center.lat - d],
    [center.lng + d, center.lat - d],
    [center.lng + d, center.lat + d],
    [center.lng - d, center.lat + d],
    [center.lng - d, center.lat - d],
  ];

  return Zone.create({
    name: overrides.name ?? `Zona ${counter++}`,
    city: overrides.city ?? 'Garzón',
    area: { type: 'Polygon', coordinates: [ring] },
    baseFee: overrides.baseFee ?? null,
    perKm: overrides.perKm ?? null,
    surcharge: overrides.surcharge ?? 0,
    minOrder: overrides.minOrder ?? 0,
    priority: overrides.priority ?? 0,
    isActive: overrides.isActive ?? true,
  });
}

// ── Traspaso físico del pedido ───────────────────────────────────────

/**
 * Recoge o entrega un pedido pasando por el control real: evidencia
 * fotográfica registrada y código de seguridad consumido.
 *
 * Desde que existen las dos puertas de seguridad, `updateStatus` ya no
 * acepta un salto directo a "recogido" o "entregado" — es justo lo que se
 * quería—, así que las pruebas que van *sobre otra cosa* (el libro mayor,
 * los webhooks, las liquidaciones) necesitan una forma corta y fiel de
 * llegar al final del pedido. Esta es esa forma: hace exactamente lo que
 * haría el domiciliario, sin pasar por Cloudinary.
 */
async function handOver(orderId: string, driverUser: any, kind: OrderCodeKind) {
  const [
    { Order, OrderEvidence },
    { OrderSecurity },
    { decrypt },
    { orderSecurityService },
    { resolveOrderAccess },
    { orderService },
    crypto,
  ] = await Promise.all([
    import('../models'),
    import('../security/orderSecurity'),
    import('../security/encryption'),
    import('../services/orderSecurity.service'),
    import('../services/orderAccess.service'),
    import('../services/order.service'),
    import('crypto'),
  ]);

  const order = await Order.findById(orderId);
  if (!order) throw new Error(`Pedido ${orderId} no existe`);

  await orderSecurityService.ensureIssued(orderId);

  const access = await resolveOrderAccess(orderId, driverUser);
  await orderSecurityService.markArrival(access, kind);

  await OrderEvidence.create({
    orderId: order._id,
    type: kind === OrderCodeKind.PICKUP
      ? OrderEvidenceType.PICKUP
      : OrderEvidenceType.DELIVERY,
    storageKey: `test/${orderId}/${kind}`,
    imageUrl: `https://evidencias.test/${orderId}-${kind}.jpg`,
    isPrivate: true,
    uploadedBy: driverUser._id,
    uploadedByRole: UserRole.DRIVER,
    driverId: order.driverId ?? null,
    businessId: order.businessId,
    customerId: order.clientId,
    orderStatus: order.status,
    metadata: {
      bytes: 1024,
      format: 'jpg',
      // Distinto en cada llamada: la misma foto no vale para las dos etapas.
      checksum: crypto.randomBytes(32).toString('hex'),
    },
  });

  const security = await OrderSecurity.findOne({ orderId });
  const code = decrypt(security![kind].secret);

  await orderSecurityService.verify({ access, kind, code });

  return orderService.updateStatus(
    orderId,
    kind === OrderCodeKind.PICKUP ? OrderStatus.PICKED_UP : OrderStatus.DELIVERED,
    driverUser._id.toString(),
    UserRole.DRIVER
  );
}

/** El domiciliario recoge el pedido en el local (evidencia + código). */
export function pickUpOrder(orderId: string, driverUser: any) {
  return handOver(orderId, driverUser, OrderCodeKind.PICKUP);
}

/** El domiciliario entrega al cliente (evidencia + código del cliente). */
export function deliverToCustomer(orderId: string, driverUser: any) {
  return handOver(orderId, driverUser, OrderCodeKind.DELIVERY);
}

/**
 * Camino completo del reparto: recoger → en camino → entregar, con las
 * dos validaciones de seguridad por medio.
 */
export async function runDelivery(orderId: string, driverUser: any) {
  const { orderService } = await import('../services/order.service');
  await pickUpOrder(orderId, driverUser);
  await orderService.updateStatus(
    orderId,
    OrderStatus.ON_WAY,
    driverUser._id.toString(),
    UserRole.DRIVER
  );
  return deliverToCustomer(orderId, driverUser);
}
