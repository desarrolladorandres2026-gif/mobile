import { z } from 'zod';
import {
  ReviewReasonClientToBusiness, ReviewReasonClientToDriver,
  ReviewReasonDriverToBusiness, ReviewReasonBusinessToDriver,
  ReviewReasonDriverToClient,
} from '../types';

const reasonsArray = <T extends Record<string, string>>(reasonEnum: T) =>
  z.array(z.nativeEnum(reasonEnum)).max(5).optional();

export const createReviewSchema = z.object({
  body: z.object({
    orderId: z.string().min(1, 'orderId es requerido'),
    businessId: z.string().min(1, 'businessId es requerido'),
    driverId: z.string().optional(),
    businessRating: z.number().int().min(1).max(5),
    // Solo tienen sentido en un rating bajo, pero no se obliga aquí: el
    // frontend decide cuándo mostrarlos, y enviarlos en un rating alto no
    // es un error, solo información que nadie va a mirar.
    businessRatingReasons: reasonsArray(ReviewReasonClientToBusiness),
    driverRating: z.number().int().min(1).max(5).optional(),
    driverRatingReasons: reasonsArray(ReviewReasonClientToDriver),
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

export const rateBusinessByDriverSchema = z.object({
  body: z.object({
    rating: z.number().int().min(1).max(5),
    reasons: reasonsArray(ReviewReasonDriverToBusiness),
  }),
});

export const rateDriverByBusinessSchema = z.object({
  body: z.object({
    rating: z.number().int().min(1).max(5),
    reasons: reasonsArray(ReviewReasonBusinessToDriver),
  }),
});

/** Motivos válidos al calificar al cliente, sea negocio o domiciliario quien pregunta. */
export const rateClientReasonsSchema = reasonsArray(ReviewReasonDriverToClient);
