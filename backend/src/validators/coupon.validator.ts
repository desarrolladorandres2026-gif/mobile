import { z } from 'zod';
import { MAX_MERCHANT_PERCENT_DISCOUNT } from '../models/Coupon';

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

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Hora inválida (HH:mm)');

/**
 * La franja horaria de una promoción: las dos horas o ninguna, y la de inicio
 * antes que la de fin (una franja que cruza medianoche no se puede evaluar y
 * quedaría muerta). El servicio repite la comprobación para quien lo llame sin
 * pasar por aquí.
 */
const timeWindowRefine = (body: { validFromTime?: string; validUntilTime?: string }) => {
  const hasFrom = !!body.validFromTime;
  const hasUntil = !!body.validUntilTime;
  if (hasFrom !== hasUntil) return false;
  return !(hasFrom && body.validFromTime! >= body.validUntilTime!);
};
const TIME_WINDOW_MESSAGE =
  'Indica la hora de inicio y la de fin (el inicio antes que el fin; la franja no puede cruzar la medianoche), o ninguna';

const businessCouponBody = z
  .object({
    // Con código: requerido. Automática (`autoApply: true`): ausente, el
    // servicio genera uno sintético que el panel nunca muestra.
    code: z.string().trim().min(3).max(20).optional(),
    title: z.string().trim().min(3).max(80),
    description: z.string().trim().max(200).optional(),
    // El envío gratis de un comercio no es un cupón: es el umbral de su perfil.
    // Un cupón de domicilio sería plata de ZIPP y del domiciliario, no suya.
    type: z.enum(['percentage', 'fixed']),
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
    validDays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
    validFromTime: hhmm.optional(),
    validUntilTime: hhmm.optional(),
    /** Sin código: se aplica sola cuando el carrito trae alguno de `productIds`. */
    autoApply: z.boolean().optional(),
    productIds: z.array(objectId).max(50).optional(),
  })
  .refine((body) => body.type !== 'percentage' || body.value <= MAX_MERCHANT_PERCENT_DISCOUNT, {
    message: `Un descuento porcentual de comercio no puede pasar del ${MAX_MERCHANT_PERCENT_DISCOUNT}%`,
    path: ['value'],
  })
  .refine((body) => body.type !== 'fixed' || Number.isInteger(body.value), {
    message: 'El monto fijo debe ser un número entero de pesos',
    path: ['value'],
  })
  // Un tope de descuento solo significa algo en un porcentaje: en un monto
  // fijo el tope ya es el monto.
  .refine((body) => body.type === 'percentage' || (!body.maxDiscount && !body.maxDiscountAmount), {
    message: 'El tope del descuento solo aplica a promociones por porcentaje',
    path: ['maxDiscountAmount'],
  })
  .refine(timeWindowRefine, { message: TIME_WINDOW_MESSAGE, path: ['validFromTime'] })
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
  body: z
    .object({
      title: z.string().trim().min(3).max(80).optional(),
      description: z.string().trim().max(200).optional(),
      value: z.number().min(0).optional(),
      maxDiscount: z.number().min(0).optional(),
      maxDiscountAmount: z.number().int().min(0).optional(),
      minOrderAmount: z.number().min(0).optional(),
      budgetLimit: z.number().min(0).optional(),
      usageLimit: z.number().int().min(0).optional(),
      perUserLimit: z.number().int().min(0).optional(),
      firstOrderOnly: z.boolean().optional(),
      validFrom: z.coerce.date().optional(),
      validUntil: z.coerce.date().optional(),
      validDays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
      validFromTime: hhmm.or(z.literal('')).optional(),
      validUntilTime: hhmm.or(z.literal('')).optional(),
      isPublic: z.boolean().optional(),
      productIds: z.array(objectId).max(50).optional(),
      isActive: z.boolean().optional(),
    })
    .refine(timeWindowRefine, { message: TIME_WINDOW_MESSAGE, path: ['validFromTime'] }),
  query: z.object({}).optional(),
  params: z.object({ id: objectId }),
});

/**
 * Previsualización de una promoción antes de crearla o activarla. Mismo
 * subconjunto que la creación —nada de `fundedBy` ni de campos de ZIPP— y sin
 * código ni productos reales: solo lo que cambia el dinero.
 */
const previewDraft = z
  .object({
    type: z.enum(['percentage', 'fixed']),
    value: z.number().min(0),
    maxDiscount: z.number().min(0).optional(),
    maxDiscountAmount: z.number().int().min(0).optional(),
    minOrderAmount: z.number().min(0).optional(),
    autoApply: z.boolean().optional(),
    firstOrderOnly: z.boolean().optional(),
    budgetLimit: z.number().min(0).optional(),
    usageLimit: z.number().int().min(0).optional(),
    perUserLimit: z.number().int().min(0).optional(),
    validFrom: z.coerce.date().optional(),
    validUntil: z.coerce.date().optional(),
  })
  .strict();

export const previewBusinessPromotionSchema = z.object({
  body: z
    .object({
      draft: previewDraft.nullable().optional(),
      /** Umbral de envío gratis a evaluar en lugar del guardado. */
      freeDeliveryThreshold: z.number().int().min(0).max(1_000_000).optional(),
      subtotals: z.array(z.number().int().min(0).max(5_000_000)).min(1).max(6).optional(),
      distanceKm: z.number().min(0).max(50).optional(),
      paymentMethod: z.enum(['online', 'cash_on_delivery']).optional(),
    })
    .strict()
    .refine((body) => body.draft || body.freeDeliveryThreshold !== undefined, {
      message: 'Indica una promoción o un umbral de envío gratis para simular',
    }),
  query: z.object({}).optional(),
  params: z.object({ businessId: objectId }),
});

/**
 * Simulación del administrador: además de lo del comercio, puede probar una
 * campaña financiada por ZIPP y con otro alcance. Sigue siendo solo lectura.
 */
export const previewAdminPromotionSchema = z.object({
  body: z
    .object({
      businessId: objectId,
      draft: z
        .object({
          type: z.enum(['percentage', 'fixed', 'free_delivery']),
          scope: z.enum(['product', 'delivery', 'service_fee']).optional(),
          value: z.number().min(0),
          maxDiscount: z.number().min(0).optional(),
          maxDiscountAmount: z.number().int().min(0).optional(),
          minOrderAmount: z.number().min(0).optional(),
          fundedBy: z.enum(['platform', 'business']).optional(),
          minimumContributionMargin: z.number().int().min(-1).optional(),
          campaignApproved: z.boolean().optional(),
          firstOrderOnly: z.boolean().optional(),
          budgetLimit: z.number().int().min(0).optional(),
          usageLimit: z.number().int().min(0).optional(),
          perUserLimit: z.number().int().min(0).optional(),
          validFrom: z.coerce.date().optional(),
          validUntil: z.coerce.date().optional(),
        })
        .strict(),
      subtotals: z.array(z.number().int().min(0).max(5_000_000)).min(1).max(6).optional(),
      distanceKm: z.number().min(0).max(50).optional(),
      paymentMethod: z.enum(['online', 'cash_on_delivery']).optional(),
    })
    .strict(),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});
