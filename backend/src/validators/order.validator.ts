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

const orderItemSchema = z.object({
  productId: z.string(),
  quantity: z.number().int().min(1).max(99),
  selectedExtras: z.array(z.object({
    name: z.string().min(1),
    // Accepted for backwards compatibility with older clients but ignored:
    // extra prices are always read from the product record on the server.
    price: z.number().optional(),
    quantity: z.number().int().min(1).max(99).default(1),
  })).optional().default([]),
  notes: z.string().max(200).optional(),
});

const moneyExtras = {
  couponCode: z.string().trim().max(24).optional(),
  tip: z.number().min(0).optional(),
};

export const createOrderSchema = z.object({
  body: z.object({
    businessId: z.string(),
    items: z.array(orderItemSchema).min(1, 'Mínimo un producto'),
    paymentMethod,
    deliveryAddress: z.string().min(5),
    deliveryDetails: z.string().max(200).optional(),
    deliveryLongitude: z.number().min(-180).max(180),
    deliveryLatitude: z.number().min(-90).max(90),
    notes: z.string().max(200).optional(),
    idempotencyKey: z.string().max(120).optional(),
    ...moneyExtras,
  }),
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
  }),
  query: z.object({}).optional(),
  params: z.object({ id: z.string() }),
});
