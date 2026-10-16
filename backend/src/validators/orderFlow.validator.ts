import { z } from 'zod';
import { config } from '../config';
import { ItemShortageReason } from '../types';
import { objectId } from './common';

/**
 * Coordenadas opcionales que acompañan a una acción sobre el terreno.
 *
 * Opcionales de verdad: un teléfono puede tener el GPS apagado o estar en
 * un sótano, y eso no puede impedir que se entregue un pedido — sin ellas,
 * `orderSecurityService` simplemente no aplica la geocerca (ver
 * `enforceGeofence`). Cuando SÍ viajan, dejan de ser solo contexto de
 * auditoría: `pickup/verify`, `pickup/arrive`, `delivery/verify` y
 * `delivery/arrive` las comparan contra el destino real. `accuracy` es la
 * precisión que reportó el GPS, en metros; se usa como tolerancia y para
 * decidir si el fix es demasiado impreciso para confiar en él.
 */
const geo = {
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  accuracy: z.number().positive().optional(),
};

const orderParams = z.object({ id: z.string() });

/**
 * El código que teclea el domiciliario.
 *
 * Solo dígitos y con la longitud configurada: cualquier otra cosa se
 * rechaza aquí, antes de tocar la base de datos, así que un intento con
 * basura no gasta uno de los intentos legítimos del pedido.
 */
export const verifyOrderCodeSchema = z.object({
  body: z.object({
    code: z
      .string()
      .trim()
      .regex(/^\d+$/, 'El código solo tiene números')
      .min(4)
      .max(10),
    ...geo,
  }),
  query: z.object({}).optional(),
  params: orderParams,
});

export const orderArrivalSchema = z.object({
  body: z.object({ ...geo }),
  query: z.object({}).optional(),
  params: orderParams,
});

export const orderChatMessageSchema = z.object({
  body: z.object({
    message: z.string().min(1, 'Escribe un mensaje').max(config.orderFlow.chat.maxLength),
    /**
     * Solo lo usa el domiciliario, que habla con el cliente y con el comercio.
     * Para los demás el servidor lo ignora: su hilo lo decide su papel.
     */
    channel: z.enum(['client_driver', 'business_driver']).optional(),
  }),
  query: z.object({}).optional(),
  params: orderParams,
});

export const orderCallSchema = z.object({
  body: z.object({ reason: z.string().max(120).optional() }).optional(),
  query: z.object({}).optional(),
  params: z.object({ id: z.string(), callId: z.string() }),
});

/**
 * Aviso de un producto que falta. `itemId` es el `_id` de la línea en
 * `order.items`; el servidor vuelve a comprobar que exista y que las cantidades
 * quepan. Estricto: un campo de más (p. ej. un `refundAmount` que alguien
 * intente imponer) es un 400, no se ignora en silencio.
 */
export const reportItemShortageSchema = z.object({
  body: z
    .object({
      reason: z.nativeEnum(ItemShortageReason, {
        errorMap: () => ({ message: 'Indica el motivo: se agotó, está dañado u otro' }),
      }),
      note: z.string().trim().max(200).optional(),
      items: z
        .array(
          z
            .object({
              itemId: objectId,
              missingQty: z.number().int('Debe ser un entero').min(1, 'Debe faltar al menos 1').max(999),
            })
            .strict()
        )
        .min(1, 'Indica qué producto falta')
        .max(50),
    })
    .strict(),
  query: z.object({}).optional(),
  params: z.object({ id: objectId }),
});

/** Respuesta del cliente a la consulta: sigue sin el producto (`true`) o cancela (`false`). */
export const respondItemShortageSchema = z.object({
  body: z
    .object({
      accept: z.boolean({
        required_error: 'Indica si sigues sin ese producto',
        invalid_type_error: 'Indica si sigues sin ese producto',
      }),
    })
    .strict(),
  query: z.object({}).optional(),
  params: z.object({ id: objectId }),
});
