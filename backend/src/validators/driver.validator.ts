import { z } from 'zod';

export const registerDriverSchema = z.object({
  body: z.object({
    vehicleType: z.enum(['motorcycle', 'bicycle', 'car']).optional().default('motorcycle'),
    licensePlate: z.string().min(4).max(10).optional(),
    baseFund: z.number().positive().optional().default(50000),
  }),
});

export const updateDriverStatusSchema = z.object({
  body: z.object({
    status: z.enum(['available', 'busy', 'offline']),
  }),
});

export const updateDriverLocationSchema = z.object({
  body: z.object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
  }),
});

export const updateBaseFundSchema = z.object({
  params: z.object({ id: z.string() }),
  body: z.object({
    baseFund: z.number().positive('El fondo base debe ser positivo'),
  }),
});
