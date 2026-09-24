import { z } from 'zod';
import { objectId, copAmount } from './common';

const coordinate = z.tuple([
  z.number().min(-180).max(180), // longitude
  z.number().min(-90).max(90),   // latitude
]);

const polygon = z
  .array(z.array(coordinate).min(4, 'Un anillo requiere al menos 4 puntos'))
  .min(1, 'El polígono requiere al menos un anillo')
  .refine(
    (rings) =>
      rings.every((ring) => {
        const first = ring[0];
        const last = ring[ring.length - 1];
        return first[0] === last[0] && first[1] === last[1];
      }),
    { message: 'Cada anillo debe cerrarse: el primer punto igual al último' }
  );

/**
 * Motivo de un cambio de tarifa. Obligatorio cuando el cambio toca
 * `baseFee`, `perKm`, `surcharge` o `minOrder` (lo comprueba el servicio, que
 * es quien sabe si el valor realmente cambió); opcional en cualquier otro.
 */
const changeReason = z.string().trim().min(5, 'El motivo debe tener al menos 5 caracteres').max(300);

// Dinero entero en COP: nada de decimales en lo que se cobra y se paga.
const zoneBody = z.object({
  name: z.string().trim().min(2).max(80),
  city: z.string().trim().max(80).optional(),
  coordinates: polygon,
  baseFee: copAmount.nullable().optional(),
  perKm: copAmount.nullable().optional(),
  surcharge: copAmount.optional(),
  minOrder: copAmount.optional(),
  priority: z.number().int().optional(),
  isActive: z.boolean().optional(),
});

export const createZoneSchema = z.object({
  body: zoneBody.extend({ reason: changeReason.optional() }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

export const updateZoneSchema = z.object({
  body: zoneBody.partial().extend({ reason: changeReason.optional() }),
  query: z.object({}).optional(),
  params: z.object({ id: objectId }),
});

/** El motivo del borrado es opcional pero, si viene, queda en la auditoría. */
export const deleteZoneSchema = z.object({
  body: z.object({ reason: changeReason.optional() }).optional(),
  query: z.object({}).optional(),
  params: z.object({ id: objectId }),
});

export const zoneIdParamSchema = z.object({
  params: z.object({ id: objectId }),
});

export const checkCoverageSchema = z.object({
  body: z.object({}).optional(),
  query: z.object({
    lat: z.coerce.number().min(-90).max(90),
    lng: z.coerce.number().min(-180).max(180),
    businessId: z.string().optional(),
  }),
  params: z.object({}).optional(),
});
