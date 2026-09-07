export class EmailService {
  async sendOTP(email: string, code: string): Promise<void> {
    const provider = process.env.EMAIL_PROVIDER;

    if (provider === 'sendgrid') {
      // const sgMail = require('@sendgrid/mail');
      // sgMail.setApiKey(process.env.SENDGRID_API_KEY);
      // await sgMail.send({
      //   to: email,
      //   from: process.env.EMAIL_FROM_ADDRESS,
      //   subject: 'Tu código de verificación ZIPP',
      //   text: `Tu código de verificación ZIPP es: ${code}. Expira en 5 minutos.`,
      // });
      // return;
    }

    if (provider === 'smtp') {
      // const nodemailer = require('nodemailer');
      // const transporter = nodemailer.createTransport({
      //   host: process.env.SMTP_HOST,
      //   port: Number(process.env.SMTP_PORT),
      //   auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      // });
      // await transporter.sendMail({
      //   to: email,
      //   from: process.env.EMAIL_FROM_ADDRESS,
      //   subject: 'Tu código de verificación ZIPP',
      //   text: `Tu código de verificación ZIPP es: ${code}. Expira en 5 minutos.`,
      // });
      // return;
    }

    // Development fallback — print to console
    console.log(`[EMAIL-OTP] ${email} → ${code}`);
  }
}

export const emailService = new EmailService();
