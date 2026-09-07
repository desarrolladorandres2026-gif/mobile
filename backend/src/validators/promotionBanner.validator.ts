import { z } from 'zod';
import { BusinessCategory } from '../types';
import { BANNER_SCREEN_KEYS, BANNER_DURATION } from '../models/PromotionBanner';

const OBJECT_ID = /^[a-f\d]{24}$/i;

const actionTypes = ['none', 'url', 'business', 'category', 'screen'] as const;
const placements = ['home', 'all'] as const;

/**
 * El destino tiene que corresponder al tipo de acción.
 *
 * Se comprueba aquí además de en el esquema de Mongoose porque un 400 con
 * el campo señalado es lo que el panel puede mostrarle al administrador;
 * un ValidationError de Mongoose llega tarde y peor explicado.
 */
const actionValueMatchesType = (data: {
  actionType?: (typeof actionTypes)[number];
  actionValue?: string;
}) => {
  const value = (data.actionValue ?? '').trim();
  switch (data.actionType) {
    case 'url':
      return /^https?:\/\/.+/i.test(value);
    case 'business':
      return OBJECT_ID.test(value);
    case 'category':
      return (Object.values(BusinessCategory) as string[]).includes(value);
    case 'screen':
      return BANNER_SCREEN_KEYS.includes(value);
    default:
      return true;
  }
};

const ACTION_VALUE_ERROR = {
  message: 'El destino no corresponde al tipo de acción elegido',
  path: ['actionValue'],
};

const bannerFields = {
  imageUrl: z.string().trim().min(1, 'La imagen del banner es requerida').max(2048),
  title: z.string().trim().max(60, 'El título no puede exceder 60 caracteres').optional(),
  description: z.string().trim().max(140, 'La descripción no puede exceder 140 caracteres').optional(),
  buttonText: z.string().trim().max(24, 'El texto del botón no puede exceder 24 caracteres').optional(),
  actionType: z.enum(actionTypes).optional(),
  actionValue: z.string().trim().max(2048).optional(),
  displayOrder: z.number().int().min(0).max(999).optional(),
  durationSeconds: z
    .number()
    .int()
    .min(BANNER_DURATION.min, `La duración mínima es ${BANNER_DURATION.min} segundos`)
    .max(BANNER_DURATION.max, `La duración máxima es ${BANNER_DURATION.max} segundos`)
    .optional(),
  startDate: z.coerce.date(),
  endDate: z.coerce.date(),
  isActive: z.boolean().optional(),
  priority: z.number().int().min(0).max(100).optional(),
  placement: z.enum(placements).optional(),
};

const createBody = z
  .object(bannerFields)
  .refine((data) => data.endDate > data.startDate, {
    message: 'La fecha de finalización debe ser posterior a la de inicio',
    path: ['endDate'],
  })
  .refine(actionValueMatchesType, ACTION_VALUE_ERROR);

export const createPromotionBannerSchema = z.object({
  body: createBody,
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

// Un PATCH puede tocar un solo campo, así que las fechas se vuelven
// opcionales y la coherencia entre ellas la termina de comprobar el
// controlador contra el documento ya guardado.
const updateBody = z
  .object({
    ...bannerFields,
    imageUrl: bannerFields.imageUrl.optional(),
    startDate: z.coerce.date().optional(),
    endDate: z.coerce.date().optional(),
  })
  .refine(actionValueMatchesType, ACTION_VALUE_ERROR);

export const updatePromotionBannerSchema = z.object({
  body: updateBody,
  query: z.object({}).optional(),
  params: z.object({ id: z.string().regex(OBJECT_ID, 'Identificador inválido') }),
});

export const bannerIdSchema = z.object({
  body: z.object({}).optional(),
  query: z.object({}).optional(),
  params: z.object({ id: z.string().regex(OBJECT_ID, 'Identificador inválido') }),
});

export const reorderPromotionBannersSchema = z.object({
  body: z.object({
    ids: z
      .array(z.string().regex(OBJECT_ID, 'Identificador inválido'))
      .min(1, 'Envía al menos un banner')
      .max(100, 'Demasiados banners en una sola operación')
      .refine((ids) => new Set(ids).size === ids.length, {
        message: 'La lista de orden no puede repetir banners',
      }),
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});
