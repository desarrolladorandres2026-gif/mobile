import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { User } from '../models';
import { OtpOutbox } from '../models/OtpOutbox';
import { UserRole } from '../types';
import { config } from '../config';
import { adminService } from '../services/admin.service';
import { anonymizeAccount } from '../services/accountDeletion.service';
import { ageOn, parseBirthDate, birthDateProblem } from '../utils/age';
import { makeUser, authHeader } from './factories';

/**
 * Mi cuenta (2026-09-19): nombre y apellido por separado, documento de
 * identidad, fecha de nacimiento que se guarda una sola vez y verificación
 * del correo sin abrir otra sesión.
 */

const patchProfile = async (user: any, body: Record<string, unknown>) =>
  request(app).patch('/api/v1/auth/profile').set(await authHeader(user)).send(body);

/** `AAAA-MM-DD` de hace `years` años (hoy en UTC), para edades exactas. */
const yearsAgo = (years: number) => {
  const now = new Date();
  return `${now.getUTCFullYear() - years}-01-01`;
};

describe('Edad contada en el día de Colombia', () => {
  const born = new Date(Date.UTC(2000, 2, 9)); // 9 de marzo de 2000

  it('no suma el año antes del cumpleaños en Bogotá, aunque en UTC ya sea el día', () => {
    // 8 de marzo, 8 p. m. en Bogotá = 9 de marzo, 01:00 UTC.
    expect(ageOn(born, new Date('2026-03-09T01:00:00Z'))).toBe(25);
    // 9 de marzo, 00:30 en Bogotá.
    expect(ageOn(born, new Date('2026-03-09T05:30:00Z'))).toBe(26);
  });

  it('quien nació un 29 de febrero cumple el 1 de marzo en años no bisiestos', () => {
    const leap = new Date(Date.UTC(2008, 1, 29));
    expect(ageOn(leap, new Date('2026-02-28T17:00:00Z'))).toBe(17);
    expect(ageOn(leap, new Date('2026-03-01T17:00:00Z'))).toBe(18);
  });

  it('rechaza fechas que no existen', () => {
    expect(parseBirthDate('2001-02-29')).toBeNull();
    expect(parseBirthDate('2001-13-01')).toBeNull();
    expect(parseBirthDate('01/02/2001')).toBeNull();
    expect(parseBirthDate('2000-02-29')).not.toBeNull();
  });

  it('pide al menos 14 años y rechaza el futuro', () => {
    const now = new Date('2026-09-19T15:00:00Z');
    expect(birthDateProblem(parseBirthDate('2012-01-01')!, now)).toBeNull();
    expect(birthDateProblem(parseBirthDate('2012-12-31')!, now)).toMatch(/14 años/);
    expect(birthDateProblem(parseBirthDate('2030-01-01')!, now)).toMatch(/futura/);
  });
});

describe('PATCH /auth/profile — datos de Mi cuenta', () => {
  it('nombre y apellido recalculan el nombre visible', async () => {
    const user = await makeUser({ name: 'María José Pérez Gómez' });

    const res = await patchProfile(user, { firstName: 'María José', lastName: 'Pérez Gómez' });

    expect(res.status).toBe(200);
    expect(res.body.data.user).toMatchObject({
      firstName: 'María José',
      lastName: 'Pérez Gómez',
      name: 'María José Pérez Gómez',
    });
  });

  it('guarda el documento limpio de puntos y espacios', async () => {
    const user = await makeUser();

    const res = await patchProfile(user, { documentType: 'CC', documentNumber: '1.020.304.050' });

    expect(res.status).toBe(200);
    expect(res.body.data.user).toMatchObject({ documentType: 'CC', documentNumber: '1020304050' });
  });

  it('rechaza un documento con el formato de otro tipo, con un motivo claro', async () => {
    const user = await makeUser();

    const res = await patchProfile(user, { documentType: 'CC', documentNumber: 'AB12345' });

    expect(res.status).toBe(400);
    expect(res.body.errors[0].message).toMatch(/cédula/i);
  });

  it('el tipo y el número van juntos', async () => {
    const user = await makeUser();
    expect((await patchProfile(user, { documentType: 'CC' })).status).toBe(400);
  });

  it('`null` en los dos borra el documento', async () => {
    const user = await makeUser();
    await patchProfile(user, { documentType: 'PASAPORTE', documentNumber: 'ab123456' });

    const res = await patchProfile(user, { documentType: null, documentNumber: null });

    expect(res.status).toBe(200);
    const stored = await User.findById(user._id);
    expect(stored!.documentType).toBeUndefined();
    expect(stored!.documentNumber).toBeUndefined();
  });

  it('la fecha de nacimiento se guarda una sola vez', async () => {
    const user = await makeUser();

    expect((await patchProfile(user, { birthDate: '1995-06-15' })).status).toBe(200);
    // Repetir la misma no es un cambio.
    expect((await patchProfile(user, { birthDate: '1995-06-15' })).status).toBe(200);

    const change = await patchProfile(user, { birthDate: '1990-06-15' });
    expect(change.status).toBe(403);
    expect(change.body.code).toBe('BIRTHDATE_LOCKED');

    const stored = await User.findById(user._id);
    expect(stored!.birthDate!.toISOString().slice(0, 10)).toBe('1995-06-15');
  });

  it('no acepta menores de 14 años', async () => {
    const user = await makeUser();

    const res = await patchProfile(user, { birthDate: yearsAgo(12) });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BIRTHDATE_INVALID');
    expect((await User.findById(user._id))!.birthDate).toBeUndefined();
  });

  it('soporte puede corregirla después', async () => {
    const user = await makeUser();
    const admin = await makeUser({ role: UserRole.ADMIN });
    await patchProfile(user, { birthDate: '1995-06-15' });

    await adminService.correctBirthDate(user._id.toString(), '1995-05-16', admin);

    const stored = await User.findById(user._id);
    expect(stored!.birthDate!.toISOString().slice(0, 10)).toBe('1995-05-16');
  });
});

describe('GET /auth/me — hasPassword', () => {
  it('dice si la cuenta tiene contraseña, sin mostrarla', async () => {
    const withPassword = await makeUser();
    const res = await request(app).get('/api/v1/auth/me').set(await authHeader(withPassword));

    expect(res.status).toBe(200);
    expect(res.body.data.hasPassword).toBe(true);
    expect(res.body.data.user.password).toBeUndefined();
  });

  it('una cuenta de Google no tiene contraseña', async () => {
    const google = await User.create({
      name: 'Cuenta Google',
      email: `google-${Date.now()}@example.com`,
      googleId: `sub-${Date.now()}`,
      role: UserRole.CLIENT,
      isActive: true,
      isVerified: true,
    });
    const res = await request(app).get('/api/v1/auth/me').set(await authHeader(google));

    expect(res.body.data.hasPassword).toBe(false);
  });
});

describe('Verificar el correo desde Mi cuenta', () => {
  const originalEnabled = config.otp.email.enabled;
  afterEach(() => { config.otp.email.enabled = originalEnabled; });

  it('manda un código al correo y lo confirma sin abrir otra sesión', async () => {
    config.otp.email.enabled = true;
    const user = await makeUser();
    const email = `verificar-${Date.now()}@example.com`;
    await patchProfile(user, { email });
    const headers = await authHeader(user);

    const sent = await request(app).post('/api/v1/auth/email/send-otp').set(headers);
    expect(sent.status).toBe(200);

    const entry = await OtpOutbox.findOne({ channel: 'email', destination: email }).sort({ createdAt: -1 });
    const res = await request(app).post('/api/v1/auth/email/verify').set(headers).send({ otpCode: entry!.code });

    expect(res.status).toBe(200);
    expect(res.body.data.user.emailVerified).toBe(true);
    expect(res.body.data.accessToken).toBeUndefined();
  });

  it('con el correo apagado responde 503 EMAIL_OTP_DISABLED', async () => {
    config.otp.email.enabled = false;
    const user = await makeUser();
    await patchProfile(user, { email: `apagado-${Date.now()}@example.com` });

    const res = await request(app).post('/api/v1/auth/email/send-otp').set(await authHeader(user));

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('EMAIL_OTP_DISABLED');
  });
});

describe('Eliminar la cuenta borra también los datos de Mi cuenta', () => {
  it('nombre, apellido, documento y fecha de nacimiento', async () => {
    const user = await makeUser();
    await patchProfile(user, {
      firstName: 'Ana',
      lastName: 'Ruiz',
      documentType: 'CC',
      documentNumber: '1020304050',
      birthDate: '1990-01-01',
    });

    await anonymizeAccount(user._id.toString());

    const stored = await User.findById(user._id);
    expect(stored!.firstName).toBeUndefined();
    expect(stored!.lastName).toBeUndefined();
    expect(stored!.documentNumber).toBeUndefined();
    expect(stored!.birthDate).toBeUndefined();
  });
});
