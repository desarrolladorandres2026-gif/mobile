import crypto from 'crypto';
import mongoose from 'mongoose';
import { config } from '../config';
import { Advertisement, Business, Coupon, Order, Product, Review } from '../models';
import { AdApprovalStatus, AdPricingModel, AdPlacement } from '../models/Advertisement';
import { CouponFundedBy, CouponScope, CouponType, OrderStatus, ReviewReasonClientToBusiness } from '../types';
import { reviewService } from '../services/review.service';

/**
 * Promociones, publicidad y reseñas de demostración para "Terminal neiva"
 * (solo dev). Cinco de cada una, para ver esas pantallas del panel de
 * comercios con datos en todos sus estados. Idempotente: cupones y campañas
 * por título/nombre dentro del negocio, reseñas por pedido.
 *
 * Las reseñas cuelgan de pedidos entregados de `seedDemoOrdersTerminalNeiva`
 * (no se inventa un pedido: la reseña es única por pedido). Los contadores de
 * las campañas son de muestra; no genera facturas ni toca el libro mayor.
 */

const SLUG = 'terminal-neiva';
const DAY = 24 * 60 * 60_000;

async function seedCoupons(businessId: mongoose.Types.ObjectId, byName: Map<string, mongoose.Types.ObjectId>) {
  const now = Date.now();
  const base = {
    fundedBy: CouponFundedBy.BUSINESS,
    scope: CouponScope.PRODUCT,
    businessId,
    city: 'Neiva',
    campaignApproved: false,
    isActive: true,
  };
  const specs = [
    {
      title: 'Pizza Mitad y Mitad -15%',
      description: 'Descuento automático en la pizza de la casa.',
      autoApply: true,
      productIds: [byName.get('Pizza Mitad y Mitad')!],
      type: CouponType.PERCENTAGE,
      value: 15,
      validFrom: new Date(now - 2 * DAY),
      validUntil: new Date(now + 12 * DAY),
      budgetLimit: 150_000,
    },
    {
      title: 'Alitas BBQ x8 con $3.000 menos',
      description: 'Se descuenta sola al pedir las alitas.',
      autoApply: true,
      productIds: [byName.get('Alitas BBQ x8')!],
      type: CouponType.FIXED,
      value: 3000,
      validFrom: new Date(now - DAY),
      validUntil: new Date(now + 20 * DAY),
      budgetLimit: 90_000,
    },
    {
      title: 'Terminal 10%',
      description: '10% en tu pedido, hasta $8.000 de descuento.',
      code: 'TERMINAL10',
      type: CouponType.PERCENTAGE,
      value: 10,
      maxDiscount: 8000,
      minOrderAmount: 25_000,
      perUserLimit: 3,
      usageLimit: 200,
      isPublic: true,
      validFrom: new Date(now - 5 * DAY),
      validUntil: new Date(now + 30 * DAY),
      budgetLimit: 200_000,
    },
    {
      title: 'Primer pedido -20%',
      description: 'Para quien estrena Terminal Neiva en ZIPP.',
      code: 'TERMINALPRIMERO',
      type: CouponType.PERCENTAGE,
      value: 20,
      maxDiscount: 10_000,
      firstOrderOnly: true,
      perUserLimit: 1,
      isPublic: true,
      validFrom: new Date(now - 3 * DAY),
      validUntil: new Date(now + 45 * DAY),
      budgetLimit: 300_000,
    },
    {
      title: 'Jueves de $4.000 menos',
      description: 'Los jueves, $4.000 menos en pedidos desde $30.000.',
      code: 'JUEVESTERMINAL',
      type: CouponType.FIXED,
      value: 4000,
      minOrderAmount: 30_000,
      validDays: [4],
      perUserLimit: 0,
      usageLimit: 100,
      isPublic: false,
      validFrom: new Date(now - DAY),
      validUntil: new Date(now + 60 * DAY),
      budgetLimit: 120_000,
    },
  ];

  let created = 0;
  for (const s of specs) {
    if (await Coupon.exists({ businessId, title: s.title })) continue;
    const code = s.autoApply
      ? `AUTO-${businessId.toString().slice(-6)}-${crypto.randomBytes(5).toString('hex')}`.toUpperCase()
      : s.code;
    await Coupon.create({ ...base, ...s, code });
    created += 1;
  }
  return created;
}

async function seedAds(business: InstanceType<typeof Business>) {
  const flyerUrl = business.coverImage || business.logo;
  if (!flyerUrl) throw new Error('El negocio no tiene portada ni logo para usar de flyer');
  const now = Date.now();
  const common = {
    advertiserName: business.name,
    flyerUrl,
    actionType: 'business',
    businessId: business._id,
    billedToBusinessId: business._id,
    targetCities: ['Neiva'],
  };

  const specs = [
    {
      campaignName: 'Salchipapas de la Terminal',
      pricingModel: AdPricingModel.CPM,
      cpmRate: 12_000,
      budget: 150_000,
      maxImpressions: 12_500,
      impressionCount: 1840,
      clickCount: 96,
      placement: AdPlacement.EXPLORE,
      startDate: new Date(now - 6 * DAY),
      endDate: new Date(now + 24 * DAY),
      approvalStatus: AdApprovalStatus.APPROVED,
      isActive: true,
    },
    {
      campaignName: 'Pizza para el viaje',
      pricingModel: AdPricingModel.CPC,
      cpcRate: 600,
      budget: 90_000,
      maxClicks: 150,
      impressionCount: 920,
      clickCount: 41,
      placement: AdPlacement.SPLASH,
      startDate: new Date(now - 3 * DAY),
      endDate: new Date(now + 27 * DAY),
      approvalStatus: AdApprovalStatus.APPROVED,
      isActive: true,
    },
    {
      campaignName: 'Alitas BBQ de fin de semana',
      pricingModel: AdPricingModel.CPM,
      cpmRate: 10_000,
      budget: 100_000,
      maxImpressions: 10_000,
      placement: AdPlacement.EXPLORE,
      startDate: new Date(now + 2 * DAY),
      endDate: new Date(now + 16 * DAY),
      approvalStatus: AdApprovalStatus.PENDING,
      isActive: false,
    },
    {
      campaignName: 'Mazorcada mixta',
      pricingModel: AdPricingModel.CPC,
      cpcRate: 500,
      budget: 50_000,
      maxClicks: 100,
      placement: AdPlacement.SPLASH,
      startDate: new Date(now + DAY),
      endDate: new Date(now + 10 * DAY),
      approvalStatus: AdApprovalStatus.REJECTED,
      rejectionReason: 'El texto del flyer no se lee bien en pantalla pequeña. Súbelo con letra más grande.',
      isActive: false,
    },
    {
      campaignName: 'Reapertura de la terminal',
      pricingModel: AdPricingModel.CPM,
      cpmRate: 8000,
      budget: 80_000,
      maxImpressions: 10_000,
      impressionCount: 9_870,
      clickCount: 212,
      placement: AdPlacement.EXPLORE,
      startDate: new Date(now - 40 * DAY),
      endDate: new Date(now - 10 * DAY),
      approvalStatus: AdApprovalStatus.APPROVED,
      isActive: true,
    },
  ];

  let created = 0;
  for (const s of specs) {
    if (await Advertisement.exists({ billedToBusinessId: business._id, campaignName: s.campaignName })) continue;
    await Advertisement.create({ ...common, ...s });
    created += 1;
  }
  return created;
}

interface ReviewSeed {
  orderKey: string;
  rating: number;
  driverRating?: number;
  comment: string;
  reasons?: ReviewReasonClientToBusiness[];
  reply?: string;
}

const REVIEWS: ReviewSeed[] = [
  { orderKey: 'd1', rating: 5, driverRating: 5, comment: 'Los cubanos llegaron calientes y llenos. Repito seguro.', reply: '¡Gracias! Te esperamos de nuevo.' },
  { orderKey: 'd3', rating: 4, driverRating: 5, comment: 'La pizza muy rica, solo se demoró un poco más de lo dicho.' },
  { orderKey: 'n9', rating: 5, driverRating: 4, comment: 'El perro americano, de lo mejor de la terminal.' },
  {
    orderKey: 'n11',
    rating: 2,
    driverRating: 4,
    comment: 'Faltó el patacón y los sándwiches estaban tibios.',
    reasons: [ReviewReasonClientToBusiness.MISSING_ITEM, ReviewReasonClientToBusiness.BAD_CONDITION],
    reply: 'Lamentamos lo del patacón. Escríbenos y te lo compensamos en tu próximo pedido.',
  },
  { orderKey: 'd2', rating: 4, comment: 'Buen patacón y buen precio. El jugo un poco aguado.' },
];

async function seedReviews(business: InstanceType<typeof Business>) {
  let created = 0;
  for (const r of REVIEWS) {
    const order = await Order.findOne({
      idempotencyKey: `demo-terminal-neiva-${r.orderKey}`,
      status: OrderStatus.DELIVERED,
    });
    if (!order) throw new Error(`Falta el pedido entregado ${r.orderKey}; corre seedDemoOrdersTerminalNeiva primero`);
    if (await Review.exists({ orderId: order._id })) continue;

    const at = new Date((order.deliveredAt ?? order.createdAt).getTime() + 25 * 60_000);
    await Review.collection.insertOne({
      orderId: order._id,
      userId: order.clientId,
      businessId: business._id,
      driverId: order.driverId ?? null,
      businessRating: r.rating,
      businessRatingReasons: r.reasons,
      driverRating: order.driverId ? r.driverRating ?? null : null,
      comment: r.comment,
      businessReply: r.reply,
      businessRepliedAt: r.reply ? new Date(at.getTime() + 3 * 60 * 60_000) : undefined,
      productFeedback: order.items.map((i) => ({ productId: i.productId, liked: r.rating >= 4 })),
      isHidden: false,
      createdAt: at,
      updatedAt: at,
    });
    created += 1;
  }
  await reviewService.recalculateBusinessRating(business._id.toString());
  return created;
}

async function main(): Promise<void> {
  if (config.nodeEnv === 'production') {
    console.error('Este script no corre en producción.');
    process.exit(1);
  }
  await mongoose.connect(config.mongodb.uri);

  const business = await Business.findOne({ slug: SLUG });
  if (!business) throw new Error(`No existe el negocio ${SLUG}`);
  const products = await Product.find({ businessId: business._id }).select('_id name');
  const byName = new Map(products.map((p) => [p.name, p._id as mongoose.Types.ObjectId]));
  for (const n of ['Pizza Mitad y Mitad', 'Alitas BBQ x8']) {
    if (!byName.has(n)) throw new Error(`Producto no encontrado: ${n}`);
  }

  const coupons = await seedCoupons(business._id as mongoose.Types.ObjectId, byName);
  const ads = await seedAds(business);
  const reviews = await seedReviews(business);
  console.log(`Promociones: ${coupons} · Campañas: ${ads} · Reseñas: ${reviews}`);
  await mongoose.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
