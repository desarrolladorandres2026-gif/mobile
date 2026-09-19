import { Request, Response, NextFunction } from 'express';
import { authService } from '../services';
import type { AuthOutcome } from '../services/auth.service';
import { resolveAuthorization } from '../services/authorization.service';
import { sendResponse } from '../utils';
import { AppError } from '../middlewares';
import { uploadAvatarImage } from '../middlewares/upload';
import { config } from '../config/env';

/**
 * Traduce el resultado de cualquier camino de login a la respuesta HTTP.
 *
 * Es el único sitio que decide qué sale en el cuerpo: o `requiresTOTP` con un
 * reto, o la sesión con sus tokens. Así un endpoint nuevo no puede olvidarse
 * del 2FA y devolver tokens por su cuenta.
 */
async function sendAuthOutcome(
  res: Response,
  status: number,
  message: string,
  outcome: AuthOutcome,
  extra: Record<string, unknown> = {}
) {
  if (outcome.requiresTOTP) {
    return sendResponse(res, 200, 'Se requiere verificación en dos pasos', {
      requiresTOTP: true,
      challengeToken: outcome.challengeToken || undefined,
      user: { _id: outcome.user._id, name: outcome.user.name },
    });
  }

  const { permissions, roleSlugs } = await resolveAuthorization(outcome.user);

  return sendResponse(res, status, message, {
    user: outcome.user,
    ...outcome.tokens,
    isNewDevice: outcome.isNewDevice,
    permissions,
    roleSlugs,
    ...extra,
  });
}

export class AuthController {
  async updateMarketingPreferences(req: Request, res: Response, next: NextFunction) {
    try {
      const consent = Boolean(req.body.consent);
      req.user!.marketingConsent = consent;
      req.user!.marketingConsentAt = consent ? new Date() : undefined;
      req.user!.marketingChannels = consent ? req.body.channels : [];
      await req.user!.save();
      sendResponse(res, 200, consent ? 'Preferencias de comunicaciones actualizadas' : 'Comunicaciones comerciales desactivadas', { marketingConsent: consent, marketingChannels: req.user!.marketingChannels });
    } catch (error) { next(error); }
  }

  // ── Entrada única: el celular decide entre login y registro. ──
  async phoneStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await authService.getPhoneStatus(req.body.phone);
      sendResponse(res, 200, 'Estado del celular', result);
    } catch (error) { next(error); }
  }

  // ── Registro en 3 pasos: celular verificado por OTP antes de pedir
  // nombre y contraseña. ──
  async registerSendOTP(req: Request, res: Response, next: NextFunction) {
    try {
      await authService.sendRegistrationOTP(req.body.phone, req);
      sendResponse(res, 200, 'OTP enviado');
    } catch (error) { next(error); }
  }

  async registerVerifyOTP(req: Request, res: Response, next: NextFunction) {
    try {
      await authService.verifyRegistrationOTP(req.body.phone, req.body.otpCode, req);
      sendResponse(res, 200, 'Celular verificado');
    } catch (error) { next(error); }
  }

  async registerComplete(req: Request, res: Response, next: NextFunction) {
    try {
      const outcome = await authService.completeRegistration(
        req.body.phone, req.body.name, req.body.password, req
      );
      await sendAuthOutcome(res, 201, 'Registro exitoso', outcome);
    } catch (error) { next(error); }
  }

  async login(req: Request, res: Response, next: NextFunction) {
    try {
      const outcome = await authService.login(req.body, req);
      await sendAuthOutcome(res, 200, 'Login exitoso', outcome);
    } catch (error) { next(error); }
  }

  /** Segundo paso de cualquier login en una cuenta con 2FA. */
  async mfaChallenge(req: Request, res: Response, next: NextFunction) {
    try {
      const outcome = await authService.completeMfaChallenge(req.body.challengeToken, req.body.code, req);
      const needsPhone = outcome.method === 'google' || outcome.method === 'apple'
        ? !outcome.user.phone || !outcome.user.phoneVerified
        : undefined;
      await sendAuthOutcome(res, 200, 'Login exitoso', outcome, needsPhone === undefined ? {} : { needsPhone });
    } catch (error) { next(error); }
  }

  async googleLogin(req: Request, res: Response, next: NextFunction) {
    try {
      const { needsPhone, ...outcome } = await authService.loginWithGoogle(req.body.idToken, req, { nonce: req.body.nonce });
      await sendAuthOutcome(res, 200, 'Login con Google exitoso', outcome as AuthOutcome, { needsPhone });
    } catch (error) { next(error); }
  }

  async appleLogin(req: Request, res: Response, next: NextFunction) {
    try {
      const { needsPhone, ...outcome } = await authService.loginWithApple(
        { code: req.body.code, nonce: req.body.nonce, fullName: req.body.fullName },
        req
      );
      await sendAuthOutcome(res, 200, 'Login con Apple exitoso', outcome as AuthOutcome, { needsPhone });
    } catch (error) { next(error); }
  }

  /**
   * Apple no permite un esquema `zipp://` como `redirect_uri` — exige un
   * dominio HTTPS registrado en el Services ID. Este endpoint es ese
   * dominio: recibe el `form_post` de Apple (fuera de la app, sin sesión) y
   * rebota al deep link de la app.
   *
   * El deep link ya NO lleva el `id_token`: lleva un código de un solo uso
   * que solo se canjea junto con el nonce en claro que generó la app (ver
   * `models/OAuthReplay.ts`). Una app que registre el mismo esquema y
   * capture el deep link se queda con un código inservible.
   */
  async appleCallback(req: Request, res: Response) {
    const idToken = typeof req.body?.id_token === 'string' ? req.body.id_token : '';
    const state = typeof req.body?.state === 'string' ? req.body.state.slice(0, 128) : '';

    // El campo `user` solo viaja en el primer `form_post` de siempre, como
    // JSON de texto: `{"name":{"firstName":"...","lastName":"..."}}`.
    let fullName = '';
    if (typeof req.body?.user === 'string') {
      try {
        const parsed = JSON.parse(req.body.user);
        fullName = [parsed?.name?.firstName, parsed?.name?.lastName].filter(Boolean).join(' ').trim();
      } catch {
        // `user` con formato inesperado: se sigue sin nombre, no es fatal.
      }
    }

    const redirect = new URL(`${config.deepLinkScheme}://apple-callback`);
    if (state) redirect.searchParams.set('state', state);

    if (!idToken || idToken.length > 4096) {
      redirect.searchParams.set('error', '1');
      return res.redirect(302, redirect.toString());
    }

    try {
      const code = await authService.createAppleAuthCode(idToken, fullName || undefined);
      redirect.searchParams.set('code', code);
    } catch {
      redirect.searchParams.set('error', '1');
    }

    res.redirect(302, redirect.toString());
  }

  async refreshToken(req: Request, res: Response, next: NextFunction) {
    try {
      const tokens = await authService.refreshTokens(req.body.refreshToken, req);
      sendResponse(res, 200, 'Tokens renovados', tokens);
    } catch (error) { next(error); }
  }

  /** La respuesta es idéntica exista o no la cuenta. */
  async sendOTP(req: Request, res: Response, next: NextFunction) {
    try {
      await authService.sendOTP(req.body.phone, req);
      sendResponse(res, 200, 'Si el número tiene una cuenta, te enviamos un código.');
    } catch (error) { next(error); }
  }

  async verifyOTP(req: Request, res: Response, next: NextFunction) {
    try {
      const outcome = await authService.verifyOTP(req.body.phone, req.body.otpCode, req);
      await sendAuthOutcome(res, 200, 'OTP verificado', outcome);
    } catch (error) { next(error); }
  }

  /** La respuesta es idéntica exista o no la cuenta. */
  async sendEmailOTP(req: Request, res: Response, next: NextFunction) {
    try {
      await authService.sendEmailOTP(req.body.email, req);
      sendResponse(res, 200, 'Si el correo tiene una cuenta, te enviamos un código.');
    } catch (error) { next(error); }
  }

  async verifyEmailOTP(req: Request, res: Response, next: NextFunction) {
    try {
      const outcome = await authService.verifyEmailOTP(req.body.email, req.body.otpCode, req);
      await sendAuthOutcome(res, 200, 'OTP verificado', outcome);
    } catch (error) { next(error); }
  }

  async logout(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await authService.logout(req.user!._id.toString(), req);
      sendResponse(res, 200, 'Sesión cerrada', result);
    } catch (error) { next(error); }
  }

  async resetPassword(req: Request, res: Response, next: NextFunction) {
    try {
      const outcome = await authService.resetPassword(
        req.body.phone, req.body.otpCode, req.body.password, req, req.body.totpToken
      );
      await sendAuthOutcome(res, 200, 'Contraseña restablecida exitosamente', outcome);
    } catch (error) { next(error); }
  }

  async updateProfile(req: Request, res: Response, next: NextFunction) {
    try {
      const { user, phoneVerificationSent } = await authService.updateProfile(req.user!._id.toString(), req.body, req);
      sendResponse(
        res,
        200,
        phoneVerificationSent ? 'Te enviamos un código para confirmar tu celular' : 'Perfil actualizado',
        { user, phoneVerificationSent }
      );
    } catch (error) { next(error); }
  }

  async resendPhoneOtp(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await authService.resendPendingPhoneOtp(req.user!._id.toString());
      sendResponse(res, 200, result.sent ? 'Código enviado' : 'Espera unos segundos antes de pedir otro código', result);
    } catch (error) { next(error); }
  }

  async verifyPhone(req: Request, res: Response, next: NextFunction) {
    try {
      const user = await authService.verifyPendingPhone(req.user!._id.toString(), req.body.otpCode, req);
      sendResponse(res, 200, 'Celular verificado', { user });
    } catch (error) { next(error); }
  }

  async uploadAvatar(req: Request, res: Response, next: NextFunction) {
    uploadAvatarImage(req, res, async (err: unknown) => {
      try {
        if (err) throw new AppError(err instanceof Error ? err.message : 'No se pudo procesar la imagen', 400);
        if (!req.file) throw new AppError('Selecciona una imagen para tu perfil', 400);

        const user = await authService.uploadAvatar(req.user!._id.toString(), req.file.buffer, req);
        sendResponse(res, 200, 'Foto de perfil actualizada', { user });
      } catch (error) { next(error); }
    });
  }

  async getMe(req: Request, res: Response, next: NextFunction) {
    try {
      // Calculados en `authenticate` para esta misma request — ver
      // authorization.service.ts. El panel los usa para el PermissionGate
      // sin depender de nada que el propio cliente hubiera podido alterar.
      sendResponse(res, 200, 'Perfil obtenido', {
        user: req.user,
        permissions: req.permissions || [],
        roleSlugs: req.roleSlugs || [],
        twoFactorSetupRequired: req.twoFactorSetupRequired === true,
      });
    } catch (error) { next(error); }
  }

  // ── 2FA Endpoints ──

  async setup2FA(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await authService.setup2FA(req.user!._id.toString(), req);
      sendResponse(res, 200, 'Configuración 2FA generada', result);
    } catch (error) { next(error); }
  }

  async verify2FA(req: Request, res: Response, next: NextFunction) {
    try {
      await authService.verify2FASetup(req.user!._id.toString(), req.body.token, req);
      sendResponse(res, 200, '2FA habilitado exitosamente');
    } catch (error) { next(error); }
  }

  async disable2FA(req: Request, res: Response, next: NextFunction) {
    try {
      await authService.disable2FA(req.user!._id.toString(), req.body.token, req);
      sendResponse(res, 200, '2FA deshabilitado');
    } catch (error) { next(error); }
  }

  // ── Session Management ──

  async getActiveSessions(req: Request, res: Response, next: NextFunction) {
    try {
      const sessions = await authService.getActiveSessions(req.user!._id.toString(), req.sessionId);
      sendResponse(res, 200, 'Sesiones activas', { sessions });
    } catch (error) { next(error); }
  }

  async revokeSession(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await authService.revokeSession(req.params.sessionId as string, req.user!._id.toString(), req);
      if (!result) {
        return sendResponse(res, 404, 'Sesión no encontrada');
      }
      sendResponse(res, 200, 'Sesión revocada');
    } catch (error) { next(error); }
  }

  async revokeAllSessions(req: Request, res: Response, next: NextFunction) {
    try {
      const count = await authService.revokeAllSessions(
        req.user!._id.toString(),
        req.body?.currentRefreshToken,
        req
      );
      sendResponse(res, 200, `${count} sesiones cerradas`, { revokedCount: count });
    } catch (error) { next(error); }
  }

  async changePassword(req: Request, res: Response, next: NextFunction) {
    try {
      await authService.changePassword(
        req.user!._id.toString(),
        req.body.currentPassword,
        req.body.newPassword,
        req
      );
      sendResponse(res, 200, 'Contraseña cambiada exitosamente');
    } catch (error) { next(error); }
  }

  // ── Eliminación de cuenta ──

  async requestAccountDeletionOtp(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await authService.requestAccountDeletionOtp(req.user!._id.toString());
      sendResponse(res, 200, 'Te enviamos un código para confirmar', result);
    } catch (error) { next(error); }
  }

  async deleteAccount(req: Request, res: Response, next: NextFunction) {
    try {
      await authService.deleteOwnAccount(
        req.user!._id.toString(),
        { password: req.body?.password, otpCode: req.body?.otpCode },
        req
      );
      sendResponse(res, 200, 'Tu cuenta fue eliminada');
    } catch (error) { next(error); }
  }
}

export const authController = new AuthController();
