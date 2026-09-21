import { z } from 'zod';
import { objectId } from './common';

const money = z.number().int().min(0);
const bps = z.number().int().min(0).max(10_000);

/**
 * Pricing configuration patch.
 *
 * Strict: an unknown key is rejected rather than ignored, so a typo in a
 * field name fails loudly instead of silently leaving a rate unchanged
 * while the admin believes they changed it.
 */
export const updatePricingConfigSchema = z.object({
  body: z
    .object({
      reason: z.string().min(5).max(300),

      merchantCommissionBps: bps.optional(),
      categoryCommissionBps: z.record(z.string(), bps).optional(),
      commissionAfterMerchantDiscount: z.boolean().optional(),

      driverBaseFee: money.optional(),
      driverPerKm: money.optional(),
      driverMinFee: money.optional(),
      freeRadiusMeters: money.optional(),

      deliveryMarginFixed: money.optional(),
      deliveryMarginBps: bps.optional(),

      deliveryMinFee: money.optional(),
      deliveryMaxFee: money.optional(),
      deliveryRoundingStep: money.optional(),

      serviceFeeFixed: money.optional(),
      serviceFeeBps: bps.optional(),
      serviceFeeMin: money.optional(),
      serviceFeeMax: money.optional(),

      maxTipBps: bps.optional(),
      maxRadiusMeters: money.optional(),
      taxBps: bps.optional(),

      couponSubsidyLimit: money.optional(),
      campaignBudgetTotal: money.optional(),
      defaultMinimumContributionMargin: money.optional(),

      cashOnDeliveryEnabled: z.boolean().optional(),
      cashOnDeliveryMaxAmount: money.optional(),
      // 0 desactiva el techo. Se admite a propósito: apagar la regla no
      // debería exigir un despliegue.
      maxDriverCashDebt: money.optional(),
    })
    .strict()
    .refine(
      (body) => Object.keys(body).some((key) => key !== 'reason'),
      { message: 'Indica al menos un campo a modificar' }
    ),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

export const settleSchema = z.object({
  body: z
    .object({
      beneficiary: z.enum(['business', 'driver']),
      businessId: z.string().optional(),
      driverId: z.string().optional(),
      reference: z.string().max(120).optional(),
    })
    .strict(),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

export const cashIdsSchema = z.object({
  body: z
    .object({
      ids: z.array(z.string()).min(1, 'Selecciona al menos un registro'),
      note: z.string().max(200).optional(),
    })
    .strict(),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

/**
 * Resolución de una incidencia de efectivo.
 *
 * `strict()` y sin monto: la cifra la pone el expediente, que a su vez la
 * tomó del pedido. Un endpoint que aceptara un importe aquí sería un sitio
 * donde renegociar cuánto se debía.
 */
export const resolveCashIncidentSchema = z.object({
  body: z
    .object({
      resolution: z.enum(['driver_favor', 'debt_confirmed', 'closed']),
      adminNote: z.string().trim().max(500).optional(),
      /** Cierra el caso como declaración falsa en vez de como resuelta. */
      reject: z.boolean().optional(),
    })
    .strict(),
  query: z.object({}).optional(),
  params: z.object({ id: objectId }),
});

/** Tomar una incidencia para revisión. No mueve dinero. */
export const cashIncidentIdSchema = z.object({
  body: z.object({}).strict().optional(),
  query: z.object({}).optional(),
  params: z.object({ id: objectId }),
});

/** A driver declaring a remittance. Never settles anything by itself. */
export const reportCashSchema = z.object({
  body: z
    .object({
      ids: z.array(z.string()).optional(),
      reference: z.string().min(4).max(120),
    })
    .strict(),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

export const refundSchema = z.object({
  body: z
    .object({
      // Acotado por arriba además de por abajo: un importe absurdo no debe
      // llegar hasta el reparto por cuentas para que allí lo frene un
      // `assertMoney` que responde 500 en vez de un 400 explicativo.
      amount: z.number().int().positive().max(100_000_000).optional(),
      reason: z.string().min(3).max(300),
      idempotencyKey: z.string().trim().max(120).optional(),
    })
    .strict(),
  query: z.object({}).optional(),
  params: z.object({ orderId: objectId }),
});
