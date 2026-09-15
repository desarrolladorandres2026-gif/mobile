import { Request, Response, NextFunction } from 'express';
import { authService } from '../services';
import { getEffectivePermissions, getEffectiveRoleSlugs } from '../services/authorization.service';
import { sendResponse } from '../utils';
import { AppError } from '../middlewares';
import { uploadAvatarImage } from '../middlewares/upload';
import { config } from '../config/env';

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
  async register(req: Request, res: Response, next: NextFunction) {
    try {
      const { user, tokens } = await authService.register(req.body, req);
      sendResponse(res, 201, 'Registro exitoso', { user, ...tokens });
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
      const { user, tokens } = await authService.completeRegistration(
        req.body.phone, req.body.name, req.body.password, req
      );
      sendResponse(res, 201, 'Registro exitoso', { user, ...tokens });
    } catch (error) { next(error); }
  }

  async login(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await authService.login(req.body, req);

      if (result.requiresTOTP) {
        return sendResponse(res, 200, 'Se requiere verificación 2FA', {
          requiresTOTP: true,
          user: { _id: result.user._id, name: result.user.name },
        });
      }

      const [permissions, roleSlugs] = await Promise.all([
        getEffectivePermissions(result.user),
        getEffectiveRoleSlugs(result.user),
      ]);

      sendResponse(res, 200, 'Login exitoso', {
        user: result.user,
        ...result.tokens,
        isNewDevice: result.isNewDevice,
        permissions,
        roleSlugs,
      });
    } catch (error) { next(error); }
  }

  async googleLogin(req: Request, res: Response, next: NextFunction) {
    try {
      const { user, tokens, needsPhone } = await authService.loginWithGoogle(req.body.idToken, req);
      sendResponse(res, 200, 'Login con Google exitoso', { user, ...tokens, needsPhone });
    } catch (error) { next(error); }
  }

  async appleLogin(req: Request, res: Response, next: NextFunction) {
    try {
      const { user, tokens, needsPhone } = await authService.loginWithApple(req.body.idToken, req.body.fullName, req);
      sendResponse(res, 200, 'Login con Apple exitoso', { user, ...tokens, needsPhone });
    } catch (error) { next(error); }
  }

  /**
   * Apple no permite un esquema `zipp://` como `redirect_uri` — exige un
   * dominio HTTPS registrado en el Services ID. Este endpoint es ese
   * dominio: recibe el `form_post` de Apple (fuera de la app, sin sesión) y
   * rebota de inmediato al deep link de la app con lo que trajo, para que
   * `WebBrowser.openAuthSessionAsync` del lado del cliente cierre el
   * navegador y continúe el login. No guarda nada ni valida el token acá:
   * eso lo hace `POST /auth/apple`, ya dentro de la app.
   */
  async appleCallback(req: Request, res: Response) {
    const idToken = typeof req.body?.id_token === 'string' ? req.body.id_token : '';

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

    const state = typeof req.body?.state === 'string' ? req.body.state : '';

    const redirect = new URL(`${config.deepLinkScheme}://apple-callback`);
    if (idToken) redirect.searchParams.set('idToken', idToken);
    if (fullName) redirect.searchParams.set('fullName', fullName);
    if (state) redirect.searchParams.set('state', state);
    if (!idToken) redirect.searchParams.set('error', '1');

    res.redirect(302, redirect.toString());
  }

  async refreshToken(req: Request, res: Response, next: NextFunction) {
    try {
      const tokens = await authService.refreshTokens(req.body.refreshToken, req);
      sendResponse(res, 200, 'Tokens renovados', tokens);
    } catch (error) { next(error); }
  }

  async sendOTP(req: Request, res: Response, next: NextFunction) {
    try {
      await authService.sendOTP(req.body.phone, req);
      sendResponse(res, 200, 'OTP enviado');
    } catch (error) { next(error); }
  }

  async verifyOTP(req: Request, res: Response, next: NextFunction) {
    try {
      const { user, tokens } = await authService.verifyOTP(req.body.phone, req.body.otpCode, req);
      sendResponse(res, 200, 'OTP verificado', { user, ...tokens });
    } catch (error) { next(error); }
  }

  async sendEmailOTP(req: Request, res: Response, next: NextFunction) {
    try {
      await authService.sendEmailOTP(req.body.email, req);
      sendResponse(res, 200, 'OTP enviado');
    } catch (error) { next(error); }
  }

  async verifyEmailOTP(req: Request, res: Response, next: NextFunction) {
    try {
      const { user, tokens } = await authService.verifyEmailOTP(req.body.email, req.body.otpCode, req);
      sendResponse(res, 200, 'OTP verificado', { user, ...tokens });
    } catch (error) { next(error); }
  }

  async logout(req: Request, res: Response, next: NextFunction) {
    try {
      await authService.logout(req.user!._id.toString(), req);
      sendResponse(res, 200, 'Sesión cerrada');
    } catch (error) { next(error); }
  }

  async resetPassword(req: Request, res: Response, next: NextFunction) {
    try {
      const { user, tokens } = await authService.resetPassword(
        req.body.phone, req.body.otpCode, req.body.password, req
      );
      sendResponse(res, 200, 'Contraseña restablecida exitosamente', { user, ...tokens });
    } catch (error) { next(error); }
  }

  async updateProfile(req: Request, res: Response, next: NextFunction) {
    try {
      const user = await authService.updateProfile(req.user!._id.toString(), req.body, req);
      sendResponse(res, 200, 'Perfil actualizado', { user });
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
      const sessions = await authService.getActiveSessions(req.user!._id.toString());
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
        req.body.currentRefreshToken,
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
}

export const authController = new AuthController();
