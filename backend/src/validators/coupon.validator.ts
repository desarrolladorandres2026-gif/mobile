import { z } from 'zod';

export const validateCouponSchema = z.object({
  body: z.object({
    code: z.string().trim().min(1, 'Ingresa un código').max(24),
    businessId: z.string(),
    subtotal: z.number().min(0),
    deliveryFee: z.number().min(0).optional().default(0),
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

const couponBody = z.object({
  code: z.string().trim().min(3).max(24).regex(/^[A-Za-z0-9_-]+$/, 'Código inválido'),
  title: z.string().trim().min(3).max(80),
  description: z.string().max(200).optional(),
  type: z.enum(['percentage', 'fixed', 'free_delivery']),
  value: z.number().min(0),
  maxDiscount: z.number().min(0).optional(),

  // ── Financiación y presupuesto ──
  // Sin estos campos el validador los descartaba en silencio (Zod ignora las
  // claves que no declara), así que toda promoción creada por la API nacía
  // financiada por la plataforma y con presupuesto ilimitado, aunque el
  // administrador hubiera elegido otra cosa. El modelo siempre supo
  // expresarlo; la API no lo dejaba pasar.
  fundedBy: z.enum(['platform', 'business']).optional(),
  scope: z.enum(['product', 'delivery', 'service_fee']).optional(),
  maxDiscountAmount: z.number().int().min(0).optional(),
  budgetLimit: z.number().int().min(0).optional(),
  /** -1 = usar el mínimo por defecto de la configuración de plataforma. */
  minimumContributionMargin: z.number().int().min(-1).optional(),

  minOrderAmount: z.number().min(0).optional(),
  validFrom: z.coerce.date().optional(),
  validUntil: z.coerce.date(),
  usageLimit: z.number().int().min(0).optional(),
  perUserLimit: z.number().int().min(0).optional(),
  businessId: z.string().nullable().optional(),
  city: z.string().max(80).optional(),
  firstOrderOnly: z.boolean().optional(),
  zoneIds: z.array(z.string()).max(50).optional(),
  eligibleRoles: z.array(z.enum(['client', 'driver', 'business', 'admin'])).max(4).optional(),
  validDays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  validFromTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  validUntilTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  /**
   * Deja correr una campaña por debajo del margen mínimo. Se acepta aquí
   * para que la API pueda expresarlo, pero el controlador sólo lo honra
   * cuando quien firma la petición es administrador financiero.
   */
  campaignApproved: z.boolean().optional(),
  isActive: z.boolean().optional(),
  isPublic: z.boolean().optional(),
});

export const createCouponSchema = z.object({
  body: couponBody,
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

export const updateCouponSchema = z.object({
  body: couponBody.partial(),
  query: z.object({}).optional(),
  params: z.object({ id: z.string() }),
});
