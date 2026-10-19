import { z } from 'zod';
import { objectId } from './common';
import type { BusinessDocumentType } from '../models/BusinessDocument';

/** Debe coincidir con el enum de `BusinessDocument.type` (un test lo comprueba). */
export const BUSINESS_DOCUMENT_TYPES = [
  'rut',
  'chamber_of_commerce',
  'legal_rep_id',
  'bank_certificate',
  'health_permit',
] as const satisfies readonly BusinessDocumentType[];

const params = z.object({ id: objectId });

export const businessIdParamSchema = z.object({ params });

export const setSuspensionSchema = z.object({
  params,
  body: z.object({
    suspended: z.boolean(),
    // Obligatorio en las dos direcciones (M-026).
    reason: z.string().trim().min(5, 'Indica el motivo').max(300),
  }),
});

export const requestDocumentsSchema = z.object({
  params,
  body: z.object({
    types: z.array(z.enum(BUSINESS_DOCUMENT_TYPES)).min(1).max(10),
    message: z.string().trim().max(300).optional(),
  }),
});
