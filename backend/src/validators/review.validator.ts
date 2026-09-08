import { z } from 'zod';

export const createReviewSchema = z.object({
  body: z.object({
    orderId: z.string().min(1, 'orderId es requerido'),
    businessId: z.string().min(1, 'businessId es requerido'),
    driverId: z.string().optional(),
    businessRating: z.number().int().min(1).max(5),
    driverRating: z.number().int().min(1).max(5).optional(),
    comment: z.string().max(500).optional(),
    /**
     * Pulgar arriba o abajo por plato. Opcional: la calificación del pedido
     * vale por sí sola, y exigir opinión de cada producto convertiría una
     * pantalla de dos toques en un formulario.
     */
    productFeedback: z
      .array(z.object({ productId: z.string().length(24), liked: z.boolean() }))
      .max(50)
      .optional(),
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});
