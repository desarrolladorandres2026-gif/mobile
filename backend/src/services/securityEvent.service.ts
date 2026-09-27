import { Request } from 'express';
import { Types } from 'mongoose';
import { Business, BusinessStaff, SecurityEvent, SecurityEventType, SecurityEventResult, User } from '../models';
import { NotificationType, UserRole } from '../types';
import { clientIp } from '../utils';
import { parseUserAgent } from '../security/sessions';
import { notificationService } from './notification.service';

/**
 * Escribe el historial de seguridad (`SecurityEvent`) de las cuentas que
 * entran al panel de comercios: el dueño (`role: business`) y su personal.
 * Las demás cuentas no dejan nada aquí; lo suyo sigue en `AuditLog`.
 *
 * Nunca rompe el flujo que la llama (login, refresh, logout): un fallo de
 * escritura se registra en consola y ya. Igual que `logAudit`.
 */

export const NEW_DEVICE_MESSAGE =
  'Se detectó un nuevo dispositivo en tu cuenta de ZIPP. Si reconoces este acceso, no necesitas realizar ninguna acción. Si no lo reconoces, revisa tus sesiones activas y cambia tu contraseña.';

type Id = string | Types.ObjectId;

/** Los negocios a los que la cuenta tiene acceso hoy: los suyos y donde es empleado activo. */
export async function businessIdsForUser(userId: Id): Promise<Types.ObjectId[]> {
  if (!Types.ObjectId.isValid(String(userId))) return [];
  const [owned, staffOf] = await Promise.all([
    Business.find({ ownerId: userId }).distinct('_id'),
    BusinessStaff.find({ userId, isActive: true }).distinct('businessId'),
  ]);
  const unique = new Map<string, Types.ObjectId>();
  for (const id of [...owned, ...staffOf] as Types.ObjectId[]) unique.set(String(id), id);
  return [...unique.values()];
}

/**
 * Negocios de la cuenta, o `null` si no es una cuenta de comercio (no se
 * registra nada). Una cuenta `business` sin negocio todavía (en alta) sí se
 * registra, con la lista vacía.
 */
async function trackedBusinessIds(userId: Id, role?: string): Promise<Types.ObjectId[] | null> {
  const businessIds = await businessIdsForUser(userId);
  if (businessIds.length > 0) return businessIds;
  const accountRole = role ?? (await User.findById(userId).select('role').lean())?.role;
  return accountRole === UserRole.BUSINESS ? [] : null;
}

export interface SecurityEventInput {
  userId: Id;
  /** Si el llamador ya lo sabe, ahorra una lectura. */
  role?: string;
  type: SecurityEventType;
  result?: SecurityEventResult;
  req?: Request;
  ip?: string;
  userAgent?: string;
  sessionId?: string | null;
  deviceId?: string | null;
  reason?: string | null;
  /** Motivo escrito por un administrador. */
  note?: string | null;
  actorId?: Id | null;
  metadata?: Record<string, unknown>;
  /** Ya resueltos: una revocación masiva no los recalcula persona por persona. */
  businessIds?: Types.ObjectId[];
}

function requestContext(input: Pick<SecurityEventInput, 'req' | 'ip' | 'userAgent'>) {
  const ip = input.ip ?? (input.req ? clientIp(input.req) : 'unknown');
  const userAgent = input.userAgent ?? ((input.req?.headers['user-agent'] as string) || 'unknown');
  return { ip, userAgent };
}

/** Registra un evento. Devuelve false si la cuenta no es de comercio o si la escritura falló. */
export async function recordSecurityEvent(input: SecurityEventInput): Promise<boolean> {
  try {
    const businessIds = input.businessIds ?? (await trackedBusinessIds(input.userId, input.role));
    if (businessIds === null) return false;

    const { ip, userAgent } = requestContext(input);
    const { platform, os, browser, browserVersion } = parseUserAgent(userAgent);
    await SecurityEvent.create({
      userId: input.userId,
      businessIds,
      type: input.type,
      result: input.result ?? 'info',
      ip: ip.slice(0, 64),
      userAgent: userAgent.slice(0, 512),
      sessionId: input.sessionId ?? null,
      deviceId: input.deviceId ?? null,
      device: { platform, os, browser, browserVersion },
      reason: input.reason ?? null,
      note: input.note ? input.note.slice(0, 500) : null,
      actorId: input.actorId ?? null,
      metadata: input.metadata ?? {},
    });
    return true;
  } catch (error) {
    console.error('[SECURITY_EVENT] No se pudo registrar el evento:', error);
    return false;
  }
}

/** ¿Esta IP ya había entrado a la cuenta? Solo cuenta si hay historia contra la que comparar. */
async function isUnseenIp(userId: Id, ip: string): Promise<boolean> {
  if (!ip || ip === 'unknown') return false;
  const [seen, anyHistory] = await Promise.all([
    SecurityEvent.exists({ userId, ip, type: { $in: [SecurityEventType.LOGIN_SUCCESS, SecurityEventType.NEW_IP] } }),
    SecurityEvent.exists({ userId, type: SecurityEventType.LOGIN_SUCCESS }),
  ]);
  return !seen && !!anyHistory;
}

export interface SessionStartedInput {
  user: { _id: Id; role: string };
  req?: Request;
  sessionId: string;
  deviceId: string;
  identified: boolean;
  isNewDevice: boolean;
  method: string;
  mfa: boolean;
  evictedSessionIds: string[];
}

/**
 * Todo lo que deja un inicio de sesión: el acceso, el segundo factor, el
 * dispositivo o la IP nuevos y las sesiones que se cerraron por el tope.
 *
 * Un dispositivo no identificado (sin `X-Device-ID` válido) cuenta siempre
 * como nuevo: si no, bastaría con omitir la cabecera para no disparar el
 * aviso. El aviso a la persona solo sale cuando la cuenta ya tenía accesos
 * registrados: el primer login tras desplegar esto (o el primero de una
 * cuenta nueva) no tiene contra qué comparar, y avisarle a alguien de que
 * entró él mismo enseña a ignorar el aviso.
 */
export async function recordSessionStarted(input: SessionStartedInput): Promise<void> {
  try {
    const { user, req, sessionId, deviceId, identified, isNewDevice, method, mfa } = input;
    const businessIds = await trackedBusinessIds(user._id, user.role);
    if (businessIds === null) return;

    const { ip } = requestContext({ req });
    const [hadHistory, newIp] = await Promise.all([
      SecurityEvent.exists({ userId: user._id, type: SecurityEventType.LOGIN_SUCCESS }),
      isUnseenIp(user._id, ip),
    ]);
    const base = { userId: user._id, businessIds, req, sessionId, deviceId };

    if (mfa) {
      await recordSecurityEvent({ ...base, type: SecurityEventType.TWO_FACTOR_SUCCESS, result: 'success', metadata: { method } });
    }
    await recordSecurityEvent({
      ...base,
      type: SecurityEventType.LOGIN_SUCCESS,
      result: 'success',
      metadata: { method, mfa, identified },
    });

    const newDevice = isNewDevice || !identified;
    if (newDevice) {
      await recordSecurityEvent({ ...base, type: SecurityEventType.NEW_DEVICE, metadata: { identified } });
    }
    if (newIp) {
      await recordSecurityEvent({ ...base, type: SecurityEventType.NEW_IP, metadata: { at: 'login' } });
    }
    if (input.evictedSessionIds.length > 0) {
      await recordSecurityEvent({
        ...base,
        type: SecurityEventType.SESSION_REVOKED,
        reason: 'session_limit',
        metadata: { sessionIds: input.evictedSessionIds, count: input.evictedSessionIds.length },
      });
    }

    if (newDevice && hadHistory) {
      await notificationService.create({
        userId: String(user._id),
        type: NotificationType.SYSTEM,
        title: 'Nuevo dispositivo en tu cuenta',
        body: NEW_DEVICE_MESSAGE,
        data: { kind: 'new_device', sessionId },
      });
    }
  } catch (error) {
    console.error('[SECURITY_EVENT] No se pudo registrar el inicio de sesión:', error);
  }
}

/**
 * La sesión se refrescó desde otra IP. No se invalida (cambiar de Wi-Fi a
 * datos es lo normal en un celular): solo se registra si esa IP nunca había
 * entrado a la cuenta, para que el administrador la vea.
 */
export async function recordSessionIpChange(input: {
  user: { _id: Id; role: string };
  req?: Request;
  sessionId: string;
  deviceId: string;
  previousIp: string | null;
}): Promise<void> {
  try {
    const { ip } = requestContext({ req: input.req });
    if (!input.previousIp || ip === input.previousIp || ip === 'unknown') return;
    const businessIds = await trackedBusinessIds(input.user._id, input.user.role);
    if (businessIds === null) return;
    if (!(await isUnseenIp(input.user._id, ip))) return;

    await recordSecurityEvent({
      userId: input.user._id,
      businessIds,
      req: input.req,
      type: SecurityEventType.NEW_IP,
      sessionId: input.sessionId,
      deviceId: input.deviceId,
      metadata: { at: 'refresh', previousIp: input.previousIp },
    });
  } catch (error) {
    console.error('[SECURITY_EVENT] No se pudo registrar el cambio de IP:', error);
  }
}
