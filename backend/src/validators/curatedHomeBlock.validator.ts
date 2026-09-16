import { z } from 'zod';
import { CURATED_HOME_BLOCK_KINDS } from '../models/CuratedHomeBlock';

const OBJECT_ID = /^[a-f\d]{24}$/i;
const objectId = () => z.string().regex(OBJECT_ID, 'Identificador inválido');

const kinds = CURATED_HOME_BLOCK_KINDS as unknown as [string, ...string[]];

/** Cuántos items exige cada formato — el mismo rango que valida el modelo. */
const ITEM_COUNT: Record<string, { min: number; max: number }> = {
  productBanner: { min: 3, max: 3 },
  businessBanner: { min: 3, max: 3 },
  businessCollection: { min: 4, max: 20 },
};

const itemsMatchKind = (data: { kind?: string; items?: string[] }) => {
  if (!data.kind || !data.items) return true;
  const bounds = ITEM_COUNT[data.kind];
  if (!bounds) return false;
  return data.items.length >= bounds.min && data.items.length <= bounds.max;
};

const ITEMS_ERROR = {
  message: 'La cantidad de elementos no corresponde al tipo de bloque',
  path: ['items'],
};

const blockFields = {
  kind: z.enum(kinds),
  title: z.string().trim().min(1, 'El título es requerido').max(80, 'El título no puede exceder 80 caracteres'),
  subtitle: z.string().trim().max(140, 'El subtítulo no puede exceder 140 caracteres').optional(),
  items: z.array(objectId()).min(3).max(20),
  order: z.number().int().min(0).max(999),
  isActive: z.boolean().optional(),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
};

const createBody = z
  .object(blockFields)
  .refine((data) => !data.startDate || !data.endDate || data.endDate > data.startDate, {
    message: 'La fecha de finalización debe ser posterior a la de inicio',
    path: ['endDate'],
  })
  .refine(itemsMatchKind, ITEMS_ERROR);

export const createCuratedHomeBlockSchema = z.object({
  body: createBody,
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

const updateBody = z
  .object({
    ...blockFields,
    kind: blockFields.kind.optional(),
    title: blockFields.title.optional(),
    items: blockFields.items.optional(),
    order: blockFields.order.optional(),
  })
  .refine((data) => !data.startDate || !data.endDate || data.endDate > data.startDate, {
    message: 'La fecha de finalización debe ser posterior a la de inicio',
    path: ['endDate'],
  })
  .refine(itemsMatchKind, ITEMS_ERROR);

export const updateCuratedHomeBlockSchema = z.object({
  body: updateBody,
  query: z.object({}).optional(),
  params: z.object({ id: objectId() }),
});

export const curatedHomeBlockIdSchema = z.object({
  body: z.object({}).optional(),
  query: z.object({}).optional(),
  params: z.object({ id: objectId() }),
});
