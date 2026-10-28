import { createHash, randomBytes } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { assertCurrency } from '../core/money.js';
import { COLLECTIONS } from '../data/db.js';
import { DUPLICATE_KEY, withTransaction } from '../data/tx.js';
import { templates } from '../mail/templates.js';
import { DEFAULT_PASSWORD_PARAMS, hashPassword, validatePasswordStrength, verifyPassword } from './password.js';
import { ROLE_PERMISSIONS, can, isRole } from './permissions.js';
import { open, seal } from './secretbox.js';
import { generateSecret, otpauthUri, verifyTotp } from './totp.js';

export class AuthError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

/*
 * Modelo (referencia, sin tipos):
 * tenants:     { _id, name, country, currency, ownerEpoch, createdAt }
 * users:       { _id, email, name, passwordHash, failedAttempts, lockedUntil, emailVerifiedAt|null,
 *                mfa? { enabled, secretEnc, pendingSecretEnc, lastStep, recoveryHashes[], enrolledAt }, createdAt }
 * memberships: { _id, tenantId, userId, role, createdAt }   (un usuario puede pertenecer a varias empresas)
 * sessions:    { _id, userId, tokenHash, createdAt, lastSeenAt, expiresAt, stepUpAt? }
 * tokens:      { _id, purpose 'verify_email'|'password_reset'|'invite'|'mfa_login', tokenHash, userId?, email?,
 *                tenantId?, role?, invitedBy?, attempts?, createdAt, expiresAt, usedAt|null }
 *
 * - Ningún token se guarda en claro: solo su SHA-256. Cada uno sirve una sola vez y vence.
 * - El secreto TOTP se guarda cifrado (AES-256-GCM); los códigos de recuperación, como hash.
 * - Un usuario no declara a qué empresa pertenece: cada petición nombra la empresa y se
 *   comprueba contra `memberships`. Quien no es miembro recibe el mismo FORBIDDEN que quien
 *   no tiene permiso, para no revelar qué empresas existen.
 * - Los métodos que escriben aceptan `{ inTx }`, que se invoca con la sesión de la transacción
 *   para que la auditoría se confirme junto con la operación.
 */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SESSION_TOKEN_LENGTH = 43; // 32 bytes en base64url
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const RECOVERY_CODE_COUNT = 10;
const MAX_MFA_ATTEMPTS = 5;

const normalizeEmail = (email) => String(email ?? '').trim().toLowerCase();
const hashToken = (token) => createHash('sha256').update(token).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');

function newRecoveryCode() {
  const chars = 'abcdefghijklmnopqrstuvwxyz234567';
  const pick = () => Array.from(randomBytes(5), (b) => chars[b % 32]).join('');
  return `${pick()}-${pick()}`;
}

export function createAuthService(client, db, options = {}) {
  const now = options.now ?? (() => new Date());
  const passwordParams = options.passwordParams ?? DEFAULT_PASSWORD_PARAMS;
  const idleMs = options.idleMs ?? 30 * MINUTE;
  const absoluteMs = options.absoluteMs ?? 12 * HOUR;
  const maxFailedAttempts = options.maxFailedAttempts ?? 5;
  const lockMs = options.lockMs ?? 15 * MINUTE;
  // `lastSeenAt` se escribe como mucho una vez por `touchMs`: escribir en cada petición era una escritura por llamada de cada usuario.
  // El costo es que el vencimiento por inactividad tiene esa precisión (un minuto sobre 30).
  const touchMs = options.touchMs ?? MINUTE;
  // Cuánto dura la confirmación reciente de la contraseña (y del segundo factor) para operaciones delicadas.
  const stepUpMs = options.stepUpMs ?? 10 * MINUTE;
  const membershipCacheMs = options.membershipCacheMs ?? 5000;
  const { mailer = null, appBaseUrl = 'http://localhost:3100', mfaKey = null, issuer = 'Lulubiz', onMailError } = options;

  const tenants = db.collection(COLLECTIONS.tenants);
  const users = db.collection(COLLECTIONS.users);
  const memberships = db.collection(COLLECTIONS.memberships);
  const sessions = db.collection(COLLECTIONS.sessions);
  const tokens = db.collection(COLLECTIONS.tokens);
  const apiKeys = db.collection(COLLECTIONS.apiKeys);

  // Pertenencia (rol) en memoria unos segundos: `authorize` corre en cada petición. Se invalida al cambiar o quitar un rol en
  // este proceso; entre procesos la diferencia máxima es `membershipCacheMs`. Solo guarda pertenencias que existen.
  const memberCache = new Map();
  const cacheKey = (tenantId, userId) => `${tenantId}|${userId}`;
  const forgetMember = (tenantId, userId) => memberCache.delete(cacheKey(tenantId, userId));

  const forbidden = () => new AuthError('no tienes permiso para esta operación', 'FORBIDDEN');
  const invalidCredentials = () => new AuthError('credenciales inválidas', 'INVALID_CREDENTIALS');
  const invalidSession = () => new AuthError('sesión inválida o vencida', 'INVALID_SESSION');
  const invalidMfa = () => new AuthError('código de verificación inválido', 'INVALID_MFA');
  const expiredToken = () => new AuthError('el enlace es inválido o ya venció', 'EXPIRED_TOKEN');
  const requireKey = () => {
    if (!mfaKey) throw new Error('la verificación en dos pasos necesita MFA_ENCRYPTION_KEY');
    return mfaKey;
  };

  let dummyHash;
  /** Hash de relleno: un correo inexistente cuesta lo mismo que uno existente, para no revelar cuentas por tiempo. */
  async function dummyVerify(password) {
    dummyHash ??= await hashPassword(randomBytes(16).toString('hex'), passwordParams);
    await verifyPassword(password, dummyHash);
  }

  /** Envía un correo sin que su fallo tumbe la operación. Devuelve si salió. */
  async function sendMail(to, { subject, text }) {
    if (!mailer) return false;
    try {
      await mailer.send({ to, subject, text });
      return true;
    } catch (err) {
      onMailError?.(err, { to, subject });
      return false;
    }
  }

  /** Crea un token de un solo uso; devuelve el valor en claro, que solo se entrega una vez. */
  async function issueToken(purpose, ttlMs, fields = {}, session) {
    const token = newToken();
    const t = now();
    await tokens.insertOne(
      { purpose, tokenHash: hashToken(token), ...fields, createdAt: t, expiresAt: new Date(t.getTime() + ttlMs), usedAt: null },
      session ? { session } : undefined,
    );
    return token;
  }

  /** Consume un token válido de forma atómica: dos usos simultáneos no pueden ganar los dos. */
  async function consumeToken(token, purpose, session) {
    if (typeof token !== 'string' || token.length !== SESSION_TOKEN_LENGTH) throw expiredToken();
    const t = now();
    const doc = await tokens.findOneAndUpdate(
      { tokenHash: hashToken(token), purpose, usedAt: null, expiresAt: { $gt: t } },
      { $set: { usedAt: t } },
      { returnDocument: 'after', ...(session ? { session } : {}) },
    );
    if (!doc) throw expiredToken();
    return doc;
  }

  async function createSession(userId, session) {
    const t = now();
    const token = newToken();
    const expiresAt = new Date(t.getTime() + absoluteMs);
    // Iniciar sesión verificó la contraseña (y el segundo factor): cuenta como confirmación reciente desde ese instante.
    await sessions.insertOne(
      { userId, tokenHash: hashToken(token), createdAt: t, lastSeenAt: t, stepUpAt: t, expiresAt },
      { session },
    );
    return { token, expiresAt };
  }

  /** Suma un fallo de autenticación y bloquea la cuenta al llegar al máximo. */
  async function registerFailure(user, t) {
    const updated = await users.findOneAndUpdate(
      { _id: user._id },
      { $inc: { failedAttempts: 1 } },
      { returnDocument: 'after' },
    );
    if (updated && updated.failedAttempts >= maxFailedAttempts) {
      await users.updateOne(
        { _id: user._id },
        { $set: { lockedUntil: new Date(t.getTime() + lockMs), failedAttempts: 0 } },
      );
    }
  }

  /** Devuelve la pertenencia del usuario a la empresa si su rol tiene el permiso; si no, FORBIDDEN. */
  async function requireMember(tenantId, userId, permission, session) {
    const member = await memberships.findOne({ tenantId, userId }, session ? { session } : undefined);
    if (!member || !can(member.role, permission)) throw forbidden();
    return member;
  }

  /**
   * Comprueba el segundo factor: código TOTP o código de recuperación. No escribe nada;
   * devuelve cómo se validó para que el llamador lo marque como usado dentro de su transacción.
   */
  function checkSecondFactor(user, rawCode, t) {
    const code = String(rawCode ?? '').trim().toLowerCase().replace(/\s+/g, '');
    if (/^[a-z2-7]{5}-[a-z2-7]{5}$/.test(code)) {
      const hash = hashToken(code);
      return user.mfa.recoveryHashes?.includes(hash) ? { ok: true, via: 'recovery', hash } : { ok: false };
    }
    const secret = open(user.mfa.secretEnc, requireKey());
    const step = verifyTotp(secret, code, { now: t.getTime(), lastStep: user.mfa.lastStep ?? -1 });
    return step === null ? { ok: false } : { ok: true, via: 'totp', step };
  }

  /** Marca el segundo factor como usado. Un código repetido o ya gastado no pasa, ni en carreras. */
  async function spendSecondFactor(user, factor, session) {
    if (factor.via === 'recovery') {
      const r = await users.updateOne({ _id: user._id, 'mfa.recoveryHashes': factor.hash }, { $pull: { 'mfa.recoveryHashes': factor.hash } }, { session });
      return r.matchedCount === 1;
    }
    const r = await users.updateOne(
      { _id: user._id, $or: [{ 'mfa.lastStep': { $exists: false } }, { 'mfa.lastStep': { $lt: factor.step } }] },
      { $set: { 'mfa.lastStep': factor.step } },
      { session },
    );
    return r.matchedCount === 1;
  }

  const accountOf = async (userId) => {
    const user = await users.findOne({ _id: userId });
    if (!user) throw new AuthError('el usuario no existe', 'NOT_FOUND');
    return user;
  };

  return {
    // ---------------------------------------------------------------- registro y verificación

    async registerTenant({ companyName, country, currency, ownerName, email, password }, { inTx } = {}) {
      const name = String(companyName ?? '').trim();
      if (!name) throw new AuthError('falta el nombre de la empresa', 'VALIDATION');
      if (!/^[A-Z]{2}$/.test(String(country ?? ''))) {
        throw new AuthError('el país debe ser un código ISO de 2 letras en mayúsculas', 'VALIDATION');
      }
      assertCurrency(currency);
      const cleanEmail = normalizeEmail(email);
      if (cleanEmail.length > 254 || !EMAIL_PATTERN.test(cleanEmail)) {
        throw new AuthError('correo inválido', 'VALIDATION');
      }
      validatePasswordStrength(password);
      const passwordHash = await hashPassword(password, passwordParams);

      const t = now();
      const tenantId = new ObjectId();
      const userId = new ObjectId();
      let verifyToken;
      try {
        await withTransaction(client, async (session) => {
          await tenants.insertOne({ _id: tenantId, name, country, currency, ownerEpoch: 0, createdAt: t }, { session });
          await users.insertOne(
            {
              _id: userId,
              email: cleanEmail,
              name: String(ownerName ?? '').trim(),
              passwordHash,
              failedAttempts: 0,
              lockedUntil: null,
              emailVerifiedAt: null,
              createdAt: t,
            },
            { session },
          );
          await memberships.insertOne({ tenantId, userId, role: 'owner', createdAt: t }, { session });
          verifyToken = await issueToken('verify_email', 24 * HOUR, { userId, email: cleanEmail }, session);
          if (inTx) await inTx(session, { tenantId, userId });
        });
      } catch (err) {
        if (err?.code === DUPLICATE_KEY && String(err.message).includes('email_unique')) {
          throw new AuthError('ese correo ya está registrado', 'EMAIL_TAKEN');
        }
        throw err;
      }
      const message = templates.verifyEmail({ baseUrl: appBaseUrl, token: verifyToken, hours: 24 });
      await sendMail(cleanEmail, message);
      return { tenantId, userId };
    },

    async verifyEmail(token, { inTx } = {}) {
      return withTransaction(client, async (session) => {
        const doc = await consumeToken(token, 'verify_email', session);
        await users.updateOne({ _id: doc.userId, emailVerifiedAt: null }, { $set: { emailVerifiedAt: now() } }, { session });
        const result = { userId: doc.userId };
        if (inTx) await inTx(session, result);
        return result;
      });
    },

    /** Reenvía el enlace de verificación. Como mucho uno por minuto. */
    async resendVerification(userId) {
      const user = await accountOf(userId);
      if (user.emailVerifiedAt) return { sent: false, reason: 'ALREADY_VERIFIED' };
      const recent = await tokens.findOne({
        purpose: 'verify_email',
        userId,
        usedAt: null,
        createdAt: { $gt: new Date(now().getTime() - MINUTE) },
      });
      if (recent) return { sent: false, reason: 'TOO_SOON' };
      const token = await issueToken('verify_email', 24 * HOUR, { userId, email: user.email });
      const sent = await sendMail(user.email, templates.verifyEmail({ baseUrl: appBaseUrl, token, hours: 24 }));
      return { sent };
    },

    // ------------------------------------------------------------------ inicio y cierre de sesión

    /**
     * Inicia sesión. Cualquier fallo (correo, contraseña, bloqueo) responde igual para no revelar
     * cuentas. Si la cuenta tiene verificación en dos pasos devuelve `{ mfaRequired, challenge }`
     * y todavía no hay sesión: falta `verifyMfaLogin`.
     */
    async login(email, password, { inTx } = {}) {
      const user = await users.findOne({ email: normalizeEmail(email) });
      if (!user) {
        await dummyVerify(String(password ?? ''));
        throw invalidCredentials();
      }
      const t = now();
      const locked = user.lockedUntil && user.lockedUntil > t;
      // Se verifica aunque esté bloqueada: así el tiempo de respuesta no delata el bloqueo.
      const ok = await verifyPassword(String(password ?? ''), user.passwordHash);
      if (locked) throw invalidCredentials();
      if (!ok) {
        await registerFailure(user, t);
        throw invalidCredentials();
      }

      if (user.mfa?.enabled) {
        const challenge = await issueToken('mfa_login', 5 * MINUTE, { userId: user._id, attempts: 0 });
        return { mfaRequired: true, challenge, userId: user._id };
      }

      return withTransaction(client, async (session) => {
        await users.updateOne({ _id: user._id }, { $set: { failedAttempts: 0, lockedUntil: null } }, { session });
        const { token, expiresAt } = await createSession(user._id, session);
        const result = { token, expiresAt, userId: user._id };
        if (inTx) await inTx(session, result);
        return result;
      });
    },

    /** Segundo paso del inicio de sesión: código TOTP o de recuperación contra el desafío recibido. */
    async verifyMfaLogin(challenge, code, { inTx } = {}) {
      if (typeof challenge !== 'string' || challenge.length !== SESSION_TOKEN_LENGTH) throw invalidMfa();
      const t = now();
      const found = await tokens.findOne({
        tokenHash: hashToken(challenge),
        purpose: 'mfa_login',
        usedAt: null,
        expiresAt: { $gt: t },
      });
      if (!found) throw invalidMfa();
      const user = await users.findOne({ _id: found.userId });
      if (!user?.mfa?.enabled || (user.lockedUntil && user.lockedUntil > t)) throw invalidMfa();

      const factor = checkSecondFactor(user, code, t);
      if (!factor.ok) {
        // Cada fallo cuenta contra el desafío (se invalida a los 5) y contra la cuenta (se bloquea).
        const updated = await tokens.findOneAndUpdate({ _id: found._id, usedAt: null }, { $inc: { attempts: 1 } }, { returnDocument: 'after' });
        if (updated && updated.attempts >= MAX_MFA_ATTEMPTS) await tokens.updateOne({ _id: found._id }, { $set: { usedAt: t } });
        await registerFailure(user, t);
        throw invalidMfa();
      }

      return withTransaction(client, async (session) => {
        const consumed = await tokens.findOneAndUpdate({ _id: found._id, usedAt: null }, { $set: { usedAt: t } }, { session });
        if (!consumed) throw invalidMfa();
        if (!(await spendSecondFactor(user, factor, session))) throw invalidMfa();
        await users.updateOne({ _id: user._id }, { $set: { failedAttempts: 0, lockedUntil: null } }, { session });
        const { token, expiresAt } = await createSession(user._id, session);
        const result = { token, expiresAt, userId: user._id, usedRecoveryCode: factor.via === 'recovery' };
        if (inTx) await inTx(session, result);
        return result;
      });
    },

    async verifySession(token) {
      if (typeof token !== 'string' || token.length !== SESSION_TOKEN_LENGTH) throw invalidSession();
      const found = await sessions.findOne({ tokenHash: hashToken(token) });
      if (!found) throw invalidSession();
      const t = now();
      if (t >= found.expiresAt || t.getTime() - found.lastSeenAt.getTime() >= idleMs) {
        await sessions.deleteOne({ _id: found._id });
        throw invalidSession();
      }
      if (t.getTime() - found.lastSeenAt.getTime() >= touchMs) await sessions.updateOne({ _id: found._id }, { $set: { lastSeenAt: t } });
      return { userId: found.userId, sessionId: found._id, stepUpAt: found.stepUpAt ?? found.createdAt };
    },

    /**
     * Confirma de nuevo la identidad de quien tiene la sesión: contraseña y, si la cuenta tiene dos pasos, un código vigente.
     * Marca la sesión (`stepUpAt`) y desde ahí valen `stepUpMs` las operaciones que lo exigen (exportar, crear claves de API,
     * cambiar roles y quitar miembros). Un fallo cuenta contra la cuenta como cualquier otro fallo de autenticación.
     */
    async stepUp(token, userId, { password, code } = {}, { inTx } = {}) {
      const user = await accountOf(userId);
      const t = now();
      if (user.lockedUntil && user.lockedUntil > t) throw invalidCredentials();
      if (!(await verifyPassword(String(password ?? ''), user.passwordHash))) {
        await registerFailure(user, t);
        throw invalidCredentials();
      }
      let factor = null;
      if (user.mfa?.enabled) {
        if (!String(code ?? '').trim()) throw new AuthError('indica el código de verificación en dos pasos', 'VALIDATION');
        factor = checkSecondFactor(user, code, t);
        if (!factor.ok) {
          await registerFailure(user, t);
          throw invalidMfa();
        }
      }
      await withTransaction(client, async (session) => {
        if (factor && !(await spendSecondFactor(user, factor, session))) throw invalidMfa();
        const marked = await sessions.updateOne({ tokenHash: hashToken(String(token ?? '')), userId }, { $set: { stepUpAt: t } }, { session });
        if (marked.matchedCount === 0) throw invalidSession();
        if (inTx) await inTx(session, { userId });
      });
      return { stepUpAt: t, validUntil: new Date(t.getTime() + stepUpMs) };
    },

    /** Sesiones abiertas de la cuenta, la más reciente primero. Nunca devuelve el token ni su huella. */
    async listSessions(userId, currentToken) {
      const t = now();
      const current = typeof currentToken === 'string' ? hashToken(currentToken) : null;
      const rows = await sessions.find({ userId, expiresAt: { $gt: t } }, { sort: { createdAt: -1 }, limit: 50 }).toArray();
      return rows.map((r) => ({ id: r._id, createdAt: r.createdAt, lastSeenAt: r.lastSeenAt, expiresAt: r.expiresAt, current: r.tokenHash === current }));
    },

    /** Cierra una sesión propia (otro dispositivo, o la actual). Una sesión de otra persona responde como inexistente. */
    async revokeSession(userId, sessionId, currentToken, { inTx } = {}) {
      if (!/^[a-f0-9]{24}$/.test(String(sessionId))) throw new AuthError('la sesión no existe', 'NOT_FOUND');
      const current = typeof currentToken === 'string' ? hashToken(currentToken) : null;
      return withTransaction(client, async (session) => {
        const found = await sessions.findOneAndDelete({ _id: new ObjectId(String(sessionId)), userId }, { session });
        if (!found) throw new AuthError('la sesión no existe', 'NOT_FOUND');
        const result = { userId, sessionId: found._id, current: found.tokenHash === current };
        if (inTx) await inTx(session, result);
        return result;
      });
    },

    async logout(token) {
      if (typeof token !== 'string') return;
      await sessions.deleteOne({ tokenHash: hashToken(token) });
    },

    /** Cierra todas las sesiones de un usuario, por ejemplo tras cambiar la contraseña o sospechar un robo. */
    async logoutAll(userId) {
      await sessions.deleteMany({ userId });
    },

    /** Datos de la cuenta que la interfaz necesita. Nunca devuelve hashes ni secretos. */
    async getAccount(userId) {
      const user = await accountOf(userId);
      return {
        userId: user._id,
        email: user.email,
        name: user.name,
        emailVerified: Boolean(user.emailVerifiedAt),
        mfaEnabled: Boolean(user.mfa?.enabled),
        recoveryCodesLeft: user.mfa?.recoveryHashes?.length ?? 0,
      };
    },

    // ------------------------------------------------------------------------- contraseña

    /** Siempre responde igual, exista o no el correo. Como mucho un enlace por minuto y cuenta. */
    async requestPasswordReset(email) {
      const user = await users.findOne({ email: normalizeEmail(email) });
      if (!user) {
        await dummyVerify('relleno'); // iguala el tiempo con el caso de cuenta existente
        return { ok: true };
      }
      const recent = await tokens.findOne({
        purpose: 'password_reset',
        userId: user._id,
        usedAt: null,
        createdAt: { $gt: new Date(now().getTime() - MINUTE) },
      });
      if (recent) return { ok: true };
      await tokens.updateMany({ purpose: 'password_reset', userId: user._id, usedAt: null }, { $set: { usedAt: now() } });
      const token = await issueToken('password_reset', 60 * MINUTE, { userId: user._id, email: user.email });
      await sendMail(user.email, templates.passwordReset({ baseUrl: appBaseUrl, token, minutes: 60 }));
      return { ok: true };
    },

    /** Cambia la contraseña con el enlace recibido, cierra todas las sesiones y avisa por correo. */
    async resetPassword(token, newPassword, { inTx } = {}) {
      validatePasswordStrength(newPassword);
      const passwordHash = await hashPassword(newPassword, passwordParams);
      const userId = await withTransaction(client, async (session) => {
        const doc = await consumeToken(token, 'password_reset', session);
        await users.updateOne(
          { _id: doc.userId },
          { $set: { passwordHash, failedAttempts: 0, lockedUntil: null } },
          { session },
        );
        await sessions.deleteMany({ userId: doc.userId }, { session });
        await tokens.updateMany({ purpose: 'password_reset', userId: doc.userId, usedAt: null }, { $set: { usedAt: now() } }, { session });
        if (inTx) await inTx(session, { userId: doc.userId });
        return doc.userId;
      });
      const user = await users.findOne({ _id: userId });
      await sendMail(user.email, templates.passwordChanged());
      return { userId };
    },

    /**
     * Cambia la contraseña de quien ya tiene sesión. Exige la actual (y un código si hay dos pasos). Cierra las demás sesiones; con
     * `logoutAll` cierra también esta. Un enlace de recuperación pendiente deja de servir.
     */
    async changePassword(userId, currentToken, { currentPassword, newPassword, code, logoutAll = false } = {}, { inTx } = {}) {
      const user = await accountOf(userId);
      const t = now();
      if (user.lockedUntil && user.lockedUntil > t) throw invalidCredentials();
      if (!(await verifyPassword(String(currentPassword ?? ''), user.passwordHash))) {
        await registerFailure(user, t);
        throw invalidCredentials();
      }
      let factor = null;
      if (user.mfa?.enabled) {
        if (!String(code ?? '').trim()) throw new AuthError('indica el código de verificación en dos pasos', 'VALIDATION');
        factor = checkSecondFactor(user, code, t);
        if (!factor.ok) {
          await registerFailure(user, t);
          throw invalidMfa();
        }
      }
      validatePasswordStrength(newPassword);
      if (newPassword === currentPassword) throw new AuthError('la contraseña nueva debe ser distinta de la actual', 'VALIDATION');
      const passwordHash = await hashPassword(newPassword, passwordParams);
      await withTransaction(client, async (session) => {
        if (factor && !(await spendSecondFactor(user, factor, session))) throw invalidMfa();
        await users.updateOne({ _id: userId }, { $set: { passwordHash, failedAttempts: 0, lockedUntil: null } }, { session });
        const keep = !logoutAll && typeof currentToken === 'string' ? { tokenHash: { $ne: hashToken(currentToken) } } : {};
        await sessions.deleteMany({ userId, ...keep }, { session });
        await tokens.updateMany({ purpose: 'password_reset', userId, usedAt: null }, { $set: { usedAt: t } }, { session });
        if (inTx) await inTx(session, { userId, loggedOut: Boolean(logoutAll) });
      });
      await sendMail(user.email, templates.passwordChanged());
      return { loggedOut: Boolean(logoutAll) };
    },

    // ------------------------------------------------------------------ dos pasos (TOTP)

    async startMfaEnrollment(userId) {
      const user = await accountOf(userId);
      if (user.mfa?.enabled) throw new AuthError('la verificación en dos pasos ya está activa', 'MFA_ALREADY');
      const secret = generateSecret();
      await users.updateOne({ _id: userId }, { $set: { 'mfa.pendingSecretEnc': seal(secret, requireKey()) } });
      return { secret, otpauthUri: otpauthUri({ secret, account: user.email, issuer }) };
    },

    /** Activa los dos pasos al probar un código válido. Devuelve los códigos de recuperación, una sola vez. */
    async confirmMfaEnrollment(userId, code, { inTx } = {}) {
      const user = await accountOf(userId);
      if (user.mfa?.enabled) throw new AuthError('la verificación en dos pasos ya está activa', 'MFA_ALREADY');
      if (!user.mfa?.pendingSecretEnc) throw new AuthError('primero inicia la activación', 'VALIDATION');
      const secret = open(user.mfa.pendingSecretEnc, requireKey());
      const step = verifyTotp(secret, String(code ?? '').trim(), { now: now().getTime() });
      if (step === null) throw invalidMfa();

      const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
      await withTransaction(client, async (session) => {
        const r = await users.updateOne(
          { _id: userId, 'mfa.enabled': { $ne: true }, 'mfa.pendingSecretEnc': user.mfa.pendingSecretEnc },
          {
            $set: {
              mfa: {
                enabled: true,
                secretEnc: user.mfa.pendingSecretEnc,
                lastStep: step,
                recoveryHashes: recoveryCodes.map(hashToken),
                enrolledAt: now(),
              },
            },
          },
          { session },
        );
        if (r.matchedCount === 0) throw new AuthError('la activación cambió: vuelve a empezar', 'VALIDATION');
        if (inTx) await inTx(session, { userId });
      });
      return { recoveryCodes };
    },

    /** Desactiva los dos pasos. Exige la contraseña y un segundo factor válido. */
    async disableMfa(userId, { password, code }, { inTx } = {}) {
      const user = await accountOf(userId);
      if (!user.mfa?.enabled) throw new AuthError('la verificación en dos pasos no está activa', 'VALIDATION');
      const t = now();
      if (!(await verifyPassword(String(password ?? ''), user.passwordHash))) throw invalidCredentials();
      const factor = checkSecondFactor(user, code, t);
      if (!factor.ok) throw invalidMfa();
      await withTransaction(client, async (session) => {
        if (!(await spendSecondFactor(user, factor, session))) throw invalidMfa();
        await users.updateOne({ _id: userId }, { $unset: { mfa: '' } }, { session });
        if (inTx) await inTx(session, { userId });
      });
    },

    /** Reemplaza los códigos de recuperación. Exige la contraseña y un código TOTP vigente. */
    async regenerateRecoveryCodes(userId, { password, code }, { inTx } = {}) {
      const user = await accountOf(userId);
      if (!user.mfa?.enabled) throw new AuthError('la verificación en dos pasos no está activa', 'VALIDATION');
      if (!(await verifyPassword(String(password ?? ''), user.passwordHash))) throw invalidCredentials();
      const secret = open(user.mfa.secretEnc, requireKey());
      const step = verifyTotp(secret, String(code ?? '').trim(), { now: now().getTime(), lastStep: user.mfa.lastStep ?? -1 });
      if (step === null) throw invalidMfa();
      const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
      await withTransaction(client, async (session) => {
        await users.updateOne(
          { _id: userId },
          { $set: { 'mfa.recoveryHashes': recoveryCodes.map(hashToken), 'mfa.lastStep': step } },
          { session },
        );
        if (inTx) await inTx(session, { userId });
      });
      return { recoveryCodes };
    },

    // --------------------------------------------------------------------------- permisos

    /** Punto único de autorización: sesión válida, pertenencia a la empresa y permiso del rol. */
    async authorize(token, tenantId, permission, { stepUp = false } = {}) {
      const { userId, stepUpAt } = await this.verifySession(token);
      // Una operación delicada exige haber confirmado la contraseña hace poco (el inicio de sesión cuenta).
      if (stepUp && now().getTime() - stepUpAt.getTime() > stepUpMs) {
        throw new AuthError('confirma tu contraseña para continuar con esta operación', 'STEP_UP_REQUIRED');
      }
      const key = cacheKey(tenantId, userId);
      const cached = memberCache.get(key);
      let member = cached && cached.until > now().getTime() ? cached.member : null;
      if (!member) {
        member = await memberships.findOne({ tenantId, userId });
        if (member) memberCache.set(key, { member, until: now().getTime() + membershipCacheMs });
        else memberCache.delete(key);
      }
      if (!member || !can(member.role, permission)) throw forbidden();
      return { userId, tenantId, role: member.role };
    },

    async listMemberships(userId) {
      const list = await memberships.find({ userId }).toArray();
      const found = await tenants.find({ _id: { $in: list.map((m) => m.tenantId) } }).toArray();
      const byId = new Map(found.map((x) => [x._id.toHexString(), x]));
      return list.map((m) => {
        const tenant = byId.get(m.tenantId.toHexString());
        return {
          tenantId: m.tenantId,
          role: m.role,
          name: tenant?.name ?? null,
          country: tenant?.country ?? null,
          currency: tenant?.currency ?? null,
          // La interfaz decide qué mostrar con esto; el servidor sigue comprobando cada petición.
          permissions: ROLE_PERMISSIONS[m.role] ?? [],
        };
      });
    },

    /** Miembros de una empresa con sus datos visibles. Nunca incluye hashes ni secretos. */
    async listMembers(tenantId) {
      const list = await memberships.find({ tenantId }).toArray();
      const found = await users.find({ _id: { $in: list.map((m) => m.userId) } }).toArray();
      const byId = new Map(found.map((u) => [u._id.toHexString(), u]));
      return list
        .map((m) => {
          const user = byId.get(m.userId.toHexString());
          return {
            userId: m.userId,
            role: m.role,
            email: user?.email ?? null,
            name: user?.name ?? '',
            emailVerified: Boolean(user?.emailVerifiedAt),
            mfaEnabled: Boolean(user?.mfa?.enabled),
          };
        })
        .sort((a, b) => String(a.email).localeCompare(String(b.email)));
    },

    // -------------------------------------------------------------------------- invitaciones

    /**
     * Invita por correo. `actor` es `{ userId, tenantId }`, normalmente el resultado de `authorize`.
     * Solo quien ya verificó su propio correo puede invitar (evita usar la plataforma para enviar
     * correo a terceros desde una cuenta sin confirmar). No revela si el invitado ya tiene cuenta.
     */
    async inviteMember(actor, { email, role }, { inTx } = {}) {
      if (!isRole(role)) throw new AuthError(`rol inválido: ${role}`, 'VALIDATION');
      const cleanEmail = normalizeEmail(email);
      if (cleanEmail.length > 254 || !EMAIL_PATTERN.test(cleanEmail)) throw new AuthError('correo inválido', 'VALIDATION');
      const actorMember = await requireMember(actor.tenantId, actor.userId, 'users:manage');
      if (role === 'owner' && actorMember.role !== 'owner') throw forbidden();
      const inviter = await accountOf(actor.userId);
      if (!inviter.emailVerifiedAt) throw new AuthError('confirma tu correo antes de invitar a otras personas', 'EMAIL_NOT_VERIFIED');

      const existing = await users.findOne({ email: cleanEmail }, { projection: { _id: 1 } });
      if (existing && (await memberships.findOne({ tenantId: actor.tenantId, userId: existing._id }))) {
        throw new AuthError('esa persona ya pertenece a la empresa', 'ALREADY_MEMBER');
      }

      const token = await withTransaction(client, async (session) => {
        await tokens.deleteMany({ purpose: 'invite', tenantId: actor.tenantId, email: cleanEmail, usedAt: null }, { session });
        const issued = await issueToken(
          'invite',
          7 * DAY,
          { tenantId: actor.tenantId, email: cleanEmail, role, invitedBy: actor.userId },
          session,
        );
        if (inTx) await inTx(session, { email: cleanEmail, role });
        return issued;
      });
      const tenant = await tenants.findOne({ _id: actor.tenantId });
      const delivered = await sendMail(
        cleanEmail,
        templates.invitation({
          baseUrl: appBaseUrl,
          token,
          company: tenant.name,
          inviter: inviter.name || inviter.email,
          role,
          days: 7,
        }),
      );
      return { invited: true, delivered };
    },

    /** Datos de una invitación para mostrar antes de aceptarla. No la consume. */
    async getInvitation(token) {
      if (typeof token !== 'string' || token.length !== SESSION_TOKEN_LENGTH) throw expiredToken();
      const doc = await tokens.findOne({ tokenHash: hashToken(token), purpose: 'invite', usedAt: null, expiresAt: { $gt: now() } });
      if (!doc) throw expiredToken();
      const [tenant, user] = await Promise.all([tenants.findOne({ _id: doc.tenantId }), users.findOne({ email: doc.email }, { projection: { _id: 1 } })]);
      return { email: doc.email, role: doc.role, company: tenant?.name ?? null, accountExists: Boolean(user) };
    },

    /**
     * Acepta una invitación. Si el correo ya tiene cuenta, hay que haber iniciado sesión con ella
     * (`sessionUserId`); si no, se crea la cuenta con `name` y `password`. Abrir el enlace prueba
     * que el correo es de quien acepta, así que queda verificado.
     */
    async acceptInvitation(token, { sessionUserId, name, password } = {}, { inTx } = {}) {
      const info = await this.getInvitation(token);
      const existing = await users.findOne({ email: info.email });
      let passwordHash;
      if (existing) {
        if (!sessionUserId || !existing._id.equals(sessionUserId)) {
          throw new AuthError(`inicia sesión como ${info.email} para aceptar la invitación`, 'LOGIN_REQUIRED');
        }
      } else {
        if (!String(name ?? '').trim()) throw new AuthError('falta tu nombre', 'VALIDATION');
        validatePasswordStrength(password);
        passwordHash = await hashPassword(password, passwordParams);
      }

      return withTransaction(client, async (session) => {
        const doc = await consumeToken(token, 'invite', session);
        const t = now();
        let userId = existing?._id;
        if (existing) {
          await users.updateOne({ _id: existing._id, emailVerifiedAt: null }, { $set: { emailVerifiedAt: t } }, { session });
        } else {
          userId = new ObjectId();
          await users.insertOne(
            {
              _id: userId,
              email: info.email,
              name: String(name).trim(),
              passwordHash,
              failedAttempts: 0,
              lockedUntil: null,
              emailVerifiedAt: t,
              createdAt: t,
            },
            { session },
          );
        }
        try {
          await memberships.insertOne({ tenantId: doc.tenantId, userId, role: doc.role, createdAt: t }, { session });
        } catch (err) {
          if (err?.code === DUPLICATE_KEY) throw new AuthError('ya perteneces a la empresa', 'ALREADY_MEMBER');
          throw err;
        }
        const result = { userId, tenantId: doc.tenantId, role: doc.role, createdAccount: !existing };
        if (inTx) await inTx(session, result);
        return result;
      });
    },

    /**
     * Alta directa, sin invitación ni consentimiento de la otra persona. No se expone por HTTP:
     * existe para código interno y pruebas. Las personas entran por `inviteMember`.
     */
    async addMember(actor, { email, role }, { inTx } = {}) {
      if (!isRole(role)) throw new AuthError(`rol inválido: ${role}`, 'VALIDATION');
      const actorMember = await requireMember(actor.tenantId, actor.userId, 'users:manage');
      if (role === 'owner' && actorMember.role !== 'owner') throw forbidden();
      const user = await users.findOne({ email: normalizeEmail(email) });
      if (!user) throw new AuthError('no existe un usuario con ese correo', 'NOT_FOUND');
      try {
        await withTransaction(client, async (session) => {
          await memberships.insertOne({ tenantId: actor.tenantId, userId: user._id, role, createdAt: now() }, { session });
          if (inTx) await inTx(session, { userId: user._id, role });
        });
      } catch (err) {
        if (err?.code === DUPLICATE_KEY) throw new AuthError('el usuario ya pertenece a la empresa', 'ALREADY_MEMBER');
        throw err;
      }
      return { userId: user._id };
    },

    async changeRole(actor, targetUserId, newRole, { inTx } = {}) {
      if (!isRole(newRole)) throw new AuthError(`rol inválido: ${newRole}`, 'VALIDATION');
      try {
        await withTransaction(client, async (session) => {
          await guardOwners(actor, targetUserId, newRole, session);
          await memberships.updateOne({ tenantId: actor.tenantId, userId: targetUserId }, { $set: { role: newRole } }, { session });
          // Una clave creada por esa persona con permisos que su nuevo rol ya no tiene seguiría sirviendo: se revoca.
          const revokedApiKeys = await revokeKeysOf(actor.tenantId, targetUserId, newRole, session);
          if (inTx) await inTx(session, { userId: targetUserId, role: newRole, revokedApiKeys });
        });
      } finally {
        forgetMember(actor.tenantId, targetUserId);
      }
    },

    async removeMember(actor, targetUserId, { inTx } = {}) {
      try {
        await withTransaction(client, async (session) => {
          await guardOwners(actor, targetUserId, null, session);
          await memberships.deleteOne({ tenantId: actor.tenantId, userId: targetUserId }, { session });
          // Las claves que creó se van con ella: ya no hay quien responda de lo que hagan.
          const revokedApiKeys = await revokeKeysOf(actor.tenantId, targetUserId, null, session);
          if (inTx) await inTx(session, { userId: targetUserId, revokedApiKeys });
        });
      } finally {
        forgetMember(actor.tenantId, targetUserId);
      }
    },
  };

  /**
   * Revoca las claves de API activas que creó `userId` en la empresa: todas si deja de ser miembro (`role` null), o las que tienen
   * algún permiso que su nuevo rol ya no concede. Devuelve cuántas.
   */
  async function revokeKeysOf(tenantId, userId, role, session) {
    const active = await apiKeys.find({ tenantId, createdBy: userId, revokedAt: { $exists: false } }, { session, projection: { scopes: 1 } }).toArray();
    const ids = active.filter((k) => role === null || k.scopes.some((scope) => !can(role, scope))).map((k) => k._id);
    if (!ids.length) return 0;
    await apiKeys.updateMany({ _id: { $in: ids } }, { $set: { revokedAt: now(), revokedReason: role === null ? 'member_removed' : 'role_downgraded' } }, { session });
    return ids.length;
  }

  /**
   * Reglas para tocar a un miembro: solo un propietario puede nombrar, degradar o quitar a otro,
   * y nunca puede quedar la empresa sin propietario. Dos degradaciones simultáneas de los dos
   * últimos propietarios no se serializarían solas (cada una tocaría un documento distinto), así
   * que ambas incrementan `ownerEpoch` de la empresa: el segundo choca y la transacción se repite.
   */
  async function guardOwners(actor, targetUserId, newRole, session) {
    await tenants.updateOne({ _id: actor.tenantId }, { $inc: { ownerEpoch: 1 } }, { session });
    const actorMember = await requireMember(actor.tenantId, actor.userId, 'users:manage', session);
    const target = await memberships.findOne({ tenantId: actor.tenantId, userId: targetUserId }, { session });
    if (!target) throw new AuthError('el usuario no pertenece a la empresa', 'NOT_FOUND');
    const touchesOwner = target.role === 'owner' || newRole === 'owner';
    if (touchesOwner && actorMember.role !== 'owner') throw forbidden();
    if (target.role === 'owner' && newRole !== 'owner') {
      const owners = await memberships.countDocuments({ tenantId: actor.tenantId, role: 'owner' }, { session });
      if (owners <= 1) throw new AuthError('la empresa no puede quedar sin propietario', 'LAST_OWNER');
    }
  }
}
