import { config } from '../config';
import { DEV_OTP_PROVIDER } from '../config/env';
import { AppError } from '../middlewares/errorHandler';
import { OtpOutbox } from '../models/OtpOutbox';

/**
 * Envío de OTP por WhatsApp Business.
 *
 * Es el canal que los usuarios en Colombia ya revisan, y por mensaje sale
 * más barato que un SMS. Dos proveedores reales, elegidos por
 * `WHATSAPP_PROVIDER`:
 *
 * - `meta_cloud_api`: plantilla de autenticación aprobada en Meta.
 * - `twilio_whatsapp`: API REST de Twilio (con `ContentSid` si la plantilla
 *   vive allí, o cuerpo de texto dentro de la ventana de 24 h).
 *
 * El código NUNCA se escribe en un log, ni siquiera ante un error del
 * proveedor: de la respuesta fallida solo se registra el estado HTTP. Antes
 * este archivo terminaba siempre en `console.log(teléfono → código)`.
 */

/** 10 dígitos nacionales → E.164 sin `+` (como lo pide Meta). */
const toE164Digits = (phone: string) => (phone.startsWith('57') && phone.length === 12 ? phone : `57${phone}`);

function sendFailure(provider: string, status?: number): AppError {
  // Solo el proveedor y el estado: nada del cuerpo, que podría citar el mensaje.
  console.error(`[OTP] ${provider} rechazó el envío${status ? ` (HTTP ${status})` : ''}.`);
  return new AppError('No pudimos enviar el código. Intenta de nuevo en unos minutos.', 502, 'OTP_DELIVERY_FAILED');
}

export class WhatsAppService {
  async sendOTP(phone: string, code: string): Promise<void> {
    const { provider, meta, twilio } = config.otp.whatsapp;
    const signal = AbortSignal.timeout(config.otp.providerTimeoutMs);

    if (provider === 'meta_cloud_api') {
      const components: unknown[] = [{ type: 'body', parameters: [{ type: 'text', text: code }] }];
      if (meta.templateHasCopyButton) {
        components.push({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] });
      }

      let res: Response;
      try {
        res = await fetch(`https://graph.facebook.com/${meta.apiVersion}/${meta.phoneNumberId}/messages`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${meta.accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: toE164Digits(phone),
            type: 'template',
            template: { name: meta.templateName, language: { code: meta.templateLanguage }, components },
          }),
          signal,
        });
      } catch {
        throw sendFailure('meta_cloud_api');
      }
      if (!res.ok) throw sendFailure('meta_cloud_api', res.status);
      return;
    }

    if (provider === 'twilio_whatsapp') {
      const form = new URLSearchParams({
        To: `whatsapp:+${toE164Digits(phone)}`,
        From: twilio.from.startsWith('whatsapp:') ? twilio.from : `whatsapp:${twilio.from}`,
      });
      if (twilio.contentSid) {
        form.set('ContentSid', twilio.contentSid);
        form.set('ContentVariables', JSON.stringify({ 1: code }));
      } else {
        form.set('Body', `Tu código de verificación ZIPP es ${code}. Vence en ${config.otp.expiryMinutes} minutos. No lo compartas con nadie.`);
      }

      let res: Response;
      try {
        res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilio.accountSid}/Messages.json`, {
          method: 'POST',
          headers: {
            Authorization: `Basic ${Buffer.from(`${twilio.accountSid}:${twilio.authToken}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: form.toString(),
          signal,
        });
      } catch {
        throw sendFailure('twilio_whatsapp');
      }
      if (!res.ok) throw sendFailure('twilio_whatsapp', res.status);
      return;
    }

    if (provider === DEV_OTP_PROVIDER && (config.isDev || config.isTest)) {
      await OtpOutbox.create({ channel: 'whatsapp', destination: phone, code });
      return;
    }

    // Inalcanzable con una configuración válida: producción no arranca sin
    // proveedor. Se falla cerrado en vez de "entregar" a ninguna parte.
    throw new AppError('El envío de códigos no está configurado.', 503, 'OTP_DELIVERY_NOT_CONFIGURED');
  }
}

export const whatsappService = new WhatsAppService();
