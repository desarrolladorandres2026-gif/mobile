import { Request, Response, NextFunction } from 'express';
import { couponService } from '../services';
import { Coupon, CouponRedemption } from '../models';
import { sendResponse, param, query } from '../utils';
import { AppError } from '../middlewares';
import { AuditAction, AuditSeverity, logAudit } from '../security';

/**
 * `campaignApproved` deja que una campaña se aplique aunque hunda el margen
 * de contribución por debajo del mínimo. Es la única llave del cupón que
 * compromete plata de la plataforma sin tope, así que se rige por la misma
 * regla que `PUT /finance/config`: la firma un administrador financiero.
 *
 * Un admin de marketing sigue pudiendo crear y editar promociones; lo que no
 * puede es autorizarse a sí mismo a vender por debajo del piso.
 */
function assertMayApproveCampaign(req: Request): void {
  if (req.body?.campaignApproved !== true) return;

  if (req.user?.isFinanceAdmin) return;

  void logAudit(req, {
    action: AuditAction.SUSPICIOUS_ACTIVITY,
    entity: 'coupon',
    severity: AuditSeverity.HIGH,
    description: 'Intento de aprobar una campaña bajo margen sin rol financiero',
    metadata: { code: req.body?.code },
  });

  throw new AppError(
    'Aprobar una campaña por debajo del margen mínimo requiere permisos de ' +
      'administrador financiero',
    403
  );
}

export class CouponController {
  // ── Promociones del propio comercio ──

  async listMine(req: Request, res: Response, next: NextFunction) {
    try {
      const coupons = await couponService.listForBusiness(
        req.user!._id.toString(),
        param(req, 'businessId')
      );
      sendResponse(res, 200, 'Tus promociones', coupons);
    } catch (error) { next(error); }
  }

  async createMine(req: Request, res: Response, next: NextFunction) {
    try {
      const coupon = await couponService.createForBusiness(
        req.user!._id.toString(),
        param(req, 'businessId'),
        req.body
      );
      sendResponse(res, 201, 'Promoción creada', coupon);
    } catch (error) { next(error); }
  }

  async deactivateMine(req: Request, res: Response, next: NextFunction) {
    try {
      const coupon = await couponService.deactivateForBusiness(
        req.user!._id.toString(),
        param(req, 'id')
      );
      sendResponse(res, 200, 'Promoción desactivada', coupon);
    } catch (error) { next(error); }
  }

  /** Public: promotions carousel for the app home screen. */
  async getPublic(req: Request, res: Response, next: NextFunction) {
    try {
      const coupons = await couponService.getPublic(
        query(req, 'city'),
        query(req, 'businessId')
      );

      // Never expose internal counters to customers.
      const safe = coupons.map((c) => ({
        _id: c._id,
        code: c.code,
        title: c.title,
        description: c.description,
        type: c.type,
        value: c.value,
        maxDiscount: c.maxDiscount,
        minOrderAmount: c.minOrderAmount,
        validUntil: c.validUntil,
        businessId: c.businessId,
        firstOrderOnly: c.firstOrderOnly,
        usageLimit: c.usageLimit,
        perUserLimit: c.perUserLimit,
        validDays: c.validDays,
        validFromTime: c.validFromTime,
        validUntilTime: c.validUntilTime,
        conditions: {
          minOrderAmount: c.minOrderAmount,
          fundedBy: c.fundedBy,
          zoneRestricted: c.zoneIds.length > 0,
          firstOrderOnly: c.firstOrderOnly,
        },
      }));

      sendResponse(res, 200, 'Promociones disponibles', safe);
    } catch (error) { next(error); }
  }

  /** Authenticated: previews a coupon against a cart without consuming it. */
  async validate(req: Request, res: Response, next: NextFunction) {
    try {
      // A standalone validation endpoint used to accept subtotal and delivery
      // values from the device. That can never be an authoritative promotion
      // decision. Checkout validates coupons through /orders/quote, which
      // loads products, zone and delivery cost from the database.
      throw new AppError('Valida promociones mediante la cotización del pedido', 422);
    } catch (error) { next(error); }
  }

  // ── Admin ──────────────────────────────────────────────────────────

  async list(req: Request, res: Response, next: NextFunction) {
    try {
      const page = Number(query(req, 'page')) || 1;
      const limit = Math.min(Number(query(req, 'limit')) || 20, 100);
      const skip = (page - 1) * limit;

      const filter: Record<string, unknown> = {};
      const search = query(req, 'search');
      if (search) filter.code = { $regex: search, $options: 'i' };
      const active = query(req, 'isActive');
      if (active !== undefined) filter.isActive = active === 'true';

      const [coupons, total] = await Promise.all([
        Coupon.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
        Coupon.countDocuments(filter),
      ]);

      sendResponse(res, 200, 'Cupones', coupons, {
        page, limit, total, totalPages: Math.ceil(total / limit),
      });
    } catch (error) { next(error); }
  }

  async create(req: Request, res: Response, next: NextFunction) {
    try {
      assertMayApproveCampaign(req);
      const coupon = await Coupon.create(req.body);
      void logAudit(req, { action: AuditAction.PROMOTION_CREATED, entity: 'coupon', entityId: coupon._id.toString(), severity: AuditSeverity.MEDIUM, description: 'Promoción creada', metadata: { code: coupon.code } });
      sendResponse(res, 201, 'Cupón creado', coupon);
    } catch (error) { next(error); }
  }

  async update(req: Request, res: Response, next: NextFunction) {
    try {
      assertMayApproveCampaign(req);

      const coupon = await Coupon.findById(param(req, 'id'));
      if (!coupon) throw new AppError('Cupón no encontrado', 404);

      Object.assign(coupon, req.body);
      await coupon.save();
      void logAudit(req, { action: AuditAction.PROMOTION_UPDATED, entity: 'coupon', entityId: coupon._id.toString(), severity: AuditSeverity.MEDIUM, description: 'Promoción actualizada', metadata: { code: coupon.code, changes: Object.keys(req.body) } });

      sendResponse(res, 200, 'Cupón actualizado', coupon);
    } catch (error) { next(error); }
  }

  /**
   * Historial de canjes de una promoción.
   *
   * Responde la pregunta que ningún contador de `usedCount` puede responder:
   * *quién* la usó, *cuándo* y *cuánto costó cada uso*. Sin esto, una campaña
   * que se dispara sólo se nota cuando ya se gastó el presupuesto.
   */
  async redemptions(req: Request, res: Response, next: NextFunction) {
    try {
      const couponId = param(req, 'id');
      const coupon = await Coupon.findById(couponId);
      if (!coupon) throw new AppError('Cupón no encontrado', 404);

      const page = Number(query(req, 'page')) || 1;
      const limit = Math.min(Number(query(req, 'limit')) || 20, 100);

      const [redemptions, total, spent] = await Promise.all([
        CouponRedemption.find({ couponId })
          .sort({ createdAt: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .populate('userId', 'name phone')
          .populate('orderId', 'orderNumber status total'),
        CouponRedemption.countDocuments({ couponId }),
        CouponRedemption.aggregate([
          { $match: { couponId: coupon._id } },
          { $group: { _id: null, total: { $sum: '$discountAmount' } } },
        ]),
      ]);

      sendResponse(
        res,
        200,
        'Historial de uso',
        {
          redemptions,
          totalDiscounted: spent[0]?.total ?? 0,
          budgetLimit: coupon.budgetLimit,
          budgetSpent: coupon.budgetSpent,
          usedCount: coupon.usedCount,
          usageLimit: coupon.usageLimit,
        },
        { page, limit, total, totalPages: Math.ceil(total / limit) }
      );
    } catch (error) { next(error); }
  }

  async remove(req: Request, res: Response, next: NextFunction) {
    try {
      const coupon = await Coupon.findById(param(req, 'id'));
      if (!coupon) throw new AppError('Cupón no encontrado', 404);

      // Soft-disable rather than delete: redemptions reference this coupon
      // and reporting must keep working.
      coupon.isActive = false;
      await coupon.save();
      void logAudit(req, { action: AuditAction.PROMOTION_UPDATED, entity: 'coupon', entityId: coupon._id.toString(), severity: AuditSeverity.HIGH, description: 'Promoción desactivada', metadata: { code: coupon.code } });

      sendResponse(res, 200, 'Cupón desactivado', coupon);
    } catch (error) { next(error); }
  }
}

export const couponController = new CouponController();
