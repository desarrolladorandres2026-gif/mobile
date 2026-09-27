export { User, IUser } from './User';
export { PendingRegistration, IPendingRegistration } from './PendingRegistration';
export { OtpOutbox, IOtpOutbox } from './OtpOutbox';
export { getNextSequence } from './Counter';
export { Position, IPosition } from './Position';
export { Role, IRole } from './Role';
export {
  Business,
  IBusiness,
  IBusinessLegal,
  IBusinessPayoutAccount,
  LegalDocumentType,
  TaxRegime,
  PayoutMethod,
  PayoutAccountType,
  PayoutAccountStatus,
  LEGAL_DOCUMENT_TYPES,
  TAX_REGIMES,
  PAYOUT_METHODS,
  PAYOUT_ACCOUNT_TYPES,
} from './Business';
export { Category, ICategory } from './Category';
export {
  Product,
  IProduct,
  IProductImage,
  IProductImageCutout,
  IBackgroundRemovalState,
  BackgroundRemovalStatus,
} from './Product';
export { Driver, IDriver } from './Driver';
export { DriverLocation, IDriverLocation } from './DriverLocation';
export { Order, IOrder, IOrderItem, IOrderFinance } from './Order';

// ── Traspaso físico del pedido ───────────────────────────────────────
export { OrderEvidence, IOrderEvidence } from './OrderEvidence';
export { OrderMessage, IOrderMessage } from './OrderMessage';
export { OrderCall, IOrderCall } from './OrderCall';
export {
  Payment,
  IPayment,
  PAYMENT_STATUS_TRANSITIONS,
  canTransitionPayment,
} from './Payment';
export { Commission, ICommission } from './Commission';
export { DriverDebt, IDriverDebt } from './DriverDebt';
export { Address, IAddress } from './Address';
export { Notification, INotification } from './Notification';
export { Review, IReview } from './Review';
export { Coupon, ICoupon, CouponRedemption, ICouponRedemption } from './Coupon';
export { Zone, IZone, IZoneVersion, ZONE_TARIFF_FIELDS, ZoneTariffField, MAX_ZONE_VERSIONS } from './Zone';

// ── Monetisation ─────────────────────────────────────────────────────
export {
  PlatformPricingConfig,
  IPlatformPricingConfig,
  PricingConfigSnapshot,
  PricingConfigAudit,
  IPricingConfigAudit,
  COMMISSION_CATEGORIES,
} from './PlatformPricingConfig';
export { LedgerEntry, ILedgerEntry } from './LedgerEntry';
export { Payout, IPayout, Settlement, ISettlement, ISettlementPayoutAccount } from './Payout';
export {
  CashReconciliation,
  ICashReconciliation,
  CASH_RECONCILIATION_TRANSITIONS,
} from './CashReconciliation';
export {
  CashPaymentIncident,
  ICashPaymentIncident,
  CASH_INCIDENT_TRANSITIONS,
} from './CashPaymentIncident';
export { Refund, IRefund, ProcessedWebhook, IProcessedWebhook } from './Refund';
export { SavedCard, ISavedCard, toPublicCard } from './SavedCard';
export { LegalDocument, ILegalDocument, LegalDocumentKind, LegalAcceptance, ILegalAcceptance, DataRequest, IDataRequest } from './Legal';
export { Pqrs, IPqrs } from './Pqrs';
export { SupportMacro, ISupportMacro } from './SupportMacro';
export { CampaignSend, ICampaignSend, CampaignSendStatus } from './CampaignSend';
export { DriverDocument, IDriverDocument } from './DriverDocument';
export { DriverOffer, IDriverOffer, OfferOutcome, DeclineReason } from './DriverOffer';
export {
  Advertisement, IAdvertisement, AdActionType, AD_DURATION,
  AdPricingModel, AdApprovalStatus, AdPlacement,
} from './Advertisement';
export { AdInvoice, IAdInvoice } from './AdInvoice';
export { FiscalDocument, IFiscalDocument } from './FiscalDocument';
export { AdEvent, IAdEvent, AdEventType } from './AdEvent';
export {
  PromotionBanner,
  IPromotionBanner,
  BannerActionType,
  BannerPlacement,
  BANNER_SCREENS,
  BANNER_SCREEN_KEYS,
  BANNER_DURATION,
} from './PromotionBanner';
export { HomeCategory, IHomeCategory } from './HomeCategory';
export {
  CuratedHomeBlock,
  ICuratedHomeBlock,
  CuratedHomeBlockKind,
  CURATED_HOME_BLOCK_KINDS,
} from './CuratedHomeBlock';
export {
  DiscoveryCollection,
  IDiscoveryCollection,
  Rule,
  RuleDSL,
  RuleSource,
  RULE_SOURCES,
  SortBy,
  SORT_OPTIONS,
  SalesWindow,
  PersonalKind,
  DisplayVariant,
  DISPLAY_VARIANTS,
  CollectionFeed,
  COLLECTION_FEEDS,
  Daypart,
  DAYPARTS,
  DAYPART_RANGES,
  daypartAt,
  RotationMode,
  ROTATION_MODES,
  DISCOVERY_OPTIONS,
  MAX_RULES_PER_COLLECTION,
  MAX_ACTIVE_COLLECTIONS_PER_FEED,
} from './DiscoveryCollection';

export { FeatureFlag, IFeatureFlag, FeatureAudience } from './FeatureFlag';

export {
  BusinessDocument,
  IBusinessDocument,
  BusinessDocumentType,
  BusinessDocumentStatus,
  IBusinessDocumentHistoryEntry,
  MAX_DOCUMENT_HISTORY,
  REQUIRED_BUSINESS_DOCUMENTS,
  FOOD_CATEGORIES,
} from './BusinessDocument';

export { Favorite, IFavorite, FavoriteKind } from './Favorite';

export { CartActivity, ICartActivity } from './CartActivity';

export {
  BusinessStaff,
  IBusinessStaff,
  BusinessRole,
  BusinessPermission,
  BUSINESS_ROLE_PERMISSIONS,
} from './BusinessStaff';

export { SosAlert, ISosAlert, SosStatus } from './SosAlert';
export { SearchLog, ISearchLog } from './SearchLog';
export { SearchRule, ISearchRule, SearchRuleKind, SearchRedirectKind, SEARCH_RULE_KINDS } from './SearchRule';
export { ClientError, IClientError } from './ClientError';
export { CrashResolution, ICrashResolution } from './CrashResolution';

export {
  ProSubscription,
  IProSubscription,
  ProSubscriptionStatus,
  isProActive,
} from './ProSubscription';

export {
  ImageProcessingEvent,
  IImageProcessingEvent,
  ImageProcessingOutcome,
} from './ImageProcessingEvent';

export {
  ExploreLayoutState,
  IExploreLayoutState,
  ExploreLayoutVersion,
  IExploreLayoutVersion,
  EXPLORE_GLOBAL_SCOPE,
} from './ExploreLayout';

// ── Panel admin, Fase 2 ──────────────────────────────────────────────
export {
  InternalNote,
  IInternalNote,
  NoteEntityType,
  NOTE_ENTITY_TYPES,
  NOTE_MAX_LENGTH,
} from './InternalNote';
export { AlertReceipt, IAlertReceipt, ALERT_RECEIPT_TTL_SECONDS } from './AlertReceipt';

// ── Centro de seguridad de comercios ─────────────────────────────────
export {
  SecurityEvent,
  ISecurityEvent,
  SecurityEventType,
  SecurityEventResult,
  SECURITY_EVENT_TYPES,
  SECURITY_EVENT_RETENTION_DAYS,
} from './SecurityEvent';
