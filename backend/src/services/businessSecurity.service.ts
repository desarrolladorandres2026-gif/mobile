import { Request } from 'express';
import { Types } from 'mongoose';
import { Business, BusinessStaff, normalizeStaffRole, SecurityEvent, SecurityEventType, User, IUser, ISecurityEvent } from '../models';
import { AppError } from '../middlewares/errorHandler';
import { UserRole } from '../types';
import { escapeRegex } from '../utils';
import {
  Session,
  DeviceFingerprint,
  SESSION_ADMIN_FIELDS,
  activeSessionFilter,
  sessionStatus,
  sessionManager,
  type ISession,
  type SessionStatus,
} from '../security/sessions';
import { logAudit, AuditAction, AuditSeverity } from '../security/audit';
import { assertExportAuthorized, assertStepUpAuthorized } from '../security/exportGate';
import { recordSecurityEvent } from './securityEvent.service';

/**
 * Centro de seguridad de un comercio, visto desde el panel admin: quién tiene
 * sesiones abiertas, desde qué dispositivos, y el historial de accesos.
 *
 * Las sesiones son de la CUENTA, no del negocio: el panel de comercios cambia
 * de local en el cliente con la misma sesión. "Las sesiones de un negocio"
 * son, entonces, las de su dueño y su personal activo, y cerrarlas corta
 * también el acceso del dueño a sus otros negocios (decisión del 2026-09-26).
 *
 * Nunca devuelve `tokenHash`, `previousTokenHash`, contraseñas ni secretos:
 * las sesiones salen con `SESSION_ADMIN_FIELDS` y los dispositivos sin su
 * `fingerprint`.
 */

/** Un dispositivo se marca "nuevo" durante sus primeros 7 días. */
const NEW_DEVICE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Tope del CSV: un informe es un archivo que alguien abre, no un volcado. */
const EXPORT_MAX_ROWS = 5000;

export type MemberRole = 'owner' | 'manager' | 'operator' | 'cashier';

export interface SecurityMember {
  userId: string;
  name: string;
  email: string | null;
  businessRole: MemberRole;
  /** Empleado dado de baja: su historia queda, sus sesiones ya no son del negocio. */
  active: boolean;
  accountRole: string;
  twoFactorEnabled: boolean;
  passwordChangedAt: Date | null;
  lastLoginAt: Date | null;
}

export interface Page {
  page: number;
  limit: number;
}

export interface SessionFilters extends Page {
  status?: SessionStatus | 'all';
  userId?: string;
  deviceId?: string;
  ip?: string;
  from?: string;
  to?: string;
  search?: string;
  /** Solo dispositivos sin identificador propio. */
  unidentified?: boolean;
}

export interface EventFilters extends Page {
  types?: SecurityEventType[];
  userId?: string;
  ip?: string;
  deviceId?: string;
  result?: 'success' | 'failure' | 'info';
  from?: string;
  to?: string;
}

/** Los 8 primeros caracteres: suficiente para reconocerlo y buscarlo, sin publicar el identificador entero. */
export const shortDeviceId = (deviceId: string | null | undefined) => (deviceId ? deviceId.slice(0, 8) : null);

/**
 * Rango de fechas del filtro. Una fecha sola (`2026-09-26`) es el día entero
 * en hora de Colombia (UTC-5, sin horario de verano), que es como la piensa
 * quien la escribe en el panel.
 */
function dateRange(from?: string, to?: string): Record<string, Date> | null {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
  const start = from ? new Date(dateOnly.test(from) ? `${from}T00:00:00-05:00` : from) : null;
  const end = to ? new Date(dateOnly.test(to) ? `${to}T23:59:59.999-05:00` : to) : null;
  if ((start && Number.isNaN(start.getTime())) || (end && Number.isNaN(end.getTime()))) {
    throw new AppError('Fecha inválida', 400);
  }
  if (!start && !end) return null;
  return { ...(start ? { $gte: start } : {}), ...(end ? { $lte: end } : {}) };
}

const pagination = ({ page, limit }: Page, total: number) => ({ page, limit, total, pages: Math.ceil(total / limit) });

type LeanSession = Pick<
  ISession,
  | 'userId'
  | 'deviceId'
  | 'identified'
  | 'deviceInfo'
  | 'ip'
  | 'lastIp'
  | 'authMethod'
  | 'mfa'
  | 'isActive'
  | 'revokedAt'
  | 'revokedReason'
  | 'revokedBy'
  | 'lastActivity'
  | 'createdAt'
  | 'expiresAt'
  | 'absoluteExpiresAt'
> & { _id: Types.ObjectId };

type FingerprintRef = { _id: Types.ObjectId; userId: string; deviceId: string; firstSeen: Date; isTrusted: boolean };

export class BusinessSecurityService {
  /** El negocio y quienes tienen (o tuvieron) acceso a su panel. 404 si no existe. */
  async loadMembers(businessId: string): Promise<{ business: { _id: Types.ObjectId; name: string; panelSeenAt: Date | null }; members: SecurityMember[] }> {
    if (!Types.ObjectId.isValid(businessId)) throw new AppError('Negocio no encontrado', 404);
    const business = await Business.findById(businessId).select('name ownerId panelSeenAt').lean();
    if (!business) throw new AppError('Negocio no encontrado', 404);

    const staff = await BusinessStaff.find({ businessId }).select('userId role isActive').lean();
    const roleOf = new Map<string, { role: MemberRole; active: boolean }>();
    for (const s of staff) roleOf.set(String(s.userId), { role: normalizeStaffRole(s.role) as MemberRole, active: s.isActive });
    roleOf.set(String(business.ownerId), { role: 'owner', active: true });

    const users = await User.find({ _id: { $in: [...roleOf.keys()] } })
      .select('name email role twoFactorEnabled passwordChangedAt lastLoginAt')
      .lean();

    const members: SecurityMember[] = users.map((u) => {
      const link = roleOf.get(String(u._id))!;
      return {
        userId: String(u._id),
        name: u.name,
        email: u.email ?? null,
        businessRole: link.role,
        active: link.active,
        accountRole: u.role,
        twoFactorEnabled: !!u.twoFactorEnabled,
        passwordChangedAt: u.passwordChangedAt ?? null,
        lastLoginAt: u.lastLoginAt ?? null,
      };
    });
    // El dueño primero, después por nombre.
    members.sort((a, b) => (a.businessRole === 'owner' ? -1 : b.businessRole === 'owner' ? 1 : a.name.localeCompare(b.name)));
    return {
      business: { _id: business._id as Types.ObjectId, name: business.name, panelSeenAt: business.panelSeenAt ?? null },
      members,
    };
  }

  private async fingerprintsFor(sessions: Array<Pick<LeanSession, 'userId' | 'deviceId'>>): Promise<Map<string, FingerprintRef>> {
    const map = new Map<string, FingerprintRef>();
    if (sessions.length === 0) return map;
    const pairs = [...new Map(sessions.map((s) => [`${s.userId}:${s.deviceId}`, { userId: s.userId, deviceId: s.deviceId }])).values()];
    const rows = await DeviceFingerprint.find({ $or: pairs }).select('userId deviceId firstSeen isTrusted').lean();
    for (const r of rows) map.set(`${r.userId}:${r.deviceId}`, r as unknown as FingerprintRef);
    return map;
  }

  private sessionRow(
    s: LeanSession,
    members: Map<string, SecurityMember>,
    fingerprints: Map<string, FingerprintRef>,
    actors: Map<string, string>,
    now: Date
  ) {
    const member = members.get(s.userId);
    const fp = fingerprints.get(`${s.userId}:${s.deviceId}`);
    const expiresAt =
      s.absoluteExpiresAt && s.absoluteExpiresAt < s.expiresAt ? s.absoluteExpiresAt : s.expiresAt;
    return {
      id: String(s._id),
      user: member
        ? { id: member.userId, name: member.name, email: member.email, businessRole: member.businessRole }
        : { id: s.userId, name: 'Cuenta sin acceso actual', email: null, businessRole: null },
      device: {
        recordId: fp ? String(fp._id) : null,
        shortId: shortDeviceId(s.deviceId),
        identified: !!s.identified,
        isNew: !!fp && now.getTime() - new Date(fp.firstSeen).getTime() < NEW_DEVICE_WINDOW_MS,
        platform: s.deviceInfo?.platform ?? 'unknown',
        os: s.deviceInfo?.os ?? 'unknown',
        osVersion: s.deviceInfo?.osVersion ?? null,
        browser: s.deviceInfo?.browser ?? 'unknown',
        browserVersion: s.deviceInfo?.browserVersion ?? null,
      },
      ip: s.ip,
      lastIp: s.lastIp ?? s.ip,
      createdAt: s.createdAt,
      lastActivity: s.lastActivity,
      expiresAt,
      status: sessionStatus(s, now),
      mfa: !!s.mfa,
      authMethod: s.authMethod ?? null,
      revokedAt: s.revokedAt ?? null,
      revokedReason: s.revokedReason ?? null,
      revokedBy: s.revokedBy ? { id: s.revokedBy, name: actors.get(s.revokedBy) ?? 'Administrador' } : null,
    };
  }

  private async namesOf(ids: Array<string | null | undefined>, known: Map<string, SecurityMember>): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    const missing = new Set<string>();
    for (const id of ids) {
      if (!id) continue;
      const member = known.get(id);
      if (member) names.set(id, member.name);
      else if (Types.ObjectId.isValid(id)) missing.add(id);
    }
    if (missing.size > 0) {
      const users = await User.find({ _id: { $in: [...missing] } }).select('name').lean();
      for (const u of users) names.set(String(u._id), u.name);
    }
    return names;
  }

  // ── Resumen ──────────────────────────────────────────────────────────

  async summary(businessId: string) {
    const { business, members } = await this.loadMembers(businessId);
    const active = members.filter((m) => m.active);
    const ids = active.map((m) => m.userId);
    const now = new Date();
    const bid = business._id;

    const [openSessions, knownDevices, newDevices30d, failedAttempts7d, lastLogin, lastEvent] = await Promise.all([
      Session.find({ $and: [{ userId: { $in: ids } }, activeSessionFilter(now)] })
        .select('userId deviceId identified deviceInfo lastActivity')
        .lean(),
      DeviceFingerprint.countDocuments({ userId: { $in: ids } }),
      SecurityEvent.countDocuments({ businessIds: bid, type: SecurityEventType.NEW_DEVICE, createdAt: { $gte: new Date(now.getTime() - 30 * DAY_MS) } }),
      SecurityEvent.countDocuments({
        businessIds: bid,
        type: { $in: [SecurityEventType.LOGIN_FAILED, SecurityEventType.TWO_FACTOR_FAILED] },
        createdAt: { $gte: new Date(now.getTime() - 7 * DAY_MS) },
      }),
      SecurityEvent.findOne({ businessIds: bid, type: SecurityEventType.LOGIN_SUCCESS }).sort({ createdAt: -1 }).lean(),
      SecurityEvent.findOne({ businessIds: bid }).sort({ createdAt: -1 }).lean(),
    ]);

    const fingerprints = await this.fingerprintsFor(openSessions);
    // "Sesión desconocida": abierta desde un dispositivo sin identificador
    // propio o que apareció hace menos de 7 días. Es lo primero que el admin
    // tiene que poder ver de un vistazo.
    const unknownActiveSessions = openSessions.filter((s) => {
      if (!s.identified) return true;
      const fp = fingerprints.get(`${s.userId}:${s.deviceId}`);
      return !fp || now.getTime() - new Date(fp.firstSeen).getTime() < NEW_DEVICE_WINDOW_MS;
    }).length;

    const memberMap = new Map(members.map((m) => [m.userId, m]));
    const names = await this.namesOf([lastLogin?.actorId && String(lastLogin.actorId), lastEvent?.actorId && String(lastEvent.actorId)], memberMap);

    // Instalaciones de Zipp Negocios (la app de escritorio) conectadas ahora
    // mismo: `deviceInfo.appVersion` solo lo escribe esa app (ver
    // `parseUserAgent`). `panelSeenAt` cubre también el panel web, que no
    // tiene versión que mostrar.
    const installations = openSessions
      .filter((s) => s.deviceInfo?.appVersion)
      .map((s) => ({
        userId: s.userId.toString(),
        name: memberMap.get(s.userId.toString())?.name ?? null,
        appVersion: s.deviceInfo!.appVersion!,
        lastActivity: s.lastActivity,
      }));

    return {
      business: { id: String(bid), name: business.name, panelSeenAt: business.panelSeenAt ?? null },
      installations,
      activeSessions: openSessions.length,
      unknownActiveSessions,
      knownDevices,
      newDevices30d,
      failedAttempts7d,
      lastSuccessfulLogin: lastLogin ? this.eventRow(lastLogin, memberMap, names) : null,
      lastSecurityEvent: lastEvent ? this.eventRow(lastEvent, memberMap, names) : null,
      members: active.map((m) => ({
        userId: m.userId,
        name: m.name,
        email: m.email,
        businessRole: m.businessRole,
        accountRole: m.accountRole,
        twoFactorEnabled: m.twoFactorEnabled,
        passwordChangedAt: m.passwordChangedAt,
        lastLoginAt: m.lastLoginAt,
      })),
    };
  }

  // ── Sesiones ─────────────────────────────────────────────────────────

  async sessions(businessId: string, f: SessionFilters) {
    const { members } = await this.loadMembers(businessId);
    const active = members.filter((m) => m.active);
    const memberMap = new Map(members.map((m) => [m.userId, m]));
    const now = new Date();

    const userIds = f.userId ? active.filter((m) => m.userId === f.userId).map((m) => m.userId) : active.map((m) => m.userId);
    const and: Record<string, unknown>[] = [{ userId: { $in: userIds } }];

    const status = f.status ?? 'active';
    if (status === 'active') and.push(activeSessionFilter(now));
    else if (status === 'revoked') and.push({ isActive: false });
    else if (status === 'expired') {
      and.push({ isActive: true }, { $or: [{ expiresAt: { $lte: now } }, { absoluteExpiresAt: { $lte: now } }] });
    }

    if (f.unidentified) and.push({ identified: { $ne: true } });
    if (f.deviceId) and.push({ deviceId: { $regex: `^${escapeRegex(f.deviceId.toLowerCase())}` } });
    if (f.ip) and.push({ $or: [{ ip: f.ip }, { lastIp: f.ip }] });
    const range = dateRange(f.from, f.to);
    if (range) and.push({ createdAt: range });
    if (f.search) {
      const term = f.search.trim().toLowerCase();
      const matched = active
        .filter((m) => m.name.toLowerCase().includes(term) || (m.email ?? '').toLowerCase().includes(term))
        .map((m) => m.userId);
      const or: Record<string, unknown>[] = [{ userId: { $in: matched } }];
      // Mismo tope que el filtro `deviceId`: 8 caracteres, no un oráculo del identificador entero.
      if (/^[0-9a-f-]{4,8}$/.test(term)) or.push({ deviceId: { $regex: `^${escapeRegex(term)}` } });
      and.push({ $or: or });
    }

    const filter = { $and: and };
    const [rows, total] = await Promise.all([
      Session.find(filter)
        .select(SESSION_ADMIN_FIELDS)
        .sort({ lastActivity: -1 })
        .skip((f.page - 1) * f.limit)
        .limit(f.limit)
        .lean<LeanSession[]>(),
      Session.countDocuments(filter),
    ]);

    const [fingerprints, actors] = await Promise.all([
      this.fingerprintsFor(rows),
      this.namesOf(rows.map((r) => r.revokedBy), memberMap),
    ]);

    return {
      sessions: rows.map((r) => this.sessionRow(r, memberMap, fingerprints, actors, now)),
      pagination: pagination(f, total),
    };
  }

  // ── Dispositivos ─────────────────────────────────────────────────────

  async devices(businessId: string, f: Page & { userId?: string }) {
    const { members } = await this.loadMembers(businessId);
    const memberMap = new Map(members.map((m) => [m.userId, m]));
    const ids = members.filter((m) => m.active && (!f.userId || m.userId === f.userId)).map((m) => m.userId);
    const now = new Date();
    const filter = { userId: { $in: ids } };

    const [rows, total, open] = await Promise.all([
      DeviceFingerprint.find(filter)
        .select('userId deviceId identified deviceInfo firstIp lastIp isTrusted firstSeen lastSeen loginCount')
        .sort({ lastSeen: -1 })
        .skip((f.page - 1) * f.limit)
        .limit(f.limit)
        .lean(),
      DeviceFingerprint.countDocuments(filter),
      Session.aggregate<{ _id: { userId: string; deviceId: string }; n: number }>([
        { $match: { $and: [{ userId: { $in: ids } }, activeSessionFilter(now)] } },
        { $group: { _id: { userId: '$userId', deviceId: '$deviceId' }, n: { $sum: 1 } } },
      ]),
    ]);
    const openCount = new Map(open.map((o) => [`${o._id.userId}:${o._id.deviceId}`, o.n]));

    return {
      devices: rows.map((d) => this.deviceRow(d, memberMap, openCount.get(`${d.userId}:${d.deviceId}`) ?? 0, now)),
      pagination: pagination(f, total),
    };
  }

  private deviceRow(d: any, members: Map<string, SecurityMember>, activeSessions: number, now: Date) {
    const member = members.get(d.userId);
    return {
      id: String(d._id),
      shortId: shortDeviceId(d.deviceId),
      identified: !!d.identified,
      isNew: now.getTime() - new Date(d.firstSeen).getTime() < NEW_DEVICE_WINDOW_MS,
      trusted: !!d.isTrusted,
      platform: d.deviceInfo?.platform ?? 'unknown',
      os: d.deviceInfo?.os ?? 'unknown',
      osVersion: d.deviceInfo?.osVersion ?? null,
      browser: d.deviceInfo?.browser ?? 'unknown',
      browserVersion: d.deviceInfo?.browserVersion ?? null,
      firstSeen: d.firstSeen,
      lastSeen: d.lastSeen,
      firstIp: d.firstIp ?? null,
      lastIp: d.lastIp ?? null,
      loginCount: d.loginCount ?? 0,
      activeSessions,
      user: member
        ? { id: member.userId, name: member.name, email: member.email, businessRole: member.businessRole }
        : { id: d.userId, name: 'Cuenta sin acceso actual', email: null, businessRole: null },
    };
  }

  async device(businessId: string, recordId: string) {
    const { business, members } = await this.loadMembers(businessId);
    const memberMap = new Map(members.map((m) => [m.userId, m]));
    const notFound = new AppError('Ese dispositivo no pertenece a este negocio', 404);
    if (!Types.ObjectId.isValid(recordId)) throw notFound;

    const fp = await DeviceFingerprint.findById(recordId)
      .select('userId deviceId identified deviceInfo firstIp lastIp isTrusted firstSeen lastSeen loginCount')
      .lean();
    // Cualquier miembro, también un empleado ya dado de baja: su equipo
    // sigue siendo parte de la historia del negocio.
    if (!fp || !memberMap.has(fp.userId)) throw notFound;

    const now = new Date();
    const [sessions, events, openCount] = await Promise.all([
      Session.find({ userId: fp.userId, deviceId: fp.deviceId })
        .select(`${SESSION_ADMIN_FIELDS} userAgent`)
        .sort({ createdAt: -1 })
        .limit(20)
        .lean<Array<LeanSession & { userAgent?: string }>>(),
      // Solo lo que pasó mientras la cuenta tenía acceso a ESTE negocio: un
      // exempleado que ahora trabaja en otro no deja ver su actividad nueva.
      SecurityEvent.find({ userId: fp.userId, deviceId: fp.deviceId, businessIds: business._id }).sort({ createdAt: -1 }).limit(50).lean(),
      Session.countDocuments({ $and: [{ userId: fp.userId, deviceId: fp.deviceId }, activeSessionFilter(now)] }),
    ]);
    const fingerprints = new Map([[`${fp.userId}:${fp.deviceId}`, fp as unknown as FingerprintRef]]);
    const names = await this.namesOf(
      [...sessions.map((s) => s.revokedBy), ...events.map((e) => e.actorId && String(e.actorId))],
      memberMap
    );

    return {
      device: { ...this.deviceRow(fp, memberMap, openCount, now), userAgent: sessions[0]?.userAgent ?? null },
      sessions: sessions.map((s) => this.sessionRow(s, memberMap, fingerprints, names, now)),
      events: events.map((e) => this.eventRow(e, memberMap, names)),
    };
  }

  // ── Historial ────────────────────────────────────────────────────────

  private eventFilter(businessId: Types.ObjectId, f: Omit<EventFilters, 'page' | 'limit'>) {
    const filter: Record<string, unknown> = { businessIds: businessId };
    if (f.types?.length) filter.type = { $in: f.types };
    if (f.userId) filter.userId = new Types.ObjectId(f.userId);
    if (f.ip) filter.ip = f.ip;
    if (f.deviceId) filter.deviceId = { $regex: `^${escapeRegex(f.deviceId.toLowerCase())}` };
    if (f.result) filter.result = f.result;
    const range = dateRange(f.from, f.to);
    if (range) filter.createdAt = range;
    return filter;
  }

  private eventRow(e: Pick<ISecurityEvent, 'type' | 'result' | 'createdAt' | 'ip' | 'device' | 'deviceId' | 'sessionId' | 'reason' | 'note' | 'actorId' | 'userId' | 'metadata'> & { _id: unknown }, members: Map<string, SecurityMember>, names: Map<string, string>) {
    const member = members.get(String(e.userId));
    const actorId = e.actorId ? String(e.actorId) : null;
    return {
      id: String(e._id),
      type: e.type,
      result: e.result,
      createdAt: e.createdAt,
      ip: e.ip,
      device: e.device ?? null,
      deviceShortId: shortDeviceId(e.deviceId),
      sessionId: e.sessionId,
      reason: e.reason,
      note: e.note,
      user: member
        ? { id: member.userId, name: member.name, email: member.email, businessRole: member.businessRole }
        : { id: String(e.userId), name: names.get(String(e.userId)) ?? 'Cuenta sin acceso actual', email: null, businessRole: null },
      actor: actorId ? { id: actorId, name: names.get(actorId) ?? 'Administrador' } : null,
      metadata: e.metadata ?? {},
    };
  }

  async events(businessId: string, f: EventFilters) {
    const { business, members } = await this.loadMembers(businessId);
    const memberMap = new Map(members.map((m) => [m.userId, m]));
    const filter = this.eventFilter(business._id, f);

    const [rows, total] = await Promise.all([
      SecurityEvent.find(filter).sort({ createdAt: -1 }).skip((f.page - 1) * f.limit).limit(f.limit).lean(),
      SecurityEvent.countDocuments(filter),
    ]);
    const names = await this.namesOf(
      rows.flatMap((r) => [String(r.userId), r.actorId ? String(r.actorId) : null]),
      memberMap
    );
    return { events: rows.map((r) => this.eventRow(r, memberMap, names)), pagination: pagination(f, total) };
  }

  // ── Revocaciones ─────────────────────────────────────────────────────

  /**
   * Una cuenta administrativa que además es empleada de un comercio no se
   * toca desde aquí: sus sesiones se rigen por la S12 (solo Super
   * Administrador, desde Seguridad). Si no, `security:manage` sobre un
   * comercio sería una puerta lateral para cerrar sesiones de otros admins.
   */
  private assertRevocable(member: SecurityMember): void {
    if (member.accountRole === UserRole.ADMIN) {
      throw new AppError(
        'Es una cuenta administrativa: sus sesiones se gestionan desde Seguridad, no desde un comercio.',
        403,
        'ADMIN_ACCOUNT_PROTECTED'
      );
    }
  }

  async revokeSession(businessId: string, sessionId: string, note: string, actor: IUser, req: Request) {
    const { business, members } = await this.loadMembers(businessId);
    const notFound = new AppError('Esa sesión no pertenece a este negocio', 404);
    if (!Types.ObjectId.isValid(sessionId)) throw notFound;

    const session = await Session.findById(sessionId).select('userId deviceId').lean();
    const member = session ? members.find((m) => m.active && m.userId === session.userId) : undefined;
    if (!session || !member) throw notFound;
    this.assertRevocable(member);

    const revoked = await sessionManager.revokeSession(sessionId, member.userId, 'admin', actor._id.toString());
    if (!revoked) throw new AppError('Esa sesión ya estaba cerrada', 409, 'SESSION_ALREADY_CLOSED');

    await recordSecurityEvent({
      userId: member.userId,
      role: member.accountRole,
      req,
      type: SecurityEventType.ADMIN_SESSION_REVOCATION,
      sessionId,
      deviceId: session.deviceId,
      reason: 'admin',
      note,
      actorId: actor._id,
      metadata: { scope: 'session', count: 1, businessId: String(business._id) },
    });
    await logAudit(req, {
      action: AuditAction.SESSION_REVOKED,
      entity: 'session',
      entityId: sessionId,
      severity: AuditSeverity.HIGH,
      description: `Sesión de ${member.name} cerrada desde el centro de seguridad de ${business.name}: ${note}`,
      metadata: { businessId: String(business._id), targetUserId: member.userId, reason: note },
    });
    return { revoked: 1 };
  }

  async revokeUserSessions(businessId: string, userId: string, note: string, totpToken: string, actor: IUser, req: Request) {
    const { business, members } = await this.loadMembers(businessId);
    const member = members.find((m) => m.active && m.userId === userId);
    if (!member) throw new AppError('Esa persona no tiene acceso a este negocio', 404);
    this.assertRevocable(member);
    // La membresía se comprueba antes del TOTP: un código de un solo uso no
    // debería gastarse en una petición que iba a fallar igual.
    await assertStepUpAuthorized(req, note, totpToken, 'de la revocación', 'al revocar sesiones de un comercio');

    const revoked = await sessionManager.revokeAllSessions(userId, { reason: 'admin', revokedBy: actor._id.toString() });
    await recordSecurityEvent({
      userId,
      role: member.accountRole,
      req,
      type: SecurityEventType.ADMIN_SESSION_REVOCATION,
      reason: 'admin',
      note,
      actorId: actor._id,
      metadata: { scope: 'user', count: revoked, businessId: String(business._id) },
    });
    await logAudit(req, {
      action: AuditAction.SESSION_REVOKED_ALL,
      entity: 'user',
      entityId: userId,
      severity: AuditSeverity.HIGH,
      description: `${revoked} sesiones de ${member.name} cerradas desde el centro de seguridad de ${business.name}: ${note}`,
      metadata: { businessId: String(business._id), revoked, reason: note },
    });
    return { revoked };
  }

  async revokeBusinessSessions(businessId: string, note: string, totpToken: string, actor: IUser, req: Request) {
    const { business, members } = await this.loadMembers(businessId);
    const active = members.filter((m) => m.active);
    const targets = active.filter((m) => m.accountRole !== UserRole.ADMIN);
    const skipped = active.length - targets.length;
    await assertStepUpAuthorized(req, note, totpToken, 'de la revocación', 'al revocar sesiones de un comercio');

    let total = 0;
    for (const member of targets) {
      const revoked = await sessionManager.revokeAllSessions(member.userId, { reason: 'admin', revokedBy: actor._id.toString() });
      total += revoked;
      if (revoked > 0) {
        await recordSecurityEvent({
          userId: member.userId,
          role: member.accountRole,
          req,
          type: SecurityEventType.ADMIN_SESSION_REVOCATION,
          reason: 'admin',
          note,
          actorId: actor._id,
          metadata: { scope: 'business', count: revoked, businessId: String(business._id) },
        });
      }
    }
    await logAudit(req, {
      action: AuditAction.SESSION_REVOKED_ALL,
      entity: 'business',
      entityId: String(business._id),
      severity: AuditSeverity.CRITICAL,
      description: `${total} sesiones de ${targets.length} cuentas de ${business.name} cerradas desde el centro de seguridad: ${note}`,
      metadata: { revoked: total, users: targets.length, skipped, reason: note },
    });
    return { revoked: total, users: targets.length, skipped };
  }

  // ── Exporte ──────────────────────────────────────────────────────────

  /**
   * Historial en CSV. Trae correos e IP de personas: pasa por la misma
   * puerta que los demás exportes con datos personales (Super
   * Administrador, motivo y TOTP).
   */
  async exportEvents(businessId: string, f: Omit<EventFilters, 'page' | 'limit'>, reason: string, totpToken: string, req: Request) {
    const { business, members } = await this.loadMembers(businessId);
    await assertExportAuthorized(req, reason, totpToken);

    const memberMap = new Map(members.map((m) => [m.userId, m]));
    const rows = await SecurityEvent.find(this.eventFilter(business._id, f)).sort({ createdAt: -1 }).limit(EXPORT_MAX_ROWS).lean();
    const names = await this.namesOf(
      rows.flatMap((r) => [String(r.userId), r.actorId ? String(r.actorId) : null]),
      memberMap
    );

    void logAudit(req, {
      action: AuditAction.DATA_EXPORTED,
      entity: 'business',
      entityId: String(business._id),
      severity: AuditSeverity.HIGH,
      description: `Exporte del historial de seguridad de ${business.name} (${rows.length} filas): ${reason}`,
      metadata: { rows: rows.length, reason, filter: f },
    });
    return { business, events: rows.map((r) => this.eventRow(r, memberMap, names)) };
  }
}

export const businessSecurityService = new BusinessSecurityService();
