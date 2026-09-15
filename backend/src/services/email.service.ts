import { config } from '../config';
import { DEV_OTP_PROVIDER } from '../config/env';
import { AppError } from '../middlewares/errorHandler';
import { OtpOutbox } from '../models/OtpOutbox';

/**
 * Envío de OTP por correo.
 *
 * Proveedor real: SendGrid por su API REST (sin SDK: es un único POST). Igual
 * que en WhatsApp, el código nunca pasa por un log; antes este archivo
 * terminaba siempre en `console.log(correo → código)`.
 *
 * Con `EMAIL_OTP_ENABLED=false` el canal está apagado y el servicio lo dice
 * con un 503 en vez de fingir que envió.
 */
export class EmailService {
  get isEnabled(): boolean {
    return config.otp.email.enabled;
  }

  async sendOTP(email: string, code: string): Promise<void> {
    const { enabled, provider, fromAddress, sendgridApiKey } = config.otp.email;

    if (!enabled) {
      throw new AppError('El inicio de sesión por correo no está disponible.', 503, 'EMAIL_OTP_DISABLED');
    }

    if (provider === 'sendgrid') {
      let res: Response;
      try {
        res = await fetch('https://api.sendgrid.com/v3/mail/send', {
          method: 'POST',
          headers: { Authorization: `Bearer ${sendgridApiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            personalizations: [{ to: [{ email }] }],
            from: { email: fromAddress, name: 'ZIPP' },
            subject: 'Tu código de verificación ZIPP',
            content: [{
              type: 'text/plain',
              value: `Tu código de verificación ZIPP es ${code}. Vence en ${config.otp.expiryMinutes} minutos. Si no lo pediste, ignora este correo.`,
            }],
          }),
          signal: AbortSignal.timeout(config.otp.providerTimeoutMs),
        });
      } catch {
        console.error('[OTP] sendgrid no respondió.');
        throw new AppError('No pudimos enviar el código. Intenta de nuevo en unos minutos.', 502, 'OTP_DELIVERY_FAILED');
      }
      if (!res.ok) {
        console.error(`[OTP] sendgrid rechazó el envío (HTTP ${res.status}).`);
        throw new AppError('No pudimos enviar el código. Intenta de nuevo en unos minutos.', 502, 'OTP_DELIVERY_FAILED');
      }
      return;
    }

    if (provider === DEV_OTP_PROVIDER && (config.isDev || config.isTest)) {
      await OtpOutbox.create({ channel: 'email', destination: email, code });
      return;
    }

    throw new AppError('El envío de códigos no está configurado.', 503, 'OTP_DELIVERY_NOT_CONFIGURED');
  }
}

export const emailService = new EmailService();
