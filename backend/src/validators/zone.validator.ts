import { z } from 'zod';

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

const zoneBody = z.object({
  name: z.string().trim().min(2).max(80),
  city: z.string().trim().max(80).optional(),
  coordinates: polygon,
  baseFee: z.number().min(0).nullable().optional(),
  perKm: z.number().min(0).nullable().optional(),
  surcharge: z.number().min(0).optional(),
  minOrder: z.number().min(0).optional(),
  priority: z.number().int().optional(),
  isActive: z.boolean().optional(),
});

export const createZoneSchema = z.object({
  body: zoneBody,
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

export const updateZoneSchema = z.object({
  body: zoneBody.partial(),
  query: z.object({}).optional(),
  params: z.object({ id: z.string() }),
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
