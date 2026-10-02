import { Types } from 'mongoose';
import { User, ProSubscription, ProSubscriptionStatus, isProActive, Payment, Order, type IProSubscription } from '../models';
import { FraudAlert, FraudAlertType } from '../security';
import { PRO_PLAN } from '../config/pro';
import { OrderStatus, PaymentStatus, PaymentType } from '../types';
import { pricingConfigService } from './pricingConfig.service';
import { estimateGatewayFee } from '../utils/gatewayFee';

/**
 * Lecturas de Crecimiento para el panel: referidos y Zipp Pro.
 *
 * Solo lectura. Aquí no se decide nada de dinero: lo que el panel enseña es
 * lo que los servicios de invitaciones y de membresía ya registraron.
 */

/** "Ana Pérez Gómez" → "Ana P.". El panel de crecimiento no necesita el apellido entero. */
function shortName(name: string | undefined | null): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'Sin nombre';
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[1].charAt(0).toUpperCase()}.`;
}

export type ReferralStatus = 'pending' | 'converted' | 'blocked';

export class AdminGrowthService {
  /**
   * Invitaciones: quién trajo a quién y en qué quedó.
   *
   * `referralRewardedAt` se marca tanto cuando la invitación se cumplió como
   * cuando se bloqueó por abuso (así no se reevalúa), de modo que solo la
   * alerta `PROMOTION_ABUSE` distingue una de otra.
   */
  async referrals(params: { status?: ReferralStatus; limit?: number }) {
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 100);

    const blockedAlerts = await FraudAlert.find({
      type: FraudAlertType.PROMOTION_ABUSE,
      description: /^Invitación no premiada/,
    })
      .select('userId description evidence createdAt')
      .sort({ createdAt: -1 })
      .limit(500)
      .lean();

    const blockedIds = blockedAlerts
      .map((a) => a.evidence?.inviteeId)
      .filter((id): id is string => typeof id === 'string' && Types.ObjectId.isValid(id))
      .map((id) => new Types.ObjectId(id));
    const reasonByInvitee = new Map<string, string>(
      blockedAlerts.map((a) => [String(a.evidence?.inviteeId), String(a.evidence?.reason ?? '')])
    );

    const base = { referredBy: { $ne: null } };
    const [invited, converted] = await Promise.all([
      User.countDocuments(base),
      User.countDocuments({ ...base, referralRewardedAt: { $ne: null } }),
    ]);
    const blocked = blockedIds.length
      ? await User.countDocuments({ ...base, _id: { $in: blockedIds } })
      : 0;

    const filter: Record<string, unknown> = { ...base };
    if (params.status === 'pending') filter.referralRewardedAt = null;
    else if (params.status === 'blocked') filter._id = { $in: blockedIds };
    else if (params.status === 'converted') {
      filter.referralRewardedAt = { $ne: null };
      filter._id = { $nin: blockedIds };
    }

    const [rows, top] = await Promise.all([
      User.find(filter)
        .sort({ createdAt: -1 })
        .limit(limit)
        .select('name referredBy referralRewardedAt createdAt')
        .lean(),
      User.aggregate([
        { $match: base },
        {
          $group: {
            _id: '$referredBy',
            invited: { $sum: 1 },
            converted: { $sum: { $cond: [{ $ne: ['$referralRewardedAt', null] }, 1, 0] } },
          },
        },
        { $sort: { invited: -1 } },
        { $limit: 10 },
      ]),
    ]);

    const referrerIds = [
      ...new Set([...rows.map((r) => String(r.referredBy)), ...top.map((t) => String(t._id))]),
    ];
    const referrers = await User.find({ _id: { $in: referrerIds } })
      .select('name')
      .lean();
    const nameOf = new Map(referrers.map((u) => [String(u._id), shortName(u.name)]));

    const blockedSet = new Set(blockedIds.map(String));

    return {
      summary: {
        invited,
        converted: Math.max(converted - blocked, 0),
        blocked,
        pending: Math.max(invited - converted, 0),
      },
      // Quien invita a mucha gente merece una mirada aunque no haya alerta.
      topReferrers: top.map((t) => ({
        referrerId: String(t._id),
        name: nameOf.get(String(t._id)) ?? 'Sin nombre',
        invited: t.invited as number,
        converted: t.converted as number,
      })),
      invitations: rows.map((r) => {
        const id = String(r._id);
        const status: ReferralStatus = blockedSet.has(id)
          ? 'blocked'
          : r.referralRewardedAt
            ? 'converted'
            : 'pending';
        return {
          inviteeId: id,
          invitee: shortName(r.name),
          referrerId: String(r.referredBy),
          referrer: nameOf.get(String(r.referredBy)) ?? 'Sin nombre',
          status,
          reason: status === 'blocked' ? reasonByInvitee.get(id) || null : null,
          joinedAt: r.createdAt,
          resolvedAt: r.referralRewardedAt ?? null,
        };
      }),
    };
  }

  /**
   * Los últimos 30 días de Pro en dinero: lo cobrado, la comisión estimada
   * de Wompi sobre esos cobros y lo que costaron los beneficios en pedidos
   * entregados. Sin las tres cifras "ingreso recurrente" se ve bien y no
   * dice si el plan deja margen.
   *
   * `complete` es falso mientras haya pedidos de la ventana sin el desglose
   * de Pro (anteriores a guardarlo) o la tarifa de Wompi siga en 0: en ese
   * caso el margen sale inflado y el panel lo dice.
   */
  private async proMoney30d(now: Date) {
    const since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const [payments, benefits, cfg] = await Promise.all([
      Payment.find({
        type: PaymentType.PRO_SUBSCRIPTION,
        status: PaymentStatus.PAID,
        $or: [
          { processedAt: { $gte: since } },
          { processedAt: null, createdAt: { $gte: since } },
        ],
      })
        .select('amount paymentMethodType')
        .limit(20_000)
        .lean(),
      Order.aggregate([
        { $match: { status: OrderStatus.DELIVERED, deliveredAt: { $gte: since } } },
        {
          $group: {
            _id: null,
            delivery: { $sum: { $ifNull: ['$finance.proDeliveryDiscount', 0] } },
            serviceFee: { $sum: { $ifNull: ['$finance.proServiceFeeDiscount', 0] } },
            ordersWithBenefit: {
              $sum: {
                $cond: [
                  { $gt: [{ $add: [{ $ifNull: ['$finance.proDeliveryDiscount', 0] }, { $ifNull: ['$finance.proServiceFeeDiscount', 0] }] }, 0] },
                  1,
                  0,
                ],
              },
            },
            // Pedidos sin el campo: anteriores a que se guardara el desglose.
            ordersWithoutData: {
              $sum: { $cond: [{ $eq: [{ $type: '$finance.proDeliveryDiscount' }, 'missing'] }, 1, 0] },
            },
          },
        },
      ]),
      pricingConfigService.getCurrent(),
    ]);

    const collected = payments.reduce((s, p) => s + p.amount, 0);
    const gatewayFee = payments.reduce((s, p) => s + estimateGatewayFee(cfg, p.paymentMethodType, p.amount), 0);
    const b = benefits[0] ?? { delivery: 0, serviceFee: 0, ordersWithBenefit: 0, ordersWithoutData: 0 };
    const benefitsCost = b.delivery + b.serviceFee;
    const gatewayFeeConfigured = estimateGatewayFee(cfg, 'CARD', 100_000) > 0;

    return {
      since,
      collected,
      payments: payments.length,
      gatewayFee,
      gatewayFeeConfigured,
      benefitsCost: { delivery: b.delivery, serviceFee: b.serviceFee, total: benefitsCost, orders: b.ordersWithBenefit },
      ordersWithoutData: b.ordersWithoutData,
      margin: collected - gatewayFee - benefitsCost,
      complete: b.ordersWithoutData === 0 && gatewayFeeConfigured,
    };
  }

  /**
   * Zipp Pro visto desde el negocio: cuánta gente, cuánto entra, cuánto
   * cuestan sus beneficios y quién falla al renovar.
   */
  async proOverview() {
    const now = new Date();
    const activeFilter = {
      status: { $in: [ProSubscriptionStatus.ACTIVE, ProSubscriptionStatus.CANCELLED] },
      currentPeriodEnd: { $gt: now },
    };

    const [byStatus, active, renewing, atRisk, recent, last30Days] = await Promise.all([
      ProSubscription.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
      ProSubscription.countDocuments(activeFilter),
      ProSubscription.aggregate([
        { $match: { ...activeFilter, autoRenew: true, status: ProSubscriptionStatus.ACTIVE } },
        { $group: { _id: null, count: { $sum: 1 }, revenue: { $sum: '$price' } } },
      ]),
      ProSubscription.find({ renewalFailures: { $gt: 0 } })
        .sort({ lastRenewalAttemptAt: -1 })
        .limit(20)
        .select('userId renewalFailures lastRenewalAttemptAt currentPeriodEnd status')
        .lean(),
      ProSubscription.find()
        .sort({ createdAt: -1 })
        .limit(30)
        .select('userId status price startedAt currentPeriodEnd autoRenew cancelledAt')
        .lean(),
      this.proMoney30d(now),
    ]);

    const userIds = [...atRisk, ...recent].map((s) => s.userId);
    const users = await User.find({ _id: { $in: userIds } }).select('name').lean();
    const nameOf = new Map(users.map((u) => [String(u._id), shortName(u.name)]));

    const counts: Record<string, number> = {};
    for (const row of byStatus) counts[row._id as string] = row.count as number;

    return {
      plan: {
        id: PRO_PLAN.id,
        name: PRO_PLAN.name,
        price: PRO_PLAN.price,
        periodDays: PRO_PLAN.periodDays,
        freeDelivery: PRO_PLAN.benefits.freeDelivery,
        serviceFeeWaived: PRO_PLAN.benefits.serviceFeeWaived,
      },
      members: {
        active,
        renewing: renewing[0]?.count ?? 0,
        cancelledStillValid: Math.max(active - (renewing[0]?.count ?? 0), 0),
        expired: counts[ProSubscriptionStatus.EXPIRED] ?? 0,
        pending: counts[ProSubscriptionStatus.PENDING] ?? 0,
      },
      // Suma de lo que hoy se renueva: ingreso mensual bruto, antes de la
      // comisión de Wompi y sin restar lo que cuestan los beneficios.
      monthlyRecurringGross: renewing[0]?.revenue ?? 0,
      last30Days,
      atRisk: atRisk.map((s) => ({
        name: nameOf.get(String(s.userId)) ?? 'Sin nombre',
        renewalFailures: s.renewalFailures,
        lastAttemptAt: s.lastRenewalAttemptAt,
        validUntil: s.currentPeriodEnd,
      })),
      recent: recent.map((s) => ({
        name: nameOf.get(String(s.userId)) ?? 'Sin nombre',
        status: s.status,
        // El estado solo no basta: una ACTIVE cuya renovación aún se
        // reintenta, o una CANCELLED a la que el barrido no ha llegado,
        // ya no dan beneficios. Misma definición que la app y los precios.
        member: isProActive(s as Pick<IProSubscription, 'status' | 'currentPeriodEnd'>, now),
        price: s.price,
        since: s.startedAt,
        validUntil: s.currentPeriodEnd,
        autoRenew: s.autoRenew,
        cancelledAt: s.cancelledAt,
      })),
    };
  }
}

export const adminGrowthService = new AdminGrowthService();
