import { z } from 'zod';

export const listAlertsSchema = z.object({
  query: z.object({ limit: z.coerce.number().int().min(1).max(100).optional() }),
});

export const markSeenSchema = z.object({
  body: z.object({
    keys: z.array(z.string().trim().min(1).max(200)).min(1).max(100),
  }),
});
