import { Types } from 'mongoose';
import {
  PlatformPricingConfig,
  IPlatformPricingConfig,
  PricingConfigAudit,
} from '../models';
import { AppError } from '../middlewares';
import { config as envConfig } from '../config';
import { rateToBps } from '../utils';
import { invalidatePrefixes, CachePrefix } from '../cache';

/** The fields an admin is allowed to change. Everything else is derived. */
export const EDITABLE_PRICING_FIELDS = [
  'merchantCommissionBps',
  'categoryCommissionBps',
  'commissionAfterMerchantDiscount',
  'driverBaseFee',
  'driverPerKm',
  'driverMinFee',
  'freeRadiusMeters',
  'deliveryMarginFixed',
  'deliveryMarginBps',
  'deliveryMinFee',
  'deliveryMaxFee',
  'deliveryRoundingStep',
  'serviceFeeFixed',
  'serviceFeeBps',
  'serviceFeeMin',
  'serviceFeeMax',
  'maxTipBps',
  'maxRadiusMeters',
  'taxBps',
  'couponSubsidyLimit',
  'campaignBudgetTotal',
  'defaultMinimumContributionMargin',
  // Un programa de puntos es un coste por pedido que sale del margen, igual
  // que una comisión: se decide aquí, con motivo y versión, y no editando la
  // base de datos a mano. El modelo lo deja apagado de fábrica a propósito;
  // esto es lo que permite encenderlo sin tocar código.
  'loyaltyEarnBps',
  'loyaltyExpiryDays',
  'loyaltyMinRedeem',
  'cashOnDeliveryEnabled',
  'cashOnDeliveryMaxAmount',
  'maxDriverCashDebt',
] as const;

export type EditablePricingField = (typeof EDITABLE_PRICING_FIELDS)[number];
export type PricingConfigPatch = Partial<Record<EditablePricingField, unknown>>;

/**
 * Documents are typed by their interface, matching the rest of the codebase:
 * `IPlatformPricingConfig` extends Mongoose's `Document`, so it already
 * carries `save()` and `toObject()`.
 */
type PricingConfigDoc = IPlatformPricingConfig;

/**
 * Loads and versions the platform's monetisation parameters.
 *
 * The current config is cached in module memory because it is read on
 * every single quote. The cache is invalidated on write; in a multi-process
 * deployment each worker refreshes within `CACHE_TTL_MS`, which is
 * acceptable because a stale read only delays a rate change — it can never
 * corrupt an order, since the version actually used is stamped onto it.
 */
export class PricingConfigService {
  private cached: PricingConfigDoc | null = null;
  private cachedAt = 0;
  private static readonly CACHE_TTL_MS = 30_000;

  /** Test seam and post-write invalidation. */
  invalidate(): void {
    this.cached = null;
    this.cachedAt = 0;
  }

  /**
   * Returns the active config, bootstrapping version 1 from the current
   * environment variables on first use.
   *
   * Bootstrapping from env rather than from invented numbers is deliberate:
   * the migration must not silently change anyone's economics. Service fee
   * and delivery margin therefore start at zero, and an admin turns them on
   * explicitly.
   */
  async getCurrent(): Promise<PricingConfigDoc> {
    const fresh = Date.now() - this.cachedAt < PricingConfigService.CACHE_TTL_MS;
    if (this.cached && fresh) return this.cached;

    let current: PricingConfigDoc | null = await PlatformPricingConfig.findOne({
      isCurrent: true,
    }).sort({ version: -1 });

    if (!current) current = await this.bootstrap();

    this.cached = current;
    this.cachedAt = Date.now();
    return current;
  }

  /** Historical lookup, so an old order can be explained with its own rules. */
  async getByVersion(version: number): Promise<PricingConfigDoc | null> {
    return PlatformPricingConfig.findOne({ version });
  }

  async listVersions(limit = 50): Promise<PricingConfigDoc[]> {
    return PlatformPricingConfig.find().sort({ version: -1 }).limit(limit);
  }

  private async bootstrap(): Promise<PricingConfigDoc> {
    const platform = envConfig.platform;
    const delivery = platform.delivery;

    const created = await PlatformPricingConfig.create({
      version: 1,
      isCurrent: true,

      merchantCommissionBps: rateToBps(platform.commissionRate),
      categoryCommissionBps: new Map<string, number>(),
      commissionAfterMerchantDiscount: true,

      // The driver's guarantee inherits exactly today's customer-facing
      // delivery pricing, so nobody's pay changes on the day of migration.
      driverBaseFee: delivery.baseFee,
      driverPerKm: delivery.perKm,
      driverMinFee: delivery.minFee,
      freeRadiusMeters: Math.round(delivery.freeRadiusKm * 1000),

      // Zero until finance decides otherwise: migration must be economically
      // neutral, not a silent price increase.
      deliveryMarginFixed: 0,
      deliveryMarginBps: 0,
      serviceFeeFixed: 0,
      serviceFeeBps: 0,
      serviceFeeMin: 0,
      serviceFeeMax: 10000,

      deliveryMinFee: delivery.minFee,
      deliveryMaxFee: delivery.maxFee,
      deliveryRoundingStep: delivery.rounding,

      maxTipBps: rateToBps(platform.maxTipRate),
      maxRadiusMeters: Math.round(delivery.maxRadiusKm * 1000),
      taxBps: rateToBps(platform.taxRate),

      couponSubsidyLimit: 20000,
      campaignBudgetTotal: 0,
      defaultMinimumContributionMargin: 0,

      // Cash stays off until reconciliation is operating. Rule 4 of the
      // financial policy cannot be honoured without it.
      cashOnDeliveryEnabled: false,
      cashOnDeliveryMaxAmount: 150000,
      maxDriverCashDebt: 50000,

      changeReason: 'Migración inicial desde variables de entorno',
    });

    return created;
  }

  /**
   * Publishes a new configuration version.
   *
   * Never mutates the previous row: history is the audit trail, and orders
   * point at the version they were priced with.
   */
  async update(
    patch: PricingConfigPatch,
    context: { userId: string; userName?: string; reason: string; ip?: string }
  ): Promise<{ config: PricingConfigDoc; changes: Record<string, unknown> }> {
    const reason = (context.reason || '').trim();
    if (reason.length < 5) {
      throw new AppError('Debes indicar el motivo del cambio (mínimo 5 caracteres)', 400);
    }

    const current = await this.getCurrent();
    const currentObj = current.toObject();

    const unknownKeys = Object.keys(patch).filter(
      (key) => !(EDITABLE_PRICING_FIELDS as readonly string[]).includes(key)
    );
    if (unknownKeys.length > 0) {
      throw new AppError(`Campos no editables: ${unknownKeys.join(', ')}`, 400);
    }

    const changes: Record<string, { before: unknown; after: unknown }> = {};
    const nextValues: Record<string, unknown> = {};

    for (const field of EDITABLE_PRICING_FIELDS) {
      if (!(field in patch)) continue;

      const before =
        field === 'categoryCommissionBps'
          ? Object.fromEntries(current.categoryCommissionBps ?? new Map())
          : currentObj[field];
      const after = patch[field];

      if (JSON.stringify(before) === JSON.stringify(after)) continue;

      changes[field] = { before, after };
      nextValues[field] = after;
    }

    if (Object.keys(changes).length === 0) {
      throw new AppError('No hay cambios que aplicar', 400);
    }

    const nextVersion = current.version + 1;

    // Build the new version from the old one, so unspecified fields carry
    // forward rather than silently resetting to schema defaults.
    const draft = {
      ...currentObj,
      ...nextValues,
      _id: undefined,
      version: nextVersion,
      isCurrent: true,
      createdBy: new Types.ObjectId(context.userId),
      changeReason: reason,
      createdAt: undefined,
      updatedAt: undefined,
    };

    const created = await PlatformPricingConfig.create(draft);

    await PlatformPricingConfig.updateMany(
      { _id: { $ne: created._id }, isCurrent: true },
      { $set: { isCurrent: false } }
    );

    await PricingConfigAudit.create({
      fromVersion: current.version,
      toVersion: nextVersion,
      changedBy: context.userId,
      changedByName: context.userName ?? '',
      reason,
      changes,
      ip: context.ip ?? '',
    });

    this.invalidate();
    // El "Desde $X" de cada ficha sale de esta tarifa.
    await invalidatePrefixes([CachePrefix.BUSINESS_ALL, CachePrefix.BUSINESS_SLUG]);
    return { config: created, changes };
  }

  async getAuditTrail(limit = 50) {
    return PricingConfigAudit.find()
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate('changedBy', 'name phone');
  }
}

export const pricingConfigService = new PricingConfigService();
