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

// ── Promociones que crea el propio comercio ──
//
// Subconjunto reducido: `fundedBy`, `businessId` y `campaignApproved` nunca
// se leen del body (el servicio los fuerza), así que ni siquiera se
// declaran aquí — no hay forma de que la petición los cuele.
const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Identificador inválido');

const businessCouponBody = z
  .object({
    // Con código: requerido. Automática (`autoApply: true`): ausente, el
    // servicio genera uno sintético que el panel nunca muestra.
    code: z.string().trim().min(3).max(20).optional(),
    title: z.string().trim().min(3).max(80),
    description: z.string().trim().max(200).optional(),
    type: z.enum(['percentage', 'fixed', 'free_delivery']),
    scope: z.enum(['product', 'delivery']).optional(),
    value: z.number().min(0),
    maxDiscount: z.number().min(0).optional(),
    maxDiscountAmount: z.number().int().min(0).optional(),
    minOrderAmount: z.number().min(0).optional(),
    budgetLimit: z.number().min(0).optional(),
    usageLimit: z.number().int().min(0).optional(),
    perUserLimit: z.number().int().min(0).optional(),
    firstOrderOnly: z.boolean().optional(),
    validFrom: z.coerce.date().optional(),
    validUntil: z.coerce.date(),
    isPublic: z.boolean().optional(),
    /** Sin código: se aplica sola cuando el carrito trae alguno de `productIds`. */
    autoApply: z.boolean().optional(),
    productIds: z.array(objectId).max(50).optional(),
  })
  .refine((body) => body.type !== 'percentage' || body.value <= 90, {
    message: 'Un descuento porcentual de comercio no puede pasar del 90%',
    path: ['value'],
  })
  .refine((body) => !body.autoApply || (body.productIds && body.productIds.length > 0), {
    message: 'Una promoción automática debe cubrir al menos un producto',
    path: ['productIds'],
  })
  .refine((body) => (body.productIds?.length ?? 0) === 0 || body.autoApply === true, {
    message: 'Solo una promoción automática puede tener productos asociados',
    path: ['autoApply'],
  })
  .refine((body) => body.autoApply || (body.code && body.code.length >= 3), {
    message: 'El código es requerido',
    path: ['code'],
  });

export const businessCouponSchema = z.object({
  body: businessCouponBody,
  query: z.object({}).optional(),
  params: z.object({ businessId: z.string() }),
});

export const updateBusinessCouponSchema = z.object({
  body: z.object({
    title: z.string().trim().min(3).max(80).optional(),
    description: z.string().trim().max(200).optional(),
    value: z.number().min(0).optional(),
    maxDiscount: z.number().min(0).optional(),
    maxDiscountAmount: z.number().int().min(0).optional(),
    minOrderAmount: z.number().min(0).optional(),
    budgetLimit: z.number().min(0).optional(),
    usageLimit: z.number().int().min(0).optional(),
    perUserLimit: z.number().int().min(0).optional(),
    validFrom: z.coerce.date().optional(),
    validUntil: z.coerce.date().optional(),
    productIds: z.array(objectId).max(50).optional(),
    isActive: z.boolean().optional(),
  }),
  query: z.object({}).optional(),
  params: z.object({ id: objectId }),
});
