import crypto from 'crypto';
import mongoose from 'mongoose';
import { Coupon, ICoupon, CouponRedemption, Order, Product, IPlatformPricingConfig } from '../models';
import { AppError } from '../middlewares';
import { CouponType, CouponFundedBy, CouponScope, OrderStatus } from '../types';
import { applyBps, assertMoney, couponAvailability } from '../utils';
import type { CouponAvailability } from '../utils';
import { config as envConfig } from '../config';
import { pricingConfigService } from './pricingConfig.service';

/** Techo anti-abuso: evita que un comercio infle su presencia en /offers. */
const MAX_ACTIVE_AUTO_PROMOTIONS_PER_BUSINESS = 20;

/**
 * Lo que un comercio puede fijar al CREAR una promoción. Quién la financia,
 * de qué negocio es, si se aprueba bajo margen, el alcance, a quién va dirigida
 * y los contadores de uso no están aquí a propósito: son de ZIPP.
 */
const BUSINESS_CONFIGURABLE_FIELDS = [
  'title',
  'description',
  'type',
  'value',
  'maxDiscount',
  'maxDiscountAmount',
  'minOrderAmount',
  'budgetLimit',
  'usageLimit',
  'perUserLimit',
  'firstOrderOnly',
  'validFrom',
  'validUntil',
  'isPublic',
  'validDays',
  'validFromTime',
  'validUntilTime',
] as const;

/** Lo que puede cambiar al EDITAR (no el tipo ni el código: eso es otra promoción). */
const BUSINESS_EDITABLE_FIELDS = [
  'title',
  'description',
  'value',
  'maxDiscount',
  'maxDiscountAmount',
  'minOrderAmount',
  'budgetLimit',
  'usageLimit',
  'perUserLimit',
  'firstOrderOnly',
  'validFrom',
  'validUntil',
  'validDays',
  'validFromTime',
  'validUntilTime',
  'isPublic',
  'productIds',
  'isActive',
] as const;

function pickFields<K extends string>(source: Record<string, unknown>, keys: readonly K[]): Partial<Record<K, unknown>> {
  const picked: Partial<Record<K, unknown>> = {};
  for (const key of keys) if (source[key] !== undefined) picked[key] = source[key];
  return picked;
}

/**
 * La franja horaria de una promoción: o las dos horas, o ninguna, y la de
 * apertura antes que la de cierre. Una franja que cruza medianoche
 * (22:00–02:00) no puede evaluarse (ver `couponAvailability`) y quedaría
 * muerta, y con solo una hora el filtro se ignora en silencio y la promoción
 * corre todo el día aunque el comercio creyera acotarla.
 */
export function assertValidTimeWindow(from?: string, until?: string): void {
  const hasFrom = !!from;
  const hasUntil = !!until;
  if (hasFrom !== hasUntil) {
    throw new AppError('Indica la hora de inicio y la de fin de la franja, o ninguna de las dos', 400);
  }
  if (hasFrom && hasUntil && from! >= until!) {
    throw new AppError(
      'La franja horaria no puede cruzar la medianoche: la hora de inicio debe ser anterior a la de fin',
      400
    );
  }
}

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

/** Por qué un cupón no es para ti. */
export type CouponIneligibility = 'already_used' | 'not_first_order' | 'role' | 'not_yours';

export interface CouponEligibility {
  couponId: string;
  usable: boolean;
  reason?: CouponIneligibility;
}

/** La forma en la que un cupón sale de la API hacia un cliente. */
export interface PublicCoupon {
  _id: string;
  code: string;
  title: string;
  description?: string;
  type: CouponType;
  scope: CouponScope;
  value: number;
  maxDiscount: number;
  minOrderAmount: number;
  validUntil: Date;
  businessId: string | null;
  firstOrderOnly: boolean;
  usageLimit: number;
  usedCount: number;
  perUserLimit: number;
  availability: CouponAvailability;
  conditions: {
    minOrderAmount: number;
    zoneRestricted: boolean;
    firstOrderOnly: boolean;
  };
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

    // Un cupón nominal solo lo usa su dueño. Va antes que el resto de
    // comprobaciones porque es la más barata y la que más gente frena.
    if (coupon.restrictedToUserId && coupon.restrictedToUserId.toString() !== ctx.userId) {
      throw new AppError('Este cupón no es tuyo', 403);
    }

    if (coupon.firstOrderOnly && (await this.hasPreviousOrders(ctx.userId))) {
      throw new AppError('Este cupón es solo para tu primer pedido', 400);
    }

    if (coupon.eligibleRoles.length && !coupon.eligibleRoles.includes(ctx.userRole || 'client')) {
      throw new AppError('Esta promoción no aplica para tu tipo de cuenta', 400);
    }
    if (coupon.zoneIds.length && (!ctx.zoneId || !coupon.zoneIds.some((id) => id.toString() === ctx.zoneId))) {
      throw new AppError('Esta promoción no aplica para esta zona de entrega', 400);
    }
    // Día y franja los decide `couponAvailability`, la misma función con la
    // que la pestaña de Descuentos pinta el horario. Cuando cada lado lo
    // resolvía por su cuenta, la pantalla anunciaba a las 3 de la mañana un
    // cupón que el cobro rechazaba; y el día se leía con `getDay()`, en la
    // zona del servidor, así que en UTC el cupón de los viernes se apagaba
    // a las siete de la tarde del viernes.
    const availability = couponAvailability(coupon, now, envConfig.settlement.timezone);
    if (availability.state === 'scheduled') {
      throw new AppError(
        availability.window
          ? `Esta promoción solo aplica de ${availability.window.from} a ${availability.window.to}`
          : 'Esta promoción no está disponible en este momento',
        400
      );
    }
    if (availability.state === 'exhausted') {
      throw new AppError('Este cupón ya no está disponible', 400);
    }

    const applied = this.computeDiscount(coupon, ctx, config);

    // Campaign budget is checked against the amount this order would spend,
    // so an exhausted campaign stops costing money immediately rather than
    // at the next reconciliation. Lo que gasta el presupuesto es lo que
    // pone quien financia la promoción (ver `budgetSpendOf`).
    if (!this.fitsBudget(coupon, this.budgetSpendOf(applied))) {
      throw new AppError('Esta campaña agotó su presupuesto', 400);
    }

    await this.assertWithinGlobalBudget(applied, config);

    return applied;
  }

  /**
   * Si esta persona ya hizo algún pedido que no se canceló.
   *
   * Es la definición de "primer pedido" de ZIPP, y vive en un solo sitio:
   * el cupón de código la usa al validar, la lista de elegibilidad al
   * decidir qué enseñar y la promoción automática al decidir si aplica. Un
   * pedido cancelado no cuenta —el cliente no llegó a recibir nada—; uno en
   * curso o sin pagar sí, porque ya es un pedido.
   */
  async hasPreviousOrders(userId: string): Promise<boolean> {
    const count = await Order.countDocuments({
      clientId: userId,
      status: { $ne: OrderStatus.CANCELLED },
    });
    return count > 0;
  }

  /**
   * Cuánto gasta del presupuesto de la promoción este descuento.
   *
   * `budgetLimit` es "lo que la campaña puede costarle a quien la financia"
   * (ver el modelo): en una promoción de ZIPP es el subsidio de plataforma;
   * en la de un comercio, lo que sale de su liquidación. Cada descuento
   * pertenece a uno de los dos —nunca a los dos—, así que no se cuenta dos
   * veces.
   */
  budgetSpendOf(applied: Pick<AppliedCoupon, 'fundedBy' | 'merchantFunded' | 'platformFunded'>): number {
    return applied.fundedBy === CouponFundedBy.BUSINESS
      ? applied.merchantFunded
      : applied.platformFunded;
  }

  /** Si `spend` cabe en lo que le queda de presupuesto a la promoción. 0 = sin tope. */
  fitsBudget(coupon: Pick<ICoupon, 'budgetLimit' | 'budgetSpent'>, spend: number): boolean {
    if (coupon.budgetLimit <= 0 || spend <= 0) return true;
    return spend <= coupon.budgetLimit - coupon.budgetSpent;
  }

  /**
   * Cuánto lleva gastado la plataforma en promociones, sumando todos los
   * cupones que financia.
   *
   * `budgetSpent` se incrementa en cada canje aunque el cupón no tenga
   * presupuesto propio (ver `redeem`), así que esta suma es el gasto real y
   * no hace falta recorrer los canjes uno a uno.
   */
  private async platformPromotionSpend(): Promise<number> {
    const [row] = await Coupon.aggregate<{ total: number }>([
      { $match: { fundedBy: CouponFundedBy.PLATFORM } },
      { $group: { _id: null, total: { $sum: '$budgetSpent' } } },
    ]);
    return row?.total ?? 0;
  }

  /**
   * El techo global de gasto en promociones.
   *
   * `campaignBudgetTotal` llevaba desde el principio en la configuración de
   * finanzas —modelo, validador y panel— sin que ninguna decisión de precio
   * lo consultara: solo se hacían cumplir los presupuestos de cada cupón.
   * Con veinte campañas de dos millones, el tope real eran cuarenta, no el
   * número que finanzas creía haber puesto.
   *
   * No lo salta ni `campaignApproved`: esa bandera permite bajar del margen
   * mínimo en una campaña concreta, no gastar plata que ya no hay.
   *
   * Solo consulta la base cuando el tope está encendido, que no es el valor
   * de fábrica: con `campaignBudgetTotal` en 0 esta guarda no cuesta nada.
   */
  private async assertWithinGlobalBudget(
    applied: AppliedCoupon,
    config: IPlatformPricingConfig
  ): Promise<void> {
    if (config.campaignBudgetTotal <= 0) return;
    if (applied.platformFunded <= 0) return;

    const spent = await this.platformPromotionSpend();
    if (spent + applied.platformFunded > config.campaignBudgetTotal) {
      throw new AppError('Las promociones se agotaron por ahora', 400);
    }
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
    /**
     * Lo que este canje gasta del presupuesto de la promoción: el subsidio de
     * plataforma si la paga ZIPP, lo que sale de la liquidación del comercio
     * si la paga él (`budgetSpendOf`). Se guarda en el canje para que
     * `release` devuelva exactamente esto.
     */
    budgetSpend: number,
    session?: mongoose.ClientSession
  ): Promise<boolean> {
    assertMoney(discountAmount, 'descuento');
    assertMoney(budgetSpend, 'presupuesto');

    const coupon = await Coupon.findById(couponId).session(session ?? null);
    if (!coupon) return false;

    // Todos los topes se comprueban DENTRO de la escritura, contra los
    // valores que el cupón tenga en ese instante —no contra los que se leyeron
    // arriba—. Así dos checkouts simultáneos no pueden pasarse del tope de
    // usos ni del presupuesto, y un administrador que cambia un límite o apaga
    // la promoción en el medio de un canje queda obedecido: el canje ve el
    // valor nuevo, no una combinación de los dos.
    const claimed = await Coupon.findOneAndUpdate(
      {
        _id: couponId,
        isActive: true,
        $expr: {
          $and: [
            { $or: [{ $lte: ['$usageLimit', 0] }, { $lt: ['$usedCount', '$usageLimit'] }] },
            {
              $or: [
                { $lte: ['$budgetLimit', 0] },
                { $lte: [{ $add: ['$budgetSpent', budgetSpend] }, '$budgetLimit'] },
              ],
            },
          ],
        },
      },
      { $inc: { usedCount: 1, budgetSpent: budgetSpend } },
      { new: true, session: session ?? null }
    );
    if (!claimed) return false;

    const [redemption] = await CouponRedemption.create(
      [{ couponId, userId, orderId, discountAmount, budgetConsumed: budgetSpend }],
      session ? { session } : {}
    );

    // Deshace lo escrito, en orden inverso, cuando el canje pierde un
    // desempate posterior al reclamo.
    const undo = async () => {
      await CouponRedemption.deleteOne({ _id: redemption._id }, session ? { session } : {});
      await Coupon.updateOne(
        { _id: couponId },
        { $inc: { usedCount: -1, budgetSpent: -budgetSpend } },
        session ? { session } : {}
      );
    };

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
        await undo();
        return false;
      }
    }

    // El techo global de campañas de ZIPP suma varios cupones, así que no cabe
    // en la escritura condicional de uno solo: se reclama primero y se
    // comprueba después, igual que el tope por usuario. Si dos canjes
    // simultáneos se pasan juntos, se deshacen los dos: es preferible rechazar
    // de más que gastar de más.
    if (budgetSpend > 0 && coupon.fundedBy === CouponFundedBy.PLATFORM) {
      const pricing = await pricingConfigService.getCurrent();
      if (pricing.campaignBudgetTotal > 0) {
        const spent = await this.platformPromotionSpend();
        if (spent > pricing.campaignBudgetTotal) {
          await undo();
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Releases every redemption of an order when it is cancelled or
   * refunded — el cupón de código, más cualquier promoción automática que
   * haya aplicado. Antes solo podía haber una fila por pedido; ahora puede
   * haber varias, así que se reversa cada una por separado.
   */
  async release(orderId: string, session?: mongoose.ClientSession): Promise<void> {
    const redemptions = await CouponRedemption.find({ orderId }).session(session ?? null);

    for (const redemption of redemptions) {
      // Borrar primero y revertir solo si esta llamada fue la que borró:
      // si cancelar y reembolsar se cruzan, las dos leen las mismas filas
      // y sin esto las dos devolvían el cupo.
      const deleted = await CouponRedemption.deleteOne(
        { _id: redemption._id },
        session ? { session } : {}
      );
      if (deleted.deletedCount !== 1) continue;

      // Se devuelve exactamente lo que ese canje gastó del presupuesto
      // (`budgetConsumed`, que `redeem` guarda), ni más ni menos.
      //
      // `order.finance.platformFundedDiscount` es el subsidio TOTAL del
      // pedido — incluye lo que puso Zipp Pro, que no tiene nada que ver con
      // este cupón. Devolver eso al presupuesto del cupón inflaba
      // `couponService.budgetSpent` con dinero que Pro había gastado, no él.
      //
      // Los canjes anteriores a `budgetConsumed` no lo traen: para ellos
      // vale la regla con la que se gastaron —el descuento si lo financiaba
      // ZIPP, cero si lo financiaba el comercio, que entonces no tocaba el
      // presupuesto—.
      const coupon = await Coupon.findById(redemption.couponId).session(session ?? null);
      const budgetConsumed =
        typeof redemption.budgetConsumed === 'number'
          ? redemption.budgetConsumed
          : coupon?.fundedBy === CouponFundedBy.PLATFORM
            ? redemption.discountAmount
            : 0;

      await Coupon.updateOne(
        { _id: redemption.couponId, usedCount: { $gt: 0 } },
        { $inc: { usedCount: -1, budgetSpent: -budgetConsumed } },
        session ? { session } : {}
      );
      // A campaign whose spend was returned must never go negative.
      await Coupon.updateOne(
        { _id: redemption.couponId, budgetSpent: { $lt: 0 } },
        { $set: { budgetSpent: 0 } },
        session ? { session } : {}
      );
    }
  }

  /** Coupons shown in the app's promotions carousel. */
  // ── Promociones que crea el propio comercio ──

  /**
   * Crea una promoción a nombre de un negocio.
   *
   * Tres campos NO se leen de la petición aunque vengan: quién financia,
   * de qué negocio es, y si tiene permiso para saltarse el margen mínimo.
   * Son justo los tres con los que un comercio podría hacer que ZIPP pague
   * su promoción, y confiar en el cuerpo de la petición para eso sería
   * dejar la caja abierta.
   */
  async createForBusiness(
    ownerId: string,
    businessId: string,
    input: Record<string, unknown>,
    scope?: import('./businessStaff.service').SessionScope
  ): Promise<ICoupon> {
    const { Business, BusinessPermission } = await import('../models');
    const { businessStaffService } = await import('./businessStaff.service');
    const business = await Business.findById(businessId).select('city');

    if (!business) throw new AppError('Negocio no encontrado', 404);
    await businessStaffService.assertCan(ownerId, businessId, BusinessPermission.PROMOTIONS_MANAGE, 'Sin permisos para gestionar promociones.', scope);

    const autoApply = input.autoApply === true;

    let code: string;
    if (autoApply) {
      // Sin código visible: uno sintético, único, que el panel nunca
      // muestra — solo satisface la restricción de unicidad del campo.
      code = `AUTO-${business._id.toString().slice(-6)}-${crypto.randomBytes(5).toString('hex')}`.toUpperCase();
    } else {
      code = String(input.code).toUpperCase();
      const existing = await Coupon.findOne({ code });
      if (existing) throw new AppError('Ya existe un cupón con ese código', 409);
    }

    let productIds: string[] = [];
    if (autoApply) {
      productIds = Array.isArray(input.productIds) ? (input.productIds as string[]) : [];
      await this.assertProductsBelongToBusiness(businessId, productIds);
      const from = new Date((input.validFrom as string | Date | undefined) ?? Date.now());
      const until = new Date(input.validUntil as string | Date);
      if (until <= from) throw new AppError('La fecha de fin debe ser posterior a la de inicio', 400);
      // Sin horizonte, una promoción eterna bloquearía para siempre el
      // solapamiento de esos productos.
      if (until.getTime() - from.getTime() > 366 * 24 * 3600_000) {
        throw new AppError('Una promoción automática dura como máximo un año', 400);
      }
      await this.assertNoAutoPromotionOverlap(businessId, productIds, from, until);
      await this.assertBelowActivePromotionCap(businessId);
    }

    // Lista blanca, no `...input`: del cuerpo solo pasa lo que un comercio puede
    // configurar. Antes se esparcía el cuerpo entero y la única defensa era que
    // el validador descartara lo demás; un campo nuevo en el modelo
    // (`restrictedToUserId`, `eligibleRoles`, `zoneIds`, `usedCount`…) habría
    // quedado abierto sin que nadie lo notara.
    const configurable = pickFields(input, BUSINESS_CONFIGURABLE_FIELDS);
    assertValidTimeWindow(configurable.validFromTime as string | undefined, configurable.validUntilTime as string | undefined);

    return Coupon.create({
      ...configurable,
      code,
      productIds,
      autoApply,

      // Siempre sobre productos: ni el domicilio ni la tarifa de servicio son
      // plata del comercio (el modelo también lo exige).
      scope: CouponScope.PRODUCT,
      // «Primer pedido» solo tiene sentido si el cupo por persona es uno: con
      // más, dos pedidos simultáneos de quien estrena pasarían los dos.
      ...(configurable.firstOrderOnly === true ? { perUserLimit: 1 } : {}),

      // Forzados, no leídos.
      fundedBy: CouponFundedBy.BUSINESS,
      businessId: business._id,
      campaignApproved: false,
      city: business.city,
    });
  }

  /**
   * `productIds` restringidos al propio negocio, verificado por conteo
   * exacto — no basta con que existan, tienen que ser todos suyos. Sin
   * esto, un comercio podría descontar el producto de un competidor y
   * confundir al cliente sobre a quién le está comprando barato.
   */
  private async assertProductsBelongToBusiness(businessId: string, productIds: string[]): Promise<void> {
    if (productIds.length === 0) return; // El modelo rechaza la lista vacía al validar.
    const owned = await Product.countDocuments({ _id: { $in: productIds }, businessId });
    if (owned !== productIds.length) {
      throw new AppError('Uno o más productos no pertenecen a este negocio', 403);
    }
  }

  /**
   * Dos promociones automáticas nunca pueden cubrir el mismo producto al
   * mismo tiempo: si se permitiera, ¿cuál de los dos precios se le muestra
   * al cliente? Se corta en la escritura, nunca se arbitra en la lectura.
   */
  private async assertNoAutoPromotionOverlap(
    businessId: string,
    productIds: string[],
    validFrom: Date,
    validUntil: Date,
    excludeCouponId?: string
  ): Promise<void> {
    if (productIds.length === 0) return;
    const filter: Record<string, unknown> = {
      businessId,
      autoApply: true,
      isActive: true,
      productIds: { $in: productIds },
      validFrom: { $lte: validUntil },
      validUntil: { $gte: validFrom },
    };
    if (excludeCouponId) filter._id = { $ne: excludeCouponId };

    const conflict = await Coupon.findOne(filter).select('title productIds validUntil');
    if (conflict) {
      throw new AppError(
        `Uno de estos productos ya está en la promoción "${conflict.title}" hasta ${conflict.validUntil.toLocaleDateString('es-CO')}`,
        409
      );
    }
  }

  /** Evita que un comercio infle su presencia en /offers con cientos de promociones. */
  private async assertBelowActivePromotionCap(businessId: string): Promise<void> {
    const active = await Coupon.countDocuments({ businessId, autoApply: true, isActive: true });
    if (active >= MAX_ACTIVE_AUTO_PROMOTIONS_PER_BUSINESS) {
      throw new AppError(
        `Ya tienes ${MAX_ACTIVE_AUTO_PROMOTIONS_PER_BUSINESS} promociones automáticas activas, el máximo permitido`,
        409
      );
    }
  }

  /**
   * Las promociones de un negocio, para su propio panel.
   *
   * `availability` va resuelto aquí, no en el frontend: el panel no debe
   * reimplementar en JS qué significa "programada" o "agotada" — la misma
   * pregunta que ya responde `couponAvailability()` para el cobro.
   */
  async listForBusiness(
    ownerId: string,
    businessId: string,
    scope?: import('./businessStaff.service').SessionScope
  ): Promise<Array<Record<string, unknown> & { availability: CouponAvailability }>> {
    const { Business, BusinessPermission } = await import('../models');
    const { businessStaffService } = await import('./businessStaff.service');
    const business = await Business.findById(businessId).select('_id');

    if (!business) throw new AppError('Negocio no encontrado', 404);
    await businessStaffService.assertCan(ownerId, businessId, BusinessPermission.PROMOTIONS_VIEW, 'Sin permisos para ver promociones.', scope);

    const coupons = await Coupon.find({ businessId, fundedBy: CouponFundedBy.BUSINESS }).sort({
      createdAt: -1,
    });
    const now = new Date();
    return coupons.map((coupon) => ({
      ...coupon.toObject(),
      availability: couponAvailability(coupon, now, envConfig.settlement.timezone),
    }));
  }

  /** Carga una promoción propia verificando dueño, o lanza. Común a editar/desactivar/reactivar/eliminar. */
  private async loadOwnedBusinessCoupon(ownerId: string, couponId: string, scope?: import('./businessStaff.service').SessionScope): Promise<ICoupon> {
    const coupon = await Coupon.findById(couponId);
    if (!coupon || coupon.fundedBy !== CouponFundedBy.BUSINESS || !coupon.businessId) {
      throw new AppError('Promoción no encontrada', 404);
    }

    const { BusinessPermission } = await import('../models');
    const { businessStaffService } = await import('./businessStaff.service');
    await businessStaffService.assertCan(
      ownerId,
      coupon.businessId.toString(),
      BusinessPermission.PROMOTIONS_MANAGE,
      'Sin permisos para gestionar promociones.',
      scope
    );

    return coupon;
  }

  /**
   * Apaga una promoción del comercio.
   *
   * Se desactiva en vez de borrarse: un cupón ya usado tiene canjes
   * apuntando a él, y borrarlo dejaría esas liquidaciones señalando a un
   * documento que no existe.
   */
  async deactivateForBusiness(ownerId: string, couponId: string, scope?: import('./businessStaff.service').SessionScope): Promise<ICoupon> {
    const coupon = await this.loadOwnedBusinessCoupon(ownerId, couponId, scope);
    coupon.isActive = false;
    await coupon.save();
    return coupon;
  }

  /**
   * Reactiva una promoción apagada. No revive sola una que ya venció: la
   * vigencia se evalúa en cada lectura, así que si `validUntil` ya pasó,
   * `couponAvailability()` la seguirá mostrando agotada hasta que también
   * se edite la fecha.
   */
  async reactivateForBusiness(ownerId: string, couponId: string, scope?: import('./businessStaff.service').SessionScope): Promise<ICoupon> {
    const coupon = await this.loadOwnedBusinessCoupon(ownerId, couponId, scope);
    await this.assertMayBeActive(coupon);
    coupon.isActive = true;
    await coupon.save();
    return coupon;
  }

  /**
   * Volver a encender una promoción automática pasa por las mismas
   * guardas que crearla: si no, desactivar la A, crear la B sobre los
   * mismos productos y reactivar la A dejaba dos activas a la vez (y
   * promociones ilimitadas en /offers).
   */
  private async assertMayBeActive(coupon: ICoupon): Promise<void> {
    if (!coupon.autoApply || coupon.isActive) return;
    const businessId = coupon.businessId!.toString();
    await this.assertNoAutoPromotionOverlap(
      businessId,
      coupon.productIds.map((id) => id.toString()),
      coupon.validFrom,
      coupon.validUntil,
      coupon._id.toString()
    );
    await this.assertBelowActivePromotionCap(businessId);
  }

  /**
   * Edita una promoción propia.
   *
   * Whitelist explícita, no negra: `fundedBy`, `businessId`, `campaignApproved`,
   * `code` y `autoApply` nunca se leen aquí, igual que en la creación — son
   * los campos con los que un comercio podría cambiarse a sí mismo quién
   * financia su promoción.
   */
  async updateForBusiness(
    ownerId: string,
    couponId: string,
    input: Record<string, unknown>,
    scope?: import('./businessStaff.service').SessionScope,
    /**
     * Recibe, ya aplicado el cambio, qué campos cambiaron con su valor
     * anterior y el nuevo. Lo usa el controlador para dejar la auditoría de
     * una modificación financiera con el antes y el después.
     */
    onChanged?: (changes: Record<string, { before: unknown; after: unknown }>) => void
  ): Promise<ICoupon> {
    const coupon = await this.loadOwnedBusinessCoupon(ownerId, couponId, scope);

    const editable = BUSINESS_EDITABLE_FIELDS;

    if (
      typeof input.budgetLimit === 'number' &&
      input.budgetLimit > 0 &&
      input.budgetLimit < coupon.budgetSpent
    ) {
      throw new AppError('El presupuesto no puede quedar por debajo de lo ya gastado', 409);
    }

    const wasActive = coupon.isActive;
    const changes: Record<string, { before: unknown; after: unknown }> = {};
    for (const field of editable) {
      if (input[field] === undefined) continue;
      const before = (coupon as any)[field];
      if (JSON.stringify(before) === JSON.stringify(input[field])) continue;
      changes[field] = { before, after: input[field] };
      (coupon as any)[field] = input[field];
    }

    // Una promoción de primer pedido solo admite un uso por persona.
    if (coupon.firstOrderOnly && coupon.perUserLimit !== 1) {
      if (input.perUserLimit !== undefined && input.perUserLimit !== 1) {
        throw new AppError('Una promoción de primer pedido solo puede usarse una vez por persona', 400);
      }
      if (coupon.perUserLimit !== 1) changes.perUserLimit = { before: coupon.perUserLimit, after: 1 };
      coupon.perUserLimit = 1;
    }
    assertValidTimeWindow(coupon.validFromTime, coupon.validUntilTime);

    if (coupon.validUntil <= coupon.validFrom) {
      throw new AppError('La fecha de fin debe ser posterior a la de inicio', 400);
    }
    if (coupon.autoApply && coupon.isActive && !wasActive) {
      coupon.isActive = false; // que assertMayBeActive vea el estado previo
      await this.assertMayBeActive(coupon);
      coupon.isActive = true;
    }

    if (coupon.autoApply) {
      const productIds = coupon.productIds.map((id) => id.toString());
      await this.assertProductsBelongToBusiness(coupon.businessId!.toString(), productIds);
      await this.assertNoAutoPromotionOverlap(
        coupon.businessId!.toString(),
        productIds,
        coupon.validFrom,
        coupon.validUntil,
        couponId
      );
    }

    await coupon.save();
    if (Object.keys(changes).length > 0) onChanged?.(changes);
    return coupon;
  }

  /**
   * Elimina de verdad una promoción, solo si nunca tuvo canjes. Con
   * canjes, `CouponRedemption` quedaría apuntando a un documento inexistente
   * y las liquidaciones que ya se hicieron con él perderían su rastro — se
   * ofrece desactivar en su lugar.
   */
  async deleteForBusiness(ownerId: string, couponId: string, scope?: import('./businessStaff.service').SessionScope): Promise<void> {
    const coupon = await this.loadOwnedBusinessCoupon(ownerId, couponId, scope);
    if (coupon.usedCount > 0) {
      throw new AppError('No puedes eliminar una promoción que ya tuvo pedidos; desactívala', 409);
    }
    await Coupon.deleteOne({ _id: coupon._id });
  }

  /**
   * Si esta persona todavía puede beneficiarse de la promoción automática.
   *
   * `computeDiscount` no mira límites; `redeem` sí, y tumba el pedido con
   * 409. Cotizar una promoción que luego no se puede canjear dejaba al
   * cliente sin poder pedir nunca: se filtra aquí, antes de cotizarla.
   */
  async autoPromotionUsableBy(coupon: ICoupon, userId: string, subtotal: number): Promise<boolean> {
    if (subtotal < coupon.minOrderAmount) return false;
    if (coupon.perUserLimit > 0) {
      const used = await CouponRedemption.countDocuments({ couponId: coupon._id, userId });
      if (used >= coupon.perUserLimit) return false;
    }
    // La misma definición de "primer pedido" que el cupón de código: una
    // promoción que el comercio anunció solo para quien estrena la app no se
    // le da a quien ya pidió, aunque se aplique sola.
    if (coupon.firstOrderOnly && (await this.hasPreviousOrders(userId))) return false;
    return true;
  }

  /**
   * Las promociones automáticas activas de un negocio ahora mismo, una por
   * producto — el chequeo de solapamiento en escritura garantiza que nunca
   * hay dos cubriendo el mismo producto. Una sola consulta, sin importar
   * cuántos productos traiga el carrito: la llama `pricing.service` una vez
   * por cotización, no una vez por línea.
   */
  async autoPromotionsFor(
    businessId: string,
    now = new Date(),
    /**
     * Solo la cotización necesita las promociones que dependen de quién
     * pide (`firstOrderOnly`). La carta, el inicio y las ofertas se sirven
     * desde caché compartida y enseñan el mismo precio a todos: pintar ahí un
     * descuento «solo para tu primer pedido» se lo mostraría también a quien
     * ya pidió, y luego el checkout no se lo daría.
     */
    options: { includePersonal?: boolean } = {}
  ): Promise<Map<string, ICoupon>> {
    const coupons = await Coupon.find({
      businessId,
      autoApply: true,
      isActive: true,
      fundedBy: CouponFundedBy.BUSINESS,
      ...(options.includePersonal ? {} : { firstOrderOnly: { $ne: true } }),
    });

    const byProduct = new Map<string, ICoupon>();
    for (const coupon of coupons) {
      if (couponAvailability(coupon, now, envConfig.settlement.timezone).state !== 'active') continue;
      for (const productId of coupon.productIds) {
        byProduct.set(productId.toString(), coupon);
      }
    }
    return byProduct;
  }

  /**
   * Lo mismo que `autoPromotionsFor`, pero entre todos los negocios: la
   * usan `/offers`, la búsqueda y las colecciones de Inicio, que no saben de
   * antemano en qué negocio está cada producto. Se apoya en el índice
   * parcial `{autoApply, isActive, validFrom, validUntil}`, así que no
   * escanea los cupones de código, que son la inmensa mayoría.
   */
  async activeAutoPromotionsAcrossBusinesses(now = new Date()): Promise<Map<string, ICoupon>> {
    const coupons = await Coupon.find({
      autoApply: true,
      isActive: true,
      fundedBy: CouponFundedBy.BUSINESS,
      // Ver `autoPromotionsFor`: es para pintar precios compartidos, y una
      // promoción de primer pedido depende de quién mira.
      firstOrderOnly: { $ne: true },
      validFrom: { $lte: now },
      validUntil: { $gte: now },
    });

    const byProduct = new Map<string, ICoupon>();
    for (const coupon of coupons) {
      if (couponAvailability(coupon, now, envConfig.settlement.timezone).state !== 'active') continue;
      for (const productId of coupon.productIds) {
        byProduct.set(productId.toString(), coupon);
      }
    }
    return byProduct;
  }

  /**
   * Los cupones que son de un cliente y de nadie más, todavía usables.
   *
   * Son privados (`isPublic:
   * false`), así que `getPublic` no los devuelve nunca: sin esto, el código
   * solo se veía una vez, en el aviso del canje, y un canje abandonado a
   * medio checkout eran puntos que el cliente ya no podía encontrar aunque el
   * cupón siguiera vivo un mes.
   */
  async getForUser(userId: string): Promise<ICoupon[]> {
    const now = new Date();
    const coupons = await Coupon.find({
      restrictedToUserId: userId,
      isActive: true,
      validFrom: { $lte: now },
      validUntil: { $gte: now },
    })
      .sort({ validUntil: 1 })
      .limit(20);

    return coupons.filter((c) => c.usageLimit === 0 || c.usedCount < c.usageLimit);
  }

  /**
   * Todos los cupones que esta persona podría llegar a usar en este negocio.
   *
   * Los públicos que aplican aquí, más los suyos propios —los de canjear
   * puntos, que no salen en ninguna lista pública—. Es la materia prima del
   * sugeridor del checkout: sin los nominales, alguien con un canje de
   * $5.000 sin estrenar pagaría el pedido entero porque nadie se lo
   * recordó.
   *
   * Se deduplica por id: un cupón nominal tiene `isPublic: false`, pero
   * confiar en eso aquí sería atarse a cómo se crean hoy.
   */
  async candidatesFor(userId: string, city?: string, businessId?: string): Promise<ICoupon[]> {
    const [publicOnes, ownOnes] = await Promise.all([
      this.getPublic(city, businessId),
      this.getForUser(userId),
    ]);

    const byId = new Map<string, ICoupon>();
    for (const coupon of [...publicOnes, ...ownOnes]) {
      byId.set(coupon._id.toString(), coupon);
    }
    return [...byId.values()];
  }

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

    // Se van los agotados y se quedan los que todavía no abrieron. Un cupón
    // de 11 a 13 h antes desaparecía de la lista el resto del día —o peor,
    // aparecía sin decir su horario y fallaba al pagar—; ahora se anuncia
    // con la hora a la que vuelve, que es justo lo que lo hace apetecible.
    return coupons.filter(
      (c) => couponAvailability(c, now, envConfig.settlement.timezone).state !== 'exhausted'
    );
  }

  /**
   * El techo con el que `computeDiscount` corta este cupón: el menor de los
   * topes que apliquen, o 0 si ninguno. Espeja sus tres cortes —`maxDiscount`
   * (solo porcentajes), `maxDiscountAmount` y `couponSubsidyLimit` (solo si
   * paga la plataforma)—; si cambia uno, cambia el otro.
   */
  private effectiveCeiling(coupon: ICoupon, config: IPlatformPricingConfig): number {
    const caps: number[] = [];
    if (coupon.type === CouponType.PERCENTAGE) caps.push(coupon.maxDiscount);
    caps.push(coupon.maxDiscountAmount);
    if (coupon.fundedBy === CouponFundedBy.PLATFORM) caps.push(config.couponSubsidyLimit);

    const active = caps.filter((cap) => cap > 0);
    return active.length ? Math.min(...active) : 0;
  }

  /**
   * Un cupón tal y como puede verlo un cliente.
   *
   * La lista es blanca, no negra: lo que no esté aquí no sale. `/offers`
   * reenviaba el documento de Mongo tal cual mientras `/coupons/public` sí
   * filtraba, así que la misma entidad se exponía con dos criterios
   * distintos y por el flojo se escapaban `budgetSpent`,
   * `minimumContributionMargin` y `fundedBy`: cuánto subsidia Zipp cada
   * campaña y con qué margen. Ahora las dos rutas pasan por aquí.
   *
   * `usedCount` y `usageLimit` sí salen: son el cupo, y esa escasez es del
   * cliente —"queda el 20%"— no de la contabilidad.
   *
   * `maxDiscount` sale ya resuelto: el techo real con el que cobra
   * `computeDiscount`, no el campo crudo del documento. Los cupones
   * sembrados llevan `maxDiscount: 0` y aun así el cobro corta en
   * `couponSubsidyLimit`, de modo que la app anunciaba "20%" sin techo y el
   * cliente pagaba menos de lo prometido. Sin exponer `fundedBy` ni el límite
   * de subsidio sueltos: solo llega el número que ya los combina.
   */
  publicView(coupon: ICoupon, config: IPlatformPricingConfig, now = new Date()): PublicCoupon {
    return {
      _id: coupon._id.toString(),
      code: coupon.code,
      title: coupon.title,
      description: coupon.description,
      type: coupon.type,
      scope: coupon.scope,
      value: coupon.value,
      maxDiscount: this.effectiveCeiling(coupon, config),
      minOrderAmount: coupon.minOrderAmount,
      validUntil: coupon.validUntil,
      businessId: coupon.businessId ? coupon.businessId.toString() : null,
      firstOrderOnly: coupon.firstOrderOnly,
      usageLimit: coupon.usageLimit,
      usedCount: coupon.usedCount,
      perUserLimit: coupon.perUserLimit,
      availability: couponAvailability(coupon, now, envConfig.settlement.timezone),
      conditions: {
        minOrderAmount: coupon.minOrderAmount,
        zoneRestricted: coupon.zoneIds.length > 0,
        firstOrderOnly: coupon.firstOrderOnly,
      },
    };
  }

  /**
   * Cuáles de los cupones públicos puede usar esta persona.
   *
   * Vive aparte de `getPublic()` porque `/offers` se sirve desde una caché
   * compartida de 60 s: mezclar ahí algo que depende de quién pregunta
   * significaría servirle a alguien la respuesta de otro. La app pide las
   * dos cosas y las junta.
   *
   * No devuelve ni un peso. `/coupons/validate` se desactivó justo por
   * aceptar cifras del teléfono, y la cantidad sigue saliendo solo de
   * `/orders/quote`, que carga productos, zona y envío de la base.
   */
  async eligibility(userId: string, userRole = 'client', city?: string): Promise<CouponEligibility[]> {
    const coupons = await this.getPublic(city);
    if (!coupons.length) return [];

    // Dos consultas para toda la lista, no dos por cupón: cuántas veces ha
    // canjeado cada uno, y si ya ha pedido alguna vez.
    const [redemptions, previousOrders] = await Promise.all([
      CouponRedemption.aggregate<{ _id: mongoose.Types.ObjectId; count: number }>([
        {
          $match: {
            userId: new mongoose.Types.ObjectId(userId),
            couponId: { $in: coupons.map((c) => c._id) },
          },
        },
        { $group: { _id: '$couponId', count: { $sum: 1 } } },
      ]),
      Order.countDocuments({ clientId: userId, status: { $ne: OrderStatus.CANCELLED } }),
    ]);

    const used = new Map(redemptions.map((r) => [r._id.toString(), r.count]));

    return coupons.map((coupon) => {
      const id = coupon._id.toString();

      if (coupon.restrictedToUserId && coupon.restrictedToUserId.toString() !== userId) {
        return { couponId: id, usable: false, reason: 'not_yours' as const };
      }
      if (coupon.eligibleRoles.length && !coupon.eligibleRoles.includes(userRole)) {
        return { couponId: id, usable: false, reason: 'role' as const };
      }
      if (coupon.perUserLimit > 0 && (used.get(id) ?? 0) >= coupon.perUserLimit) {
        return { couponId: id, usable: false, reason: 'already_used' as const };
      }
      if (coupon.firstOrderOnly && previousOrders > 0) {
        return { couponId: id, usable: false, reason: 'not_first_order' as const };
      }

      return { couponId: id, usable: true };
    });
  }
}

export const couponService = new CouponService();
