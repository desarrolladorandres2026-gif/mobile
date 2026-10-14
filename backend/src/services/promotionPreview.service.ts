import { Types } from 'mongoose';
import { Business, BusinessPermission } from '../models';
import { AppError } from '../middlewares';
import { CouponFundedBy, CouponScope, CouponType, PaymentMethod } from '../types';
import { businessStaffService, type SessionScope } from './businessStaff.service';
import { pricingService, type PromotionDraft, type PromotionPreview } from './pricing.service';
import { effectiveFreeDeliveryThreshold } from '../utils/freeDeliveryWindow';
import { config as envConfig } from '../config';

/**
 * Previsualización de promociones antes de activarlas.
 *
 * Este servicio solo decide quién puede pedirla y qué carritos de ejemplo
 * simular; el dinero lo calcula `pricingService.previewPromotion`, que usa
 * las mismas funciones que el cobro. No hay aquí ninguna fórmula.
 */

export interface BusinessPreviewBody {
  draft?: {
    type: 'percentage' | 'fixed';
    value: number;
    maxDiscount?: number;
    maxDiscountAmount?: number;
    minOrderAmount?: number;
    autoApply?: boolean;
    firstOrderOnly?: boolean;
    budgetLimit?: number;
    usageLimit?: number;
    perUserLimit?: number;
    validFrom?: Date;
    validUntil?: Date;
  } | null;
  freeDeliveryThreshold?: number;
  subtotals?: number[];
  distanceKm?: number;
  paymentMethod?: 'online' | 'cash_on_delivery';
}

/** Redondea a miles: son carritos de ejemplo, no precios. */
const roundThousand = (n: number) => Math.max(0, Math.round(n / 1000) * 1000);

/**
 * Los carritos de ejemplo: el pedido mínimo del comercio y sus múltiplos, más
 * los umbrales que la promoción o el envío gratis ponen en juego, porque el
 * caso interesante siempre está justo en el umbral.
 */
function defaultSubtotals(parts: { minOrder: number; threshold: number; promotionMin: number }): number[] {
  const base = Math.max(parts.minOrder, 15_000);
  const candidates = [base, base * 2, base * 3];
  if (parts.threshold > 0) candidates.push(parts.threshold, Math.max(1000, parts.threshold - 1000));
  if (parts.promotionMin > 0) candidates.push(parts.promotionMin);
  return [...new Set(candidates.map(roundThousand).filter((n) => n > 0))].sort((a, b) => a - b).slice(0, 6);
}

export const promotionPreviewService = {
  async forBusiness(
    ownerId: string,
    businessId: string,
    body: BusinessPreviewBody,
    scope?: SessionScope
  ): Promise<PromotionPreview> {
    // Solo ver: simular no escribe nada, y quien puede ver las promociones
    // puede ver cuánto costarían.
    await businessStaffService.assertCan(
      ownerId,
      businessId,
      BusinessPermission.PROMOTIONS_VIEW,
      'Sin permisos para ver promociones.',
      scope
    );

    const business = await Business.findById(businessId);
    if (!business) throw new AppError('Negocio no encontrado', 404);

    const threshold =
      body.freeDeliveryThreshold ??
      effectiveFreeDeliveryThreshold(business, new Date(), envConfig.settlement.timezone);

    const draft: PromotionDraft | null = body.draft
      ? {
          ...body.draft,
          type: body.draft.type === 'percentage' ? CouponType.PERCENTAGE : CouponType.FIXED,
          scope: CouponScope.PRODUCT,
          // Un comercio solo simula lo que él paga.
          fundedBy: CouponFundedBy.BUSINESS,
        }
      : null;

    return pricingService.previewPromotion({
      businessId,
      draft,
      freeDeliveryThreshold: body.freeDeliveryThreshold,
      subtotals:
        body.subtotals ??
        defaultSubtotals({
          minOrder: business.minOrder || 0,
          threshold,
          promotionMin: body.draft?.minOrderAmount ?? 0,
        }),
      distanceKm: body.distanceKm,
      paymentMethod:
        body.paymentMethod === 'cash_on_delivery' ? PaymentMethod.CASH_ON_DELIVERY : PaymentMethod.ONLINE,
    });
  },

  /**
   * Para el administrador: puede simular una campaña financiada por ZIPP en
   * cualquier comercio. Los permisos los decide la ruta; aquí no hay
   * restricción de pertenencia.
   */
  async forAdmin(body: {
    businessId: string;
    draft: PromotionDraft;
    subtotals?: number[];
    distanceKm?: number;
    paymentMethod?: 'online' | 'cash_on_delivery';
  }): Promise<PromotionPreview> {
    if (!Types.ObjectId.isValid(body.businessId)) throw new AppError('Negocio inválido', 400);
    const business = await Business.findById(body.businessId).select('minOrder');
    if (!business) throw new AppError('Negocio no encontrado', 404);

    return pricingService.previewPromotion({
      businessId: body.businessId,
      draft: body.draft,
      subtotals:
        body.subtotals ??
        defaultSubtotals({
          minOrder: business.minOrder || 0,
          threshold: 0,
          promotionMin: body.draft.minOrderAmount ?? 0,
        }),
      distanceKm: body.distanceKm,
      paymentMethod:
        body.paymentMethod === 'cash_on_delivery' ? PaymentMethod.CASH_ON_DELIVERY : PaymentMethod.ONLINE,
      allowPlatformFunding: true,
    });
  },
};
