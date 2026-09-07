import { z } from 'zod';
import { config } from '../config';

/**
 * Coordenadas opcionales que acompañan a una acción sobre el terreno.
 *
 * Opcionales de verdad: un teléfono puede tener el GPS apagado o estar en
 * un sótano, y eso no puede impedir que se entregue un pedido. Se guardan
 * como contexto para auditoría, nunca como condición.
 */
const geo = {
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
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
  }),
  query: z.object({}).optional(),
  params: orderParams,
});

export const orderCallSchema = z.object({
  body: z.object({ reason: z.string().max(120).optional() }).optional(),
  query: z.object({}).optional(),
  params: z.object({ id: z.string(), callId: z.string() }),
});
