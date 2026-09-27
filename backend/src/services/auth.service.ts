import { Request } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import { OAuth2Client } from 'google-auth-library';
import { User, IUser, PendingRegistration } from '../models';
import { UsedIdentityToken, AppleAuthCode } from '../models/OAuthReplay';
import { AppError } from '../middlewares/errorHandler';
import { UserRole } from '../types';
import { config } from '../config/env';
import { cloudinary } from '../config';
import { whatsappService } from './whatsapp.service';
import { emailService } from './email.service';
import {
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
  clientIp,
  normalizePhone,
} from '../utils';
import { maskEmail, maskPhone } from '../utils/mask';
import { parseBirthDate, birthDateProblem } from '../utils/age';
import type { DocumentType } from '../models/User';
import {
  Session,
  sessionManager,
  generateDeviceId,
  checkBruteForce,
  recordFailedAttempt,
  clearAttempts,
  logAudit,
  AuditAction,
  AuditSeverity,
  antiFraudService,
  generateTOTPSecret,
  matchTOTPStep,
  sealTotpSecret,
  hashRecoveryCodes,
  validatePasswordComplexity,
  OTP_SLOTS,
  OtpCheck,
  checkOtp,
  generateOtpCode,
  otpIssuedAt,
  otpSetFields,
} from '../security';
import { hashToken, normalizeClientDeviceId } from '../security/sessions';
import {
  FirstFactor,
  hasTwoFactor,
  twoFactorSetupPending,
  openMfaChallenge,
  resolveMfaChallenge,
  verifySecondFactor,
} from './mfa.service';
import { anonymizeAccount, deletionBlocker } from './accountDeletion.service';
import { SecurityEventType } from '../models';
import { recordSecurityEvent, recordSessionIpChange, recordSessionStarted } from './securityEvent.service';

interface LoginInput {
  phone?: string;
  email?: string;
  password: string;
  deviceId?: string;
  totpToken?: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

/**
 * Resultado de cualquier camino de autenticación.
 *
 * O bien una sesión completa, o bien un reto de segundo factor. No existe un
 * tercer estado: ningún flujo puede devolver tokens a una cuenta con 2FA sin
 * pasar por `completeLogin`.
 */
export type AuthOutcome =
  | { requiresTOTP: true; challengeToken: string; user: IUser; method: FirstFactor }
  | { requiresTOTP: false; user: IUser; tokens: AuthTokens; sessionId: string; isNewDevice: boolean; method: FirstFactor };

const MAX_PASSWORD_LENGTH = 128;

function otpError(result: OtpCheck, missingMessage = 'No hay un código pendiente. Pide uno nuevo.'): AppError {
  switch (result) {
    case 'locked':
      return new AppError('Demasiados intentos con este código. Pide uno nuevo.', 429, 'OTP_LOCKED');
    case 'expired':
      return new AppError('OTP expirado', 400, 'OTP_EXPIRED');
    case 'missing':
      return new AppError(missingMessage, 400, 'OTP_MISSING');
    default:
      return new AppError('OTP inválido', 400, 'OTP_INVALID');
  }
}

/** ¿Pasó el enfriamiento desde el último envío? */
function resendAllowed(expires: Date | null | undefined): boolean {
  const issued = otpIssuedAt(expires);
  if (!issued) return true;
  return Date.now() - issued.getTime() >= config.otp.resendCooldownSeconds * 1000;
}

const requestIp = (req?: Request) => (req ? clientIp(req) : 'unknown');
const requestUa = (req?: Request) => (req?.headers['user-agent'] as string) || 'unknown';

/**
 * El identificador de dispositivo que mandó el cliente: en el cuerpo del
 * login o en la cabecera `X-Device-ID` (así llega también en Google, Apple
 * y el reto 2FA sin tocar sus esquemas). Se valida en `createSession`.
 */
const requestDeviceId = (req?: Request, explicit?: string | null): string | null => {
  if (explicit) return explicit;
  const header = req?.headers['x-device-id'];
  return typeof header === 'string' ? header : null;
};

// ── Verificación de identidad de Google y Apple ───────────────────────

// Un solo cliente valida tokens emitidos para cualquiera de los client IDs
// registrados (web, iOS, Android) — verifyIdToken acepta un arreglo de
// audiencias válidas.
const googleClient = new OAuth2Client();

// ── Verificación del identityToken de "Sign in with Apple" ────────────
//
// Apple no publica un SDK de servidor (a diferencia de `google-auth-library`
// para Google), así que esto reimplementa lo mínimo: bajar su JWKS, elegir
// la llave por `kid` y verificar la firma RS256 con el `jsonwebtoken` que ya
// es dependencia del proyecto. Node soporta importar un JWK directo con
// `crypto.createPublicKey`, así que no hace falta sumar `jwks-rsa` ni
// `apple-signin-auth` solo para esto.
const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';
const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_JWKS_CACHE_TTL_MS = 60 * 60 * 1000; // Apple rota estas llaves con muy poca frecuencia.
const APPLE_CODE_TTL_MS = 2 * 60 * 1000;

let appleJwksCache: { keys: any[]; expiresAt: number } | null = null;

async function getAppleJwks(forceRefresh = false): Promise<any[]> {
  if (!forceRefresh && appleJwksCache && appleJwksCache.expiresAt > Date.now()) {
    return appleJwksCache.keys;
  }

  const response = await fetch(APPLE_JWKS_URL, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Apple JWKS respondió ${response.status}`);

  const { keys } = (await response.json()) as { keys: any[] };
  appleJwksCache = { keys, expiresAt: Date.now() + APPLE_JWKS_CACHE_TTL_MS };
  return keys;
}

export interface IdentityPayload {
  sub: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
  /** Google los da por separado; Apple no los pone en el token (ver `appleCallback`). */
  given_name?: string;
  family_name?: string;
  picture?: string;
  nonce?: string;
  exp?: number;
}

/**
 * Verificadores de los proveedores, detrás de un objeto para que las pruebas
 * puedan sustituirlos sin tocar la red. Validan firma, emisor, audiencia y
 * caducidad; todo lo demás (nonce, un solo uso, vinculación) lo decide el
 * servicio.
 */
export const identityVerifiers = {
  async google(idToken: string, audiences: string[]): Promise<IdentityPayload> {
    const ticket = await googleClient.verifyIdToken({ idToken, audience: audiences });
    const payload = ticket.getPayload();
    if (!payload) throw new Error('Token de Google sin contenido');
    return payload as IdentityPayload;
  },

  async apple(identityToken: string, audience: string): Promise<IdentityPayload> {
    const decoded = jwt.decode(identityToken, { complete: true });
    const kid = decoded && typeof decoded === 'object' ? (decoded.header as any)?.kid : undefined;
    if (!kid) throw new Error('identityToken sin kid');

    let keys = await getAppleJwks();
    let jwk = keys.find((k) => k.kid === kid);
    if (!jwk) {
      // Un `kid` desconocido puede ser una rotación reciente de Apple: se
      // pide el JWKS de nuevo una vez antes de rechazar.
      keys = await getAppleJwks(true);
      jwk = keys.find((k) => k.kid === kid);
    }
    if (!jwk) throw new Error('Ninguna llave de Apple coincide con el kid del token');

    const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    return jwt.verify(identityToken, publicKey, {
      algorithms: ['RS256'],
      issuer: APPLE_ISSUER,
      audience,
    }) as IdentityPayload;
  },
};

// ── Identidades de Google, Apple y Facebook ───────────────────────────

export type OAuthProvider = 'google' | 'apple' | 'facebook';

const OAUTH_ID_FIELD: Record<OAuthProvider, 'googleId' | 'appleId' | 'facebookId'> = {
  google: 'googleId',
  apple: 'appleId',
  facebook: 'facebookId',
};

const OAUTH_PROVIDER_NAME: Record<OAuthProvider, string> = {
  google: 'Google',
  apple: 'Apple',
  facebook: 'Facebook',
};

/** El `name` que ponemos cuando el proveedor no da ninguno. */
const oauthPlaceholderName = (provider: OAuthProvider) => `Usuario ${OAUTH_PROVIDER_NAME[provider]}`;

/** Lo que un proveedor dice de la persona, ya verificado por su firma o por Graph. */
export interface OAuthIdentity {
  sub: string;
  email?: string;
  /**
   * El proveedor garantiza que el correo es de quien entra. Solo así se
   * vincula una cuenta existente por correo o se marca verificado.
   */
  emailTrusted: boolean;
  /** Nombre completo, cuando el proveedor no lo da partido. */
  name?: string;
  firstName?: string;
  lastName?: string;
  /** URL de la foto de perfil. */
  avatar?: string;
  /** La foto se sube a Cloudinary en vez de guardar la URL (las de Facebook caducan). */
  importAvatar?: boolean;
}

/** Nombre y apellido recortados al largo del modelo; vacíos como `undefined`. */
function oauthNames(identity: OAuthIdentity): { firstName?: string; lastName?: string } {
  const clean = (v?: string) => {
    const t = v?.trim().replace(/\s+/g, ' ').slice(0, 60);
    return t && t.length >= 2 ? t : undefined;
  };
  return { firstName: clean(identity.firstName), lastName: clean(identity.lastName) };
}

// ── Graph API de Meta ("Continuar con Facebook") ──────────────────────

export interface FacebookProfile {
  id: string;
  email?: string;
  first_name?: string;
  last_name?: string;
  name?: string;
  picture?: { data?: { url?: string; is_silhouette?: boolean } };
}

/**
 * `appsecret_proof`: Meta rechaza una llamada con un token robado si no viene
 * firmada con el secreto de la app, que solo tiene este servidor.
 */
const appSecretProof = (accessToken: string) =>
  crypto.createHmac('sha256', config.facebook.appSecret).update(accessToken).digest('hex');

/**
 * Las dos llamadas a Meta, detrás de un objeto para que las pruebas las
 * sustituyan sin red (igual que `identityVerifiers`).
 */
export const facebookGraph = {
  /**
   * Canjea el `code` del diálogo por un token de acceso. Va con el secreto
   * de la app **y** el `code_verifier` (PKCE) que solo conoce la app que
   * abrió el diálogo: quien intercepte el deep link tiene el código, pero
   * no puede canjearlo.
   */
  async exchangeCode(code: string, codeVerifier: string): Promise<string> {
    const { appId, appSecret, graphVersion, redirectUri } = config.facebook;
    const url = new URL(`https://graph.facebook.com/${graphVersion}/oauth/access_token`);
    url.search = new URLSearchParams({
      client_id: appId,
      client_secret: appSecret,
      redirect_uri: redirectUri,
      code,
      code_verifier: codeVerifier,
    }).toString();
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string };
    if (!res.ok || !body.access_token) throw new Error(`Meta rechazó el código (HTTP ${res.status})`);
    return body.access_token;
  },

  async profile(accessToken: string): Promise<FacebookProfile> {
    const { graphVersion } = config.facebook;
    const url = new URL(`https://graph.facebook.com/${graphVersion}/me`);
    url.search = new URLSearchParams({
      fields: 'id,first_name,last_name,name,email,picture.width(512).height(512)',
      access_token: accessToken,
      appsecret_proof: appSecretProof(accessToken),
    }).toString();
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const body = (await res.json().catch(() => ({}))) as FacebookProfile;
    if (!res.ok || !body.id) throw new Error(`Meta no devolvió el perfil (HTTP ${res.status})`);
    return body;
  },
};

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

function sameString(a: string | undefined, b: string | undefined): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Un `id_token` solo sirve una vez. Si alguien lo intercepta después de que
 * la app lo usara, llega tarde; si lo usa antes, la app legítima recibe el
 * rechazo y el intento queda auditado.
 */
async function consumeIdentityToken(provider: 'google' | 'apple', token: string, exp?: number): Promise<void> {
  const expiresAt = new Date(((exp ?? Math.floor(Date.now() / 1000) + 3600) + 60) * 1000);
  try {
    await UsedIdentityToken.create({ provider, tokenHash: sha256(token), expiresAt });
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      throw new AppError('Este inicio de sesión ya se usó. Vuelve a intentarlo.', 401, 'IDENTITY_TOKEN_REPLAYED');
    }
    throw error;
  }
}

export class AuthService {
  // ── Emisión de sesiones: el único sitio que entrega tokens ──────────

  private generateTokens(user: IUser, sessionId: Types.ObjectId | string): AuthTokens {
    const payload = { id: user._id.toString(), role: user.role as UserRole, sid: sessionId.toString() };
    return {
      accessToken: generateAccessToken(payload),
      refreshToken: generateRefreshToken(payload),
    };
  }

  /** Una cuenta bloqueada, desactivada o anonimizada no abre sesión por ningún camino. */
  private assertAccountUsable(user: IUser): void {
    if (user.anonymizedAt) throw new AppError('Esta cuenta ya no existe.', 403, 'ACCOUNT_DELETED');
    if (user.isBlocked) throw new AppError('Tu cuenta está bloqueada. Contacta a soporte.', 403, 'ACCOUNT_BLOCKED');
    if (!user.isActive) throw new AppError('Tu cuenta está desactivada', 403, 'ACCOUNT_INACTIVE');
  }

  /**
   * Crea la sesión y firma sus tokens con el mismo `sid`. Es el único punto
   * por el que pasan todos los inicios de sesión (contraseña, Google, Apple,
   * OTP, reto 2FA, restablecimiento), así que el historial de seguridad se
   * escribe aquí y no en cada camino.
   */
  private async startSession(
    user: IUser,
    req: Request | undefined,
    options: { method: string; mfa: boolean; deviceId?: string | null }
  ) {
    const sessionId = new Types.ObjectId();
    const tokens = this.generateTokens(user, sessionId);
    const ip = requestIp(req);
    const ua = requestUa(req);

    const { session, isNewDevice, identified, evictedSessionIds } = await sessionManager.createSession({
      userId: user._id.toString(),
      sessionId,
      refreshToken: tokens.refreshToken,
      ip,
      userAgent: ua,
      deviceId: requestDeviceId(req, options.deviceId),
      // S8: 8h/30min para staff, en vez de la sesión de cliente.
      isStaff: user.role === UserRole.ADMIN,
      authMethod: options.method,
      mfa: options.mfa,
    });

    await recordSessionStarted({
      user,
      req,
      sessionId: sessionId.toString(),
      deviceId: session.deviceId,
      identified,
      isNewDevice,
      method: options.method,
      mfa: options.mfa,
      evictedSessionIds,
    });

    const lastLoginAt = new Date();
    await User.updateOne({ _id: user._id }, { $set: { lastLoginAt, lastLoginIp: ip } });
    // También en el documento que ya tenemos en memoria: si no, la respuesta
    // de este login concreto seguiría mostrando el `lastLoginAt` anterior.
    user.lastLoginAt = lastLoginAt;

    return { tokens, sessionId: sessionId.toString(), isNewDevice };
  }

  /**
   * Cierra cualquier inicio de sesión que ya superó el primer factor.
   *
   * Si la cuenta tiene 2FA y no llegó un segundo factor, no hay tokens:
   * hay un reto. `totpToken` solo lo trae el login por contraseña, que ya lo
   * aceptaba en la misma petición; los demás caminos resuelven el reto en
   * `completeMfaChallenge`.
   */
  private async completeLogin(
    user: IUser,
    req: Request | undefined,
    options: { method: FirstFactor; totpToken?: string; deviceId?: string }
  ): Promise<AuthOutcome> {
    this.assertAccountUsable(user);

    if (hasTwoFactor(user)) {
      if (!options.totpToken) {
        const challengeToken = await openMfaChallenge(user._id, options.method);
        return { requiresTOTP: true, challengeToken, user, method: options.method };
      }

      const valid = await verifySecondFactor(user._id, options.totpToken);
      if (!valid) {
        if (req) {
          await logAudit(req, {
            action: AuditAction.TOTP_FAILED,
            entity: 'user',
            entityId: user._id.toString(),
            severity: AuditSeverity.MEDIUM,
            description: 'Verificación 2FA fallida',
            metadata: { method: options.method },
          });
        }
        await recordSecurityEvent({
          userId: user._id,
          role: user.role,
          req,
          type: SecurityEventType.TWO_FACTOR_FAILED,
          result: 'failure',
          metadata: { method: options.method },
        });
        throw new AppError('Código 2FA inválido', 401, 'MFA_CODE_INVALID');
      }
    }

    const session = await this.startSession(user, req, {
      method: options.method,
      mfa: hasTwoFactor(user),
      deviceId: options.deviceId,
    });
    return { requiresTOTP: false, user, method: options.method, ...session };
  }

  /** Segundo paso de cualquier login con 2FA. */
  async completeMfaChallenge(
    challengeToken: string,
    code: string,
    req?: Request,
    deviceId?: string
  ): Promise<AuthOutcome & { requiresTOTP: false }> {
    let resolved: Awaited<ReturnType<typeof resolveMfaChallenge>>;
    try {
      resolved = await resolveMfaChallenge(challengeToken, code);
    } catch (error) {
      // Solo se atribuye a la cuenta cuando el reto era auténtico y falló el
      // código. Con un reto inválido, el id del token lo escribió quien llama
      // y no demuestra nada: registrarlo dejaría ensuciar el historial ajeno.
      if (error instanceof AppError && (error.code === 'MFA_CODE_INVALID' || error.code === 'MFA_LOCKED')) {
        const [userId] = challengeToken.split('.');
        await recordSecurityEvent({
          userId,
          req,
          type: SecurityEventType.TWO_FACTOR_FAILED,
          result: 'failure',
          metadata: { locked: error.code === 'MFA_LOCKED' },
        });
      }
      throw error;
    }
    const { user, method } = resolved;
    this.assertAccountUsable(user);

    // Antes este camino abría la sesión sin el identificador del dispositivo
    // y sin pasar por el aviso de nuevo dispositivo ni por el antifraude: con
    // 2FA activo, la detección simplemente no existía.
    const session = await this.startSession(user, req, { method, mfa: true, deviceId });

    if (req) {
      await this.recordLoginChecks(user, req, session.isNewDevice, deviceId);
      await logAudit(req, {
        action: AuditAction.LOGIN_SUCCESS,
        entity: 'user',
        entityId: user._id.toString(),
        description: 'Login con verificación en dos pasos',
        metadata: { method, mfa: true, role: user.role, isNewDevice: session.isNewDevice },
      });
    }

    return { requiresTOTP: false, user, method, ...session };
  }

  /**
   * Aviso de nuevo dispositivo en la auditoría y cruce antifraude de cuentas
   * que comparten equipo o IP. Lo comparten el login por contraseña y el
   * segundo paso del 2FA.
   */
  private async recordLoginChecks(user: IUser, req: Request, isNewDevice: boolean, deviceId?: string): Promise<void> {
    const ip = requestIp(req);
    const identifierMask = user.email ? maskEmail(user.email) : maskPhone(user.phone);
    if (isNewDevice) {
      await logAudit(req, {
        action: AuditAction.NEW_DEVICE_DETECTED,
        entity: 'user',
        entityId: user._id.toString(),
        severity: AuditSeverity.MEDIUM,
        description: `Nuevo dispositivo detectado para ${identifierMask}`,
      });
    }

    // Normalizado: con el valor crudo, uno distinto por cuenta esquivaba el
    // cruce de multicuenta, y reusar el de otra persona la ligaba en falso.
    const fraudDeviceId = generateDeviceId(requestUa(req), ip, normalizeClientDeviceId(requestDeviceId(req, deviceId)) ?? undefined);
    const fraudCheck = await antiFraudService.checkMultipleAccounts(user._id.toString(), fraudDeviceId, ip);
    if (fraudCheck.suspicious && fraudCheck.alert) {
      await antiFraudService.createAlert(fraudCheck.alert);
    }
  }

  // ── Google, Apple y Facebook ─────────────────────────────────────────

  /**
   * Encuentra o crea la cuenta de una identidad de Google/Apple/Facebook ya
   * verificada, y rellena lo que le falte al perfil (ver `fillMissingProfile`).
   *
   * Nunca vincula por un correo que ZIPP no haya verificado. Antes bastaba con
   * que coincidiera: un atacante registraba una cuenta con el correo de la
   * víctima y su propia contraseña, y cuando la víctima entraba con Google
   * quedaba dentro de la cuenta del atacante (pre-secuestro).
   *
   * - Identidad ya vinculada → esa cuenta.
   * - Correo verificado en ZIPP, sin otra identidad del mismo proveedor → se vincula.
   * - Correo verificado pero ya vinculado a OTRA identidad → 409, no se pisa.
   * - Correo NO verificado en ZIPP → no se vincula. El proveedor sí demostró
   *   la titularidad del correo, así que se libera de la cuenta que solo lo
   *   declaraba y la cuenta nueva lo recibe verificado. Queda auditado.
   *
   * Todo lo anterior exige `emailTrusted`: que el proveedor garantice que el
   * correo es de quien entra. Google y Apple lo dicen en el token; Facebook
   * no, así que su correo nunca vincula ni libera nada — solo se guarda, sin
   * verificar, en una cuenta que no lo tenga y si nadie más lo usa.
   */
  private async resolveOAuthUser(provider: OAuthProvider, identity: OAuthIdentity, req?: Request): Promise<IUser> {
    const idField = OAUTH_ID_FIELD[provider];
    const providerName = OAUTH_PROVIDER_NAME[provider];

    const linked = await User.findOne({ [idField]: identity.sub }).select(`+${idField}`);
    if (linked) return this.fillMissingProfile(linked, provider, identity, req);

    const email = identity.email?.trim().toLowerCase();

    if (email && identity.emailTrusted) {
      const byEmail = await User.findOne({ email }).select(`+${idField}`);

      if (byEmail && byEmail.emailVerified === true) {
        const current = byEmail.get(idField) as string | undefined;
        if (current && current !== identity.sub) {
          throw new AppError(
            `Este correo ya está vinculado a otra cuenta de ${providerName}.`,
            409,
            'OAUTH_IDENTITY_CONFLICT'
          );
        }

        // Condicionado a que siga sin identidad: dos logins simultáneos con
        // identidades distintas no pueden vincular los dos.
        const result = await User.updateOne(
          { _id: byEmail._id, emailVerified: true, $or: [{ [idField]: { $exists: false } }, { [idField]: null }] },
          { $set: { [idField]: identity.sub } }
        );
        if (result.modifiedCount !== 1) {
          throw new AppError(`Este correo ya está vinculado a otra cuenta de ${providerName}.`, 409, 'OAUTH_IDENTITY_CONFLICT');
        }

        if (req) {
          await logAudit(req, {
            action: AuditAction.PROFILE_UPDATED,
            entity: 'user',
            entityId: byEmail._id.toString(),
            severity: AuditSeverity.HIGH,
            description: `Identidad de ${providerName} vinculada por correo verificado`,
            metadata: { provider, updatedFields: [idField] },
          });
        }
        return this.fillMissingProfile((await User.findById(byEmail._id))!, provider, identity, req);
      }

      if (byEmail) {
        await User.updateOne(
          { _id: byEmail._id, email, emailVerified: { $ne: true } },
          { $unset: { email: 1 } }
        );
        if (req) {
          await logAudit(req, {
            action: AuditAction.USER_CONTACT_OVERRIDDEN,
            entity: 'user',
            entityId: byEmail._id.toString(),
            severity: AuditSeverity.HIGH,
            description: `Correo no verificado liberado: ${providerName} demostró que pertenece a otra persona`,
            metadata: { provider, updatedFields: ['email'] },
          });
        }
      }
    }

    // Un correo no garantizado (Facebook) solo entra si nadie más lo usa. Si
    // otra cuenta lo tiene se omite en silencio: decirlo revelaría que existe.
    const emailForNew = email && (identity.emailTrusted || !(await User.exists({ email }))) ? email : undefined;
    const { firstName, lastName } = oauthNames(identity);

    let created: IUser;
    try {
      created = await User.create({
        name: [firstName, lastName].filter(Boolean).join(' ') || identity.name?.trim()
          || (emailForNew ? emailForNew.split('@')[0] : oauthPlaceholderName(provider)),
        firstName,
        lastName,
        email: emailForNew,
        emailVerified: !!emailForNew && identity.emailTrusted,
        avatar: identity.importAvatar ? undefined : identity.avatar,
        [idField]: identity.sub,
        role: UserRole.CLIENT,
        // Sin celular todavía: la app lo pide y lo verifica por OTP justo
        // después de este login.
        isVerified: false,
      });
    } catch (error) {
      if ((error as { code?: number }).code === 11000) {
        throw new AppError('No pudimos completar el inicio de sesión. Intenta de nuevo.', 409, 'OAUTH_ACCOUNT_CONFLICT');
      }
      throw error;
    }

    if (identity.importAvatar && identity.avatar) {
      return (await this.importRemoteAvatar(created, identity.avatar)) ?? created;
    }
    return created;
  }

  /**
   * Rellena con lo del proveedor lo que la cuenta todavía no tiene. **Nunca
   * pisa** lo que el cliente escribió o editó en Mi cuenta.
   *
   * - Nombre y apellido: solo si los dos están vacíos y el `name` actual es
   *   uno que pusimos nosotros (el comodín, el prefijo del correo o el que ya
   *   había dado este mismo proveedor). Si la persona escribió su nombre al
   *   registrarse con el celular, se respeta y Mi cuenta le pide el apellido.
   * - Correo: solo si no tiene, y si ninguna otra cuenta lo usa. Uno no
   *   garantizado (Facebook) entra sin verificar.
   * - Foto: solo si no tiene.
   */
  private async fillMissingProfile(
    user: IUser,
    provider: OAuthProvider,
    identity: OAuthIdentity,
    req?: Request
  ): Promise<IUser> {
    const set: Record<string, unknown> = {};
    const { firstName, lastName } = oauthNames(identity);
    const providerFullName = [firstName, lastName].filter(Boolean).join(' ') || identity.name?.trim() || '';

    if (!user.firstName && !user.lastName && (firstName || lastName)) {
      const norm = (v: string) => v.trim().toLocaleLowerCase('es');
      const current = norm(user.name ?? '');
      const ours =
        current === norm(oauthPlaceholderName(provider)) ||
        (!!user.email && current === norm(user.email.split('@')[0])) ||
        (!!providerFullName && current === norm(providerFullName));
      if (ours) {
        if (firstName) set.firstName = firstName;
        if (lastName) set.lastName = lastName;
        set.name = [firstName, lastName].filter(Boolean).join(' ');
      }
    }

    const email = identity.email?.trim().toLowerCase();
    if (!user.email && email && !(await User.exists({ email, _id: { $ne: user._id } }))) {
      set.email = email;
      set.emailVerified = identity.emailTrusted;
    }

    const wantsAvatar = !user.avatar && !!identity.avatar;
    if (wantsAvatar && !identity.importAvatar) set.avatar = identity.avatar;

    const updatedFields = Object.keys(set);
    if (updatedFields.length > 0) {
      // Condicionado a que sigan vacíos: si el cliente guardó algo desde Mi
      // cuenta entre la lectura y esta escritura, gana lo suyo.
      const empty = { $in: [null, ''] };
      const guard: Record<string, unknown> = { _id: user._id };
      if (set.firstName !== undefined || set.lastName !== undefined) {
        guard.firstName = empty;
        guard.lastName = empty;
      }
      if (set.email !== undefined) guard.email = empty;
      if (set.avatar !== undefined) guard.avatar = empty;

      try {
        await User.updateOne(guard, { $set: set });
      } catch (error) {
        // Otra cuenta tomó el correo en ese mismo instante: no vale la pena
        // romper el login por eso.
        if ((error as { code?: number }).code !== 11000) throw error;
      }

      if (req) {
        await logAudit(req, {
          action: AuditAction.PROFILE_UPDATED,
          entity: 'user',
          entityId: user._id.toString(),
          description: `Perfil completado con datos de ${OAUTH_PROVIDER_NAME[provider]}`,
          metadata: { provider, updatedFields },
        });
      }
    }

    let fresh: IUser = (await User.findById(user._id))!;
    if (wantsAvatar && identity.importAvatar && identity.avatar && !fresh.avatar) {
      fresh = (await this.importRemoteAvatar(fresh, identity.avatar)) ?? fresh;
    }
    return fresh;
  }

  /**
   * Trae una foto de un proveedor y la sube como avatar propio. Las URLs de
   * Facebook están firmadas y caducan: guardarlas tal cual dejaría la foto
   * rota en unos días. Si algo falla, el login sigue sin foto.
   */
  private async importRemoteAvatar(user: IUser, url: string): Promise<IUser | null> {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const type = res.headers.get('content-type') ?? '';
      if (!res.ok || !type.startsWith('image/')) return null;
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length === 0 || buffer.length > 5 * 1024 * 1024) return null;
      return await this.uploadAvatar(user._id.toString(), buffer);
    } catch {
      return null;
    }
  }

  private oauthNeedsPhone(user: IUser): boolean {
    return !user.phone || !user.phoneVerified;
  }

  async loginWithGoogle(
    idToken: string,
    req?: Request,
    options: { nonce?: string } = {}
  ): Promise<AuthOutcome & { needsPhone: boolean }> {
    const audiences = [
      config.google.webClientId,
      config.google.iosClientId,
      config.google.androidClientId,
    ].filter(Boolean);

    if (audiences.length === 0) {
      throw new AppError('Inicio de sesión con Google no está configurado', 500);
    }

    let payload: IdentityPayload;
    try {
      payload = await identityVerifiers.google(idToken, audiences);
    } catch {
      throw new AppError('Token de Google inválido', 401);
    }

    const emailVerified = payload.email_verified === true || payload.email_verified === 'true';
    if (!payload.sub || !payload.email || !emailVerified) {
      throw new AppError('No pudimos verificar tu cuenta de Google', 401);
    }

    // El SDK nativo instalado no permite fijar un nonce, así que no se exige;
    // pero si el token trae uno, tiene que coincidir con el que manda la app.
    if (payload.nonce || options.nonce) {
      if (!sameString(payload.nonce, options.nonce)) {
        throw new AppError('Token de Google inválido', 401, 'NONCE_MISMATCH');
      }
    }

    await consumeIdentityToken('google', idToken, payload.exp);

    // Arriba ya se exigió `email_verified`: el correo de Google es de quien entra.
    const user = await this.resolveOAuthUser(
      'google',
      {
        sub: payload.sub,
        email: payload.email,
        emailTrusted: true,
        name: payload.name,
        firstName: payload.given_name,
        lastName: payload.family_name,
        avatar: payload.picture,
      },
      req
    );

    const outcome = await this.completeLogin(user, req, { method: 'google' });
    if (req && !outcome.requiresTOTP) {
      await logAudit(req, {
        action: AuditAction.LOGIN_SUCCESS,
        entity: 'user',
        entityId: user._id.toString(),
        description: `Login con Google exitoso: ${maskEmail(user.email)}`,
        metadata: { provider: 'google' },
      });
    }

    return { ...outcome, needsPhone: this.oauthNeedsPhone(outcome.user) };
  }

  /**
   * Recibe el `form_post` de Apple y lo guarda tras un código de un solo uso
   * para que el deep link de vuelta a la app no lleve el `id_token`. Ver
   * `models/OAuthReplay.ts`.
   */
  async createAppleAuthCode(
    idToken: string,
    fullName?: string,
    parts: { firstName?: string; lastName?: string } = {}
  ): Promise<string> {
    const code = crypto.randomBytes(32).toString('base64url');
    const cut = (v?: string) => (v?.trim() ? v.trim().slice(0, 60) : undefined);
    await AppleAuthCode.create({
      codeHash: sha256(code),
      idToken,
      fullName: fullName ? fullName.slice(0, 100) : undefined,
      firstName: cut(parts.firstName),
      lastName: cut(parts.lastName),
      expiresAt: new Date(Date.now() + APPLE_CODE_TTL_MS),
    });
    return code;
  }

  async loginWithApple(
    input: { code: string; nonce: string; fullName?: string },
    req?: Request
  ): Promise<AuthOutcome & { needsPhone: boolean }> {
    if (!config.apple.servicesId) {
      throw new AppError('Inicio de sesión con Apple no está configurado', 500);
    }

    // Canje de un solo uso: quien llega segundo no encuentra nada.
    const pending = await AppleAuthCode.findOneAndDelete({
      codeHash: sha256(input.code),
      expiresAt: { $gt: new Date() },
    });
    if (!pending) throw new AppError('El inicio de sesión con Apple venció. Vuelve a intentarlo.', 401, 'APPLE_CODE_INVALID');

    let payload: IdentityPayload;
    try {
      payload = await identityVerifiers.apple(pending.idToken, config.apple.servicesId);
    } catch {
      throw new AppError('Token de Apple inválido', 401);
    }

    // La app envió a Apple el SHA-256 de un nonce que solo ella conoce, y
    // Apple lo firmó dentro del token. Sin el nonce en claro el código no se
    // puede canjear, aunque se haya interceptado el deep link.
    if (!payload.sub || !sameString(payload.nonce, sha256(input.nonce))) {
      throw new AppError('Token de Apple inválido', 401, 'NONCE_MISMATCH');
    }

    await consumeIdentityToken('apple', pending.idToken, payload.exp);

    // "true"/"false" en vez de booleano es una inconsistencia conocida del
    // token de Apple según la versión de iOS/macOS que lo generó.
    const emailVerified = payload.email_verified === true || payload.email_verified === 'true';
    const email = payload.email && emailVerified ? payload.email.toLowerCase() : undefined;

    // El correo puede ser el privado de Apple (`@privaterelay.appleid.com`):
    // reenvía al real, así que se guarda verificado igual (decisión del
    // 2026-09-19). Mi cuenta lo rotula como tal.
    const user = await this.resolveOAuthUser(
      'apple',
      {
        sub: payload.sub,
        email,
        emailTrusted: !!email,
        name: pending.fullName || input.fullName,
        firstName: pending.firstName,
        lastName: pending.lastName,
      },
      req
    );

    const outcome = await this.completeLogin(user, req, { method: 'apple' });
    if (req && !outcome.requiresTOTP) {
      await logAudit(req, {
        action: AuditAction.LOGIN_SUCCESS,
        entity: 'user',
        entityId: user._id.toString(),
        description: 'Login con Apple exitoso',
        metadata: { provider: 'apple' },
      });
    }

    return { ...outcome, needsPhone: this.oauthNeedsPhone(outcome.user) };
  }

  /**
   * "Continuar con Facebook", sin SDK nativo: la app abre el diálogo de Meta
   * en el navegador, Meta vuelve a `/auth/facebook/callback` y de ahí al deep
   * link con el `code`. Aquí se canjea con PKCE y se lee el perfil.
   *
   * El correo de Facebook no trae una marca de verificado como la de Google:
   * se guarda sin verificar y nunca vincula una cuenta existente por correo
   * (ver `resolveOAuthUser`). La foto se importa porque su URL caduca.
   */
  async loginWithFacebook(
    input: { code: string; codeVerifier: string },
    req?: Request
  ): Promise<AuthOutcome & { needsPhone: boolean }> {
    if (!config.facebook.appId || !config.facebook.appSecret) {
      throw new AppError('Inicio de sesión con Facebook no está disponible todavía.', 503, 'FACEBOOK_NOT_CONFIGURED');
    }

    let profile: FacebookProfile;
    try {
      const accessToken = await facebookGraph.exchangeCode(input.code, input.codeVerifier);
      profile = await facebookGraph.profile(accessToken);
    } catch {
      throw new AppError('No pudimos confirmar tu cuenta de Facebook. Vuelve a intentarlo.', 401, 'FACEBOOK_CODE_INVALID');
    }

    const picture = profile.picture?.data;
    const user = await this.resolveOAuthUser(
      'facebook',
      {
        sub: profile.id,
        email: profile.email,
        emailTrusted: false,
        name: profile.name,
        firstName: profile.first_name,
        lastName: profile.last_name,
        // La silueta gris por defecto no es una foto: mejor las iniciales.
        avatar: picture?.url && !picture.is_silhouette ? picture.url : undefined,
        importAvatar: true,
      },
      req
    );

    const outcome = await this.completeLogin(user, req, { method: 'facebook' });
    if (req && !outcome.requiresTOTP) {
      await logAudit(req, {
        action: AuditAction.LOGIN_SUCCESS,
        entity: 'user',
        entityId: user._id.toString(),
        description: 'Login con Facebook exitoso',
        metadata: { provider: 'facebook' },
      });
    }

    return { ...outcome, needsPhone: this.oauthNeedsPhone(outcome.user) };
  }

  // ── Registro en tres pasos ───────────────────────────────────────────

  /**
   * Entrada única: le dice al front si ese celular ya tiene cuenta, para que
   * decida entre pedir la contraseña (login) o arrancar el registro. Es una
   * lectura simple sin efectos secundarios, así que va detrás del límite
   * general (`authRateLimiter`) y no del de OTP — ese lo gasta únicamente
   * `sendRegistrationOTP`, que sí manda un WhatsApp real.
   */
  async getPhoneStatus(phone: string): Promise<{ exists: boolean }> {
    const user = await User.findOne({ phone });
    return { exists: !!user };
  }

  /**
   * Paso 1 del registro en 3 pasos: manda el OTP a un celular que todavía no
   * tiene cuenta. Como no existe un `User` para guardar el código, vive en
   * `PendingRegistration`, que se autodestruye si nadie vuelve.
   */
  async sendRegistrationOTP(phone: string, req?: Request): Promise<void> {
    const existing = await User.findOne({ phone });
    if (existing) {
      throw new AppError('Este número de celular ya está registrado', 409);
    }

    const current = await PendingRegistration.findOne({ phone }).select('+otpExpires');
    if (current && !resendAllowed(current.otpExpires)) {
      throw new AppError('Espera unos segundos antes de pedir otro código.', 429, 'OTP_COOLDOWN');
    }

    const code = generateOtpCode();
    await PendingRegistration.findOneAndUpdate(
      { phone },
      { $set: { phone, verified: false, ...otpSetFields(OTP_SLOTS.registration, code) }, $unset: { verifiedUntil: 1 } },
      { upsert: true, setDefaultsOnInsert: true }
    );

    await whatsappService.sendOTP(phone, code);

    if (req) {
      await logAudit(req, {
        action: AuditAction.OTP_SENT,
        entity: 'user',
        description: `OTP de registro enviado a ${maskPhone(phone)}`,
        metadata: { channel: 'whatsapp', purpose: 'registration' },
      });
    }
  }

  /**
   * Paso 2: confirma el código y marca el celular como verificado por un
   * rato — no emite tokens todavía porque no hay cuenta que abrir, solo el
   * visto bueno para que el paso 3 pueda crearla.
   */
  async verifyRegistrationOTP(phone: string, otpCode: string, req?: Request): Promise<void> {
    const result = await checkOtp(PendingRegistration, { phone }, OTP_SLOTS.registration, otpCode);

    if (result !== 'ok') {
      if (req && result !== 'missing') {
        await logAudit(req, {
          action: AuditAction.OTP_FAILED,
          entity: 'user',
          severity: AuditSeverity.MEDIUM,
          description: `OTP de registro rechazado para ${maskPhone(phone)} (${result})`,
          metadata: { channel: 'whatsapp', purpose: 'registration', result },
        });
      }
      throw otpError(result, 'No hay un código pendiente para este celular');
    }

    await PendingRegistration.updateOne(
      { phone },
      { $set: { verified: true, verifiedUntil: new Date(Date.now() + 15 * 60 * 1000) } }
    );
  }

  /**
   * Paso 3: con el celular ya verificado, pide lo que falta y crea la
   * cuenta de una vez, ya confirmada.
   */
  async completeRegistration(
    phone: string, name: string, password: string, req?: Request
  ): Promise<AuthOutcome> {
    const pending = await PendingRegistration.findOne({ phone });
    if (!pending || !pending.verified || !pending.verifiedUntil || new Date() > pending.verifiedUntil) {
      throw new AppError('Verifica tu celular primero', 400);
    }

    const existing = await User.findOne({ phone });
    if (existing) {
      throw new AppError('Este número de celular ya está registrado', 409);
    }

    if (password.length > MAX_PASSWORD_LENGTH) {
      throw new AppError('La contraseña no puede exceder 128 caracteres', 400);
    }

    // Borrar primero y crear después: si dos peticiones completan a la vez,
    // solo una encuentra el registro pendiente para consumir.
    const consumed = await PendingRegistration.deleteOne({ _id: pending._id });
    if (consumed.deletedCount !== 1) throw new AppError('Verifica tu celular primero', 400);

    const user = await User.create({
      name,
      phone,
      password,
      role: UserRole.CLIENT,
      isVerified: true,
      // El celular se confirmó por OTP en el paso 2: ya no hace falta
      // volver a verificarlo, y queda protegido contra cambios.
      phoneVerified: true,
    });

    const outcome = await this.completeLogin(user, req, { method: 'otp' });

    if (req) {
      const ip = requestIp(req);
      const ua = requestUa(req);
      await antiFraudService.checkMultipleAccounts(user._id.toString(), generateDeviceId(ua, ip), ip);
      await logAudit(req, {
        action: AuditAction.REGISTER,
        entity: 'user',
        entityId: user._id.toString(),
        description: `Nuevo usuario registrado: ${maskPhone(user.phone)} (client)`,
        metadata: { role: UserRole.CLIENT, phoneVerified: true },
      });
    }

    return outcome;
  }

  // ── Contraseña ───────────────────────────────────────────────────────

  async login(input: LoginInput, req?: Request): Promise<AuthOutcome> {
    const ip = requestIp(req);

    // Cliente y domiciliario entran por celular; admin y business —que ya
    // no tienen garantizado un `phone` (ver `models/User.ts`)— entran por
    // correo. El validador exige exactamente uno de los dos.
    const byEmail = !!input.email;
    const identifierValue = byEmail ? input.email!.toLowerCase().trim() : (normalizePhone(input.phone) ?? input.phone!);
    const identifierMask = byEmail ? maskEmail(identifierValue) : maskPhone(identifierValue);
    const identifierFilter = byEmail ? { email: identifierValue } : { phone: identifierValue };

    const bruteCheck = await checkBruteForce(ip, identifierValue);
    if (!bruteCheck.allowed) {
      if (req) {
        await logAudit(req, {
          action: AuditAction.BRUTE_FORCE_DETECTED,
          entity: 'auth',
          severity: AuditSeverity.HIGH,
          description: `Brute force detectado para ${identifierMask}: ${bruteCheck.reason}`,
          metadata: { retryAfterMs: bruteCheck.retryAfterMs },
        });
      }
      throw new AppError(bruteCheck.reason || 'Demasiados intentos. Intenta más tarde.', 429);
    }

    const user = await User.findOne(identifierFilter)
      .select('+password +twoFactorEnabled +twoFactorSecret +failedLoginAttempts +lastLoginIp +passwordExpiresAt');

    const passwordOk = !!user && (await user.comparePassword(input.password));

    if (!user || !passwordOk) {
      // Misma respuesta exista o no la cuenta. El bloqueo lo decide el
      // contador por identificador escrito (ver security/bruteforce.ts), que
      // se comporta igual para un teléfono registrado y uno inventado.
      const attempt = await recordFailedAttempt(ip, identifierValue);

      if (user) {
        await User.updateOne({ _id: user._id }, { $inc: { failedLoginAttempts: 1 } });
        if (req) {
          await logAudit(req, {
            action: attempt.allowed ? AuditAction.LOGIN_FAILED : AuditAction.ACCOUNT_LOCKED,
            entity: 'user',
            entityId: user._id.toString(),
            severity: attempt.allowed ? AuditSeverity.MEDIUM : AuditSeverity.HIGH,
            description: `Login fallido para ${identifierMask}`,
          });
        }
        await recordSecurityEvent({
          userId: user._id,
          role: user.role,
          req,
          type: SecurityEventType.LOGIN_FAILED,
          result: 'failure',
          reason: attempt.allowed ? 'bad_password' : 'locked',
        });
      }

      if (!attempt.allowed) {
        throw new AppError(attempt.reason || 'Demasiados intentos. Intenta más tarde.', 429);
      }
      throw new AppError('Credenciales inválidas', 401);
    }

    // S10: una contraseña temporal generada por un admin caduca sola a las
    // 24h (ver `admin.service.ts::resetUserPassword`). Vencida, ni siquiera
    // sirve para entrar — evita que quede funcionando indefinidamente como
    // una contraseña más si nadie la cambia.
    if (user.passwordExpiresAt && user.passwordExpiresAt.getTime() < Date.now()) {
      throw new AppError(
        'Esta contraseña temporal venció. Pide a un administrador que te restablezca el acceso.',
        403,
        'TEMPORARY_PASSWORD_EXPIRED'
      );
    }

    let outcome: AuthOutcome;
    try {
      outcome = await this.completeLogin(user, req, {
        method: 'password',
        totpToken: input.totpToken,
        deviceId: input.deviceId,
      });
    } catch (error) {
      // Un TOTP equivocado con la contraseña correcta también es un intento
      // fallido: si no contara, el TOTP se podía probar sin límite.
      if (error instanceof AppError && error.code === 'MFA_CODE_INVALID') {
        await recordFailedAttempt(ip, identifierValue);
      }
      throw error;
    }

    if (outcome.requiresTOTP) return outcome;

    await clearAttempts(ip, identifierValue);
    await User.updateOne({ _id: user._id }, { $set: { failedLoginAttempts: 0, isVerified: true }, $unset: { lockedUntil: 1 } });

    if (req) {
      await this.recordLoginChecks(user, req, outcome.isNewDevice, input.deviceId);

      await logAudit(req, {
        action: AuditAction.LOGIN_SUCCESS,
        entity: 'user',
        entityId: user._id.toString(),
        description: `Login exitoso: ${identifierMask}`,
        metadata: { isNewDevice: outcome.isNewDevice, role: user.role },
      });
    }

    return outcome;
  }

  // ── Refresh ──────────────────────────────────────────────────────────

  /**
   * Rota el refresh token contra `Session.tokenHash`, la única fuente de
   * verdad. Antes se comparaba primero contra `User.refreshToken` (un solo
   * campo, en claro): un token viejo recibía 401 sin llegar nunca a la
   * detección de reuso, y abrir sesión en un segundo dispositivo dejaba al
   * primero sin poder refrescar.
   */
  async refreshTokens(refreshToken: string, req?: Request): Promise<AuthTokens> {
    let decoded;
    try {
      decoded = verifyRefreshToken(refreshToken);
    } catch {
      throw new AppError('Refresh token inválido', 401, 'REFRESH_INVALID');
    }

    const presentedHash = hashToken(refreshToken);
    const sessionRef = decoded.sid
      ? { _id: decoded.sid }
      : await Session.findOne({ $or: [{ tokenHash: presentedHash }, { previousTokenHash: presentedHash }] }).select('_id');
    if (!sessionRef) throw new AppError('Refresh token inválido', 401, 'REFRESH_INVALID');

    const user = await User.findById(decoded.id);
    if (!user) throw new AppError('Refresh token inválido', 401, 'REFRESH_INVALID');

    const tokens = this.generateTokens(user, sessionRef._id.toString());
    const rotation = await sessionManager.rotateRefreshToken(refreshToken, tokens.refreshToken, requestIp(req));

    if (rotation.status === 'race') {
      throw new AppError('La sesión se está renovando en otra petición. Reintenta.', 409, 'REFRESH_IN_PROGRESS');
    }

    if (rotation.status === 'reuse') {
      if (req) {
        await logAudit(req, {
          action: AuditAction.SUSPICIOUS_ACTIVITY,
          entity: 'session',
          entityId: rotation.userId,
          severity: AuditSeverity.CRITICAL,
          description: `Reuso de refresh token detectado. ${rotation.revokedCount} sesiones revocadas.`,
        });
      }
      await recordSecurityEvent({
        userId: rotation.userId,
        req,
        type: SecurityEventType.SESSION_REVOKED,
        result: 'failure',
        reason: 'reuse_detected',
        metadata: { count: rotation.revokedCount },
      });
      throw new AppError('Sesión comprometida. Todas las sesiones han sido cerradas por seguridad.', 401, 'REFRESH_REUSED');
    }

    if (rotation.status === 'revoked' || rotation.session.userId !== user._id.toString()) {
      throw new AppError('Refresh token inválido', 401, 'REFRESH_INVALID');
    }

    // El refresh no abre la puerta a una cuenta que se bloqueó después de
    // iniciar sesión: se cierra la sesión en vez de rotarla.
    if (user.isBlocked || !user.isActive || user.anonymizedAt) {
      await sessionManager.revokeSession(rotation.session._id!.toString(), user._id.toString(), 'admin');
      throw new AppError('Tu cuenta no está disponible.', 401, 'ACCOUNT_UNAVAILABLE');
    }

    await recordSessionIpChange({
      user,
      req,
      sessionId: String(rotation.session._id),
      deviceId: rotation.session.deviceId,
      previousIp: rotation.previousIp,
    });

    return tokens;
  }

  // ── OTP de WhatsApp: login y recuperación ────────────────────────────

  /**
   * Manda el OTP de login/recuperación. La respuesta es la misma exista o no
   * la cuenta: antes un 404 "Usuario no encontrado" servía para saber qué
   * números estaban registrados.
   */
  async sendOTP(phone: string, req?: Request): Promise<void> {
    const user = await User.findOne({ phone }).select('+otpExpires isActive isBlocked anonymizedAt phone');
    if (!user || !user.isActive || user.isBlocked || user.anonymizedAt) return;
    if (!resendAllowed(user.otpExpires)) return;

    const code = generateOtpCode();
    await User.updateOne({ _id: user._id }, { $set: otpSetFields(OTP_SLOTS.phone, code) });
    await whatsappService.sendOTP(user.phone!, code);

    if (req) {
      await logAudit(req, {
        action: AuditAction.OTP_SENT,
        entity: 'user',
        entityId: user._id.toString(),
        description: `OTP enviado a ${maskPhone(user.phone)}`,
        metadata: { channel: 'whatsapp' },
      });
    }
  }

  async verifyOTP(phone: string, otpCode: string, req?: Request): Promise<AuthOutcome> {
    const user = await User.findOne({ phone });
    if (!user) throw otpError('invalid');

    const result = await checkOtp(User, { _id: user._id }, OTP_SLOTS.phone, otpCode);
    if (result !== 'ok') {
      if (req && result !== 'missing') {
        await logAudit(req, {
          action: AuditAction.OTP_FAILED,
          entity: 'user',
          entityId: user._id.toString(),
          severity: result === 'locked' ? AuditSeverity.HIGH : AuditSeverity.MEDIUM,
          description: `OTP rechazado para ${maskPhone(user.phone)} (${result})`,
          metadata: { channel: 'whatsapp', result },
        });
      }
      throw otpError(result, 'No hay OTP pendiente');
    }

    // Login por WhatsApp OTP exitoso: el teléfono queda confirmado y se
    // bloquea para edición por el propio usuario (ver updateProfile).
    await User.updateOne({ _id: user._id }, { $set: { isVerified: true, phoneVerified: true } });
    user.isVerified = true;
    user.phoneVerified = true;

    const outcome = await this.completeLogin(user, req, { method: 'otp' });

    if (req) {
      await logAudit(req, {
        action: AuditAction.OTP_VERIFIED,
        entity: 'user',
        entityId: user._id.toString(),
        description: `OTP verificado para ${maskPhone(user.phone)}`,
        metadata: { channel: 'phone', requiresTOTP: outcome.requiresTOTP },
      });
    }

    return outcome;
  }

  // ── OTP de correo ────────────────────────────────────────────────────

  async sendEmailOTP(email: string, req?: Request): Promise<void> {
    if (!emailService.isEnabled) {
      throw new AppError('El inicio de sesión por correo no está disponible.', 503, 'EMAIL_OTP_DISABLED');
    }

    const normalizedEmail = email.trim().toLowerCase();
    const user = await User.findOne({ email: normalizedEmail }).select('+emailOtpExpires isActive isBlocked anonymizedAt');
    if (!user || !user.isActive || user.isBlocked || user.anonymizedAt) return;
    if (!resendAllowed(user.emailOtpExpires)) return;

    const code = generateOtpCode();
    await User.updateOne({ _id: user._id }, { $set: otpSetFields(OTP_SLOTS.email, code) });
    await emailService.sendOTP(normalizedEmail, code);

    if (req) {
      await logAudit(req, {
        action: AuditAction.OTP_SENT,
        entity: 'user',
        entityId: user._id.toString(),
        description: `OTP enviado a ${maskEmail(normalizedEmail)}`,
        metadata: { channel: 'email' },
      });
    }
  }

  async verifyEmailOTP(email: string, otpCode: string, req?: Request): Promise<AuthOutcome> {
    if (!emailService.isEnabled) {
      throw new AppError('El inicio de sesión por correo no está disponible.', 503, 'EMAIL_OTP_DISABLED');
    }

    const normalizedEmail = email.trim().toLowerCase();
    const user = await User.findOne({ email: normalizedEmail });
    if (!user) throw otpError('invalid');

    const result = await checkOtp(User, { _id: user._id }, OTP_SLOTS.email, otpCode);
    if (result !== 'ok') {
      if (req && result !== 'missing') {
        await logAudit(req, {
          action: AuditAction.OTP_FAILED,
          entity: 'user',
          entityId: user._id.toString(),
          severity: result === 'locked' ? AuditSeverity.HIGH : AuditSeverity.MEDIUM,
          description: `OTP rechazado para ${maskEmail(normalizedEmail)} (${result})`,
          metadata: { channel: 'email', result },
        });
      }
      throw otpError(result, 'No hay OTP pendiente');
    }

    // Login por OTP de correo exitoso: el correo queda confirmado y se
    // bloquea para edición por el propio usuario (ver updateProfile).
    await User.updateOne({ _id: user._id }, { $set: { isVerified: true, emailVerified: true } });
    user.isVerified = true;
    user.emailVerified = true;

    const outcome = await this.completeLogin(user, req, { method: 'email_otp' });

    if (req) {
      await logAudit(req, {
        action: AuditAction.OTP_VERIFIED,
        entity: 'user',
        entityId: user._id.toString(),
        description: `OTP verificado para ${maskEmail(normalizedEmail)}`,
        metadata: { channel: 'email', requiresTOTP: outcome.requiresTOTP },
      });
    }

    return outcome;
  }

  // ── Logout ───────────────────────────────────────────────────────────

  /**
   * Cierra la sesión en el servidor. La sesión sale del `sid` del access
   * token, así que no depende de que el cliente mande el refresh token; si lo
   * manda (tokens previos a `sid`), también se usa.
   */
  async logout(userId: string, req?: Request): Promise<{ revoked: boolean }> {
    let revoked = false;

    if (req?.sessionId) {
      revoked = await sessionManager.revokeSession(req.sessionId, userId, 'logout');
    }

    const bodyToken = req?.body?.refreshToken;
    if (typeof bodyToken === 'string' && bodyToken) {
      revoked = (await sessionManager.revokeByRefreshToken(bodyToken, userId, 'logout')) || revoked;
    }

    if (req) {
      await logAudit(req, {
        action: AuditAction.LOGOUT,
        entity: 'user',
        entityId: userId,
        description: 'Sesión cerrada',
        metadata: { revoked },
      });
    }
    await recordSecurityEvent({
      userId,
      role: req?.user?.role,
      req,
      type: SecurityEventType.LOGOUT,
      sessionId: req?.sessionId ?? null,
      reason: 'logout',
    });

    return { revoked };
  }

  // ── Recuperación de contraseña ───────────────────────────────────────

  /**
   * Restablece la contraseña con el OTP de WhatsApp.
   *
   * En una cuenta con 2FA el OTP solo no alcanza: tener el celular (o su SIM)
   * es justo lo que el segundo factor está para no dar por suficiente. Sin
   * `totpToken` se valida el código SIN gastarlo y se responde
   * `requiresTOTP`; la app pide el TOTP y reenvía todo junto.
   */
  async resetPassword(
    phone: string,
    otpCode: string,
    newPassword: string,
    req?: Request,
    totpToken?: string
  ): Promise<AuthOutcome> {
    const ip = requestIp(req);
    const bruteCheck = await checkBruteForce(ip, phone);
    if (!bruteCheck.allowed) {
      throw new AppError(bruteCheck.reason || 'Demasiados intentos. Intenta más tarde.', 429);
    }

    // La política se valida antes de tocar el OTP: una contraseña débil no
    // debe quemar un código correcto.
    const passwordCheck = validatePasswordComplexity(newPassword);
    if (!passwordCheck.valid) {
      throw new AppError(passwordCheck.errors.join('. '), 400);
    }

    const user = await User.findOne({ phone }).select('+password');
    if (!user) throw otpError('invalid');

    const twoFactor = hasTwoFactor(user);
    const firstCheck = await checkOtp(User, { _id: user._id }, OTP_SLOTS.phone, otpCode, { consume: !twoFactor });
    if (firstCheck !== 'ok') throw otpError(firstCheck, 'No hay OTP pendiente');

    if (twoFactor) {
      if (!totpToken) {
        // Sin sesión ni reto: la app reenvía el mismo formulario con el TOTP.
        return { requiresTOTP: true, challengeToken: '', user, method: 'password_reset' };
      }
      if (!(await verifySecondFactor(user._id, totpToken))) {
        await recordFailedAttempt(ip, phone);
        throw new AppError('Código 2FA inválido', 401, 'MFA_CODE_INVALID');
      }
      const burned = await checkOtp(User, { _id: user._id }, OTP_SLOTS.phone, otpCode);
      if (burned !== 'ok') throw otpError(burned, 'No hay OTP pendiente');
    }

    this.assertAccountUsable(user);

    user.password = newPassword;
    user.isVerified = true;
    // Recibir el OTP demuestra que el celular es suyo.
    user.phoneVerified = true;
    user.failedLoginAttempts = 0;
    user.lockedUntil = undefined;
    // A5: esta contraseña es nueva y la puso el propio usuario — no hay
    // razón para seguir exigiendo un cambio pendiente ni para que caduque
    // a las 24h como si fuera la temporal que un admin le asignó.
    user.mustChangePassword = false;
    user.passwordExpiresAt = undefined;
    await user.save();

    // Revoke all existing sessions (password changed)
    await sessionManager.revokeAllSessions(user._id.toString(), { reason: 'password_changed' });
    await clearAttempts(ip, phone);

    await recordSecurityEvent({
      userId: user._id,
      role: user.role,
      req,
      type: SecurityEventType.PASSWORD_CHANGED,
      reason: 'password_changed',
      metadata: { how: 'reset' },
    });

    // El segundo factor, si hacía falta, ya se verificó arriba.
    const session = await this.startSession(user, req, { method: 'password_reset', mfa: twoFactor });

    if (req) {
      await logAudit(req, {
        action: AuditAction.PASSWORD_RESET,
        entity: 'user',
        entityId: user._id.toString(),
        severity: AuditSeverity.HIGH,
        description: `Contraseña restablecida para ${maskPhone(user.phone)}`,
        metadata: { twoFactor },
      });
    }

    return { requiresTOTP: false, user, method: 'password_reset', ...session };
  }

  // ── Perfil y celular ─────────────────────────────────────────────────

  /**
   * Actualiza el perfil.
   *
   * El celular nunca se escribe directamente: queda en `pendingPhone` y se
   * manda un OTP a ese número. Solo al confirmarlo (`verifyPendingPhone`) pasa
   * a ser `phone`. Antes bastaba un `PATCH` para quedarse con un número ajeno
   * aún no registrado: se le bloqueaba el registro al dueño y, cuando pedía
   * un OTP para "su" número, entraba en la cuenta de quien lo había puesto.
   */
  async updateProfile(
    userId: string,
    data: {
      name?: string;
      firstName?: string;
      lastName?: string;
      email?: string;
      receiptEmail?: string;
      phone?: string;
      documentType?: DocumentType | null;
      documentNumber?: string | null;
      birthDate?: string;
    },
    req?: Request
  ): Promise<{ user: IUser; phoneVerificationSent: boolean }> {
    const user = await User.findById(userId).select('+pendingPhoneOtpExpires');
    if (!user) {
      throw new AppError('Usuario no encontrado', 404);
    }

    let phoneVerificationSent = false;

    if (data.phone) {
      if (user.phoneVerified) {
        if (data.phone !== user.phone) {
          throw new AppError('Tu número de celular ya fue verificado y no se puede editar. Contacta a soporte.', 403);
        }
      } else {
        if (data.phone !== user.phone) {
          const taken = await User.findOne({ phone: data.phone, _id: { $ne: user._id } }).select('_id');
          if (taken) {
            throw new AppError('Este número de celular ya está registrado por otro usuario', 409);
          }
        }
        phoneVerificationSent = await this.startPhoneVerification(user, data.phone);
      }
    }

    if (data.email !== undefined) {
      const trimmedEmail = data.email.trim().toLowerCase();
      if (trimmedEmail !== (user.email || '')) {
        if (user.emailVerified) {
          throw new AppError('Tu correo ya fue verificado y no se puede editar. Contacta a soporte.', 403);
        }
        if (trimmedEmail !== '') {
          const existingEmail = await User.findOne({ email: trimmedEmail });
          if (existingEmail) {
            throw new AppError('Este correo electrónico ya está registrado por otro usuario', 409);
          }
          user.email = trimmedEmail;
        } else {
          user.email = undefined;
        }
      }
    }

    // Correo del comprobante: sin verificar y sin bloqueo, se sobreescribe
    // libremente. No es la identidad de la cuenta, es solo a dónde llega el
    // recibo de Wompi cuando no hay `email` — y aquí es el único lugar del
    // que sale: el flujo de pago ya no deja editarlo.
    if (data.receiptEmail !== undefined) {
      user.receiptEmail = data.receiptEmail.trim().toLowerCase() || undefined;
    }

    if (data.name) {
      user.name = data.name;
    }

    // Nombre y apellido por separado. `name` sigue siendo el nombre visible
    // en paneles, domiciliario y pedidos, así que se recalcula con ellos en
    // vez de obligar a cada consumidor a juntarlos.
    if (data.firstName !== undefined || data.lastName !== undefined) {
      if (data.firstName !== undefined) user.firstName = data.firstName;
      if (data.lastName !== undefined) user.lastName = data.lastName;
      const full = [user.firstName ?? user.name, user.lastName].filter(Boolean).join(' ').trim();
      if (full.length >= 2) user.name = full.slice(0, 100);
    }

    if (data.documentType !== undefined) {
      if (data.documentType === null) {
        user.documentType = undefined;
        user.documentNumber = undefined;
      } else {
        user.documentType = data.documentType;
        user.documentNumber = data.documentNumber ?? undefined;
      }
    }

    // Una sola vez: decide si puede pedir productos +18, así que dejarla
    // editable haría el bloqueo inútil. Después solo la corrige soporte
    // (`adminService.correctBirthDate`).
    if (data.birthDate !== undefined) {
      const birthDate = parseBirthDate(data.birthDate);
      if (!birthDate) throw new AppError('Fecha de nacimiento inválida', 400);
      if (user.birthDate) {
        if (user.birthDate.getTime() !== birthDate.getTime()) {
          throw new AppError(
            'Tu fecha de nacimiento ya está guardada. Para corregirla, escríbenos.',
            403,
            'BIRTHDATE_LOCKED'
          );
        }
      } else {
        const problem = birthDateProblem(birthDate);
        if (problem) throw new AppError(problem, 400, 'BIRTHDATE_INVALID');
        user.birthDate = birthDate;
      }
    }

    await user.save();

    if (req) {
      await logAudit(req, {
        action: AuditAction.PROFILE_UPDATED,
        entity: 'user',
        entityId: userId,
        description: `Perfil actualizado`,
        metadata: { updatedFields: Object.keys(data), phoneVerificationSent },
      });
    }

    const fresh = (await User.findById(userId))!;
    return { user: fresh, phoneVerificationSent };
  }

  /** Deja `phone` como pendiente y manda el OTP. Devuelve si se envió (o si el enfriamiento lo impidió). */
  private async startPhoneVerification(user: IUser, phone: string): Promise<boolean> {
    const samePending = user.pendingPhone === phone;
    if (samePending && !resendAllowed(user.pendingPhoneOtpExpires)) return false;

    const code = generateOtpCode();
    await User.updateOne({ _id: user._id }, { $set: { pendingPhone: phone, ...otpSetFields(OTP_SLOTS.pendingPhone, code) } });
    user.pendingPhone = phone;
    await whatsappService.sendOTP(phone, code);
    return true;
  }

  /** Reenvía el OTP al celular pendiente. */
  async resendPendingPhoneOtp(userId: string): Promise<{ sent: boolean }> {
    const user = await User.findById(userId).select('+pendingPhoneOtpExpires');
    if (!user) throw new AppError('Usuario no encontrado', 404);
    if (!user.pendingPhone) {
      throw new AppError('No hay un celular pendiente de verificar.', 400, 'NO_PENDING_PHONE');
    }
    return { sent: await this.startPhoneVerification(user, user.pendingPhone) };
  }

  /** Confirma el celular pendiente con su OTP y lo asocia a la cuenta. */
  async verifyPendingPhone(userId: string, otpCode: string, req?: Request): Promise<IUser> {
    const user = await User.findById(userId);
    if (!user) throw new AppError('Usuario no encontrado', 404);
    if (!user.pendingPhone) {
      throw new AppError('No hay un celular pendiente de verificar.', 400, 'NO_PENDING_PHONE');
    }

    const result = await checkOtp(User, { _id: user._id, pendingPhone: user.pendingPhone }, OTP_SLOTS.pendingPhone, otpCode);
    if (result !== 'ok') throw otpError(result);

    const newPhone = user.pendingPhone;
    const taken = await User.findOne({ phone: newPhone, _id: { $ne: user._id } }).select('_id');
    if (taken) {
      await User.updateOne({ _id: user._id }, { $unset: { pendingPhone: 1 } });
      throw new AppError('Este número de celular ya está registrado por otro usuario', 409);
    }

    try {
      await User.updateOne(
        { _id: user._id, pendingPhone: newPhone },
        { $set: { phone: newPhone, phoneVerified: true, isVerified: true }, $unset: { pendingPhone: 1 } }
      );
    } catch (error) {
      if ((error as { code?: number }).code === 11000) {
        throw new AppError('Este número de celular ya está registrado por otro usuario', 409);
      }
      throw error;
    }

    // Cambió la identidad de la cuenta: cualquier otra sesión abierta sale.
    const revoked = await sessionManager.revokeAllSessions(userId, {
      exceptSessionId: req?.sessionId,
      reason: 'contact_changed',
    });

    if (req) {
      await logAudit(req, {
        action: AuditAction.PROFILE_UPDATED,
        entity: 'user',
        entityId: userId,
        severity: AuditSeverity.HIGH,
        description: `Celular verificado y asociado: ${maskPhone(newPhone)}`,
        metadata: { updatedFields: ['phone'], otherSessionsRevoked: revoked },
      });
    }

    return (await User.findById(userId))!;
  }

  /**
   * Manda un código al correo de la cuenta para verificarlo.
   *
   * A diferencia de `sendEmailOTP` —que es el login por correo y termina
   * abriendo una sesión nueva—, esto es para alguien que ya está dentro y
   * solo quiere confirmar su correo desde Mi cuenta.
   */
  async sendAccountEmailOtp(userId: string): Promise<{ sent: boolean }> {
    if (!emailService.isEnabled) {
      throw new AppError('La verificación por correo no está disponible todavía.', 503, 'EMAIL_OTP_DISABLED');
    }
    const user = await User.findById(userId).select('+emailOtpExpires');
    if (!user) throw new AppError('Usuario no encontrado', 404);
    if (!user.email) throw new AppError('Primero agrega un correo a tu cuenta.', 400, 'NO_EMAIL');
    if (user.emailVerified) throw new AppError('Tu correo ya está verificado.', 400, 'EMAIL_ALREADY_VERIFIED');
    if (!resendAllowed(user.emailOtpExpires)) return { sent: false };

    const code = generateOtpCode();
    await User.updateOne({ _id: user._id }, { $set: otpSetFields(OTP_SLOTS.email, code) });
    await emailService.sendOTP(user.email, code);
    return { sent: true };
  }

  /** Confirma el correo de la cuenta con el código de `sendAccountEmailOtp`. */
  async verifyAccountEmail(userId: string, otpCode: string, req?: Request): Promise<IUser> {
    if (!emailService.isEnabled) {
      throw new AppError('La verificación por correo no está disponible todavía.', 503, 'EMAIL_OTP_DISABLED');
    }
    const user = await User.findById(userId);
    if (!user) throw new AppError('Usuario no encontrado', 404);
    if (!user.email) throw new AppError('Primero agrega un correo a tu cuenta.', 400, 'NO_EMAIL');

    // El filtro lleva el correo: si lo cambió entre pedir el código y
    // usarlo, el código del correo anterior ya no sirve.
    const result = await checkOtp(User, { _id: user._id, email: user.email }, OTP_SLOTS.email, otpCode);
    if (result !== 'ok') throw otpError(result);

    await User.updateOne({ _id: user._id, email: user.email }, { $set: { emailVerified: true } });

    if (req) {
      await logAudit(req, {
        action: AuditAction.PROFILE_UPDATED,
        entity: 'user',
        entityId: userId,
        description: `Correo verificado: ${maskEmail(user.email)}`,
        metadata: { updatedFields: ['emailVerified'] },
      });
    }

    return (await User.findById(userId))!;
  }

  /**
   * Sube la foto de perfil a Cloudinary y guarda la URL en el usuario.
   *
   * La transformación es de entrada: Cloudinary recorta a un cuadrado
   * centrado en el rostro (`gravity: 'face'`) y reduce el archivo antes de
   * almacenarlo, así que la app nunca descarga el original de la cámara y
   * la miniatura del perfil siempre encaja sin deformarse. El teléfono ya
   * envía la imagen comprimida; esto es la segunda red de seguridad.
   */
  async uploadAvatar(userId: string, buffer: Buffer, req?: Request): Promise<IUser> {
    const user = await User.findById(userId);
    if (!user) {
      throw new AppError('Usuario no encontrado', 404);
    }

    const url = await new Promise<string>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: 'zipp/avatars',
          resource_type: 'image',
          transformation: [
            { width: 400, height: 400, crop: 'fill', gravity: 'center' },
            { quality: 'auto', fetch_format: 'auto' },
          ],
        },
        (error, result) => {
          if (error || !result) {
            reject(new AppError('No se pudo subir la imagen', 502));
            return;
          }
          resolve(result.secure_url);
        }
      );
      stream.end(buffer);
    });

    user.avatar = url;
    await user.save();

    if (req) {
      await logAudit(req, {
        action: AuditAction.PROFILE_UPDATED,
        entity: 'user',
        entityId: userId,
        description: 'Foto de perfil actualizada',
        metadata: { updatedFields: ['avatar'] },
      });
    }

    return user;
  }

  // ── 2FA ──────────────────────────────────────────────────────────────

  async setup2FA(userId: string, req?: Request, currentPassword?: string): Promise<{
    secret: string;
    /**
     * En el móvil el QR no sirve: no se puede escanear la pantalla del mismo
     * teléfono. El enlace `otpauth://` abre la app autenticadora con la
     * cuenta ya cargada.
     */
    otpauthUrl: string;
    qrCodeDataUrl: string;
    recoveryCodes: string[];
  }> {
    const user = await User.findById(userId).select('+password twoFactorEnabled email phone role');
    if (!user) throw new AppError('Usuario no encontrado', 404);

    if (user.twoFactorEnabled) {
      throw new AppError('2FA ya está habilitado', 400, 'TWO_FACTOR_ALREADY_ENABLED');
    }

    // Cuentas de panel: la sesión sola no basta para enrolar un autenticador.
    // Sin esto, una sesión olvidada en el PC del local (o el refresh token de
    // un exempleado) registraba su propio Google Authenticator, y
    // `verify2FASetup` expulsaba al dueño. 400 y no 401: el interceptor de
    // los paneles trata un 401 como sesión vencida y cerraría la sesión.
    const isPanelAccount = user.role === UserRole.ADMIN || user.role === UserRole.BUSINESS;
    if (isPanelAccount && user.password) {
      const ok = typeof currentPassword === 'string' && currentPassword.length > 0
        && (await user.comparePassword(currentPassword));
      if (!ok) throw new AppError('La contraseña no es correcta', 400, 'REAUTH_INVALID');
    }

    const result = await generateTOTPSecret(user.email || user.phone || user._id.toString());

    // `findById → mutate → save()` sobre este mismo documento es el patrón
    // que ya causó carreras de concurrencia en dinero (ver CLAUDE.md): dos
    // pestañas o un doble-submit pisándose la versión de Mongoose termina en
    // un `VersionError` sin capturar → 500. Un `updateOne` atómico no tiene
    // ese problema: cada petición escribe el suyo sin chocar, y el último en
    // guardar es el que `verify2FASetup` compara. El secreto se guarda
    // cifrado; se devuelve en claro una única vez para que el usuario lo
    // registre en su app autenticadora.
    const update = await User.updateOne(
      { _id: userId, twoFactorEnabled: { $ne: true } },
      { $set: { twoFactorSecret: sealTotpSecret(result.secret), recoveryCodes: hashRecoveryCodes(result.recoveryCodes) } }
    );
    if (update.matchedCount === 0) {
      throw new AppError('2FA ya está habilitado', 400, 'TWO_FACTOR_ALREADY_ENABLED');
    }

    if (req) {
      await logAudit(req, {
        action: AuditAction.TOTP_ENABLED,
        entity: 'user',
        entityId: userId,
        severity: AuditSeverity.HIGH,
        description: 'Configuración 2FA iniciada',
      });
    }

    return {
      secret: result.secret,
      otpauthUrl: result.otpauthUrl,
      qrCodeDataUrl: result.qrCodeDataUrl,
      recoveryCodes: result.recoveryCodes,
    };
  }

  async verify2FASetup(userId: string, token: string, req?: Request): Promise<boolean> {
    const user = await User.findById(userId).select('+twoFactorSecret');
    if (!user || !user.twoFactorSecret) {
      throw new AppError('No hay configuración 2FA pendiente', 400);
    }

    const step = matchTOTPStep(user.twoFactorSecret, token);
    if (step === null) {
      throw new AppError('Código 2FA inválido', 400);
    }

    user.twoFactorEnabled = true;
    user.twoFactorVerifiedAt = new Date();
    // El código usado para activar tampoco sirve para entrar después.
    user.twoFactorLastStep = step;
    await user.save();

    // Las sesiones abiertas antes de activar el 2FA no pasaron por él.
    await sessionManager.revokeAllSessions(userId, { exceptSessionId: req?.sessionId, reason: 'revoke_all' });

    if (req) {
      await logAudit(req, {
        action: AuditAction.TOTP_VERIFIED,
        entity: 'user',
        entityId: userId,
        severity: AuditSeverity.HIGH,
        description: '2FA habilitado exitosamente',
      });
    }
    await recordSecurityEvent({
      userId,
      role: user.role,
      req,
      type: SecurityEventType.SECURITY_SETTINGS_CHANGED,
      reason: 'two_factor_enabled',
      sessionId: req?.sessionId ?? null,
    });

    return true;
  }

  async disable2FA(userId: string, token: string, req?: Request): Promise<boolean> {
    const user = await User.findById(userId);
    if (!user) throw new AppError('Usuario no encontrado', 404);

    if (!user.twoFactorEnabled) {
      throw new AppError('2FA no está habilitado', 400);
    }

    // Donde el 2FA es obligatorio, quitarlo no tiene sentido: la siguiente
    // petición lo exigiría de nuevo, y mientras tanto el socket ya abierto
    // seguiría recibiendo pedidos en vivo. Se pierde el celular → reset desde
    // el panel admin.
    if (twoFactorSetupPending({ role: user.role, twoFactorEnabled: false })) {
      throw new AppError('La verificación en dos pasos es obligatoria para tu cuenta', 409, 'TWO_FACTOR_REQUIRED');
    }

    // TOTP (sin repetición) o código de recuperación (se consume).
    const isValid = await verifySecondFactor(user._id, token);
    if (!isValid) {
      throw new AppError('Código de verificación inválido', 400);
    }

    await User.updateOne(
      { _id: user._id },
      {
        $set: { twoFactorEnabled: false },
        $unset: { twoFactorSecret: 1, recoveryCodes: 1, twoFactorVerifiedAt: 1, twoFactorLastStep: 1 },
      }
    );

    if (req) {
      await logAudit(req, {
        action: AuditAction.TOTP_DISABLED,
        entity: 'user',
        entityId: userId,
        severity: AuditSeverity.HIGH,
        description: '2FA deshabilitado',
      });
    }
    await recordSecurityEvent({
      userId,
      role: req?.user?.role,
      req,
      type: SecurityEventType.SECURITY_SETTINGS_CHANGED,
      reason: 'two_factor_disabled',
      sessionId: req?.sessionId ?? null,
    });

    return true;
  }

  // ── Sesiones ─────────────────────────────────────────────────────────

  /** Si la cuenta tiene contraseña (las creadas con Google/Apple no). */
  async hasPassword(userId: string): Promise<boolean> {
    return !!(await User.exists({ _id: userId, password: { $exists: true, $nin: [null, ''] } }));
  }

  async getActiveSessions(userId: string, currentSessionId?: string) {
    const sessions = await sessionManager.getActiveSessions(userId);
    return sessions.map((s) => ({ ...s, current: !!currentSessionId && String(s._id) === currentSessionId }));
  }

  async revokeSession(sessionId: string, userId: string, req?: Request) {
    const result = await sessionManager.revokeSession(sessionId, userId, 'user_revoked');

    if (req && result) {
      await logAudit(req, {
        action: AuditAction.SESSION_REVOKED,
        entity: 'session',
        entityId: sessionId,
        description: 'Sesión revocada remotamente',
      });
    }
    if (result) {
      await recordSecurityEvent({
        userId,
        role: req?.user?.role,
        req,
        type: SecurityEventType.REMOTE_LOGOUT,
        sessionId,
        reason: 'user_revoked',
        metadata: { count: 1, fromSessionId: req?.sessionId ?? null },
      });
    }

    return result;
  }

  async revokeAllSessions(userId: string, currentRefreshToken?: string, req?: Request) {
    const count = await sessionManager.revokeAllSessions(userId, {
      exceptSessionId: req?.sessionId,
      exceptRefreshToken: currentRefreshToken,
      reason: 'revoke_all',
    });

    if (req) {
      await logAudit(req, {
        action: AuditAction.SESSION_REVOKED_ALL,
        entity: 'user',
        entityId: userId,
        severity: AuditSeverity.HIGH,
        description: `${count} sesiones revocadas`,
      });
    }
    if (count > 0) {
      await recordSecurityEvent({
        userId,
        role: req?.user?.role,
        req,
        type: SecurityEventType.REMOTE_LOGOUT,
        sessionId: req?.sessionId ?? null,
        reason: 'revoke_all',
        metadata: { count },
      });
    }

    return count;
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string, req?: Request): Promise<void> {
    const user = await User.findById(userId).select('+password');
    if (!user) throw new AppError('Usuario no encontrado', 404);

    const isMatch = typeof currentPassword === 'string' && (await user.comparePassword(currentPassword));
    if (!isMatch) {
      throw new AppError('Contraseña actual incorrecta', 401);
    }

    const passwordCheck = validatePasswordComplexity(newPassword);
    if (!passwordCheck.valid) {
      throw new AppError(passwordCheck.errors.join('. '), 400);
    }

    user.password = newPassword;
    // Sale del estado "contraseña temporal de admin" (S10) en cuanto la
    // persona pone la suya.
    user.mustChangePassword = false;
    user.passwordExpiresAt = undefined;
    await user.save();

    // Revoke all sessions: el cambio es la reacción de quien cree que le
    // robaron la cuenta.
    const revokedCount = await sessionManager.revokeAllSessions(userId, { reason: 'password_changed' });
    await recordSecurityEvent({
      userId,
      role: user.role,
      req,
      type: SecurityEventType.PASSWORD_CHANGED,
      reason: 'password_changed',
      sessionId: req?.sessionId ?? null,
      metadata: { how: 'change', sessionsRevoked: revokedCount },
    });

    if (req) {
      await logAudit(req, {
        action: AuditAction.PASSWORD_CHANGE,
        entity: 'user',
        entityId: userId,
        severity: AuditSeverity.HIGH,
        description: 'Contraseña cambiada exitosamente',
      });
    }
  }

  // ── Eliminación de la cuenta ─────────────────────────────────────────

  /**
   * Primer paso para una cuenta sin contraseña (creada con Google/Apple):
   * manda un OTP al celular verificado para confirmar la eliminación.
   */
  async requestAccountDeletionOtp(userId: string): Promise<{ channel: 'whatsapp' }> {
    const user = await User.findById(userId).select('+otpExpires');
    if (!user) throw new AppError('Usuario no encontrado', 404);
    if (!user.phone || !user.phoneVerified) {
      throw new AppError('Verifica tu celular antes de eliminar la cuenta.', 400, 'PHONE_NOT_VERIFIED');
    }

    const blocker = await deletionBlocker(user);
    if (blocker) throw new AppError(blocker, 409, 'ACCOUNT_DELETION_BLOCKED');

    if (resendAllowed(user.otpExpires)) {
      const code = generateOtpCode();
      await User.updateOne({ _id: user._id }, { $set: otpSetFields(OTP_SLOTS.phone, code) });
      await whatsappService.sendOTP(user.phone, code);
    }
    return { channel: 'whatsapp' };
  }

  /**
   * Reautenticación para acciones de alto riesgo (borrar la cuenta, cambiar
   * la cuenta de pago): la contraseña si la cuenta tiene una, o el OTP del
   * celular si no. Un token de acceso robado no basta.
   */
  async assertReauth(userId: string, proof: { password?: string; otpCode?: string }): Promise<void> {
    const user = await User.findById(userId).select('+password');
    if (!user) throw new AppError('Usuario no encontrado', 404);

    if (user.password) {
      if (!proof.password || !(await user.comparePassword(proof.password))) {
        throw new AppError('Contraseña incorrecta', 401, 'REAUTH_FAILED');
      }
    } else {
      if (!proof.otpCode) throw new AppError('Confirma con el código que te enviamos.', 400, 'REAUTH_REQUIRED');
      const result = await checkOtp(User, { _id: user._id }, OTP_SLOTS.phone, proof.otpCode);
      if (result !== 'ok') throw otpError(result);
    }
  }

  /**
   * Pide el OTP de reautenticación para cuentas sin contraseña (solo entran
   * con OAuth). Mismo canal y mismo espaciado que el resto de OTP.
   */
  async requestReauthOtp(userId: string): Promise<{ channel: 'whatsapp' } | { channel: 'password' }> {
    const user = await User.findById(userId).select('+password +otpExpires');
    if (!user) throw new AppError('Usuario no encontrado', 404);
    // Con contraseña no hay OTP que pedir: no se manda un código que no se usará.
    if (user.password) return { channel: 'password' };
    if (!user.phone || !user.phoneVerified) {
      throw new AppError('Verifica tu celular para confirmar este cambio.', 400, 'PHONE_NOT_VERIFIED');
    }
    if (resendAllowed(user.otpExpires)) {
      const code = generateOtpCode();
      await User.updateOne({ _id: user._id }, { $set: otpSetFields(OTP_SLOTS.phone, code) });
      await whatsappService.sendOTP(user.phone, code);
    }
    return { channel: 'whatsapp' };
  }

  /**
   * Elimina (anonimiza) la propia cuenta. Exige reautenticación: la
   * contraseña si la cuenta tiene una, o el OTP del celular si no.
   */
  async deleteOwnAccount(
    userId: string,
    proof: { password?: string; otpCode?: string },
    req?: Request
  ): Promise<void> {
    await this.assertReauth(userId, proof);

    await anonymizeAccount(userId);

    if (req) {
      await logAudit(req, {
        action: AuditAction.DATA_REQUEST_RESOLVED,
        entity: 'user',
        entityId: userId,
        severity: AuditSeverity.HIGH,
        description: 'Cuenta eliminada por su titular (datos anonimizados)',
        metadata: { selfService: true },
      });
    }
  }
}

export const authService = new AuthService();
