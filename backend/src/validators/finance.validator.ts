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

      // Comisión de la pasarela por método (contrato con Wompi).
      gatewayCardBps: bps.optional(),
      gatewayCardFixed: money.optional(),
      gatewayPseBps: bps.optional(),
      gatewayPseFixed: money.optional(),
      gatewayNequiBps: bps.optional(),
      gatewayNequiFixed: money.optional(),
      gatewayOtherBps: bps.optional(),
      gatewayOtherFixed: money.optional(),
      gatewayFeeVatBps: bps.optional(),
      gatewayFeeVatBase: z.enum(['total', 'fixed']).optional(),
      // null = sin definir; 0 = no reembolsable; 10000 = reembolsable.
      gatewayFeeRefundBps: bps.nullable().optional(),
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
      businessId: objectId.optional(),
      driverId: objectId.optional(),
      reference: z.string().max(120).optional(),
    })
    .strict()
    // Sin este filtro, `settle({beneficiary: 'business'})` sin `businessId`
    // reclama TODOS los payouts PAYABLE de negocio de la plataforma en una
    // sola liquidación — un solo comercio equivocado se lleva el dinero de
    // todos los demás.
    .refine((body) => (body.beneficiary === 'business' ? Boolean(body.businessId) : true), {
      message: 'businessId es obligatorio para liquidar a un comercio',
      path: ['businessId'],
    })
    .refine((body) => (body.beneficiary === 'driver' ? Boolean(body.driverId) : true), {
      message: 'driverId es obligatorio para liquidar a un domiciliario',
      path: ['driverId'],
    }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

export const listSettlementsSchema = z.object({
  body: z.object({}).strict().optional(),
  query: z.object({
    beneficiary: z.enum(['business', 'driver']).optional(),
    businessId: objectId.optional(),
    driverId: objectId.optional(),
    paymentStatus: z.enum(['pending', 'paid']).optional(),
    page: z.coerce.number().int().min(1).max(10_000).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  }),
  params: z.object({}).optional(),
});

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (AAAA-MM-DD)');

export const listPaymentsSchema = z.object({
  body: z.object({}).strict().optional(),
  query: z.object({
    status: z.enum(['pending', 'paid', 'refunded', 'failed']).optional(),
    methodType: z.string().trim().max(40).regex(/^[A-Za-z_]+$/).optional(),
    from: isoDay.optional(),
    to: isoDay.optional(),
    page: z.coerce.number().int().min(1).max(10_000).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  }),
  params: z.object({}).optional(),
});

export const paymentsDailySchema = z.object({
  body: z.object({}).strict().optional(),
  query: z.object({ from: isoDay.optional(), to: isoDay.optional() }),
  params: z.object({}).optional(),
});

export const financeExportSchema = z.object({
  body: z
    .object({
      reason: z.string().trim().min(5, 'Indica el motivo del exporte').max(300),
      totpToken: z.string().trim().min(6).max(12),
      from: isoDay.optional(),
      to: isoDay.optional(),
    })
    .strict(),
  query: z.object({}).optional(),
  params: z.object({ kind: z.enum(['ledger', 'settlements', 'refunds', 'payments', 'cash', 'documents']) }),
});

export const listAdInvoicesSchema = z.object({
  body: z.object({}).strict().optional(),
  query: z.object({
    view: z.enum(['to_deduct', 'deducted', 'to_collect', 'collected']).optional(),
    page: z.coerce.number().int().min(1).max(10_000).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  }),
  params: z.object({}).optional(),
});

export const collectAdInvoiceSchema = z.object({
  body: z
    .object({
      reference: z.string().trim().min(3).max(120),
      receiptUrl: z.string().trim().url().max(500),
    })
    .strict(),
  query: z.object({}).optional(),
  params: z.object({ id: objectId }),
});

export const listFiscalDocumentsSchema = z.object({
  body: z.object({}).strict().optional(),
  query: z.object({
    month: z.string().regex(/^\d{4}-\d{2}$/, 'Mes inválido (AAAA-MM)').optional(),
    page: z.coerce.number().int().min(1).max(10_000).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  }),
  params: z.object({}).optional(),
});

export const listPayablesSchema = z.object({
  body: z.object({}).strict().optional(),
  query: z.object({ beneficiary: z.enum(['business', 'driver']).optional() }),
  params: z.object({}).optional(),
});

export const settlementIdParamSchema = z.object({
  params: z.object({ id: objectId }),
});

export const settlementPaymentSchema = z.object({
  body: z
    .object({
      method: z.enum(['bank_transfer', 'nequi', 'daviplata', 'cash', 'other']),
      reference: z.string().trim().min(3).max(120),
      paidAt: z.coerce.date().optional(),
      // Obligatorio (decisión 7): referencia y comprobante, no uno u otro.
      receiptUrl: z.string().trim().url().max(500),
      note: z.string().trim().max(500).optional(),
    })
    .strict(),
  query: z.object({}).optional(),
  params: z.object({ id: objectId }),
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
 * Verificar efectivo exige la prueba de la consignación: sin referencia y
 * sin comprobante, "verificar" era darle crédito a la palabra del
 * domiciliario sobre dinero real.
 */
export const verifyCashSchema = z.object({
  body: z
    .object({
      ids: z.array(z.string()).min(1, 'Selecciona al menos un registro'),
      reference: z.string().trim().min(4).max(200),
      receiptUrl: z.string().trim().url().max(500),
      // Obligatorio: tiene que coincidir con la suma de los registros
      // seleccionados, o el servicio lo rechaza. Sin esto, "verificar" no
      // comprobaba que el monto real consignado fuera el que se debía.
      amount: z.number().int().positive(),
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

export const externalRefundSchema = z.object({
  body: z
    .object({
      amount: z.number().int().positive().max(100_000_000),
      reason: z.string().min(3).max(300),
      externalReference: z.string().trim().min(3).max(120),
    })
    .strict(),
  query: z.object({}).optional(),
  params: z.object({ orderId: objectId }),
});

export const listClawbacksSchema = z.object({
  body: z.object({}).strict().optional(),
  query: z.object({
    status: z.enum(['open', 'collected', 'written_off']).optional(),
    businessId: objectId.optional(),
  }),
  params: z.object({}).optional(),
});

export const collectClawbackSchema = z.object({
  body: z
    .object({
      reference: z.string().trim().min(3).max(120),
      receiptUrl: z.string().trim().url().max(500),
    })
    .strict(),
  query: z.object({}).optional(),
  params: z.object({ id: objectId }),
});

export const writeOffClawbackSchema = z.object({
  body: z
    .object({
      reason: z.string().trim().min(5).max(500),
    })
    .strict(),
  query: z.object({}).optional(),
  params: z.object({ id: objectId }),
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

export const listAllRefundsSchema = z.object({
  body: z.object({}).strict().optional(),
  query: z.object({
    status: z.enum(['pending', 'completed', 'failed']).optional(),
    kind: z.enum(['full', 'partial', 'chargeback', 'external']).optional(),
    attention: z.enum(['true', 'false']).optional(),
    page: z.coerce.number().int().min(1).max(10_000).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  }),
  params: z.object({}).optional(),
});
