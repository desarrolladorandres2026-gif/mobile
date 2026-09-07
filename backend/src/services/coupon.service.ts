import mongoose from 'mongoose';
import { Coupon, ICoupon, CouponRedemption, Order, IPlatformPricingConfig } from '../models';
import { AppError } from '../middlewares';
import { CouponType, CouponFundedBy, CouponScope, OrderStatus } from '../types';
import { applyBps, assertMoney } from '../utils';

export interface CouponContext {
  userId: string;
  businessId: string;
  city?: string;
  /** Products subtotal, before any discount. */
  subtotal: number;
  /** Customer-facing delivery fee, before any discount. */
  deliveryFee: number;
  /** Customer service fee, before any discount. */
  serviceFee: number;
  zoneId?: string | null;
  userRole?: string;
}

export interface AppliedCoupon {
  couponId: string;
  code: string;
  title: string;
  type: CouponType;
  fundedBy: CouponFundedBy;
  scope: CouponScope;
  /** Discount against the products subtotal. */
  productDiscount: number;
  /** Discount against the delivery fee. */
  deliveryDiscount: number;
  /** Discount against the service fee. */
  serviceFeeDiscount: number;
  /** Total across all scopes. */
  totalDiscount: number;
  /** Portion the merchant absorbs (only ever the product scope). */
  merchantFunded: number;
  /** Portion the platform absorbs, booked as promotion expense. */
  platformFunded: number;
  /** Effective floor this coupon requires on contribution margin. */
  minimumContributionMargin: number;
  campaignApproved: boolean;
}

export class CouponService {
  /**
   * Resolves a coupon code and computes its discount for an order context.
   *
   * Read-only: eligibility only. Consumption happens in `redeem` once an
   * order exists, and the contribution-margin check happens in the pricing
   * service, which is the only place that knows the final margin.
   */
  async validate(
    code: string,
    ctx: CouponContext,
    config: IPlatformPricingConfig
  ): Promise<AppliedCoupon> {
    const normalized = code.trim().toUpperCase();
    if (!normalized) throw new AppError('Ingresa un código de cupón', 400);

    const coupon = await Coupon.findOne({ code: normalized });
    if (!coupon) throw new AppError('Cupón inválido', 404);

    if (!coupon.isActive) throw new AppError('Este cupón ya no está disponible', 400);

    const now = new Date();
    if (coupon.validFrom > now) throw new AppError('Este cupón aún no está vigente', 400);
    if (coupon.validUntil < now) throw new AppError('Este cupón ya expiró', 400);

    if (coupon.usageLimit > 0 && coupon.usedCount >= coupon.usageLimit) {
      throw new AppError('Este cupón alcanzó su límite de usos', 400);
    }

    if (coupon.businessId && coupon.businessId.toString() !== ctx.businessId) {
      throw new AppError('Este cupón no aplica para este negocio', 400);
    }

    if (coupon.city && ctx.city && coupon.city !== ctx.city) {
      throw new AppError('Este cupón no aplica en tu ciudad', 400);
    }

    if (ctx.subtotal < coupon.minOrderAmount) {
      throw new AppError(
        `Este cupón requiere un pedido mínimo de $${coupon.minOrderAmount.toLocaleString('es-CO')}`,
        400
      );
    }

    if (coupon.perUserLimit > 0) {
      const used = await CouponRedemption.countDocuments({
        couponId: coupon._id,
        userId: ctx.userId,
      });
      if (used >= coupon.perUserLimit) throw new AppError('Ya usaste este cupón', 400);
    }

    if (coupon.firstOrderOnly) {
      const previousOrders = await Order.countDocuments({
        clientId: ctx.userId,
        status: { $ne: OrderStatus.CANCELLED },
      });
      if (previousOrders > 0) {
        throw new AppError('Este cupón es solo para tu primer pedido', 400);
      }
    }

    if (coupon.eligibleRoles.length && !coupon.eligibleRoles.includes(ctx.userRole || 'client')) {
      throw new AppError('Esta promoción no aplica para tu tipo de cuenta', 400);
    }
    if (coupon.zoneIds.length && (!ctx.zoneId || !coupon.zoneIds.some((id) => id.toString() === ctx.zoneId))) {
      throw new AppError('Esta promoción no aplica para esta zona de entrega', 400);
    }
    const day = now.getDay();
    if (coupon.validDays.length && !coupon.validDays.includes(day)) {
      throw new AppError('Esta promoción no está disponible hoy', 400);
    }
    const clock = now.toLocaleTimeString('en-GB', { hour12: false, timeZone: 'America/Bogota' }).slice(0, 5);
    if (coupon.validFromTime && coupon.validUntilTime && (clock < coupon.validFromTime || clock > coupon.validUntilTime)) {
      throw new AppError('Esta promoción no está disponible en este horario', 400);
    }

    const applied = this.computeDiscount(coupon, ctx, config);

    // Campaign budget is checked against the amount this order would spend,
    // so an exhausted campaign stops costing money immediately rather than
    // at the next reconciliation.
    if (coupon.budgetLimit > 0 && applied.platformFunded > 0) {
      const remaining = coupon.budgetLimit - coupon.budgetSpent;
      if (applied.platformFunded > remaining) {
        throw new AppError('Esta campaña agotó su presupuesto', 400);
      }
    }

    return applied;
  }

  /**
   * Pure calculation, split out so it is trivially unit-testable.
   *
   * The discount is routed to the line named by `scope`, and the funding
   * split follows `fundedBy`. A merchant can only ever fund the product
   * line: the delivery fee belongs to the driver and the platform, so
   * billing a merchant for it would be charging them for someone else's
   * revenue. The model enforces the same rule on write.
   */
  computeDiscount(
    coupon: ICoupon,
    ctx: CouponContext,
    config: IPlatformPricingConfig
  ): AppliedCoupon {
    let productDiscount = 0;
    let deliveryDiscount = 0;
    let serviceFeeDiscount = 0;

    const base =
      coupon.scope === CouponScope.DELIVERY
        ? ctx.deliveryFee
        : coupon.scope === CouponScope.SERVICE_FEE
          ? ctx.serviceFee
          : ctx.subtotal;

    let raw = 0;
    switch (coupon.type) {
      case CouponType.PERCENTAGE:
        raw = applyBps(base, Math.round(coupon.value * 100));
        if (coupon.maxDiscount > 0) raw = Math.min(raw, coupon.maxDiscount);
        break;
      case CouponType.FIXED:
        raw = Math.min(coupon.value, base);
        break;
      case CouponType.FREE_DELIVERY:
        raw = ctx.deliveryFee;
        break;
    }

    // Per-coupon ceiling, then the platform-wide subsidy ceiling. Both are
    // admin-editable; the tighter one wins.
    if (coupon.maxDiscountAmount > 0) raw = Math.min(raw, coupon.maxDiscountAmount);
    if (coupon.fundedBy === CouponFundedBy.PLATFORM && config.couponSubsidyLimit > 0) {
      raw = Math.min(raw, config.couponSubsidyLimit);
    }

    raw = Math.max(0, Math.min(raw, base));

    const effectiveScope =
      coupon.type === CouponType.FREE_DELIVERY ? CouponScope.DELIVERY : coupon.scope;

    if (effectiveScope === CouponScope.DELIVERY) deliveryDiscount = raw;
    else if (effectiveScope === CouponScope.SERVICE_FEE) serviceFeeDiscount = raw;
    else productDiscount = raw;

    const totalDiscount = productDiscount + deliveryDiscount + serviceFeeDiscount;

    // Only the product line can be merchant-funded — enforced here and in
    // the schema, so neither path can produce a merchant-funded delivery
    // discount that would eat into the driver's guaranteed fee.
    const merchantFunded =
      coupon.fundedBy === CouponFundedBy.BUSINESS ? productDiscount : 0;
    const platformFunded = totalDiscount - merchantFunded;

    return {
      couponId: coupon._id.toString(),
      code: coupon.code,
      title: coupon.title,
      type: coupon.type,
      fundedBy: coupon.fundedBy,
      scope: effectiveScope,
      productDiscount,
      deliveryDiscount,
      serviceFeeDiscount,
      totalDiscount,
      merchantFunded,
      platformFunded,
      minimumContributionMargin:
        coupon.minimumContributionMargin >= 0
          ? coupon.minimumContributionMargin
          : config.defaultMinimumContributionMargin,
      campaignApproved: coupon.campaignApproved,
    };
  }

  /**
   * Consumes one use of a coupon for a created order.
   *
   * `usedCount` y `budgetSpent` se mueven juntos bajo una única escritura
   * condicional, así que dos checkouts simultáneos no pueden pasarse del
   * tope de usos ni del presupuesto de la campaña. Devuelve `false` cuando
   * el cupón se agotó por el camino.
   *
   * El tope **por usuario** no se puede resolver igual y por eso lleva su
   * propio mecanismo: no vive en un contador del cupón sino en cuántas
   * filas hay en `CouponRedemption`, y Mongo no sabe condicionar un insert
   * al conteo de otra colección. Se inserta y se comprueba después, con un
   * desempate por `_id`: como los ObjectId son un orden total, sobreviven
   * exactamente los `perUserLimit` primeros — ni cero (rechazar los dos
   * sería fallar de más y dejar al cliente sin ningún pedido) ni uno de
   * más.
   *
   * Sin esto, `validate()` era la única barrera, y `validate()` corre al
   * cotizar: dos peticiones de creación de pedido con el mismo cupón la
   * pasaban las dos antes de que ninguna hubiera canjeado nada. Con una
   * promoción sin tope global —lo normal en una campaña de bienvenida— el
   * descuento se concedía tantas veces como peticiones se lanzaran a la vez.
   */
  async redeem(
    couponId: string,
    userId: string,
    orderId: string,
    discountAmount: number,
    platformFunded: number,
    session?: mongoose.ClientSession
  ): Promise<boolean> {
    assertMoney(discountAmount, 'descuento');
    assertMoney(platformFunded, 'subsidio');

    const coupon = await Coupon.findById(couponId).session(session ?? null);
    if (!coupon) return false;

    const filter: Record<string, unknown> = { _id: couponId };
    if (coupon.usageLimit > 0) filter.usedCount = { $lt: coupon.usageLimit };
    if (coupon.budgetLimit > 0) {
      filter.budgetSpent = { $lte: coupon.budgetLimit - platformFunded };
    }

    const claimed = await Coupon.findOneAndUpdate(
      filter,
      { $inc: { usedCount: 1, budgetSpent: platformFunded } },
      { new: true, session: session ?? null }
    );
    if (!claimed) return false;

    const [redemption] = await CouponRedemption.create(
      [{ couponId, userId, orderId, discountAmount }],
      session ? { session } : {}
    );

    if (coupon.perUserLimit > 0) {
      const previos = await CouponRedemption.countDocuments({
        couponId,
        userId,
        // Solo los que llegaron antes que este, él incluido. Contar todos
        // haría que dos canjes simultáneos vieran ambos "2 > 1" y se
        // deshicieran los dos.
        _id: { $lte: redemption._id },
      }).session(session ?? null);

      if (previos > coupon.perUserLimit) {
        // Perdió el desempate: se deshace lo escrito, en orden inverso.
        await CouponRedemption.deleteOne(
          { _id: redemption._id },
          session ? { session } : {}
        );
        await Coupon.updateOne(
          { _id: couponId },
          { $inc: { usedCount: -1, budgetSpent: -platformFunded } },
          session ? { session } : {}
        );
        return false;
      }
    }

    return true;
  }

  /** Releases a redemption when its order is cancelled or refunded. */
  async release(orderId: string, session?: mongoose.ClientSession): Promise<void> {
    const redemption = await CouponRedemption.findOne({ orderId }).session(session ?? null);
    if (!redemption) return;

    const order = await Order.findById(orderId).session(session ?? null);
    const platformFunded = order?.finance?.platformFundedDiscount ?? 0;

    await Coupon.updateOne(
      { _id: redemption.couponId, usedCount: { $gt: 0 } },
      { $inc: { usedCount: -1, budgetSpent: -platformFunded } },
      session ? { session } : {}
    );
    await CouponRedemption.deleteOne(
      { _id: redemption._id },
      session ? { session } : {}
    );

    // A campaign whose spend was returned must never go negative.
    await Coupon.updateOne(
      { _id: redemption.couponId, budgetSpent: { $lt: 0 } },
      { $set: { budgetSpent: 0 } },
      session ? { session } : {}
    );
  }

  /** Coupons shown in the app's promotions carousel. */
  async getPublic(city?: string, businessId?: string): Promise<ICoupon[]> {
    const now = new Date();
    const filter: Record<string, unknown> = {
      isActive: true,
      isPublic: true,
      validFrom: { $lte: now },
      validUntil: { $gte: now },
    };

    if (city) filter.city = { $in: ['', city] };
    if (businessId) filter.businessId = { $in: [null, businessId] };

    const coupons = await Coupon.find(filter).sort({ createdAt: -1 }).limit(20);

    return coupons.filter(
      (c) =>
        (c.usageLimit === 0 || c.usedCount < c.usageLimit) &&
        (c.budgetLimit === 0 || c.budgetSpent < c.budgetLimit)
    );
  }
}

export const couponService = new CouponService();
