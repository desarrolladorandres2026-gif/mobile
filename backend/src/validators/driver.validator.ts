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

// ── Listado y ficha para el panel admin ──

const optionalText = (max: number) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().max(max).optional());

const optionalEnum = <const T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.enum(values as unknown as [T[number], ...T[number][]]).optional()
  );

/**
 * Un `YYYY-MM-DD` es un día de Colombia (-05:00), no de UTC: en UTC los
 * registros de después de las 7 de la tarde caerían en el día siguiente.
 */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const boundaryDate = (edge: 'start' | 'end') =>
  z.preprocess(
    (v) => {
      if (typeof v !== 'string' || v.trim() === '') return undefined;
      const s = v.trim();
      if (DATE_ONLY.test(s)) return new Date(`${s}T${edge === 'start' ? '00:00:00.000' : '23:59:59.999'}-05:00`);
      return new Date(s);
    },
    z.date({ invalid_type_error: 'Fecha inválida' }).optional()
  );

export const DRIVER_LIST_SORT_FIELDS = ['name', 'createdAt', 'rating', 'totalDeliveries', 'lastLocationAt'] as const;

export const listDriversQuerySchema = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).optional(),
    search: optionalText(80),
    driverStatus: optionalEnum(['pending', 'active', 'suspended']),
    availability: optionalEnum(['available', 'busy', 'offline']),
    vehicleType: optionalEnum(['motorcycle', 'bicycle']),
    dateFrom: boundaryDate('start'),
    dateTo: boundaryDate('end'),
    sortBy: optionalEnum(DRIVER_LIST_SORT_FIELDS),
    sortOrder: optionalEnum(['asc', 'desc']),
  }),
});

export type ListDriversQuery = z.infer<typeof listDriversQuerySchema>['query'];

export const driverIdParamSchema = z.object({
  params: z.object({ id: z.string().regex(/^[a-f\d]{24}$/i, 'Identificador inválido') }),
});
