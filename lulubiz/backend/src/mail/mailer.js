import nodemailer from 'nodemailer';

const EMAIL_PATTERN = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

function assertMessage({ to, subject, text }) {
  if (!EMAIL_PATTERN.test(String(to ?? ''))) throw new Error('destinatario de correo inválido');
  if (!subject || /[\r\n]/.test(subject)) throw new Error('asunto inválido');
  if (!text) throw new Error('el correo no tiene contenido');
}

/** Guarda los correos en memoria. Para pruebas y para desarrollo sin servidor de correo. */
export function createMemoryMailer() {
  const sent = [];
  return {
    sent,
    async send(message) {
      assertMessage(message);
      sent.push({ ...message });
    },
    /** El último correo enviado a una dirección. */
    last(to) {
      return [...sent].reverse().find((m) => m.to === to) ?? null;
    },
  };
}

/** Escribe los correos en el log. Desarrollo local: nada sale de la máquina. */
export function createLogMailer(log) {
  return {
    async send(message) {
      assertMessage(message);
      log.info({ to: message.to, subject: message.subject }, 'correo (no enviado, modo desarrollo)');
    },
  };
}

/**
 * Envío real por SMTP con nodemailer. `url` es una dirección `smtps://usuario:clave@servidor:465`.
 * Para pruebas se puede pasar `transport` ya creado (por ejemplo `{ jsonTransport: true }`).
 */
export function createSmtpMailer({ url, transport, from }) {
  if (!from) throw new Error('falta el remitente (MAIL_FROM)');
  const sender = nodemailer.createTransport(transport ?? url);
  return {
    async send(message) {
      assertMessage(message);
      return sender.sendMail({ from, to: message.to, subject: message.subject, text: message.text });
    },
  };
}
