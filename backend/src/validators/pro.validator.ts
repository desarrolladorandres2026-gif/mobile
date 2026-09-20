import { z } from 'zod';
import { paymentInstrument, noRawCardData } from './payment.validator';

/**
 * POST /pro/subscribe
 *
 * Reutiliza el instrumento de pago de los pedidos —misma unión
 * discriminada, misma guarda contra datos de tarjeta en claro— y le añade
 * la única regla propia de una suscripción: tiene que poder volver a
 * cobrarse dentro de un mes.
 *
 * No hay `amount`: el precio de la membresía lo pone el plan del servidor y
 * no admite ni siquiera un contraste desde la app. Un pedido sí lo acepta
 * porque su total depende del carrito; aquí no depende de nada.
 */
export const subscribeProSchema = z.object({
  body: z
    .object({
      instrument: z
        .unknown()
        .superRefine(noRawCardData)
        .pipe(paymentInstrument)
        .refine((value) => value.kind === 'card_token' || value.kind === 'saved_card', {
          message:
            'Zipp Pro se paga con tarjeta: es la única forma de que la renovación mensual pueda cobrarse sola.',
        }),
      acceptanceToken: z.string().min(20).max(2000),
      personalDataAuthToken: z.string().min(20).max(2000).optional(),
      customerEmail: z.string().trim().toLowerCase().email().max(254).optional(),
      browserInfo: z
        .record(z.string().regex(/^browser_[a-z_]{2,40}$/), z.string().max(400))
        .refine((value) => Object.keys(value).length <= 20, 'Demasiados campos de navegador')
        .optional(),
    })
    .strict(),
});
