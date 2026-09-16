import mongoose, { Schema, Document, Types } from 'mongoose';
import crypto from 'crypto';
import { config } from '../config';
import { getIO } from '../sockets/emitter';

// ── Session Model ──

export type SessionRevokeReason =
  | 'logout'
  | 'user_revoked'
  | 'revoke_all'
  | 'password_changed'
  | 'contact_changed'
  | 'admin'
  | 'reuse_detected'
  | 'session_limit'
  | 'device_removed'
  | 'account_deleted'
  | 'migration';

export interface ISession extends Document {
  userId: string;
  /**
   * SHA-256 del refresh token vigente. Es la única copia del token en el
   * servidor: `User.refreshToken` (en claro, uno por usuario) desapareció.
   */
  tokenHash: string;
  /**
   * Hash del token inmediatamente anterior. Distingue dos refrescos
   * simultáneos del mismo cliente (benigno, en unos segundos) de un token
   * robado que vuelve a usarse después (reuso → se revoca todo).
   */
  previousTokenHash?: string | null;
  rotatedAt?: Date | null;
  deviceId: string;
  deviceInfo: {
    platform: string;
    os: string;
    browser: string;
    appVersion?: string;
  };
  ip: string;
  userAgent: string;
  location?: {
    lat: number;
    lng: number;
    city?: string;
  };
  isActive: boolean;
  revokedAt?: Date | null;
  revokedReason?: SessionRevokeReason | null;
  lastActivity: Date;
  createdAt: Date;
  /** Caducidad deslizante: se renueva en cada rotación. */
  expiresAt: Date;
  /**
   * Caducidad absoluta. Sin ella un token robado que se siguiera refrescando
   * viviría para siempre, porque cada rotación empujaba `expiresAt` otros
   * siete días.
   */
  absoluteExpiresAt?: Date | null;
}

const sessionSchema = new Schema<ISession>(
  {
    userId: { type: String, required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    previousTokenHash: { type: String, default: null, index: true },
    rotatedAt: { type: Date, default: null },
    deviceId: { type: String, required: true },
    deviceInfo: {
      platform: { type: String, default: 'unknown' },
      os: { type: String, default: 'unknown' },
      browser: { type: String, default: 'unknown' },
      appVersion: { type: String },
    },
    ip: { type: String, required: true },
    userAgent: { type: String, default: 'unknown' },
    location: {
      lat: { type: Number },
      lng: { type: Number },
      city: { type: String },
    },
    isActive: { type: Boolean, default: true },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, default: null },
    lastActivity: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
    absoluteExpiresAt: { type: Date, default: null },
  },
  { timestamps: true }
);

sessionSchema.index({ userId: 1, isActive: 1 });
sessionSchema.index({ userId: 1, deviceId: 1 });

export const Session = mongoose.model<ISession>('Session', sessionSchema);

/**
 * Campos de una sesión que pueden salir por la API (al propio usuario o al
 * panel). Nunca `tokenHash` ni `previousTokenHash`: no son el token, pero son
 * la llave con la que el servidor lo reconoce.
 */
export const SESSION_PUBLIC_FIELDS =
  '_id userId deviceId deviceInfo ip userAgent location isActive revokedAt revokedReason lastActivity createdAt expiresAt';

// ── Device Fingerprint Model ──

export interface IDeviceFingerprint extends Document {
  userId: string;
  deviceId: string;
  fingerprint: string;
  isTrusted: boolean;
  firstSeen: Date;
  lastSeen: Date;
  loginCount: number;
  metadata: Record<string, any>;
}

const deviceFingerprintSchema = new Schema<IDeviceFingerprint>(
  {
    userId: { type: String, required: true, index: true },
    deviceId: { type: String, required: true },
    fingerprint: { type: String, required: true },
    isTrusted: { type: Boolean, default: false },
    firstSeen: { type: Date, default: Date.now },
    lastSeen: { type: Date, default: Date.now },
    loginCount: { type: Number, default: 1 },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

deviceFingerprintSchema.index({ userId: 1, deviceId: 1 }, { unique: true });

export const DeviceFingerprint = mongoose.model<IDeviceFingerprint>(
  'DeviceFingerprint',
  deviceFingerprintSchema
);

// ── Session Management Service ──

/**
 * Parse User-Agent for device info
 */
function parseUserAgent(ua: string): ISession['deviceInfo'] {
  const info: ISession['deviceInfo'] = {
    platform: 'unknown',
    os: 'unknown',
    browser: 'unknown',
  };

  // Detect platform
  if (/mobile|android|iphone|ipad/i.test(ua)) info.platform = 'mobile';
  else if (/tablet/i.test(ua)) info.platform = 'tablet';
  else info.platform = 'desktop';

  // Detect OS
  if (/android/i.test(ua)) info.os = 'Android';
  else if (/iphone|ipad|ipod/i.test(ua)) info.os = 'iOS';
  else if (/windows/i.test(ua)) info.os = 'Windows';
  else if (/mac/i.test(ua)) info.os = 'macOS';
  else if (/linux/i.test(ua)) info.os = 'Linux';

  // Detect browser
  if (/expo/i.test(ua)) info.browser = 'Expo';
  else if (/chrome/i.test(ua)) info.browser = 'Chrome';
  else if (/firefox/i.test(ua)) info.browser = 'Firefox';
  else if (/safari/i.test(ua)) info.browser = 'Safari';
  else if (/edge/i.test(ua)) info.browser = 'Edge';

  return info;
}

/**
 * Generate device ID from request info
 */
export function generateDeviceId(userAgent: string, ip: string, extraData?: string): string {
  const data = `${userAgent}|${extraData || 'default'}`;
  return crypto.createHash('sha256').update(data).digest('hex').substring(0, 32);
}

/**
 * Hash a token for storage
 */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Ventana en la que presentar el token *anterior* se trata como una carrera
 * benigna del propio cliente (dos pestañas o dos queries que refrescan a la
 * vez) y no como un robo. Fuera de ella, es reuso.
 */
export const REFRESH_REUSE_GRACE_MS = 15 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
const slidingTtlMs = () => Math.max(1, config.security.session.sessionTTLDays) * DAY_MS;
const absoluteTtlMs = () => Math.max(1, config.security.session.absoluteTTLDays) * DAY_MS;

/** Filtro de "no ha pasado la caducidad absoluta", tolerante con sesiones anteriores a ese campo. */
const withinAbsoluteLifetime = (now: Date) => ({
  $or: [{ absoluteExpiresAt: null }, { absoluteExpiresAt: { $exists: false } }, { absoluteExpiresAt: { $gt: now } }],
});

export type RotationResult =
  | { status: 'rotated'; session: ISession }
  /** El token anterior, dentro de la ventana de gracia: otra petición ya lo rotó. */
  | { status: 'race'; session: ISession }
  /** Token de una sesión cerrada, vencida o inexistente. */
  | { status: 'revoked'; userId?: string }
  /** Un token ya rotado, fuera de la ventana de gracia: se revocó todo. */
  | { status: 'reuse'; userId: string; revokedCount: number };

/** Cierra sockets abiertos con sesiones recién revocadas. Sin `io` (pruebas, scripts) no hace nada. */
function disconnectSessionSockets(sessionIds: Array<Types.ObjectId | string>): void {
  const io = getIO();
  if (!io) return;
  for (const id of sessionIds) io.in(`session:${id.toString()}`).disconnectSockets(true);
}

export class SessionManager {
  /**
   * Create a new session for a user.
   *
   * `sessionId` lo genera quien emite los tokens, antes de firmarlos: viaja
   * como `sid` dentro del access token y del refresh token, y la sesión se
   * crea con ese mismo `_id`.
   */
  async createSession(params: {
    userId: string;
    sessionId: Types.ObjectId;
    refreshToken: string;
    ip: string;
    userAgent: string;
    deviceId?: string;
  }): Promise<{ session: ISession; isNewDevice: boolean }> {
    const { userId, sessionId, refreshToken, ip, userAgent, deviceId } = params;
    const actualDeviceId = deviceId || generateDeviceId(userAgent, ip);

    // Check if this is a new device
    let isNewDevice = false;
    const existingDevice = await DeviceFingerprint.findOne({ userId, deviceId: actualDeviceId });

    if (!existingDevice) {
      isNewDevice = true;
      // Upsert y no `create`: dos inicios de sesión simultáneos desde el mismo
      // dispositivo chocaban con el índice único y el segundo fallaba.
      await DeviceFingerprint.updateOne(
        { userId, deviceId: actualDeviceId },
        {
          $setOnInsert: { fingerprint: hashToken(userAgent + ip), isTrusted: false, firstSeen: new Date(), loginCount: 1 },
          $set: { lastSeen: new Date() },
        },
        { upsert: true }
      );
    } else {
      existingDevice.lastSeen = new Date();
      existingDevice.loginCount += 1;
      await existingDevice.save();
    }

    const now = Date.now();
    const session = await Session.create({
      _id: sessionId,
      userId,
      tokenHash: hashToken(refreshToken),
      deviceId: actualDeviceId,
      deviceInfo: parseUserAgent(userAgent),
      ip,
      userAgent,
      isActive: true,
      lastActivity: new Date(now),
      expiresAt: new Date(now + slidingTtlMs()),
      absoluteExpiresAt: new Date(now + absoluteTtlMs()),
    });

    await this.enforceSessionLimit(userId);

    return { session, isNewDevice };
  }

  /**
   * Deja como mucho `MAX_ACTIVE_SESSIONS` abiertas, cerrando las de actividad
   * más antigua. La configuración existía pero nada la aplicaba.
   */
  private async enforceSessionLimit(userId: string): Promise<void> {
    const max = config.security.session.maxActiveSessions;
    if (!Number.isFinite(max) || max <= 0) return;

    const overflow = await Session.find({ userId, isActive: true })
      .sort({ lastActivity: -1, createdAt: -1 })
      .skip(max)
      .select('_id');
    if (overflow.length === 0) return;

    const ids = overflow.map((s) => s._id);
    await Session.updateMany(
      { _id: { $in: ids }, isActive: true },
      { $set: { isActive: false, revokedAt: new Date(), revokedReason: 'session_limit' } }
    );
    disconnectSessionSockets(ids);
  }

  /**
   * ¿Sigue viva la sesión de un access token? Lo pregunta `authenticate` en
   * cada petición: revocar una sesión corta también su access token, sin
   * esperar a que caduque.
   */
  async isSessionActive(sessionId: string, userId: string): Promise<boolean> {
    if (!Types.ObjectId.isValid(sessionId)) return false;
    const now = new Date();
    const found = await Session.exists({
      _id: sessionId,
      userId,
      isActive: true,
      expiresAt: { $gt: now },
      ...withinAbsoluteLifetime(now),
    });
    return !!found;
  }

  /** La sesión (viva o no) a la que pertenece un refresh token. */
  async findByRefreshToken(refreshToken: string): Promise<ISession | null> {
    return Session.findOne({ tokenHash: hashToken(refreshToken) });
  }

  /**
   * Validate and rotate a refresh token (Refresh Token Rotation).
   *
   * La rotación es un único `findOneAndUpdate` condicionado al hash vigente:
   * de dos refrescos simultáneos con el mismo token gana uno, y el otro cae
   * en la rama de carrera (dentro de la ventana de gracia) sin revocar nada.
   * Un token ya rotado que aparece más tarde es reuso: alguien más lo tiene,
   * y se cierran todas las sesiones del usuario.
   */
  async rotateRefreshToken(oldRefreshToken: string, newRefreshToken: string): Promise<RotationResult> {
    const oldHash = hashToken(oldRefreshToken);
    const now = new Date();

    const rotated = await Session.findOneAndUpdate(
      { tokenHash: oldHash, isActive: true, expiresAt: { $gt: now }, ...withinAbsoluteLifetime(now) },
      {
        $set: {
          tokenHash: hashToken(newRefreshToken),
          previousTokenHash: oldHash,
          rotatedAt: now,
          lastActivity: now,
          expiresAt: new Date(now.getTime() + slidingTtlMs()),
        },
      },
      { new: true }
    );
    if (rotated) return { status: 'rotated', session: rotated };

    const rotatedAway = await Session.findOne({ previousTokenHash: oldHash });
    if (rotatedAway) {
      const withinGrace =
        rotatedAway.isActive &&
        !!rotatedAway.rotatedAt &&
        now.getTime() - rotatedAway.rotatedAt.getTime() <= REFRESH_REUSE_GRACE_MS;
      if (withinGrace) return { status: 'race', session: rotatedAway };

      const revokedCount = await this.revokeAllSessions(rotatedAway.userId, { reason: 'reuse_detected' });
      console.error(`[SECURITY] Refresh token reuse detected for user ${rotatedAway.userId}. All sessions revoked.`);
      return { status: 'reuse', userId: rotatedAway.userId, revokedCount };
    }

    const dead = await Session.findOne({ tokenHash: oldHash }).select('userId');
    return { status: 'revoked', userId: dead?.userId };
  }

  /**
   * Revoke a specific session
   */
  async revokeSession(sessionId: string, userId: string, reason: SessionRevokeReason = 'user_revoked'): Promise<boolean> {
    if (!Types.ObjectId.isValid(sessionId)) return false;
    const result = await Session.findOneAndUpdate(
      { _id: sessionId, userId, isActive: true },
      { $set: { isActive: false, revokedAt: new Date(), revokedReason: reason } }
    );
    if (result) disconnectSessionSockets([sessionId]);
    return !!result;
  }

  /** Cierra la sesión dueña de un refresh token (logout de clientes con tokens previos a `sid`). */
  async revokeByRefreshToken(refreshToken: string, userId: string, reason: SessionRevokeReason = 'logout'): Promise<boolean> {
    const result = await Session.findOneAndUpdate(
      { tokenHash: hashToken(refreshToken), userId, isActive: true },
      { $set: { isActive: false, revokedAt: new Date(), revokedReason: reason } }
    );
    if (result) disconnectSessionSockets([result._id as Types.ObjectId]);
    return !!result;
  }

  /**
   * Revoke all sessions for a user, optionally keeping the current one.
   */
  async revokeAllSessions(
    userId: string,
    options: { exceptSessionId?: string; exceptRefreshToken?: string; reason?: SessionRevokeReason } = {}
  ): Promise<number> {
    const filter: Record<string, unknown> = { userId, isActive: true };
    if (options.exceptSessionId && Types.ObjectId.isValid(options.exceptSessionId)) {
      filter._id = { $ne: new Types.ObjectId(options.exceptSessionId) };
    } else if (options.exceptRefreshToken) {
      filter.tokenHash = { $ne: hashToken(options.exceptRefreshToken) };
    }

    const targets = await Session.find(filter).select('_id');
    if (targets.length === 0) return 0;

    const ids = targets.map((t) => t._id as Types.ObjectId);
    const result = await Session.updateMany(
      { _id: { $in: ids }, isActive: true },
      { $set: { isActive: false, revokedAt: new Date(), revokedReason: options.reason ?? 'revoke_all' } }
    );
    disconnectSessionSockets(ids);
    return result.modifiedCount;
  }

  /**
   * Sesiones activas de un usuario, sin los hashes de token.
   */
  async getActiveSessions(userId: string): Promise<any[]> {
    return Session.find({ userId, isActive: true, expiresAt: { $gt: new Date() } })
      .select(SESSION_PUBLIC_FIELDS)
      .sort({ lastActivity: -1 })
      .lean();
  }

  /**
   * Check for simultaneous usage (different IPs at the same time)
   */
  async checkSimultaneousUsage(userId: string, currentIp: string): Promise<boolean> {
    const recentSessions = await Session.find({
      userId,
      isActive: true,
      lastActivity: { $gte: new Date(Date.now() - 5 * 60 * 1000) }, // Last 5 min
      ip: { $ne: currentIp },
    });
    return recentSessions.length > 0;
  }

  /**
   * Dispositivos registrados de un usuario.
   */
  async getUserDevices(userId: string): Promise<any[]> {
    return DeviceFingerprint.find({ userId }).sort({ lastSeen: -1 }).lean();
  }

  /**
   * Trust a device
   */
  async trustDevice(userId: string, deviceId: string): Promise<boolean> {
    const result = await DeviceFingerprint.findOneAndUpdate(
      { userId, deviceId },
      { isTrusted: true }
    );
    return !!result;
  }

  /**
   * Remove a device
   */
  async removeDevice(userId: string, deviceId: string): Promise<boolean> {
    // Revoke all sessions from this device
    const targets = await Session.find({ userId, deviceId, isActive: true }).select('_id');
    await Session.updateMany(
      { userId, deviceId, isActive: true },
      { $set: { isActive: false, revokedAt: new Date(), revokedReason: 'device_removed' } }
    );
    disconnectSessionSockets(targets.map((t) => t._id as Types.ObjectId));
    const result = await DeviceFingerprint.findOneAndDelete({ userId, deviceId });
    return !!result;
  }
}

export const sessionManager = new SessionManager();
