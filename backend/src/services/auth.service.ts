import { Request } from 'express';
import crypto from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import { User, IUser, PendingRegistration } from '../models';
import { Session } from '../security/sessions';
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
  generateOTP,
  getOTPExpiry,
} from '../utils';
import {
  sessionManager,
  generateDeviceId,
  checkBruteForce,
  recordFailedAttempt,
  clearAttempts,
  logAudit,
  logSystemAudit,
  AuditAction,
  AuditSeverity,
  antiFraudService,
  generateTOTPSecret,
  verifyTOTP,
  hashRecoveryCodes,
  verifyRecoveryCode,
  validatePasswordComplexity,
} from '../security';

interface RegisterInput {
  name: string;
  phone: string;
  email?: string;
  password: string;
  role: string;
}

interface LoginInput {
  phone: string;
  password: string;
  deviceId?: string;
  totpToken?: string;
}

interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

function getClientIP(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

// Un solo cliente valida tokens emitidos para cualquiera de los client IDs
// registrados (web, iOS, Android) — verifyIdToken acepta un arreglo de
// audiencias válidas.
const googleClient = new OAuth2Client();

export class AuthService {
  async loginWithGoogle(idToken: string, req?: Request): Promise<{
    user: IUser;
    tokens: AuthTokens;
    needsPhone: boolean;
  }> {
    const audiences = [
      config.google.webClientId,
      config.google.iosClientId,
      config.google.androidClientId,
    ].filter(Boolean);

    if (audiences.length === 0) {
      throw new AppError('Inicio de sesión con Google no está configurado', 500);
    }

    let payload;
    try {
      const ticket = await googleClient.verifyIdToken({ idToken, audience: audiences });
      payload = ticket.getPayload();
    } catch {
      throw new AppError('Token de Google inválido', 401);
    }

    if (!payload || !payload.sub || !payload.email || !payload.email_verified) {
      throw new AppError('No pudimos verificar tu cuenta de Google', 401);
    }

    let user = await User.findOne({ googleId: payload.sub }).select('+googleId');

    if (!user) {
      // Vincula con una cuenta existente que use el mismo correo antes de
      // crear una nueva, para no duplicar al usuario.
      user = await User.findOne({ email: payload.email.toLowerCase() });

      if (user) {
        user.googleId = payload.sub;
        await user.save();
      } else {
        user = await User.create({
          name: payload.name || payload.email.split('@')[0],
          email: payload.email.toLowerCase(),
          avatar: payload.picture,
          googleId: payload.sub,
          role: UserRole.CLIENT,
          // Sin celular todavía: la app lo pide y lo verifica por OTP justo
          // después de este login.
          isVerified: false,
        });
      }
    }

    if (!user.isActive) {
      throw new AppError('Tu cuenta está desactivada', 403);
    }

    const tokens = this.generateTokens(user);
    user.refreshToken = tokens.refreshToken;
    user.lastLoginAt = new Date();
    await user.save();

    if (req) {
      const ip = getClientIP(req);
      const ua = req.headers['user-agent'] || 'unknown';
      await sessionManager.createSession(user._id.toString(), tokens.refreshToken, ip, ua);

      await logAudit(req, {
        action: AuditAction.LOGIN_SUCCESS,
        entity: 'user',
        entityId: user._id.toString(),
        description: `Login con Google exitoso: ${user.email}`,
        metadata: { provider: 'google' },
      });
    }

    return { user, tokens, needsPhone: !user.phone };
  }

  async register(input: RegisterInput, req?: Request): Promise<{ user: IUser; tokens: AuthTokens }> {
    const existing = await User.findOne({ phone: input.phone });
    if (existing) {
      throw new AppError('Este número de celular ya está registrado', 409);
    }

    const email = input.email && input.email.trim() !== '' ? input.email.trim().toLowerCase() : undefined;

    if (email) {
      const emailExists = await User.findOne({ email });
      if (emailExists) {
        throw new AppError('Este email ya está registrado', 409);
      }
    }

    // Validate password complexity for business and admin roles
    if (input.role === 'admin' || input.role === 'business') {
      const passwordCheck = validatePasswordComplexity(input.password);
      if (!passwordCheck.valid) {
        throw new AppError(passwordCheck.errors.join('. '), 400);
      }
    }

    return this.createUserAndSession({ ...input, email }, req);
  }

  /**
   * Crea el `User`, genera sus tokens y abre sesión. Lo comparten `register`
   * (celular sin verificar previamente) y `completeRegistration` (celular ya
   * confirmado por OTP en el flujo de 3 pasos) — la creación de la cuenta es
   * idéntica en ambos casos, solo cambia cómo se llegó hasta aquí.
   */
  private async createUserAndSession(
    input: RegisterInput,
    req?: Request
  ): Promise<{ user: IUser; tokens: AuthTokens }> {
    const user = await User.create({
      name: input.name,
      phone: input.phone,
      email: input.email,
      password: input.password,
      role: input.role as UserRole,
      isVerified: true,
    });

    const tokens = this.generateTokens(user);
    user.refreshToken = tokens.refreshToken;
    await user.save();

    if (req) {
      const ip = getClientIP(req);
      const ua = req.headers['user-agent'] || 'unknown';
      await sessionManager.createSession(user._id.toString(), tokens.refreshToken, ip, ua);

      // Anti-fraud check
      const deviceId = generateDeviceId(ua, ip);
      await antiFraudService.checkMultipleAccounts(user._id.toString(), deviceId, ip);

      // Audit log
      await logAudit(req, {
        action: AuditAction.REGISTER,
        entity: 'user',
        entityId: user._id.toString(),
        description: `Nuevo usuario registrado: ${user.phone} (${input.role})`,
        metadata: { role: input.role },
      });
    }

    return { user, tokens };
  }

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
   * tiene cuenta. Como no existe un `User` para guardar el código —a
   * diferencia de `sendOTP`, pensado para reenvíos a cuentas ya creadas—
   * vive en `PendingRegistration`, que se autodestruye si nadie vuelve.
   */
  async sendRegistrationOTP(phone: string, req?: Request): Promise<void> {
    const existing = await User.findOne({ phone });
    if (existing) {
      throw new AppError('Este número de celular ya está registrado', 409);
    }

    const otpCode = generateOTP();
    const otpExpires = getOTPExpiry();

    await PendingRegistration.findOneAndUpdate(
      { phone },
      { phone, otpCode, otpExpires, verified: false, verifiedUntil: undefined },
      { upsert: true, setDefaultsOnInsert: true }
    );

    if (req) {
      await logAudit(req, {
        action: AuditAction.OTP_SENT,
        entity: 'user',
        entityId: phone,
        description: `OTP de registro enviado a ${phone}`,
      });
    }

    await whatsappService.sendOTP(phone, otpCode);
  }

  /**
   * Paso 2: confirma el código y marca el celular como verificado por un
   * rato — no emite tokens todavía porque no hay cuenta que abrir, solo el
   * visto bueno para que el paso 3 pueda crearla.
   */
  async verifyRegistrationOTP(phone: string, otpCode: string, req?: Request): Promise<void> {
    const pending = await PendingRegistration.findOne({ phone }).select('+otpCode +otpExpires');
    if (!pending || !pending.otpCode || !pending.otpExpires) {
      throw new AppError('No hay un código pendiente para este celular', 400);
    }

    if (new Date() > pending.otpExpires) {
      throw new AppError('OTP expirado', 400);
    }

    if (pending.otpCode !== otpCode) {
      if (req) {
        await logAudit(req, {
          action: AuditAction.OTP_FAILED,
          entity: 'user',
          entityId: phone,
          severity: AuditSeverity.MEDIUM,
          description: `OTP de registro inválido para ${phone}`,
        });
      }
      throw new AppError('OTP inválido', 400);
    }

    pending.verified = true;
    pending.verifiedUntil = new Date(Date.now() + 15 * 60 * 1000);
    pending.otpCode = undefined;
    pending.otpExpires = undefined;
    await pending.save();
  }

  /**
   * Paso 3: con el celular ya verificado, pide lo que falta y crea la
   * cuenta de una vez, ya confirmada — no hace falta un cuarto paso de OTP
   * después, porque ese "estilo Rappi" es justo el que reemplaza este flujo.
   */
  async completeRegistration(
    phone: string, name: string, password: string, req?: Request
  ): Promise<{ user: IUser; tokens: AuthTokens }> {
    const pending = await PendingRegistration.findOne({ phone });
    if (!pending || !pending.verified || !pending.verifiedUntil || new Date() > pending.verifiedUntil) {
      throw new AppError('Verifica tu celular primero', 400);
    }

    const existing = await User.findOne({ phone });
    if (existing) {
      throw new AppError('Este número de celular ya está registrado', 409);
    }

    const result = await this.createUserAndSession(
      { name, phone, password, role: 'client' },
      req
    );

    await pending.deleteOne();

    return result;
  }

  async login(input: LoginInput, req?: Request): Promise<{
    user: IUser;
    tokens: AuthTokens;
    requiresTOTP?: boolean;
    isNewDevice?: boolean;
  }> {
    const ip = req ? getClientIP(req) : 'unknown';

    // Check brute force protection
    const bruteCheck = await checkBruteForce(ip, input.phone);
    if (!bruteCheck.allowed) {
      if (req) {
        await logAudit(req, {
          action: AuditAction.BRUTE_FORCE_DETECTED,
          entity: 'auth',
          severity: AuditSeverity.HIGH,
          description: `Brute force detectado para ${input.phone}: ${bruteCheck.reason}`,
          metadata: { phone: input.phone, retryAfterMs: bruteCheck.retryAfterMs },
        });
      }
      throw new AppError(bruteCheck.reason || 'Demasiados intentos. Intenta más tarde.', 429);
    }

    const user = await User.findOne({ phone: input.phone })
      .select('+password +twoFactorEnabled +twoFactorSecret +failedLoginAttempts +lockedUntil +lastLoginIp');

    if (!user) {
      await recordFailedAttempt(ip, input.phone);
      throw new AppError('Credenciales inválidas', 401);
    }

    // Check account lock
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const remainingMs = user.lockedUntil.getTime() - Date.now();
      if (req) {
        await logAudit(req, {
          action: AuditAction.ACCOUNT_LOCKED,
          entity: 'user',
          entityId: user._id.toString(),
          severity: AuditSeverity.MEDIUM,
          description: `Intento de login en cuenta bloqueada: ${input.phone}`,
        });
      }
      throw new AppError(
        `Cuenta bloqueada temporalmente. Intenta en ${Math.ceil(remainingMs / 60000)} minutos.`,
        423
      );
    }

    const isMatch = await user.comparePassword(input.password);
    if (!isMatch) {
      // Record failed attempt
      user.failedLoginAttempts = (user.failedLoginAttempts || 0) + 1;

      // Lock after 5 failed attempts
      if (user.failedLoginAttempts >= 5) {
        user.lockedUntil = new Date(Date.now() + 15 * 60 * 1000); // 15 min lock
        await user.save();

        if (req) {
          await logAudit(req, {
            action: AuditAction.ACCOUNT_LOCKED,
            entity: 'user',
            entityId: user._id.toString(),
            severity: AuditSeverity.HIGH,
            description: `Cuenta bloqueada por ${user.failedLoginAttempts} intentos fallidos`,
          });
        }
        throw new AppError('Cuenta bloqueada por múltiples intentos fallidos. Intenta en 15 minutos.', 423);
      }

      await user.save();
      await recordFailedAttempt(ip, input.phone);

      if (req) {
        await logAudit(req, {
          action: AuditAction.LOGIN_FAILED,
          entity: 'user',
          entityId: user._id.toString(),
          severity: AuditSeverity.MEDIUM,
          description: `Login fallido para ${input.phone} (intento ${user.failedLoginAttempts})`,
        });
      }

      throw new AppError('Credenciales inválidas', 401);
    }

    if (!user.isActive) {
      throw new AppError('Tu cuenta está desactivada', 403);
    }

    // Check 2FA requirement
    if (user.twoFactorEnabled && user.twoFactorSecret) {
      if (!input.totpToken) {
        return {
          user,
          tokens: { accessToken: '', refreshToken: '' },
          requiresTOTP: true,
        };
      }

      const isValidTOTP = verifyTOTP(user.twoFactorSecret, input.totpToken);
      if (!isValidTOTP) {
        if (req) {
          await logAudit(req, {
            action: AuditAction.TOTP_FAILED,
            entity: 'user',
            entityId: user._id.toString(),
            severity: AuditSeverity.MEDIUM,
            description: `Verificación 2FA fallida para ${input.phone}`,
          });
        }
        throw new AppError('Código 2FA inválido', 401);
      }
    }

    // Reset failed attempts on successful login
    user.failedLoginAttempts = 0;
    user.lockedUntil = undefined;
    user.lastLoginAt = new Date();
    user.lastLoginIp = ip;
    user.isVerified = true;

    await clearAttempts(ip, input.phone);

    const tokens = this.generateTokens(user);
    user.refreshToken = tokens.refreshToken;
    await user.save();

    // Create session & check for new device
    let isNewDevice = false;
    if (req) {
      const ua = req.headers['user-agent'] || 'unknown';
      const result = await sessionManager.createSession(
        user._id.toString(),
        tokens.refreshToken,
        ip,
        ua,
        input.deviceId
      );
      isNewDevice = result.isNewDevice;

      if (isNewDevice) {
        await logAudit(req, {
          action: AuditAction.NEW_DEVICE_DETECTED,
          entity: 'user',
          entityId: user._id.toString(),
          severity: AuditSeverity.MEDIUM,
          description: `Nuevo dispositivo detectado para ${input.phone}`,
          metadata: { deviceInfo: result.session.deviceInfo },
        });
      }

      // Anti-fraud checks
      const deviceId = generateDeviceId(ua, ip, input.deviceId);
      const fraudCheck = await antiFraudService.checkMultipleAccounts(
        user._id.toString(),
        deviceId,
        ip
      );
      if (fraudCheck.suspicious && fraudCheck.alert) {
        await antiFraudService.createAlert(fraudCheck.alert);
      }

      await logAudit(req, {
        action: AuditAction.LOGIN_SUCCESS,
        entity: 'user',
        entityId: user._id.toString(),
        description: `Login exitoso: ${input.phone}`,
        metadata: { isNewDevice, role: user.role },
      });
    }

    return { user, tokens, isNewDevice };
  }

  async refreshTokens(refreshToken: string, req?: Request): Promise<AuthTokens> {
    const decoded = verifyRefreshToken(refreshToken);
    const user = await User.findById(decoded.id).select('+refreshToken');

    if (!user || user.refreshToken !== refreshToken) {
      throw new AppError('Refresh token inválido', 401);
    }

    const tokens = this.generateTokens(user);

    // Rotate refresh token in session
    if (req) {
      const rotated = await sessionManager.rotateRefreshToken(refreshToken, tokens.refreshToken);
      if (!rotated) {
        // Token reuse detected - all sessions already revoked by rotateRefreshToken
        await logAudit(req, {
          action: AuditAction.SUSPICIOUS_ACTIVITY,
          entity: 'session',
          entityId: user._id.toString(),
          severity: AuditSeverity.CRITICAL,
          description: `Reuse de refresh token detectado para usuario ${user.phone}. Todas las sesiones revocadas.`,
        });
        throw new AppError('Sesión comprometida. Todas las sesiones han sido cerradas por seguridad.', 401);
      }
    }

    user.refreshToken = tokens.refreshToken;
    await user.save();

    if (req) {
      await logAudit(req, {
        action: AuditAction.TOKEN_REFRESH,
        entity: 'session',
        entityId: user._id.toString(),
        description: 'Token renovado exitosamente',
      });
    }

    return tokens;
  }

  async sendOTP(phone: string, req?: Request): Promise<void> {
    const user = await User.findOne({ phone }).select('+otpCode +otpExpires');
    if (!user) {
      throw new AppError('Usuario no encontrado', 404);
    }

    const otpCode = generateOTP();
    const otpExpires = getOTPExpiry();

    user.otpCode = otpCode;
    user.otpExpires = otpExpires;
    await user.save();

    if (req) {
      await logAudit(req, {
        action: AuditAction.OTP_SENT,
        entity: 'user',
        entityId: user._id.toString(),
        description: `OTP enviado a ${phone}`,
      });
    }

    await whatsappService.sendOTP(phone, otpCode);
  }

  async verifyOTP(phone: string, otpCode: string, req?: Request): Promise<{ user: IUser; tokens: AuthTokens }> {
    const user = await User.findOne({ phone }).select('+otpCode +otpExpires');
    if (!user) {
      throw new AppError('Usuario no encontrado', 404);
    }

    if (!user.otpCode || !user.otpExpires) {
      throw new AppError('No hay OTP pendiente', 400);
    }

    if (new Date() > user.otpExpires) {
      if (req) {
        await logAudit(req, {
          action: AuditAction.OTP_FAILED,
          entity: 'user',
          entityId: user._id.toString(),
          severity: AuditSeverity.LOW,
          description: `OTP expirado para ${phone}`,
        });
      }
      throw new AppError('OTP expirado', 400);
    }

    if (user.otpCode !== otpCode) {
      if (req) {
        await logAudit(req, {
          action: AuditAction.OTP_FAILED,
          entity: 'user',
          entityId: user._id.toString(),
          severity: AuditSeverity.MEDIUM,
          description: `OTP inválido para ${phone}`,
        });
      }
      throw new AppError('OTP inválido', 400);
    }

    user.isVerified = true;
    // Login por WhatsApp OTP exitoso: el teléfono queda confirmado y se
    // bloquea para edición por el propio usuario (ver updateProfile).
    user.phoneVerified = true;
    user.otpCode = undefined;
    user.otpExpires = undefined;

    const tokens = this.generateTokens(user);
    user.refreshToken = tokens.refreshToken;
    await user.save();

    if (req) {
      await logAudit(req, {
        action: AuditAction.OTP_VERIFIED,
        entity: 'user',
        entityId: user._id.toString(),
        description: `OTP verificado para ${phone}`,
        metadata: { channel: 'phone' },
      });

      const ip = getClientIP(req);
      const ua = req.headers['user-agent'] || 'unknown';
      await sessionManager.createSession(user._id.toString(), tokens.refreshToken, ip, ua);
    }

    return { user, tokens };
  }

  async sendEmailOTP(email: string, req?: Request): Promise<void> {
    const normalizedEmail = email.trim().toLowerCase();
    const user = await User.findOne({ email: normalizedEmail }).select('+emailOtpCode +emailOtpExpires');
    if (!user) {
      throw new AppError('Usuario no encontrado', 404);
    }

    const otpCode = generateOTP();
    const otpExpires = getOTPExpiry();

    user.emailOtpCode = otpCode;
    user.emailOtpExpires = otpExpires;
    await user.save();

    if (req) {
      await logAudit(req, {
        action: AuditAction.OTP_SENT,
        entity: 'user',
        entityId: user._id.toString(),
        description: `OTP enviado a ${normalizedEmail}`,
        metadata: { channel: 'email' },
      });
    }

    await emailService.sendOTP(normalizedEmail, otpCode);
  }

  async verifyEmailOTP(email: string, otpCode: string, req?: Request): Promise<{ user: IUser; tokens: AuthTokens }> {
    const normalizedEmail = email.trim().toLowerCase();
    const user = await User.findOne({ email: normalizedEmail }).select('+emailOtpCode +emailOtpExpires');
    if (!user) {
      throw new AppError('Usuario no encontrado', 404);
    }

    if (!user.emailOtpCode || !user.emailOtpExpires) {
      throw new AppError('No hay OTP pendiente', 400);
    }

    if (new Date() > user.emailOtpExpires) {
      if (req) {
        await logAudit(req, {
          action: AuditAction.OTP_FAILED,
          entity: 'user',
          entityId: user._id.toString(),
          severity: AuditSeverity.LOW,
          description: `OTP expirado para ${normalizedEmail}`,
          metadata: { channel: 'email' },
        });
      }
      throw new AppError('OTP expirado', 400);
    }

    if (user.emailOtpCode !== otpCode) {
      if (req) {
        await logAudit(req, {
          action: AuditAction.OTP_FAILED,
          entity: 'user',
          entityId: user._id.toString(),
          severity: AuditSeverity.MEDIUM,
          description: `OTP inválido para ${normalizedEmail}`,
          metadata: { channel: 'email' },
        });
      }
      throw new AppError('OTP inválido', 400);
    }

    user.isVerified = true;
    // Login por OTP de correo exitoso: el correo queda confirmado y se
    // bloquea para edición por el propio usuario (ver updateProfile).
    user.emailVerified = true;
    user.emailOtpCode = undefined;
    user.emailOtpExpires = undefined;

    const tokens = this.generateTokens(user);
    user.refreshToken = tokens.refreshToken;
    await user.save();

    if (req) {
      await logAudit(req, {
        action: AuditAction.OTP_VERIFIED,
        entity: 'user',
        entityId: user._id.toString(),
        description: `OTP verificado para ${normalizedEmail}`,
        metadata: { channel: 'email' },
      });

      const ip = getClientIP(req);
      const ua = req.headers['user-agent'] || 'unknown';
      await sessionManager.createSession(user._id.toString(), tokens.refreshToken, ip, ua);
    }

    return { user, tokens };
  }

  async logout(userId: string, req?: Request): Promise<void> {
    await User.findByIdAndUpdate(userId, { refreshToken: null });

    // Revoke current session
    if (req) {
      const refreshToken = req.body?.refreshToken;
      if (refreshToken) {
        const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
        await Session.findOneAndUpdate({ tokenHash }, { isActive: false });
      }

      await logAudit(req, {
        action: AuditAction.LOGOUT,
        entity: 'user',
        entityId: userId,
        description: 'Sesión cerrada',
      });
    }
  }

  async resetPassword(phone: string, otpCode: string, newPassword: string, req?: Request): Promise<{ user: IUser; tokens: AuthTokens }> {
    const user = await User.findOne({ phone }).select('+otpCode +otpExpires +password');
    if (!user) {
      throw new AppError('Usuario no encontrado', 404);
    }

    if (!user.otpCode || !user.otpExpires) {
      throw new AppError('No hay OTP pendiente', 400);
    }

    if (new Date() > user.otpExpires) {
      throw new AppError('OTP expirado', 400);
    }

    if (user.otpCode !== otpCode) {
      throw new AppError('OTP inválido', 400);
    }

    // Validate password complexity
    const passwordCheck = validatePasswordComplexity(newPassword);
    if (!passwordCheck.valid) {
      throw new AppError(passwordCheck.errors.join('. '), 400);
    }

    user.password = newPassword;
    user.isVerified = true;
    user.otpCode = undefined;
    user.otpExpires = undefined;
    user.failedLoginAttempts = 0;
    user.lockedUntil = undefined;

    const tokens = this.generateTokens(user);
    user.refreshToken = tokens.refreshToken;
    await user.save();

    // Revoke all existing sessions (password changed)
    await sessionManager.revokeAllSessions(user._id.toString());

    if (req) {
      await logAudit(req, {
        action: AuditAction.PASSWORD_RESET,
        entity: 'user',
        entityId: user._id.toString(),
        severity: AuditSeverity.HIGH,
        description: `Contraseña restablecida para ${phone}`,
      });

      const ip = getClientIP(req);
      const ua = req.headers['user-agent'] || 'unknown';
      await sessionManager.createSession(user._id.toString(), tokens.refreshToken, ip, ua);
    }

    return { user, tokens };
  }

  async updateProfile(userId: string, data: { name?: string; email?: string; phone?: string }, req?: Request): Promise<IUser> {
    const user = await User.findById(userId);
    if (!user) {
      throw new AppError('Usuario no encontrado', 404);
    }

    if (data.phone && data.phone !== user.phone) {
      if (user.phoneVerified) {
        throw new AppError('Tu número de celular ya fue verificado y no se puede editar. Contacta a soporte.', 403);
      }
      const existing = await User.findOne({ phone: data.phone });
      if (existing) {
        throw new AppError('Este número de celular ya está registrado por otro usuario', 409);
      }
      user.phone = data.phone;
      user.isVerified = false;
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

    if (data.name) {
      user.name = data.name;
    }

    await user.save();

    if (req) {
      await logAudit(req, {
        action: AuditAction.PROFILE_UPDATED,
        entity: 'user',
        entityId: userId,
        description: `Perfil actualizado`,
        metadata: { updatedFields: Object.keys(data) },
      });
    }

    return user;
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

  // ── 2FA Methods ──

  async setup2FA(userId: string, req?: Request): Promise<{
    secret: string;
    qrCodeDataUrl: string;
    recoveryCodes: string[];
  }> {
    const user = await User.findById(userId).select('+twoFactorSecret');
    if (!user) throw new AppError('Usuario no encontrado', 404);

    if (user.twoFactorEnabled) {
      throw new AppError('2FA ya está habilitado', 400);
    }

    const result = await generateTOTPSecret(user.email || user.phone || user._id.toString());

    // Store secret (not yet enabled until verified)
    user.twoFactorSecret = result.secret;
    user.recoveryCodes = hashRecoveryCodes(result.recoveryCodes);
    await user.save();

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
      qrCodeDataUrl: result.qrCodeDataUrl,
      recoveryCodes: result.recoveryCodes,
    };
  }

  async verify2FASetup(userId: string, token: string, req?: Request): Promise<boolean> {
    const user = await User.findById(userId).select('+twoFactorSecret');
    if (!user || !user.twoFactorSecret) {
      throw new AppError('No hay configuración 2FA pendiente', 400);
    }

    const isValid = verifyTOTP(user.twoFactorSecret, token);
    if (!isValid) {
      throw new AppError('Código 2FA inválido', 400);
    }

    user.twoFactorEnabled = true;
    user.twoFactorVerifiedAt = new Date();
    await user.save();

    if (req) {
      await logAudit(req, {
        action: AuditAction.TOTP_VERIFIED,
        entity: 'user',
        entityId: userId,
        severity: AuditSeverity.HIGH,
        description: '2FA habilitado exitosamente',
      });
    }

    return true;
  }

  async disable2FA(userId: string, token: string, req?: Request): Promise<boolean> {
    const user = await User.findById(userId).select('+twoFactorSecret +recoveryCodes');
    if (!user) throw new AppError('Usuario no encontrado', 404);

    if (!user.twoFactorEnabled) {
      throw new AppError('2FA no está habilitado', 400);
    }

    // Verify with TOTP or recovery code
    let isValid = false;
    if (user.twoFactorSecret) {
      isValid = verifyTOTP(user.twoFactorSecret, token);
    }

    if (!isValid && user.recoveryCodes) {
      const recoveryCheck = verifyRecoveryCode(token, user.recoveryCodes);
      isValid = recoveryCheck.valid;
      if (isValid) {
        user.recoveryCodes.splice(recoveryCheck.index, 1);
      }
    }

    if (!isValid) {
      throw new AppError('Código de verificación inválido', 400);
    }

    user.twoFactorEnabled = false;
    user.twoFactorSecret = undefined;
    user.recoveryCodes = undefined;
    user.twoFactorVerifiedAt = undefined;
    await user.save();

    if (req) {
      await logAudit(req, {
        action: AuditAction.TOTP_DISABLED,
        entity: 'user',
        entityId: userId,
        severity: AuditSeverity.HIGH,
        description: '2FA deshabilitado',
      });
    }

    return true;
  }

  // ── Session Management ──

  async getActiveSessions(userId: string) {
    return sessionManager.getActiveSessions(userId);
  }

  async revokeSession(sessionId: string, userId: string, req?: Request) {
    const result = await sessionManager.revokeSession(sessionId, userId);

    if (req && result) {
      await logAudit(req, {
        action: AuditAction.SESSION_REVOKED,
        entity: 'session',
        entityId: sessionId,
        description: 'Sesión revocada remotamente',
      });
    }

    return result;
  }

  async revokeAllSessions(userId: string, currentRefreshToken?: string, req?: Request) {
    const count = await sessionManager.revokeAllSessions(userId, currentRefreshToken);

    if (req) {
      await logAudit(req, {
        action: AuditAction.SESSION_REVOKED_ALL,
        entity: 'user',
        entityId: userId,
        severity: AuditSeverity.HIGH,
        description: `${count} sesiones revocadas`,
      });
    }

    return count;
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string, req?: Request): Promise<void> {
    const user = await User.findById(userId).select('+password');
    if (!user) throw new AppError('Usuario no encontrado', 404);

    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) {
      throw new AppError('Contraseña actual incorrecta', 401);
    }

    const passwordCheck = validatePasswordComplexity(newPassword);
    if (!passwordCheck.valid) {
      throw new AppError(passwordCheck.errors.join('. '), 400);
    }

    user.password = newPassword;
    await user.save();

    // Revoke all other sessions
    await sessionManager.revokeAllSessions(userId);

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

  private generateTokens(user: IUser): AuthTokens {
    const payload = { id: user._id.toString(), role: user.role as UserRole };
    return {
      accessToken: generateAccessToken(payload),
      refreshToken: generateRefreshToken(payload),
    };
  }
}

export const authService = new AuthService();
