import { Router } from 'express';
import { z } from 'zod';
import { authController } from '../controllers';
import {
  authenticate, validate, authRateLimiter, otpRateLimiter, sensitiveRateLimiter, refreshRateLimiter,
} from '../middlewares';
import {
  phoneStatusSchema, registerSendOtpSchema, registerVerifyOtpSchema, registerCompleteSchema, loginSchema,
  mfaChallengeSchema, googleLoginSchema, appleLoginSchema, sendOtpSchema, verifyOtpSchema, sendEmailOtpSchema,
  verifyEmailOtpSchema, refreshTokenSchema, logoutSchema, resetPasswordSchema, updateProfileSchema,
  verifyPhoneSchema, changePasswordSchema, twoFactorTokenSchema, revokeAllSessionsSchema, deleteAccountSchema,
} from '../validators';

const router = Router();

// `POST /register` ya no existe: creaba cuentas sin verificar el celular y
// dejaba elegir el rol `driver` o `business`. El único registro es el de tres
// pasos con OTP de abajo.

// ── Entrada única (celular → login o registro). ──
router.post('/phone-status', authRateLimiter, validate(phoneStatusSchema), (req, res, next) => authController.phoneStatus(req, res, next));

// ── Registro en 3 pasos (celular → nombre → contraseña), verificando el
// celular por OTP antes de pedir el resto. ──
router.post('/register/send-otp', otpRateLimiter, validate(registerSendOtpSchema), (req, res, next) => authController.registerSendOTP(req, res, next));
router.post('/register/verify-otp', authRateLimiter, validate(registerVerifyOtpSchema), (req, res, next) => authController.registerVerifyOTP(req, res, next));
router.post('/register/complete', authRateLimiter, validate(registerCompleteSchema), (req, res, next) => authController.registerComplete(req, res, next));
router.post('/login', authRateLimiter, validate(loginSchema), (req, res, next) => authController.login(req, res, next));
// Segundo paso de cualquier login con 2FA (contraseña, Google, Apple, OTP).
router.post('/2fa/challenge', authRateLimiter, validate(mfaChallengeSchema), (req, res, next) => authController.mfaChallenge(req, res, next));
router.post('/google', authRateLimiter, validate(googleLoginSchema), (req, res, next) => authController.googleLogin(req, res, next));
router.post('/apple', authRateLimiter, validate(appleLoginSchema), (req, res, next) => authController.appleLogin(req, res, next));
// Redirect público al que apunta el Services ID de Apple. No verifica
// credenciales ni devuelve tokens: guarda el `id_token` tras un código de un
// solo uso que solo se canjea con el nonce de la app.
router.post('/apple/callback', (req, res) => authController.appleCallback(req, res));
router.post('/refresh-token', refreshRateLimiter, validate(refreshTokenSchema), (req, res, next) => authController.refreshToken(req, res, next));
router.post('/send-otp', otpRateLimiter, validate(sendOtpSchema), (req, res, next) => authController.sendOTP(req, res, next));
router.post('/verify-otp', authRateLimiter, validate(verifyOtpSchema), (req, res, next) => authController.verifyOTP(req, res, next));
router.post('/send-email-otp', otpRateLimiter, validate(sendEmailOtpSchema), (req, res, next) => authController.sendEmailOTP(req, res, next));
router.post('/verify-email-otp', authRateLimiter, validate(verifyEmailOtpSchema), (req, res, next) => authController.verifyEmailOTP(req, res, next));
router.post('/reset-password', authRateLimiter, validate(resetPasswordSchema), (req, res, next) => authController.resetPassword(req, res, next));

// ── Protected routes ──
router.patch('/profile', authenticate, validate(updateProfileSchema), (req, res, next) => authController.updateProfile(req, res, next));
// Celular pendiente: solo se asocia a la cuenta al confirmar el OTP.
router.post('/phone/send-otp', authenticate, otpRateLimiter, (req, res, next) => authController.resendPhoneOtp(req, res, next));
router.post('/phone/verify', authenticate, authRateLimiter, validate(verifyPhoneSchema), (req, res, next) => authController.verifyPhone(req, res, next));
router.post('/profile/avatar', authenticate, (req, res, next) => authController.uploadAvatar(req, res, next));
router.post('/logout', authenticate, validate(logoutSchema), (req, res, next) => authController.logout(req, res, next));
router.get('/me', authenticate, (req, res, next) => authController.getMe(req, res, next));
router.patch('/marketing-preferences', authenticate, validate(z.object({ body: z.object({ consent: z.boolean(), channels: z.array(z.enum(['sms','email','whatsapp','phone'])).max(4).default([]) }) })), (req, res, next) => authController.updateMarketingPreferences(req, res, next));

// ── Password change ──
router.post('/change-password', authenticate, sensitiveRateLimiter, validate(changePasswordSchema), (req, res, next) => authController.changePassword(req, res, next));

// ── 2FA routes ──
router.post('/2fa/setup', authenticate, sensitiveRateLimiter, (req, res, next) => authController.setup2FA(req, res, next));
router.post('/2fa/verify', authenticate, authRateLimiter, validate(twoFactorTokenSchema), (req, res, next) => authController.verify2FA(req, res, next));
router.post('/2fa/disable', authenticate, sensitiveRateLimiter, validate(twoFactorTokenSchema), (req, res, next) => authController.disable2FA(req, res, next));

// ── Session management ──
router.get('/sessions', authenticate, (req, res, next) => authController.getActiveSessions(req, res, next));
router.delete('/sessions/:sessionId', authenticate, (req, res, next) => authController.revokeSession(req, res, next));
router.post('/sessions/revoke-all', authenticate, sensitiveRateLimiter, validate(revokeAllSessionsSchema), (req, res, next) => authController.revokeAllSessions(req, res, next));

// ── Eliminación de la propia cuenta (App Store 5.1.1(v), Google Play) ──
router.post('/account/delete/request-otp', authenticate, otpRateLimiter, (req, res, next) => authController.requestAccountDeletionOtp(req, res, next));
router.delete('/account', authenticate, sensitiveRateLimiter, validate(deleteAccountSchema), (req, res, next) => authController.deleteAccount(req, res, next));

export default router;
