export { authService } from './auth.service';
export { whatsappService } from './whatsapp.service';
export { emailService } from './email.service';
export { businessService } from './business.service';
export { orderService } from './order.service';

// ── Traspaso físico del pedido ───────────────────────────────────────
export {
  resolveOrderAccess,
  assertParticipant,
  getOrderParticipants,
  OrderAccess,
  OrderParticipant,
} from './orderAccess.service';
export { orderSecurityService, CODE_ERROR, OrderSecurityView } from './orderSecurity.service';
export { orderEvidenceService, EVIDENCE_ERROR, EvidenceView } from './orderEvidence.service';
export { orderChatService, CHAT_ERROR, sanitizeMessage, resetChatRateLimit } from './orderChat.service';
export { orderCallService, CALL_ERROR, CallView } from './orderCall.service';
export { productService } from './product.service';
export { driverService } from './driver.service';
export { categoryService } from './category.service';
export { adminService } from './admin.service';
export { dailySummaryService } from './dailySummary.service';
export { reviewService } from './review.service';
export { notificationService } from './notification.service';
export { pushService } from './push.service';
export { addressService } from './address.service';
export { positionService } from './position.service';
export { roleService } from './role.service';
export {
  getEffectivePermissions,
  getEffectiveRoles,
  getEffectiveRoleSlugs,
  hasPermission as hasEffectivePermission,
  hasAnyPermission as hasAnyEffectivePermission,
  hasAllPermissions as hasAllEffectivePermissions,
  hasRole as hasEffectiveRole,
  assertNotSelfTarget,
  assertCanAssignRoles,
  assertRoleMutable,
} from './authorization.service';
export { pricingService, QuoteImbalanceError, Quote } from './pricing.service';
export { couponService } from './coupon.service';
export { offersService } from './offers.service';
export { zoneService } from './zone.service';
export {
  paymentService,
  getPaymentProvider,
  setPaymentProvider,
  isOnlinePaymentAvailable,
} from './payments';

// ── Monetisation ─────────────────────────────────────────────────────
export {
  pricingConfigService,
  EDITABLE_PRICING_FIELDS,
  PricingConfigPatch,
} from './pricingConfig.service';
export { ledgerService, LedgerImbalanceError } from './ledger.service';
export { payoutService } from './payout.service';
export { cashReconciliationService } from './cashReconciliation.service';
export { cashIncidentService } from './cashIncident.service';
export { refundService, allocateRefund } from './refund.service';
export { advertisementService, AdStatus, PublicAd, AdStats } from './advertisement.service';
export {
  promotionBannerService,
  BannerStatus,
  PublicBanner,
} from './promotionBanner.service';
export { homeCategoryService } from './homeCategory.service';

// ── Seguimiento en vivo y mapas ──────────────────────────────────────
export {
  ingestPing,
  forgetDriver,
  getOrderTracking,
  getDriverRoute,
  getActiveFleet,
  findNearestDrivers,
  suggestDriverForOrder,
  getMapConfig,
  deliveryPhase,
  distanceToRouteMeters,
} from './tracking.service';
export {
  getRoute,
  getDurationsToPoint,
  estimateRoute,
  reverseGeocode,
  searchPlaces,
} from './mapbox.service';
