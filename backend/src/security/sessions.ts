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
  | 'role_changed'
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
  /**
   * `true` si `deviceId` es el identificador aleatorio que manda el propio
   * navegador (ver `normalizeClientDeviceId`). `false` si se derivó del
   * User-Agent porque no llegó ninguno: dos equipos con el mismo navegador
   * comparten ese valor, así que no identifica a nadie.
   */
  identified: boolean;
  deviceInfo: {
    platform: string;
    os: string;
    osVersion?: string;
    browser: string;
    browserVersion?: string;
    appVersion?: string;
  };
  /** IP con la que se abrió la sesión. */
  ip: string;
  /** Última IP que refrescó la sesión. Cambiar de red no la invalida. */
  lastIp?: string | null;
  userAgent: string;
  /** Primer factor con el que se abrió (`password`, `google`, `otp`…). */
  authMethod?: string | null;
  /** La sesión salió de un login que pasó el segundo factor. */
  mfa: boolean;
  location?: {
    lat: number;
    lng: number;
    city?: string;
  };
  isActive: boolean;
  revokedAt?: Date | null;
  revokedReason?: SessionRevokeReason | null;
  /** Admin que la cerró desde el panel. `null` si la cerró la persona o el sistema. */
  revokedBy?: string | null;
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
  /**
   * Sesión de staff (`role: admin`, panel admin). Decisión del 2026-09-23
   * (S8): 8 h de vida absoluta con cierre a los 30 min de inactividad —
   * mucho más corta que la de cliente/comercio/domiciliario (deslizante de
   * `SESSION_TTL_DAYS`, absoluta de `SESSION_ABSOLUTE_TTL_DAYS`). Se guarda
   * en la sesión, no se recalcula por el rol actual del usuario, para que
   * rotar el token de una sesión ya abierta no cambie sus reglas a medio
   * camino si el rol de la cuenta cambia después.
   */
  isStaff: boolean;
}

const sessionSchema = new Schema<ISession>(
  {
    userId: { type: String, required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    previousTokenHash: { type: String, default: null, index: true },
    rotatedAt: { type: Date, default: null },
    deviceId: { type: String, required: true },
    identified: { type: Boolean, default: false },
    deviceInfo: {
      platform: { type: String, default: 'unknown' },
      os: { type: String, default: 'unknown' },
      osVersion: { type: String },
      browser: { type: String, default: 'unknown' },
      browserVersion: { type: String },
      appVersion: { type: String },
    },
    ip: { type: String, required: true },
    lastIp: { type: String, default: null },
    userAgent: { type: String, default: 'unknown' },
    authMethod: { type: String, default: null },
    mfa: { type: Boolean, default: false },
    location: {
      lat: { type: Number },
      lng: { type: Number },
      city: { type: String },
    },
    isActive: { type: Boolean, default: true },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, default: null },
    revokedBy: { type: String, default: null },
    lastActivity: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
    absoluteExpiresAt: { type: Date, default: null },
    isStaff: { type: Boolean, default: false },
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
  '_id userId identified deviceInfo ip lastIp userAgent location authMethod mfa isActive revokedAt revokedReason lastActivity createdAt expiresAt absoluteExpiresAt';

/**
 * Lo mismo más el dispositivo y quién la revocó: solo para el servicio del
 * panel admin, que recorta `deviceId` antes de responder. El identificador
 * completo no sale por ninguna API: quien lo conoce puede presentarse como
 * ese equipo y silenciar el aviso de nuevo dispositivo.
 */
export const SESSION_ADMIN_FIELDS = `${SESSION_PUBLIC_FIELDS} deviceId revokedBy`;

// ── Device Fingerprint Model ──

export interface IDeviceFingerprint extends Document {
  userId: string;
  deviceId: string;
  fingerprint: string;
  /** Ver `ISession.identified`. */
  identified: boolean;
  deviceInfo?: ISession['deviceInfo'];
  firstIp?: string | null;
  lastIp?: string | null;
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
    identified: { type: Boolean, default: false },
    deviceInfo: {
      platform: { type: String },
      os: { type: String },
      osVersion: { type: String },
      browser: { type: String },
      browserVersion: { type: String },
      appVersion: { type: String },
    },
    firstIp: { type: String, default: null },
    lastIp: { type: String, default: null },
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
 * Navegador, sistema y tipo de equipo a partir del User-Agent, para que el
 * panel diga "Chrome 128 · Windows" en vez de una cadena ilegible.
 *
 * El orden importa: Edge, Opera y Samsung Internet también dicen "Chrome" en
 * su User-Agent, y Chrome también dice "Safari". Antes se preguntaba por
 * Chrome primero y Edge salía siempre como Chrome.
 *
 * Es una etiqueta para humanos, no una prueba de nada: el User-Agent lo
 * escribe el cliente.
 */
export function parseUserAgent(ua: string): ISession['deviceInfo'] {
  const info: ISession['deviceInfo'] = {
    platform: 'unknown',
    os: 'unknown',
    browser: 'unknown',
  };
  if (!ua || ua === 'unknown') return info;

  if (/ipad|tablet/i.test(ua) || (/android/i.test(ua) && !/mobile/i.test(ua))) info.platform = 'tablet';
  else if (/mobile|iphone|ipod|android/i.test(ua)) info.platform = 'mobile';
  else info.platform = 'desktop';

  const os: Array<[RegExp, string, RegExp?]> = [
    [/android/i, 'Android', /android (\d+(?:\.\d+)?)/i],
    [/iphone|ipad|ipod/i, 'iOS', /os (\d+)[_.](\d+)/i],
    [/windows/i, 'Windows', /windows nt (\d+\.\d+)/i],
    [/cros/i, 'ChromeOS'],
    [/mac os x|macintosh/i, 'macOS', /mac os x (\d+)[_.](\d+)/i],
    [/linux/i, 'Linux'],
  ];
  for (const [test, name, version] of os) {
    if (!test.test(ua)) continue;
    info.os = name;
    const m = version ? ua.match(version) : null;
    if (m) {
      // Windows 10 y 11 dicen los dos "NT 10.0": no se inventa un "11".
      info.osVersion = name === 'Windows' ? ({ '10.0': '10/11', '6.3': '8.1', '6.1': '7' }[m[1]] ?? m[1]) : m.slice(1).filter(Boolean).join('.');
    }
    break;
  }

  const browsers: Array<[RegExp, string]> = [
    [/expo/i, 'Expo'],
    [/edg(?:e|a|ios)?\/([\d.]+)/i, 'Edge'],
    [/(?:opr|opera)\/([\d.]+)/i, 'Opera'],
    [/samsungbrowser\/([\d.]+)/i, 'Samsung Internet'],
    [/(?:chrome|crios)\/([\d.]+)/i, 'Chrome'],
    [/(?:firefox|fxios)\/([\d.]+)/i, 'Firefox'],
    [/version\/([\d.]+).*safari/i, 'Safari'],
    [/safari/i, 'Safari'],
  ];
  for (const [test, name] of browsers) {
    const m = ua.match(test);
    if (!m) continue;
    info.browser = name;
    // Solo la versión mayor: "128", no "128.0.6613.120".
    if (m[1]) info.browserVersion = m[1].split('.')[0];
    break;
  }

  return info;
}

/**
 * Identificador de dispositivo que manda el cliente: un UUID v4 que el
 * navegador genera con `crypto.randomUUID()` la primera vez y guarda.
 *
 * Nada de huellas del equipo (IMEI, MAC, canvas…): es aleatorio y vive solo
 * en ese navegador. Tiene 122 bits al azar, así que no se adivina el de otra
 * persona; falsificarlo exige leer su almacenamiento, y quien puede eso ya
 * tiene sus tokens.
 *
 * Cualquier otra cosa se descarta (`null`): el llamador lo trata como un
 * dispositivo no identificado, que nunca cuenta como conocido. Si faltar la
 * cabecera sirviera para parecer conocido, omitirla sería la forma de
 * esquivar el aviso de nuevo dispositivo.
 */
const CLIENT_DEVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function normalizeClientDeviceId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  return CLIENT_DEVICE_ID.test(value) ? value : null;
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
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** Staff (S8): 30 min de inactividad cierran la sesión, sin excepción de entorno. */
const STAFF_SLIDING_TTL_MS = 30 * MINUTE_MS;
/** Staff (S8): 8 h de vida absoluta, por mucho que se refresque. */
const STAFF_ABSOLUTE_TTL_MS = 8 * HOUR_MS;

const slidingTtlMs = (isStaff: boolean) =>
  isStaff ? STAFF_SLIDING_TTL_MS : Math.max(1, config.security.session.sessionTTLDays) * DAY_MS;
const absoluteTtlMs = (isStaff: boolean) =>
  isStaff ? STAFF_ABSOLUTE_TTL_MS : Math.max(1, config.security.session.absoluteTTLDays) * DAY_MS;

/** Filtro de "no ha pasado la caducidad absoluta", tolerante con sesiones anteriores a ese campo. */
const withinAbsoluteLifetime = (now: Date) => ({
  $or: [{ absoluteExpiresAt: null }, { absoluteExpiresAt: { $exists: false } }, { absoluteExpiresAt: { $gt: now } }],
});

/**
 * Sesiones que de verdad siguen abiertas: no revocadas y sin pasar ninguna
 * de las dos caducidades. Trae un `$or`: para combinarlo con otro, va dentro
 * de un `$and`.
 */
export const activeSessionFilter = (now: Date) => ({
  isActive: true,
  expiresAt: { $gt: now },
  ...withinAbsoluteLifetime(now),
});

export type SessionStatus = 'active' | 'revoked' | 'expired';

/** Estado legible de una sesión, con la misma regla que `activeSessionFilter`. */
export function sessionStatus(
  session: Pick<ISession, 'isActive' | 'expiresAt' | 'absoluteExpiresAt'>,
  now: Date = new Date()
): SessionStatus {
  if (!session.isActive) return 'revoked';
  if (session.expiresAt <= now) return 'expired';
  if (session.absoluteExpiresAt && session.absoluteExpiresAt <= now) return 'expired';
  return 'active';
}

export type RotationResult =
  /** `previousIp`: la última IP que había usado la sesión antes de este refresco. */
  | { status: 'rotated'; session: ISession; previousIp: string | null }
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
    /** Lo que mandó el cliente; se valida aquí (ver `normalizeClientDeviceId`). */
    deviceId?: string | null;
    /** S8: cuentas `role: admin` corren con TTL de staff (8h/30min). */
    isStaff?: boolean;
    authMethod?: string;
    /** La sesión sale de un login que pasó el segundo factor. */
    mfa?: boolean;
  }): Promise<{
    session: ISession;
    /** El par (usuario, dispositivo) no se había visto nunca. */
    isNewDevice: boolean;
    /** El cliente no mandó un identificador válido: ver `ISession.identified`. */
    identified: boolean;
    /** Sesiones que se cerraron para respetar `MAX_ACTIVE_SESSIONS`. */
    evictedSessionIds: string[];
  }> {
    const { userId, sessionId, refreshToken, ip, userAgent, isStaff = false, mfa = false } = params;
    const clientDeviceId = normalizeClientDeviceId(params.deviceId);
    const identified = clientDeviceId !== null;
    const actualDeviceId = clientDeviceId ?? generateDeviceId(userAgent, ip);
    const deviceInfo = parseUserAgent(userAgent);
    const now = new Date();

    // Una sola operación atómica: antes era `findOne` → `save()`, y dos
    // inicios de sesión simultáneos desde el mismo equipo perdían un
    // `loginCount` o chocaban con el índice único. `loginCount` va solo en
    // `$inc` (sin default al insertar): Mongo rechaza que `$inc` y
    // `$setOnInsert` toquen el mismo campo.
    const upsert = await DeviceFingerprint.findOneAndUpdate(
      { userId, deviceId: actualDeviceId },
      {
        $setOnInsert: { fingerprint: hashToken(userAgent + ip), isTrusted: false, firstSeen: now, firstIp: ip },
        $set: { lastSeen: now, lastIp: ip, deviceInfo, identified },
        $inc: { loginCount: 1 },
      },
      { upsert: true, new: false, includeResultMetadata: true, setDefaultsOnInsert: false }
    );
    // Un identificador conocido que llega desde otro navegador u otro sistema
    // no es "el mismo equipo": o se copió el identificador o se falsificó.
    // Se trata como nuevo para que salte el aviso (la versión sí puede
    // cambiar: el navegador se actualiza solo).
    const previous = upsert.value?.deviceInfo;
    const mismatch =
      identified &&
      !!previous?.browser &&
      (previous.browser !== deviceInfo.browser || (previous.os ?? deviceInfo.os) !== deviceInfo.os);
    const isNewDevice = !upsert.lastErrorObject?.updatedExisting || mismatch;

    const session = await Session.create({
      _id: sessionId,
      userId,
      tokenHash: hashToken(refreshToken),
      deviceId: actualDeviceId,
      identified,
      deviceInfo,
      ip,
      lastIp: ip,
      userAgent,
      authMethod: params.authMethod ?? null,
      mfa,
      isActive: true,
      lastActivity: now,
      expiresAt: new Date(now.getTime() + slidingTtlMs(isStaff)),
      absoluteExpiresAt: new Date(now.getTime() + absoluteTtlMs(isStaff)),
      isStaff,
    });

    const evictedSessionIds = await this.enforceSessionLimit(userId);

    return { session, isNewDevice, identified, evictedSessionIds };
  }

  /**
   * Deja como mucho `MAX_ACTIVE_SESSIONS` abiertas, cerrando las de actividad
   * más antigua. La configuración existía pero nada la aplicaba.
   */
  private async enforceSessionLimit(userId: string): Promise<string[]> {
    const max = config.security.session.maxActiveSessions;
    if (!Number.isFinite(max) || max <= 0) return [];

    const overflow = await Session.find({ userId, isActive: true })
      .sort({ lastActivity: -1, createdAt: -1 })
      .skip(max)
      .select('_id');
    if (overflow.length === 0) return [];

    const ids = overflow.map((s) => s._id);
    await Session.updateMany(
      { _id: { $in: ids }, isActive: true },
      { $set: { isActive: false, revokedAt: new Date(), revokedReason: 'session_limit' } }
    );
    disconnectSessionSockets(ids);
    return ids.map((id) => String(id));
  }

  /**
   * ¿Sigue viva la sesión de un access token? Lo pregunta `authenticate` en
   * cada petición: revocar una sesión corta también su access token, sin
   * esperar a que caduque.
   */
  async isSessionActive(sessionId: string, userId: string): Promise<boolean> {
    if (!Types.ObjectId.isValid(sessionId)) return false;
    const now = new Date();
    const session = await Session.findOne({
      _id: sessionId,
      userId,
      isActive: true,
      expiresAt: { $gt: now },
      ...withinAbsoluteLifetime(now),
    }).select('isStaff lastActivity absoluteExpiresAt');
    if (!session) return false;

    // M1(c): la caducidad por inactividad del staff (30 min) solo avanzaba
    // cuando refrescaba el access token — en la práctica, hasta 15 min de
    // margen extra sobre el TTL nominal porque la petición REST de cada
    // pantalla nunca toca `expiresAt`. Aquí se desliza también, pero como
    // mucho una vez por minuto (para no convertir cada petición en una
    // escritura) y sin pasar de `absoluteExpiresAt`.
    if (session.isStaff) {
      const throttleMs = 60_000;
      const dueForSlide =
        !session.lastActivity || now.getTime() - session.lastActivity.getTime() >= throttleMs;
      if (dueForSlide) {
        let newExpiresAt = new Date(now.getTime() + slidingTtlMs(true));
        if (session.absoluteExpiresAt && newExpiresAt > session.absoluteExpiresAt) {
          newExpiresAt = session.absoluteExpiresAt;
        }
        await Session.updateOne(
          { _id: sessionId },
          { $set: { lastActivity: now, expiresAt: newExpiresAt } }
        );
      }
    }

    return true;
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
  async rotateRefreshToken(oldRefreshToken: string, newRefreshToken: string, ip?: string): Promise<RotationResult> {
    const oldHash = hashToken(oldRefreshToken);
    const now = new Date();
    const filter = { tokenHash: oldHash, isActive: true, expiresAt: { $gt: now }, ...withinAbsoluteLifetime(now) };

    // S8: la sesión de staff refresca con su propio TTL (30 min de
    // inactividad), no con el de cliente/comercio/domiciliario. `isStaff`
    // ya vive en el documento desde `createSession`, así que una lectura
    // previa (fuera del `findOneAndUpdate` atómico, que sigue siendo la
    // única escritura) basta para saber cuál aplicar.
    const existing = await Session.findOne(filter).select('isStaff ip lastIp');
    if (!existing) {
      const dead = await Session.findOne({ tokenHash: oldHash }).select('userId');
      if (!dead) {
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
        return { status: 'revoked', userId: undefined };
      }
      return { status: 'revoked', userId: dead.userId };
    }

    const rotated = await Session.findOneAndUpdate(
      filter,
      {
        $set: {
          tokenHash: hashToken(newRefreshToken),
          previousTokenHash: oldHash,
          rotatedAt: now,
          lastActivity: now,
          expiresAt: new Date(now.getTime() + slidingTtlMs(existing.isStaff)),
          ...(ip ? { lastIp: ip } : {}),
        },
      },
      { new: true }
    );
    if (rotated) return { status: 'rotated', session: rotated, previousIp: existing.lastIp ?? existing.ip ?? null };

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
  async revokeSession(
    sessionId: string,
    userId: string,
    reason: SessionRevokeReason = 'user_revoked',
    revokedBy: string | null = null
  ): Promise<boolean> {
    if (!Types.ObjectId.isValid(sessionId)) return false;
    const result = await Session.findOneAndUpdate(
      { _id: sessionId, userId, isActive: true },
      { $set: { isActive: false, revokedAt: new Date(), revokedReason: reason, revokedBy } }
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
    options: {
      exceptSessionId?: string;
      exceptRefreshToken?: string;
      reason?: SessionRevokeReason;
      /** Admin que las cierra desde el panel. */
      revokedBy?: string | null;
    } = {}
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
      { $set: { isActive: false, revokedAt: new Date(), revokedReason: options.reason ?? 'revoke_all', revokedBy: options.revokedBy ?? null } }
    );
    disconnectSessionSockets(ids);
    return result.modifiedCount;
  }

  /**
   * Sesiones activas de un usuario, sin los hashes de token.
   */
  async getActiveSessions(userId: string): Promise<any[]> {
    // También la caducidad absoluta: una sesión que ya pasó sus 30 días
    // aparecía como abierta hasta que el TTL la borrara, aunque
    // `isSessionActive` ya la rechazaba.
    return Session.find({ userId, ...activeSessionFilter(new Date()) })
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
