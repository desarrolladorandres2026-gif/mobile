import { Types } from 'mongoose';
import {
  Business,
  BusinessDocument,
  BusinessStaff,
  Product,
  Advertisement,
  AdInvoice,
  Coupon,
  Review,
  Pqrs,
  Order,
  User,
} from '../models';
import { AuditLog } from '../security';
import { Permission } from '../security/rbac';
import { OrderStatus } from '../types';
import { AppError } from '../middlewares/errorHandler';
import { openForBusiness, isLegalComplete } from './business.service';
import { advertisementService } from './advertisement.service';
import { internalNoteService, NoteActor } from './internalNote.service';
import { maskLast4, pick, MASKED_ACTION_METADATA_FIELDS } from './profileMasking';

/**
 * Ficha del comercio para el panel admin (Fase 2, B5).
 *
 * Todo se enmascara AQUÍ: sin el permiso de cada sección, la sección va `null`
 * (o el campo se omite). Nunca sale la cuenta de pago completa, el NIT
 * completo ni una URL de documento (el archivo se abre por el endpoint que
 * firma y audita). Ventas y dinero no van: el panel los pide aparte.
 */

const LIST = 10;
const HISTORY = 20;
const DAY = 24 * 60 * 60 * 1000;

const idStr = (v: unknown) => (v == null ? null : String(v));
const iso = (d: unknown) => (d ? new Date(d as Date).toISOString() : null);

export async function businessProfile360(businessId: string, actor: NoteActor) {
  if (!Types.ObjectId.isValid(businessId)) throw new AppError('Identificador de comercio inválido', 400);
  const has = (p: Permission) => actor.permissions.includes(p);
  const oid = new Types.ObjectId(businessId);

  const business = await Business.findById(oid).select('+legal +payoutAccount').lean();
  if (!business) throw new AppError('Comercio no encontrado', 404);

  const canFinance = has(Permission.FINANCE_VIEW);
  const canAds = has(Permission.ADS_VIEW);
  const canCoupons = has(Permission.COUPONS_VIEW);
  const canReviews = has(Permission.REVIEWS_VIEW);
  const canSupport = has(Permission.SUPPORT_VIEW);
  const canUsers = has(Permission.USERS_VIEW);
  const canAudit = has(Permission.ADMIN_AUDIT_LOGS);
  const canCommissions = has(Permission.COMMISSIONS_VIEW);

  const since30 = new Date(Date.now() - 30 * DAY);
  const none = <T>(v: T) => Promise.resolve(v);

  const [
    owner, documents, staff, products, available,
    ads, invoices, outstanding,
    coupons, cost, reviews, pqrs, history, notes,
  ] = await Promise.all([
    User.findById(business.ownerId).select('name').lean(),
    BusinessDocument.find({ businessId: oid }).select('type status expiresAt reviewedBy reviewedAt rejectionReason').sort({ type: 1 }).lean(),
    BusinessStaff.find({ businessId: oid }).populate('userId', canUsers ? 'name phone' : 'name').sort({ createdAt: -1 }).limit(50).lean(),
    Product.countDocuments({ businessId: oid }),
    Product.countDocuments({ businessId: oid, isAvailable: true }),
    canAds
      ? Advertisement.find({ billedToBusinessId: oid }).sort({ createdAt: -1 }).limit(LIST)
          .select('campaignName approvalStatus isActive startDate endDate cancelledAt').lean()
      : none(null),
    canAds ? AdInvoice.find({ businessId: oid }).sort({ createdAt: -1 }).limit(LIST).select('amount settledAt settledAgainstPayout createdAt campaignName').lean() : none(null),
    canAds ? advertisementService.outstandingForBusiness(businessId) : none(0),
    canCoupons ? Coupon.find({ businessId: oid }).sort({ createdAt: -1 }).limit(LIST).select('code isActive validUntil').lean() : none(null),
    canCoupons && canFinance
      ? Order.aggregate([
          { $match: { businessId: oid, status: OrderStatus.DELIVERED, createdAt: { $gte: since30 } } },
          { $group: { _id: null, total: { $sum: { $ifNull: ['$finance.merchantFundedDiscount', 0] } } } },
        ])
      : none(null),
    canReviews
      ? Review.find({ businessId: oid, isHidden: { $ne: true } }).sort({ createdAt: -1 }).limit(LIST)
          .select('businessRating comment createdAt').lean()
      : none(null),
    canSupport ? Pqrs.find({ businessId: oid }).sort({ createdAt: -1 }).limit(LIST).select('subject status createdAt').lean() : none(null),
    AuditLog.find({ entity: 'business', entityId: businessId }).sort({ timestamp: -1 }).limit(HISTORY).lean(),
    internalNoteService.listFor({ entityType: 'business', entityId: businessId, limit: HISTORY, actor }),
  ]);

  // Nombres de quien actuó en el historial y de quien revisó documentos.
  const userIds = new Set<string>();
  for (const h of history) if (h.userId) userIds.add(String(h.userId));
  for (const d of documents) if (d.reviewedBy) userIds.add(String(d.reviewedBy));
  if (business.suspendedBy) userIds.add(String(business.suspendedBy));
  const names = new Map<string, string>();
  const valid = [...userIds].filter((i) => Types.ObjectId.isValid(i));
  if (valid.length) {
    for (const u of await User.find({ _id: { $in: valid } }).select('name').lean()) names.set(String(u._id), u.name);
  }
  const actorOf = (id: unknown) => (id ? { _id: String(id), name: names.get(String(id)) ?? '' } : null);

  // Identidad fiscal: el NIT se abre solo para sacar sus 4 últimos.
  let legal: Record<string, unknown> | null = null;
  if (business.legal?.documentType) {
    const plainNumber = openForBusiness(business.legal.documentNumber, businessId);
    legal = {
      legalName: business.legal.legalName ?? null,
      documentType: business.legal.documentType,
      nitMasked: plainNumber ? `***${maskLast4(plainNumber)}` : null,
      taxRegime: business.legal.taxRegime ?? null,
      complete: isLegalComplete({ ...business.legal, documentNumber: plainNumber }),
    };
  }

  const pa = business.payoutAccount;
  const payoutAccount = !canFinance
    ? null
    : pa?.method
      ? {
          status: pa.verificationStatus,
          method: pa.method,
          bankName: pa.bankName ?? null,
          accountType: pa.accountType ?? null,
          last4: pa.accountLast4 ?? null,
          verifiedAt: iso(pa.verifiedAt),
        }
      : { status: 'none', method: null, bankName: null, accountType: null, last4: null, verifiedAt: null };

  return {
    business: {
      _id: idStr(business._id),
      name: business.name,
      category: business.category,
      city: business.city,
      address: business.address,
      phone: business.phone,
      isApproved: !!business.isApproved,
      isActive: !!business.isActive,
      isSuspended: !!business.isSuspended,
      suspensionReason: business.suspensionReason ?? null,
      suspendedAt: iso(business.suspendedAt),
      suspendedBy: actorOf(business.suspendedBy),
      isArchived: !!business.isArchived,
      archivedReason: business.archiveReason ?? null,
      createdAt: iso(business.createdAt),
      rating: business.rating,
      totalReviews: business.totalReviews,
      ...(canCommissions ? { commissionRateBps: business.commissionRateBps } : {}),
    },
    owner: owner ? { _id: idStr(owner._id), name: owner.name } : null,
    legal,
    payoutAccount,
    documents: documents.map((d) => ({
      _id: idStr(d._id),
      type: d.type,
      status: d.status,
      expiresAt: iso(d.expiresAt),
      reviewedAt: iso(d.reviewedAt),
      reviewedBy: actorOf(d.reviewedBy),
      rejectionReason: d.rejectionReason ?? null,
    })),
    team: staff.map((s: any) => ({
      _id: idStr(s._id),
      name: s.userId?.name ?? '',
      role: s.role,
      isActive: !!s.isActive,
      createdAt: iso(s.createdAt),
      ...(canUsers ? { phone: s.userId?.phone ?? null } : {}),
    })),
    menu: { products, available },
    ads: canAds
      ? {
          advertisements: (ads ?? []).map((a: any) => ({
            _id: idStr(a._id),
            title: a.campaignName,
            status: a.cancelledAt ? 'cancelled' : a.approvalStatus,
            isActive: !!a.isActive,
            startDate: iso(a.startDate),
            endDate: iso(a.endDate),
          })),
          invoices: (invoices ?? []).map((i: any) => ({
            _id: idStr(i._id),
            amount: i.amount,
            status: i.settledAt ? 'settled' : 'pending',
            createdAt: iso(i.createdAt),
          })),
          outstanding,
        }
      : null,
    promotions: canCoupons
      ? {
          coupons: (coupons ?? []).map((c: any) => ({
            _id: idStr(c._id),
            code: c.code,
            isActive: !!c.isActive,
            validUntil: iso(c.validUntil),
          })),
          cost30d: canFinance ? ((cost as any[])?.[0]?.total ?? 0) : null,
        }
      : null,
    reputation: canReviews
      ? {
          rating: business.rating,
          totalReviews: business.totalReviews,
          reviews: (reviews ?? []).map((r: any) => ({
            _id: idStr(r._id),
            rating: r.businessRating,
            comment: r.comment ?? '',
            createdAt: iso(r.createdAt),
          })),
        }
      : null,
    support: canSupport
      ? (pqrs ?? []).map((p: any) => ({ _id: idStr(p._id), subject: p.subject, status: p.status, createdAt: iso(p.createdAt) }))
      : null,
    history: history.map((h: any) => ({
      _id: idStr(h._id),
      action: h.action,
      description: h.description,
      createdAt: iso(h.timestamp),
      actorName: names.get(String(h.userId)) ?? '',
      ...(canAudit ? { metadata: h.metadata } : { metadata: pick(h.metadata, MASKED_ACTION_METADATA_FIELDS) }),
    })),
    notes: notes.items,
    masked: { commissions: !canCommissions, finance: !canFinance, sensitive: !canUsers },
  };
}

export const businessProfile360Service = { businessProfile360 };
