import { describe, expect, it } from 'vitest';
import { createMemoryMailer, createSmtpMailer } from './mailer.js';
import { templates } from './templates.js';

const good = { to: 'ana@empresa.co', subject: 'Hola', text: 'Contenido' };

describe('correo', () => {
  it('el buzón en memoria guarda los mensajes y encuentra el último de una dirección', async () => {
    const mailer = createMemoryMailer();
    await mailer.send(good);
    await mailer.send({ ...good, subject: 'Segundo' });
    expect(mailer.sent).toHaveLength(2);
    expect(mailer.last('ana@empresa.co').subject).toBe('Segundo');
    expect(mailer.last('otra@empresa.co')).toBeNull();
  });

  it('rechaza destinatarios múltiples o malformados y asuntos con saltos de línea (inyección de cabeceras)', async () => {
    const mailer = createMemoryMailer();
    await expect(mailer.send({ ...good, to: 'a@x.co, b@x.co' })).rejects.toThrow(/destinatario/);
    await expect(mailer.send({ ...good, to: 'sin-arroba' })).rejects.toThrow(/destinatario/);
    await expect(mailer.send({ ...good, subject: 'Hola\r\nBcc: robo@x.co' })).rejects.toThrow(/asunto/);
    await expect(mailer.send({ ...good, text: '' })).rejects.toThrow(/contenido/);
  });

  it('el envío SMTP compone el mensaje con remitente, destinatario y asunto', async () => {
    const mailer = createSmtpMailer({ transport: { jsonTransport: true }, from: 'Lulubiz <no-responder@lulubiz.test>' });
    const result = await mailer.send(good);
    const composed = JSON.parse(result.message);
    expect(composed.subject).toBe('Hola');
    expect(composed.to[0].address).toBe('ana@empresa.co');
    expect(composed.from.address).toBe('no-responder@lulubiz.test');
    expect(composed.text).toBe('Contenido');
  });

  it('exige remitente configurado', () => {
    expect(() => createSmtpMailer({ transport: { jsonTransport: true } })).toThrow(/MAIL_FROM/);
  });
});

describe('plantillas', () => {
  it('el token va en el fragmento de la URL, no en la consulta', () => {
    const mail = templates.passwordReset({ baseUrl: 'https://app.lulubiz.test/', token: 'abc-123_XYZ', minutes: 60 });
    expect(mail.text).toContain('https://app.lulubiz.test/restablecer-contrasena#token=abc-123_XYZ');
    expect(mail.text).not.toContain('?token=');
  });

  it('la invitación nombra empresa, rol y quien invita', () => {
    const mail = templates.invitation({ baseUrl: 'https://x.test', token: 't', company: 'Comercial Andina', inviter: 'Marta', role: 'accountant', days: 7 });
    expect(mail.subject).toContain('Marta');
    expect(mail.subject).toContain('Comercial Andina');
    expect(mail.text).toContain('accountant');
  });
});
