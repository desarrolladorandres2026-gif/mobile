import { z } from 'zod';
import { objectId } from './common';
import { NOTE_ENTITY_TYPES, NOTE_MAX_LENGTH } from '../models/InternalNote';

const entityType = z.enum(NOTE_ENTITY_TYPES);

export const listNotesSchema = z.object({
  query: z.object({
    entityType,
    entityId: objectId,
    before: z
      .string()
      .refine((v) => !Number.isNaN(new Date(v).getTime()), 'Fecha inválida')
      .optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
  }),
});

export const createNoteSchema = z.object({
  body: z.object({
    entityType,
    entityId: objectId,
    body: z.string().trim().min(1, 'La nota no puede estar vacía').max(NOTE_MAX_LENGTH, `Máximo ${NOTE_MAX_LENGTH} caracteres`),
  }),
});

export const deleteNoteSchema = z.object({
  params: z.object({ id: objectId }),
  body: z
    .object({ reason: z.string().trim().max(300, 'Máximo 300 caracteres').optional() })
    .optional()
    .default({}),
});
