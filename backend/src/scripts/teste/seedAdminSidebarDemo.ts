import mongoose, { Types } from 'mongoose';
import { config } from '../../config';
import {
  User,
  Business,
  Order,
  Driver,
  Zone,
  Review,
  ProSubscription,
  Refund,
  FeatureFlag,
  Commission,
  Coupon,
  CouponRedemption,
  CampaignSend,
  LegalDocument,
  LegalAcceptance,
  FiscalDocument,
  AdInvoice,
  Advertisement,
  Settlement,
  CashReconciliation,
  CashPaymentIncident,
  AdActionType,
  AdPlacement,
  AdPricingModel,
  AdApprovalStatus,
} from '../../models';
import {
  RefundKind,
  RefundStatus,
  CommissionStatus,
  CouponType,
  CouponFundedBy,
  CouponScope,
  PayoutBeneficiary,
  SettlementPaymentStatus,
  SettlementPaymentMethod,
  CashReconciliationStatus,
  CashIncidentType,
  CashIncidentStatus,
  CashIncidentResolution,
  ReviewReasonClientToBusiness,
  ReviewReasonClientToDriver,
} from '../../types';
import { referralService } from '../../services/referral.service';
import { connectGuarded, offsetPoint } from './common';
import { parseArgs } from './common';

/**
 * Relleno de demostración para el sidebar del panel admin.
 *
 * Catorce colecciones estaban en cero y por eso catorce páginas del panel
 * se veían vacías aunque el código que las lee funciona. Este script no
 * inventa IDs sueltos: cuelga cada documento de usuarios, comercios,
 * pedidos y domiciliarios que ya existen en la base (Atlas dev).
 *
 * ── Por qué Refund/Commission/Settlement NO pasan por sus servicios ──
 *
 * `refundService.issue()`, el reclamo de payouts y el pago de una
 * liquidación mutan pedidos reales, llaman la pasarela y mueven el saldo
 * vivo de domiciliarios/comercios de la base de dev. Correr eso contra los
 * 12 pedidos reales de Atlas dev — la mayoría ya `cancelled`/`ready` —
 * dejaría el libro mayor y el estado de esos pedidos en algo que ya no es
 * ni una demo ni la realidad. Así que estos tres modelos se insertan
 * directo, como ya hace `AdInvoice`/`FiscalDocument` por diseño (viven
 * fuera del libro). Es una desviación deliberada de "usa el servicio", y
 * se documenta aquí: estos documentos son decorativos, no representan
 * dinero que de verdad se movió, y por eso nunca escriben en `LedgerEntry`.
 *
 * Idempotente: todo upsert va por una clave estable. Correrlo dos veces no
 * duplica nada ni toca un documento que no sea de esta demo.
 */

const MARK = 'DEMO SIDEBAR —';

/**
 * `findOneAndUpdate` con `upsert` siempre devuelve un documento, exista ya
 * o se acabe de crear — por eso no sirve para contar inserciones reales.
 * `includeResultMetadata` trae `lastErrorObject.upserted`, que solo viene
 * poblado cuando el upsert insertó, así el reporte final cuenta lo que de
 * verdad se creó en esta corrida (y da 0 en una segunda corrida, como debe).
 */
async function upsert<T>(
  model: any,
  filter: Record<string, unknown>,
  setOnInsert: Record<string, unknown>
): Promise<{ doc: T; inserted: boolean }> {
  const result = (await model.findOneAndUpdate(filter, { $setOnInsert: setOnInsert }, {
    upsert: true,
    new: true,
    includeResultMetadata: true,
  })) as { value: T; lastErrorObject?: { upserted?: unknown } };
  return { doc: result.value, inserted: Boolean(result.lastErrorObject?.upserted) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await connectGuarded((args.db as string) || 'zipp');

  const users = await User.find().select('_id name email role').lean();
  const clients = users.filter((u) => u.role === 'client');
  const businesses = await Business.find().select('_id name ownerId').lean();
  const orders = await Order.find().select('_id businessId clientId driverId status finance').lean();
  const drivers = await Driver.find().select('_id userId').lean();
  const admin = users.find((u) => u.role === 'admin');

  if (!admin) throw new Error('No hay ningún usuario admin en la base: hace falta uno como autor.');
  if (orders.length === 0) throw new Error('No hay pedidos en la base: nada que colgar.');
  if (businesses.length === 0) throw new Error('No hay comercios en la base.');
  if (drivers.length === 0) throw new Error('No hay domiciliarios en la base.');

  const pick = <T>(arr: T[], i: number): T => arr[i % arr.length];

  // ── 1. Zone ──────────────────────────────────────────────────────────
  const zoneDefs = [
    { name: 'Centro Garzón', north: 0, east: 0, surcharge: 0, minOrder: 15000, priority: 10 },
    { name: 'La Esperanza', north: 1.2, east: 0.8, surcharge: 1000, minOrder: 20000, priority: 5 },
    { name: 'San José', north: -1, east: 1.5, surcharge: 500, minOrder: 15000, priority: 5 },
    { name: 'Guaduales (zona lejana)', north: 3, east: -2.5, surcharge: 3000, minOrder: 25000, priority: 1 },
  ];
  let zoneCount = 0;
  for (const z of zoneDefs) {
    const center = offsetPoint({ north: z.north, east: z.east });
    const d = 0.01;
    const ring: number[][] = [
      [center.lng - d, center.lat - d],
      [center.lng + d, center.lat - d],
      [center.lng + d, center.lat + d],
      [center.lng - d, center.lat + d],
      [center.lng - d, center.lat - d],
    ];
    const { inserted } = await upsert(Zone, { name: z.name }, {
      name: z.name,
      city: 'Garzón',
      area: { type: 'Polygon', coordinates: [ring] },
      surcharge: z.surcharge,
      minOrder: z.minOrder,
      priority: z.priority,
      isActive: true,
      version: 1,
    });
    if (inserted) zoneCount++;
  }

  // ── 2. Review ────────────────────────────────────────────────────────
  const reviewTexts = [
    { comment: 'Todo llegó caliente y a tiempo, muy buena atención.', businessRating: 5, driverRating: 5 },
    { comment: 'El pedido llegó frío y faltó una bebida.', businessRating: 2, driverRating: 4, businessReasons: [ReviewReasonClientToBusiness.PREPARATION_DELAY, ReviewReasonClientToBusiness.MISSING_ITEM] },
    { comment: 'El domiciliario se demoró más de lo esperado.', businessRating: 4, driverRating: 2, driverReasons: [ReviewReasonClientToDriver.LATE_DELIVERY] },
    { comment: 'Excelente sabor, como siempre.', businessRating: 5, driverRating: 5 },
  ];
  let reviewCount = 0;
  for (let i = 0; i < Math.min(reviewTexts.length, orders.length); i++) {
    const order = orders[i];
    const t = reviewTexts[i];
    const { inserted } = await upsert(Review, { orderId: order._id }, {
      orderId: order._id,
      userId: order.clientId,
      businessId: order.businessId,
      driverId: order.driverId ?? pick(drivers, i)._id,
      businessRating: t.businessRating,
      businessRatingReasons: t.businessReasons,
      driverRating: t.driverRating,
      driverRatingReasons: t.driverReasons,
      comment: t.comment,
      isHidden: false,
    });
    if (inserted) reviewCount++;
  }

  // ── 3. ProSubscription ──────────────────────────────────────────────
  const now = new Date();
  const proDefs = [
    { status: 'active', daysLeft: 20 },
    { status: 'cancelled', daysLeft: 5 },
    { status: 'expired', daysLeft: -10 },
  ] as const;
  let proCount = 0;
  for (let i = 0; i < Math.min(proDefs.length, clients.length); i++) {
    const client = clients[i];
    const def = proDefs[i];
    const periodEnd = new Date(now.getTime() + def.daysLeft * 86400000);
    const periodStart = new Date(periodEnd.getTime() - 30 * 86400000);
    const { inserted } = await upsert(ProSubscription, { userId: client._id }, {
      userId: client._id,
      status: def.status,
      planId: 'pro_mensual',
      price: 14900,
      currency: 'COP',
      startedAt: periodStart,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      autoRenew: def.status === 'active',
      cancelledAt: def.status === 'cancelled' ? now : null,
      renewalFailures: def.status === 'expired' ? 3 : 0,
    });
    if (inserted) proCount++;
  }

  // ── 4. Refund (decorativo, no pasa por ledger — ver cabecera) ───────
  const refundDefs = [
    { status: RefundStatus.COMPLETED, kind: RefundKind.FULL, reason: 'Pedido cancelado por el comercio antes de alistarlo' },
    { status: RefundStatus.COMPLETED, kind: RefundKind.PARTIAL, reason: 'Faltó un producto del pedido' },
    { status: RefundStatus.PENDING, kind: RefundKind.PARTIAL, reason: 'Cliente reporta producto en mal estado' },
    { status: RefundStatus.FAILED, kind: RefundKind.FULL, reason: 'La pasarela rechazó la reversión, pendiente de reintento' },
  ];
  let refundCount = 0;
  for (let i = 0; i < Math.min(refundDefs.length, orders.length); i++) {
    const order = orders[i];
    const def = refundDefs[i];
    const total = order.finance?.customerTotal ?? 30000;
    const amount = def.kind === RefundKind.FULL ? total : Math.round(total * 0.4);
    const key = `${MARK} refund-${order._id}-${i}`;
    const { inserted } = await upsert(Refund, { idempotencyKey: key }, {
      orderId: order._id,
      kind: def.kind,
      status: def.status,
      amount,
      currency: 'COP',
      reason: def.reason,
      allocation: {
        fromMerchantPayout: Math.round(amount * 0.5),
        fromDriverPayout: 0,
        fromCommission: Math.round(amount * 0.3),
        fromServiceFee: 0,
        fromDeliveryMargin: 0,
        fromTax: 0,
        fromPlatform: amount - Math.round(amount * 0.5) - Math.round(amount * 0.3),
      },
      idempotencyKey: key,
      requestedBy: admin._id,
      processedAt: def.status === RefundStatus.COMPLETED ? now : null,
    });
    if (inserted) refundCount++;
  }

  // ── 5. FeatureFlag ───────────────────────────────────────────────────
  const flagDefs = [
    { key: 'demo_checkout_v2', description: 'Rediseño del checkout en pruebas internas', audience: 'off' as const, percentage: 0 },
    { key: 'demo_pro_badge', description: 'Insignia dorada de Zipp Pro en el perfil', audience: 'all' as const, percentage: 0 },
    { key: 'demo_dispatch_cascade_v2', description: 'Nueva ronda de reparto, solo para staff', audience: 'staff' as const, percentage: 0 },
    { key: 'demo_search_rerank', description: 'Reordenar resultados de búsqueda por cercanía', audience: 'percentage' as const, percentage: 25 },
  ];
  let flagCount = 0;
  for (const f of flagDefs) {
    const { inserted } = await upsert(FeatureFlag, { key: f.key }, { ...f, updatedBy: admin._id });
    if (inserted) flagCount++;
  }

  // ── 6. Commission (decorativo, ver cabecera) ─────────────────────────
  let commissionCount = 0;
  for (let i = 0; i < orders.length; i++) {
    const order = orders[i];
    const finance = order.finance;
    if (!finance) continue;
    const { inserted } = await upsert(Commission, { orderId: order._id }, {
      orderId: order._id,
      businessId: order.businessId,
      driverId: order.driverId ?? null,
      platformAmount: finance.merchantCommission ?? 0,
      businessAmount: finance.businessPayout ?? 0,
      driverAmount: finance.driverPayout ?? 0,
      status: order.status === 'cancelled' ? CommissionStatus.PENDING : CommissionStatus.SETTLED,
      settledAt: order.status === 'cancelled' ? null : now,
    });
    if (inserted) commissionCount++;
  }

  // ── 7. Coupon + CouponRedemption ─────────────────────────────────────
  const couponDefs = [
    {
      code: 'DEMOBIENVENIDA',
      title: 'Bienvenida Zipp',
      description: '20% de descuento en tu primer pedido',
      type: CouponType.PERCENTAGE,
      value: 20,
      maxDiscount: 10000,
      fundedBy: CouponFundedBy.PLATFORM,
      scope: CouponScope.PRODUCT,
      firstOrderOnly: true,
      isPublic: true,
      isActive: true,
      validUntil: new Date(now.getTime() + 60 * 86400000),
    },
    {
      code: 'DEMOENVIOGRATIS',
      title: 'Envío gratis',
      description: 'Domicilio gratis en pedidos desde $25.000',
      type: CouponType.FREE_DELIVERY,
      value: 0,
      maxDiscount: 0,
      fundedBy: CouponFundedBy.PLATFORM,
      scope: CouponScope.DELIVERY,
      minOrderAmount: 25000,
      isPublic: true,
      isActive: true,
      validUntil: new Date(now.getTime() + 30 * 86400000),
    },
    {
      code: 'DEMOVENCIDO',
      title: 'Promo de aniversario (vencida)',
      description: '15% de descuento, campaña ya cerrada',
      type: CouponType.PERCENTAGE,
      value: 15,
      maxDiscount: 8000,
      fundedBy: CouponFundedBy.PLATFORM,
      scope: CouponScope.PRODUCT,
      isPublic: false,
      isActive: false,
      validUntil: new Date(now.getTime() - 5 * 86400000),
    },
    {
      code: 'DEMOAGOTADO',
      title: 'Cupón de comercio (agotado)',
      description: '$5.000 de descuento, cupo agotado',
      type: CouponType.FIXED,
      value: 5000,
      maxDiscount: 0,
      fundedBy: CouponFundedBy.BUSINESS,
      scope: CouponScope.PRODUCT,
      businessId: businesses[0]._id,
      usageLimit: 2,
      usedCount: 2,
      isPublic: true,
      isActive: true,
      validUntil: new Date(now.getTime() + 15 * 86400000),
    },
  ];
  let couponCount = 0;
  const couponIds: Types.ObjectId[] = [];
  for (const c of couponDefs) {
    const { doc, inserted } = await upsert<{ _id: Types.ObjectId }>(Coupon, { code: c.code }, c);
    if (inserted) couponCount++;
    couponIds.push(doc._id);
  }
  let redemptionCount = 0;
  for (let i = 0; i < Math.min(2, couponIds.length, orders.length, clients.length); i++) {
    const { inserted } = await upsert(
      CouponRedemption,
      { orderId: orders[i]._id, couponId: couponIds[i] },
      {
        couponId: couponIds[i],
        userId: orders[i].clientId ?? clients[i]._id,
        orderId: orders[i]._id,
        discountAmount: 5000,
      }
    );
    if (inserted) redemptionCount++;
  }

  // ── 8. CampaignSend ───────────────────────────────────────────────────
  const campaignDefs = [
    { title: `${MARK} Reactivación de inactivos`, body: 'Vuelve a pedir y lleva un cupón de bienvenida.', status: 'done' as const, targeted: 120, sent: 118, failed: 2 },
    { title: `${MARK} Nuevo comercio en Garzón`, body: 'Ya puedes pedir en Autoservicio Punto Fresco.', status: 'done' as const, targeted: 340, sent: 340, failed: 0 },
    { title: `${MARK} Envío fallido masivo`, body: 'Oferta de fin de semana.', status: 'failed' as const, targeted: 50, sent: 0, failed: 50 },
  ];
  let campaignCount = 0;
  for (const c of campaignDefs) {
    const existing = await CampaignSend.findOne({ title: c.title });
    if (existing) continue;
    await CampaignSend.create({
      sentBy: admin._id,
      segment: { city: 'Garzón' },
      title: c.title,
      body: c.body,
      status: c.status,
      targeted: c.targeted,
      sent: c.sent,
      failed: c.failed,
      finishedAt: c.status === 'done' || c.status === 'failed' ? now : null,
    });
    campaignCount++;
  }

  // ── 9. User.referredBy (cadena de referidos) ─────────────────────────
  let referralCount = 0;
  if (clients.length >= 3) {
    const root = clients[0];
    const mid = clients[1];
    const leaf = clients[2];
    await referralService.codeFor(String(root._id));
    await referralService.codeFor(String(mid._id));
    const midUpdate = await User.updateOne(
      { _id: mid._id, referredBy: null },
      { $set: { referredBy: root._id } }
    );
    const leafUpdate = await User.updateOne(
      { _id: leaf._id, referredBy: null },
      { $set: { referredBy: mid._id } }
    );
    referralCount = (midUpdate.modifiedCount ?? 0) + (leafUpdate.modifiedCount ?? 0);
  }

  // ── 10. LegalDocument + LegalAcceptance ───────────────────────────────
  const legalDefs = [
    { kind: 'terms' as const, version: '1.0', title: 'Términos y condiciones' },
    { kind: 'privacy' as const, version: '1.0', title: 'Política de privacidad' },
    { kind: 'habeas_data' as const, version: '1.0', title: 'Autorización de tratamiento de datos' },
  ];
  let legalDocCount = 0;
  const legalDocIds: Types.ObjectId[] = [];
  for (const l of legalDefs) {
    const { doc, inserted } = await upsert<{ _id: Types.ObjectId }>(
      LegalDocument,
      { kind: l.kind, version: l.version },
      {
        kind: l.kind,
        version: l.version,
        title: l.title,
        content: `Contenido de demostración para "${l.title}". Texto de relleno para probar el panel, no es el documento legal real.`,
        effectiveAt: now,
        isActive: true,
        publishedBy: admin._id,
      }
    );
    if (inserted) legalDocCount++;
    legalDocIds.push(doc._id);
  }
  let legalAcceptanceCount = 0;
  for (let i = 0; i < Math.min(legalDocIds.length, clients.length); i++) {
    const { inserted } = await upsert(
      LegalAcceptance,
      { userId: clients[i]._id, documentId: legalDocIds[i] },
      {
        userId: clients[i]._id,
        documentId: legalDocIds[i],
        version: legalDefs[i].version,
        ipHash: 'demo-hash',
        acceptedAt: now,
      }
    );
    if (inserted) legalAcceptanceCount++;
  }

  // ── 13. Settlement (antes que FiscalDocument, que depende de esto) ──
  // Decorativo: no reclama Payouts reales (ver cabecera).
  const settlementDefs = [
    { beneficiary: PayoutBeneficiary.BUSINESS, businessId: businesses[0]._id, paymentStatus: SettlementPaymentStatus.PAID },
    { beneficiary: PayoutBeneficiary.BUSINESS, businessId: businesses[1]?._id ?? businesses[0]._id, paymentStatus: SettlementPaymentStatus.PENDING },
    { beneficiary: PayoutBeneficiary.DRIVER, driverId: drivers[0]._id, paymentStatus: SettlementPaymentStatus.PAID },
  ];
  let settlementCount = 0;
  const settlementIds: Types.ObjectId[] = [];
  for (let i = 0; i < settlementDefs.length; i++) {
    const def = settlementDefs[i];
    const reference = `${MARK} settlement-${i}`;
    let settlement = await Settlement.findOne({ reference });
    if (!settlement) {
      const periodEnd = new Date(now.getTime() - i * 7 * 86400000);
      const periodStart = new Date(periodEnd.getTime() - 7 * 86400000);
      const gross = 150000 + i * 30000;
      settlement = await Settlement.create({
        beneficiary: def.beneficiary,
        businessId: def.businessId ?? null,
        driverId: def.driverId ?? null,
        periodStart,
        periodEnd,
        payoutCount: 4 + i,
        grossAmount: gross,
        reversedAmount: 0,
        adSpendAmount: 0,
        clawbackAmount: 0,
        netAmount: gross,
        currency: 'COP',
        reference,
        createdBy: admin._id,
        paymentStatus: def.paymentStatus,
        paymentMethod: def.paymentStatus === SettlementPaymentStatus.PAID ? SettlementPaymentMethod.BANK_TRANSFER : null,
        paidAt: def.paymentStatus === SettlementPaymentStatus.PAID ? now : null,
        paidBy: def.paymentStatus === SettlementPaymentStatus.PAID ? admin._id : null,
      });
      settlementCount++;
    }
    settlementIds.push(settlement._id as Types.ObjectId);
  }

  // ── 11. FiscalDocument (inmutable: solo se crea si no existe) ────────
  let fiscalCount = 0;
  for (let i = 0; i < Math.min(2, settlementIds.length); i++) {
    const number = `INT-DEMO-${String(i + 1).padStart(4, '0')}`;
    const existing = await FiscalDocument.findOne({ number });
    if (existing) continue;
    const def = settlementDefs[i];
    await FiscalDocument.create({
      number,
      type: def.beneficiary === PayoutBeneficiary.DRIVER ? 'driver_payment_voucher' : 'settlement_statement',
      settlementId: settlementIds[i],
      party: {
        kind: def.beneficiary === PayoutBeneficiary.DRIVER ? 'driver' : 'business',
        id: (def.businessId ?? def.driverId)!,
        name: def.beneficiary === PayoutBeneficiary.DRIVER ? 'Pedro Domicilios' : businesses[0].name,
        documentLast4: '1234',
      },
      lines: [
        { label: 'Bruto liquidado', amount: 150000 },
        { label: 'Reversiones', amount: 0 },
      ],
      netAmount: 150000,
      currency: 'COP',
      paymentMethod: 'bank_transfer',
      paidAt: now,
      issuedBy: admin._id,
      issuedAt: now,
    });
    fiscalCount++;
  }

  // ── 12. AdInvoice (requiere una Advertisement) ───────────────────────
  const adCampaigns = [
    { campaignName: `${MARK} Flyer de bienvenida`, pricingModel: AdPricingModel.CPM, cpmRate: 8000, settledAgainstPayout: true },
    { campaignName: `${MARK} Carrusel Explorar`, pricingModel: AdPricingModel.CPC, cpcRate: 600, settledAgainstPayout: false },
  ];
  let adInvoiceCount = 0;
  for (let i = 0; i < adCampaigns.length; i++) {
    const def = adCampaigns[i];
    const businessId = businesses[i % businesses.length]._id;
    let ad = await Advertisement.findOne({ campaignName: def.campaignName });
    if (!ad) {
      ad = await Advertisement.create({
        campaignName: def.campaignName,
        advertiserName: businesses[i % businesses.length].name,
        flyerUrl: 'https://example.com/demo-flyer.jpg',
        startDate: new Date(now.getTime() - 14 * 86400000),
        endDate: now,
        isActive: false,
        priority: 0,
        placement: i === 0 ? AdPlacement.SPLASH : AdPlacement.EXPLORE,
        targetCities: [],
        targetCategories: [],
        targetRoles: [],
        maxImpressionsPerUser: 0,
        actionType: AdActionType.BUSINESS,
        businessId,
        maxImpressions: 10000,
        maxClicks: 0,
        impressionCount: 2500,
        clickCount: 180,
        durationSeconds: 5,
        pricePaid: 0,
        pricingModel: def.pricingModel,
        cpmRate: def.cpmRate ?? 0,
        cpcRate: def.cpcRate ?? 0,
        budget: 0,
        billedToBusinessId: businessId,
        approvalStatus: AdApprovalStatus.APPROVED,
        rejectionReason: '',
        internalNotes: 'Campaña de demostración para /ad-invoices.',
      });
    }
    const existingInvoice = await AdInvoice.findOne({ campaignId: ad._id });
    if (existingInvoice) continue;
    const amount = def.pricingModel === AdPricingModel.CPM ? Math.round((2500 / 1000) * (def.cpmRate ?? 0)) : Math.round(180 * (def.cpcRate ?? 0));
    await AdInvoice.create({
      campaignId: ad._id,
      campaignName: ad.campaignName,
      businessId,
      advertiserName: ad.advertiserName,
      pricingModel: def.pricingModel,
      cpmRate: def.cpmRate ?? 0,
      cpcRate: def.cpcRate ?? 0,
      impressions: 2500,
      clicks: 180,
      amount,
      currency: 'COP',
      periodStart: ad.startDate,
      periodEnd: ad.endDate,
      settledAgainstPayout: def.settledAgainstPayout,
      settledAt: def.settledAgainstPayout ? now : null,
      collectionReference: def.settledAgainstPayout ? null : 'DEMO-TRANSFER-001',
      collectedBy: def.settledAgainstPayout ? null : admin._id,
    });
    adInvoiceCount++;
  }

  // ── 14. CashReconciliation + CashPaymentIncident ─────────────────────
  const cashOrders = orders.filter((o) => o.driverId);
  let cashReconCount = 0;
  let cashIncidentCount = 0;
  const cashStatuses = [
    CashReconciliationStatus.PENDING,
    CashReconciliationStatus.REPORTED,
    CashReconciliationStatus.VERIFIED,
    CashReconciliationStatus.SETTLED,
  ];
  for (let i = 0; i < Math.min(cashStatuses.length, Math.max(cashOrders.length, 1)); i++) {
    const order = cashOrders.length > 0 ? cashOrders[i % cashOrders.length] : orders[i % orders.length];
    const driverId = order.driverId ?? drivers[i % drivers.length]._id;
    const status = cashStatuses[i];
    const amount = Math.round((order.finance?.merchantCommission ?? 3000) + (order.finance?.customerServiceFee ?? 0));
    const { inserted } = await upsert(CashReconciliation, { orderId: order._id }, {
      driverId,
      orderId: order._id,
      amount: amount || 3000,
      breakdown: {
        merchantCommission: order.finance?.merchantCommission ?? 3000,
        customerServiceFee: order.finance?.customerServiceFee ?? 0,
        deliveryMargin: order.finance?.deliveryMargin ?? 0,
        taxPayable: order.finance?.taxPayable ?? 0,
      },
      currency: 'COP',
      status,
      dueAt: new Date(now.getTime() + 2 * 86400000),
      reportedAt: status !== CashReconciliationStatus.PENDING ? now : null,
      verifiedAt: status === CashReconciliationStatus.VERIFIED || status === CashReconciliationStatus.SETTLED ? now : null,
      verifiedBy: status === CashReconciliationStatus.VERIFIED || status === CashReconciliationStatus.SETTLED ? admin._id : null,
      verificationMethod: status === CashReconciliationStatus.VERIFIED || status === CashReconciliationStatus.SETTLED ? 'admin_confirmation' : null,
      settledAt: status === CashReconciliationStatus.SETTLED ? now : null,
    });
    if (inserted) cashReconCount++;
  }

  // Una incidencia abierta sobre uno de esos mismos pedidos, si hay Payment.
  if (cashOrders.length > 0) {
    const order = cashOrders[0];
    const existingIncident = await CashPaymentIncident.findOne({ orderId: order._id, type: CashIncidentType.CASH_NOT_RECEIVED });
    if (!existingIncident) {
      // CashPaymentIncident exige paymentId; se usa un ObjectId nuevo solo
      // como marcador cuando el pedido demo no tiene un Payment real
      // asociado — el panel solo necesita poder listar y abrir la incidencia.
      const Payment = mongoose.model('Payment');
      const payment = await Payment.findOne({ orderId: order._id }).select('_id');
      const paymentId = payment?._id ?? new Types.ObjectId();
      await CashPaymentIncident.create({
        orderId: order._id,
        paymentId,
        driverId: order.driverId,
        amount: order.finance?.customerTotal ?? 20000,
        currency: 'COP',
        type: CashIncidentType.CASH_NOT_RECEIVED,
        status: CashIncidentStatus.UNDER_REVIEW,
        driverNote: 'El cliente dijo que pagaría en la puerta y no abrió.',
      });
      cashIncidentCount++;
    }
    if (cashOrders.length > 1) {
      const order2 = cashOrders[1];
      const existingIncident2 = await CashPaymentIncident.findOne({ orderId: order2._id, type: CashIncidentType.CASH_NOT_RECEIVED });
      if (!existingIncident2) {
        const Payment = mongoose.model('Payment');
        const payment2 = await Payment.findOne({ orderId: order2._id }).select('_id');
        await CashPaymentIncident.create({
          orderId: order2._id,
          paymentId: payment2?._id ?? new Types.ObjectId(),
          driverId: order2.driverId,
          amount: order2.finance?.customerTotal ?? 20000,
          writtenOffAmount: order2.finance?.merchantCommission ?? 3000,
          currency: 'COP',
          type: CashIncidentType.CASH_NOT_RECEIVED,
          status: CashIncidentStatus.RESOLVED,
          resolution: CashIncidentResolution.DRIVER_FAVOR,
          driverNote: 'El apartamento estaba vacío, nadie respondió.',
          adminNote: 'Se revisó el tracking: el domiciliario sí llegó a la dirección.',
          resolvedAt: now,
          resolvedBy: admin._id,
        });
        cashIncidentCount++;
      }
    }
  }

  console.log('── Resultado ──');
  console.log('Zone:', zoneCount);
  console.log('Review:', reviewCount);
  console.log('ProSubscription:', proCount);
  console.log('Refund:', refundCount);
  console.log('FeatureFlag:', flagCount);
  console.log('Commission:', commissionCount);
  console.log('Coupon:', couponCount, '/ CouponRedemption:', redemptionCount);
  console.log('CampaignSend:', campaignCount);
  console.log('User.referredBy actualizados:', referralCount);
  console.log('LegalDocument:', legalDocCount, '/ LegalAcceptance:', legalAcceptanceCount);
  console.log('FiscalDocument:', fiscalCount);
  console.log('AdInvoice:', adInvoiceCount);
  console.log('Settlement:', settlementCount);
  console.log('CashReconciliation:', cashReconCount, '/ CashPaymentIncident:', cashIncidentCount);

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect();
  process.exit(1);
});
