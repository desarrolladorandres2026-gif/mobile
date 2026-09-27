import { z } from 'zod';
import { objectId } from './common';
import { SECURITY_EVENT_TYPES, SecurityEventType } from '../models/SecurityEvent';

/**
 * Centro de seguridad de un comercio (`/admin/businesses/:id/security/*`).
 * Todo filtro llega por query y se valida aquí: ni un `$regex` ni un id sin
 * comprobar llega a Mongo.
 */

const params = z.object({ id: objectId });

const page = z.coerce.number().int().min(1).max(10_000).default(1);
const limit = z.coerce.number().int().min(1).max(50).default(20);
/** `2026-09-26` o una fecha ISO completa. */
const date = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/, 'Fecha inválida')
  .optional();
/**
 * Prefijo del identificador de dispositivo: de 4 a 8 caracteres, los mismos
 * que muestra el panel. Más largo serviría de oráculo para reconstruir el
 * identificador entero carácter a carácter.
 */
const deviceIdPrefix = z.string().trim().toLowerCase().regex(/^[0-9a-f-]{4,8}$/, 'Usa los 8 caracteres del dispositivo que muestra el panel').optional();
const ip = z.string().trim().max(64).regex(/^[0-9a-fA-F:.]+$/, 'IP inválida').optional();
const reason = z.string().trim().min(5, 'Escribe el motivo (mínimo 5 caracteres)').max(300);
const totpToken = z.string().trim().min(6).max(20);

/** `LOGIN_FAILED,TWO_FACTOR_FAILED` → lista validada. */
const eventTypes = z
  .string()
  .trim()
  .max(400)
  .optional()
  .transform((value, ctx) => {
    if (!value) return undefined;
    const types = value.split(',').map((t) => t.trim()).filter(Boolean);
    const invalid = types.find((t) => !SECURITY_EVENT_TYPES.includes(t as SecurityEventType));
    if (invalid) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Tipo de evento desconocido: ${invalid}` });
      return z.NEVER;
    }
    return types as SecurityEventType[];
  });

const eventFilters = {
  type: eventTypes,
  userId: objectId.optional(),
  ip,
  deviceId: deviceIdPrefix,
  result: z.enum(['success', 'failure', 'info']).optional(),
  from: date,
  to: date,
};

export const businessSecuritySummarySchema = z.object({ params });

export const businessSecuritySessionsSchema = z.object({
  params,
  query: z.object({
    status: z.enum(['active', 'revoked', 'expired', 'all']).default('active'),
    userId: objectId.optional(),
    deviceId: deviceIdPrefix,
    ip,
    from: date,
    to: date,
    search: z.string().trim().max(100).optional(),
    unidentified: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
    page,
    limit,
  }),
});

export const businessSecurityDevicesSchema = z.object({
  params,
  query: z.object({ userId: objectId.optional(), page, limit }),
});

export const businessSecurityDeviceSchema = z.object({
  params: z.object({ id: objectId, deviceRecordId: objectId }),
});

export const businessSecurityEventsSchema = z.object({
  params,
  query: z.object({ ...eventFilters, page, limit }),
});

export const businessSecurityRevokeSessionSchema = z.object({
  params: z.object({ id: objectId, sessionId: objectId }),
  body: z.object({ reason }),
});

export const businessSecurityRevokeUserSchema = z.object({
  params: z.object({ id: objectId, userId: objectId }),
  body: z.object({ reason, totpToken }),
});

export const businessSecurityRevokeAllSchema = z.object({
  params,
  body: z.object({ reason, totpToken }),
});

export const businessSecurityExportSchema = z.object({
  params,
  body: z.object({
    reason,
    totpToken,
    type: z.array(z.enum(SECURITY_EVENT_TYPES as [SecurityEventType, ...SecurityEventType[]])).max(12).optional(),
    userId: objectId.optional(),
    from: date,
    to: date,
  }),
});
