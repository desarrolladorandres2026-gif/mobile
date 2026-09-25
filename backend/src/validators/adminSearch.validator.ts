import { z } from 'zod';

export const SEARCH_TYPES = ['order', 'user', 'business', 'driver', 'coupon'] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

export const adminSearchSchema = z.object({
  query: z.object({
    q: z.string().trim().min(2, 'Escribe al menos 2 caracteres').max(64, 'Máximo 64 caracteres'),
    types: z
      .string()
      .max(100)
      .optional()
      .transform((v, ctx) => {
        if (!v) return undefined;
        const list = v.split(',').map((t) => t.trim()).filter(Boolean);
        if (!list.every((t) => (SEARCH_TYPES as readonly string[]).includes(t))) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Tipo de búsqueda inválido' });
          return z.NEVER;
        }
        return list as SearchType[];
      }),
  }),
});
