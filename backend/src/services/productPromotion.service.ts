import type { ICoupon, IPlatformPricingConfig } from '../models';
import { couponService } from './coupon.service';

export interface EffectiveDiscount {
  discountPrice: number | null;
  discountPercent: number | null;
  /** El id de la promoción automática que produjo este precio, o `null` si vino de `discountPrice` manual. */
  promotionId: string | null;
}

/**
 * El precio de un producto tal y como debe mostrarse ahora mismo — el
 * mismo cálculo puro (`computeDiscount`) con el que `pricing.service.ts`
 * cobra en el checkout, reutilizado aquí para que los listados (menú de un
 * negocio, `/offers`, búsqueda, Inicio) anuncien exactamente el precio que
 * después se cobra.
 *
 * La promoción automática, cuando hay una activa, siempre gana sobre el
 * `discountPrice` manual que el comercio haya dejado puesto — la misma
 * precedencia que aplica `pricing.service.ts::priceItems()` al cobrar
 * (ver la nota en `PricingService.applyAutoPromotions`).
 */
export function resolveEffectiveDiscount(
  product: { price: number; discountPrice?: number | null },
  promotion: ICoupon | undefined,
  cfg: IPlatformPricingConfig
): EffectiveDiscount {
  if (promotion) {
    const applied = couponService.computeDiscount(
      promotion,
      { userId: '', businessId: '', subtotal: product.price, deliveryFee: 0, serviceFee: 0 },
      cfg
    );
    if (applied.productDiscount > 0 && applied.productDiscount < product.price) {
      const discountPrice = Math.max(0, product.price - applied.productDiscount);
      const discountPercent = Math.floor(((product.price - discountPrice) / product.price) * 100);
      return { discountPrice, discountPercent, promotionId: promotion._id.toString() };
    }
  }

  if (
    typeof product.discountPrice === 'number' &&
    product.discountPrice > 0 &&
    product.discountPrice < product.price
  ) {
    const discountPercent = Math.floor(
      ((product.price - product.discountPrice) / product.price) * 100
    );
    return { discountPrice: product.discountPrice, discountPercent, promotionId: null };
  }

  return { discountPrice: null, discountPercent: null, promotionId: null };
}
