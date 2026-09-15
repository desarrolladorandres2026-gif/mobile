import { Router } from 'express';
import { z } from 'zod';
import { authController } from '../controllers';
import { authenticate, validate, authRateLimiter, otpRateLimiter, sensitiveRateLimiter } from '../middlewares';
import { registerSchema, phoneStatusSchema, registerSendOtpSchema, registerVerifyOtpSchema, registerCompleteSchema, loginSchema, googleLoginSchema, appleLoginSchema, verifyOtpSchema, sendEmailOtpSchema, verifyEmailOtpSchema, refreshTokenSchema, resetPasswordSchema, updateProfileSchema } from '../validators';

const router = Router();

// ── Public auth routes (with rate limiting) ──
router.post('/register', authRateLimiter, validate(registerSchema), (req, res, next) => authController.register(req, res, next));

// ── Entrada única (celular → login o registro). ──
router.post('/phone-status', authRateLimiter, validate(phoneStatusSchema), (req, res, next) => authController.phoneStatus(req, res, next));

// ── Registro en 3 pasos (celular → nombre → contraseña), verificando el
// celular por OTP antes de pedir el resto. ──
router.post('/register/send-otp', otpRateLimiter, validate(registerSendOtpSchema), (req, res, next) => authController.registerSendOTP(req, res, next));
router.post('/register/verify-otp', authRateLimiter, validate(registerVerifyOtpSchema), (req, res, next) => authController.registerVerifyOTP(req, res, next));
router.post('/register/complete', authRateLimiter, validate(registerCompleteSchema), (req, res, next) => authController.registerComplete(req, res, next));
router.post('/login', authRateLimiter, validate(loginSchema), (req, res, next) => authController.login(req, res, next));
router.post('/google', authRateLimiter, validate(googleLoginSchema), (req, res, next) => authController.googleLogin(req, res, next));
router.post('/apple', authRateLimiter, validate(appleLoginSchema), (req, res, next) => authController.appleLogin(req, res, next));
// Redirect público al que apunta el Services ID de Apple — sin rate limit de
// login: no verifica credenciales, solo rebota el form_post al deep link.
router.post('/apple/callback', (req, res) => authController.appleCallback(req, res));
router.post('/refresh-token', validate(refreshTokenSchema), (req, res, next) => authController.refreshToken(req, res, next));
router.post('/send-otp', otpRateLimiter, (req, res, next) => authController.sendOTP(req, res, next));
router.post('/verify-otp', authRateLimiter, validate(verifyOtpSchema), (req, res, next) => authController.verifyOTP(req, res, next));
router.post('/send-email-otp', otpRateLimiter, validate(sendEmailOtpSchema), (req, res, next) => authController.sendEmailOTP(req, res, next));
router.post('/verify-email-otp', authRateLimiter, validate(verifyEmailOtpSchema), (req, res, next) => authController.verifyEmailOTP(req, res, next));
router.post('/reset-password', authRateLimiter, validate(resetPasswordSchema), (req, res, next) => authController.resetPassword(req, res, next));

// ── Protected routes ──
router.patch('/profile', authenticate, validate(updateProfileSchema), (req, res, next) => authController.updateProfile(req, res, next));
router.post('/profile/avatar', authenticate, (req, res, next) => authController.uploadAvatar(req, res, next));
router.post('/logout', authenticate, (req, res, next) => authController.logout(req, res, next));
router.get('/me', authenticate, (req, res, next) => authController.getMe(req, res, next));
router.patch('/marketing-preferences', authenticate, validate(z.object({ body: z.object({ consent: z.boolean(), channels: z.array(z.enum(['sms','email','whatsapp','phone'])).max(4).default([]) }) })), (req, res, next) => authController.updateMarketingPreferences(req, res, next));

// ── Password change ──
router.post('/change-password', authenticate, sensitiveRateLimiter, (req, res, next) => authController.changePassword(req, res, next));

// ── 2FA routes ──
router.post('/2fa/setup', authenticate, sensitiveRateLimiter, (req, res, next) => authController.setup2FA(req, res, next));
router.post('/2fa/verify', authenticate, (req, res, next) => authController.verify2FA(req, res, next));
router.post('/2fa/disable', authenticate, sensitiveRateLimiter, (req, res, next) => authController.disable2FA(req, res, next));

// ── Session management ──
router.get('/sessions', authenticate, (req, res, next) => authController.getActiveSessions(req, res, next));
router.delete('/sessions/:sessionId', authenticate, (req, res, next) => authController.revokeSession(req, res, next));
router.post('/sessions/revoke-all', authenticate, sensitiveRateLimiter, (req, res, next) => authController.revokeAllSessions(req, res, next));

export default router;
