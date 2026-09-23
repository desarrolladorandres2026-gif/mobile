import { z } from 'zod';

const advertisementBody = z
  .object({
    campaignName: z.string().trim().min(3, 'El nombre de la campaña es muy corto').max(100),
    advertiserName: z.string().trim().min(2, 'El nombre del anunciante es muy corto').max(100),
    flyerUrl: z.string().trim().min(1, 'El flyer es requerido'),
    startDate: z.coerce.date(),
    endDate: z.coerce.date(),
    isActive: z.boolean().optional(),
    priority: z.number().int().min(0).max(100).optional(),
    placement: z.enum(['splash', 'explore']).optional(),
    actionType: z.enum(['business', 'none']).optional(),
    businessId: z.string().nullable().optional(),
    maxImpressions: z.number().int().min(0).optional(),
    durationSeconds: z.number().int().min(3).max(15).optional(),
    pricePaid: z.number().min(0).optional(),
    internalNotes: z.string().trim().max(500).optional(),
  })
  .refine((data) => data.endDate > data.startDate, {
    message: 'La fecha de finalización debe ser posterior a la de inicio',
    path: ['endDate'],
  })
  .refine((data) => data.actionType !== 'business' || !!data.businessId, {
    message: 'La campaña requiere un negocio para su acción',
    path: ['businessId'],
  });

export const createAdvertisementSchema = z.object({
  body: advertisementBody,
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

// Partial updates skip the cross-field refinements above (a PATCH may touch
// only one field); the model's own pre-validate hook still guards coherence
// on save.
const advertisementBodyPartial = z.object({
  campaignName: z.string().trim().min(3).max(100).optional(),
  advertiserName: z.string().trim().min(2).max(100).optional(),
  flyerUrl: z.string().trim().min(1).optional(),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
  isActive: z.boolean().optional(),
  priority: z.number().int().min(0).max(100).optional(),
  placement: z.enum(['splash', 'explore']).optional(),
  actionType: z.enum(['business', 'none']).optional(),
  businessId: z.string().nullable().optional(),
  maxImpressions: z.number().int().min(0).optional(),
  durationSeconds: z.number().int().min(3).max(15).optional(),
  pricePaid: z.number().min(0).optional(),
  internalNotes: z.string().trim().max(500).optional(),
});

export const updateAdvertisementSchema = z.object({
  body: advertisementBodyPartial,
  query: z.object({}).optional(),
  params: z.object({ id: z.string() }),
});

export const adEventSchema = z.object({
  body: z.object({
    deviceId: z.string().trim().min(1, 'Falta el identificador de dispositivo').max(100),
  }),
  query: z.object({}).optional(),
  params: z.object({ id: z.string() }),
});
