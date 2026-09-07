export class WhatsAppService {
  /**
   * Phone verification runs over WhatsApp Business, not generic SMS — it's
   * the channel Colombian users already trust and check, and it's cheaper
   * per message than SMS at scale. Swap the provider block below for a real
   * one (Meta Cloud API is the default choice: no per-message carrier
   * surcharges once WHATSAPP_PHONE_NUMBER_ID is approved).
   */
  async sendOTP(phone: string, code: string): Promise<void> {
    const provider = process.env.WHATSAPP_PROVIDER;

    if (provider === 'meta_cloud_api') {
      // const res = await fetch(
      //   `https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      //   {
      //     method: 'POST',
      //     headers: {
      //       Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
      //       'Content-Type': 'application/json',
      //     },
      //     body: JSON.stringify({
      //       messaging_product: 'whatsapp',
      //       to: phone,
      //       type: 'template',
      //       template: {
      //         name: 'otp_verification',
      //         language: { code: 'es_CO' },
      //         components: [{ type: 'body', parameters: [{ type: 'text', text: code }] }],
      //       },
      //     }),
      //   }
      // );
      // if (!res.ok) throw new Error(`WhatsApp Business API error: ${res.status}`);
      // return;
    }

    if (provider === 'twilio_whatsapp') {
      // const client = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      // await client.messages.create({
      //   to: `whatsapp:${phone}`,
      //   from: `whatsapp:${process.env.TWILIO_WHATSAPP_FROM_NUMBER}`,
      //   body: `Tu código de verificación ZIPP es: ${code}. Expira en 5 minutos.`,
      // });
      // return;
    }

    // Development fallback — print to console
    console.log(`[WHATSAPP-OTP] ${phone} → ${code}`);
  }
}

export const whatsappService = new WhatsAppService();
