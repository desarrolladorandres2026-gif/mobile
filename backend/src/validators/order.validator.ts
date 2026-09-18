import { z } from 'zod';
import { PaymentMethod } from '../types';
import { objectId } from './common';

/**
 * El método de pago, derivado del enum y no escrito a mano.
 *
 * Estaba copiado como `z.enum(['online', 'cash_on_delivery'])` en dos
 * esquemas. Mientras sean literales sueltos, añadir o renombrar un método
 * compila perfectamente y falla en tiempo de ejecución en el esquema que
 * alguien no actualizó; derivándolo del enum, el compilador es quien
 * encuentra el sitio olvidado.
 */
const paymentMethod = z.nativeEnum(PaymentMethod);

/**
 * Un adicional elegido: o un `extra` plano por nombre, o una opción de un
 * grupo de modificadores por `groupId` + `optionId`. Los dos ids van
 * juntos o no van: una opción sin su grupo no se puede resolver, y
 * aceptarla a medias sería adivinar.
 */
const selectedExtraSchema = z
  .object({
    name: z.string().min(1).optional(),
    groupId: objectId.optional(),
    optionId: objectId.optional(),
    // Accepted for backwards compatibility with older clients but ignored:
    // extra prices are always read from the product record on the server.
    price: z.number().optional(),
    quantity: z.number().int().min(1).max(99).default(1),
  })
  .refine((e) => Boolean(e.optionId) === Boolean(e.groupId), {
    message: 'Una opción necesita su grupo',
  })
  .refine((e) => e.optionId || e.name, {
    message: 'El adicional necesita un nombre o una opción',
  });

const orderItemSchema = z.object({
  productId: z.string(),
  quantity: z.number().int().min(1).max(99),
  selectedExtras: z.array(selectedExtraSchema)
    // Un tope que ningún plato real alcanza. Sin él, una sola línea con
    // miles de adicionales obligaba al servidor a resolverlos uno por uno
    // contra el producto en cada cotización.
    .max(50, 'Demasiados adicionales en un solo producto')
    .optional()
    .default([]),
  notes: z.string().max(200).optional(),
});

const moneyExtras = {
  couponCode: z.string().trim().max(24).optional(),
  tip: z.number().min(0).optional(),

  /**
   * Para quién es el pedido, si no es para quien lo paga.
   *
   * El teléfono es obligatorio junto con el nombre: sin él, el
   * domiciliario llamaría a quien pagó —que puede estar en otra ciudad— y
   * el pedido se quedaría en la puerta.
   */
  recipient: z
    .object({
      name: z.string().trim().min(2).max(80),
      phone: z.string().trim().min(7).max(20),
      note: z.string().trim().max(200).optional(),
    })
    .optional(),

  /** Cuándo debe llegar. El servidor valida el margen contra su propio reloj. */
  scheduledFor: z.coerce.date().optional(),
};

/**
 * Cómo paga en efectivo: si necesita vuelto, y con cuánto paga.
 *
 * `payingWith` solo tiene sentido junto con `needsChange: true` — sin
 * vuelto que calcular, no hay billete que declarar. Se valida contra el
 * total del pedido en el servicio, no aquí: el total todavía no existe en
 * este punto, se calcula recién con la cotización.
 */
const cashPaymentSchema = z
  .object({
    needsChange: z.boolean({
      required_error: 'Indica si necesitas cambio',
      invalid_type_error: 'Indica si necesitas cambio',
    }),
    payingWith: z.number().positive().optional(),
  })
  .refine((c) => !c.needsChange || c.payingWith !== undefined, {
    message: 'Indica con cuánto vas a pagar',
    path: ['payingWith'],
  });

export const createOrderSchema = z.object({
  body: z
    .object({
      businessId: z.string(),
      items: z.array(orderItemSchema).min(1, 'Mínimo un producto'),
      paymentMethod,
      deliveryAddress: z.string().min(5),
      deliveryDetails: z.string().max(200).optional(),
      deliveryLongitude: z.number().min(-180).max(180),
      deliveryLatitude: z.number().min(-90).max(90),
      notes: z.string().max(200).optional(),
      idempotencyKey: z.string().max(120).optional(),
      cashPayment: cashPaymentSchema.optional(),
      ...moneyExtras,
    })
    // Se exige aquí y no con un `required` plano en el campo: un pedido
    // digital no tiene nada que declarar, y obligar a mandar `cashPayment`
    // en todos los pedidos rompería esa mitad del flujo para nada.
    .refine(
      (b) => b.paymentMethod !== PaymentMethod.CASH_ON_DELIVERY || !!b.cashPayment,
      { message: 'Indica si necesitas cambio', path: ['cashPayment'] }
    ),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

/** Same shape as creation, minus everything that only matters once an order exists. */
export const quoteOrderSchema = z.object({
  body: z.object({
    businessId: z.string(),
    items: z.array(orderItemSchema).min(1, 'Mínimo un producto'),
    paymentMethod,
    deliveryLongitude: z.number().min(-180).max(180),
    deliveryLatitude: z.number().min(-90).max(90),
    ...moneyExtras,
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

/**
 * PATCH /orders/:id/payment-method
 *
 * `strict()` a propósito: un cuerpo con campos de más aquí sería alguien
 * probando si el endpoint acepta también `total` o `paymentStatus`.
 */
export const changePaymentMethodSchema = z.object({
  body: z.object({ paymentMethod }).strict(),
  query: z.object({}).optional(),
  params: z.object({ id: objectId }),
});

/**
 * POST /orders/:id/cash/confirm
 *
 * El cuerpo lleva la declaración y nada más. En particular **no lleva
 * monto**: el importe sale del pedido en el servidor, y aceptarlo aquí
 * —aunque fuera solo para compararlo— convertiría el endpoint en un sitio
 * donde discutir cuánto se cobró.
 */
export const confirmCashSchema = z.object({
  body: z
    .object({
      received: z.boolean({
        required_error: 'Indica si recibiste el efectivo',
        invalid_type_error: 'Indica si recibiste el efectivo',
      }),
      note: z.string().trim().max(200).optional(),
    })
    .strict(),
  query: z.object({}).optional(),
  params: z.object({ id: objectId }),
});

export const updateOrderStatusSchema = z.object({
  body: z.object({
    status: z.enum(['accepted', 'preparing', 'ready', 'picked_up', 'on_way', 'delivered', 'cancelled']),
    cancellationReason: z.string().max(200).optional(),
    /**
     * Motivo del catálogo cerrado. Es lo que permite responder si se
     * cancela por falta de repartidores o porque los negocios no dan
     * abasto — un texto libre no se puede contar.
     */
    cancellationCode: z
      .enum([
        'client_changed_mind',
        'client_ordered_by_mistake',
        'client_too_slow',
        'client_wrong_address',
        'business_out_of_stock',
        'business_closed',
        'business_too_busy',
        'no_driver_available',
        'driver_incident',
        'client_unreachable',
        'payment_failed',
        'suspected_fraud',
        'other',
      ])
      .optional(),
  }),
  query: z.object({}).optional(),
  params: z.object({ id: z.string() }),
});
