import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import crypto from 'crypto';
import request from 'supertest';
import app from '../app';
import { User } from '../models';
import { config } from '../config';
import { authService, identityVerifiers, facebookGraph } from '../services/auth.service';
import { makeUser } from './factories';

/**
 * Autollenado del perfil al entrar con Google, Apple o Facebook
 * (2026-09-19). La regla: **solo se rellena lo vacío**, en cada inicio de
 * sesión, y nunca se pisa lo que el cliente escribió o editó en Mi cuenta.
 */

const sha256 = (v: string) => crypto.createHash('sha256').update(v).digest('hex');

const signedIn = (outcome: Awaited<ReturnType<typeof authService.loginWithGoogle>>) => {
  if (outcome.requiresTOTP) throw new Error('no debería pedir 2FA');
  return outcome.user;
};

describe('Google', () => {
  afterEach(() => vi.restoreAllMocks());

  const google = (claims: Record<string, unknown>) =>
    vi.spyOn(identityVerifiers, 'google').mockResolvedValue({ email_verified: true, ...claims } as any);

  it('una cuenta nueva sale con nombre, apellido, correo verificado y foto', async () => {
    google({
      sub: 'g-nueva',
      email: 'Ana.Ruiz@Ejemplo.com',
      name: 'Ana Ruiz',
      given_name: 'Ana',
      family_name: 'Ruiz Pardo',
      picture: 'https://lh3.googleusercontent.com/foto',
    });

    const user = signedIn(await authService.loginWithGoogle('token-google-1'));

    expect(user).toMatchObject({
      name: 'Ana Ruiz Pardo',
      firstName: 'Ana',
      lastName: 'Ruiz Pardo',
      email: 'ana.ruiz@ejemplo.com',
      emailVerified: true,
      avatar: 'https://lh3.googleusercontent.com/foto',
    });
  });

  it('en una cuenta ya vinculada rellena lo que falta y no pisa lo editado', async () => {
    const user = await makeUser({ name: 'Ana Ruiz' });
    await User.updateOne(
      { _id: user._id },
      { googleId: 'g-existente', firstName: 'Anita', lastName: 'Ruiz', avatar: 'https://mia.jpg' }
    );
    google({
      sub: 'g-existente',
      email: 'ana@ejemplo.com',
      given_name: 'Ana',
      family_name: 'Ruiz Pardo',
      picture: 'https://lh3.googleusercontent.com/otra',
    });

    const after = signedIn(await authService.loginWithGoogle('token-google-2'));

    // Lo editado se queda; el correo, que faltaba, llega.
    expect(after).toMatchObject({
      firstName: 'Anita',
      lastName: 'Ruiz',
      avatar: 'https://mia.jpg',
      email: 'ana@ejemplo.com',
      emailVerified: true,
    });
  });

  it('respeta el nombre que la persona escribió al registrarse con el celular', async () => {
    const user = await makeUser({ name: 'Juanchito Pérez' });
    await User.updateOne({ _id: user._id }, { email: 'juan@ejemplo.com', emailVerified: true });
    google({ sub: 'g-juan', email: 'juan@ejemplo.com', given_name: 'Juan Carlos', family_name: 'Pérez Gómez' });

    const after = signedIn(await authService.loginWithGoogle('token-google-3'));

    expect(after._id.toString()).toBe(user._id.toString());
    expect(after.name).toBe('Juanchito Pérez');
    // Sin partir: Mi cuenta le pide el apellido en vez de adivinarlo.
    expect(after.firstName).toBeUndefined();
    expect(after.lastName).toBeUndefined();
  });

  it('reemplaza el nombre comodín que pusimos nosotros', async () => {
    const user = await makeUser({ name: 'Usuario Google' });
    await User.updateOne({ _id: user._id }, { googleId: 'g-comodin' });
    google({ sub: 'g-comodin', email: 'luisa@ejemplo.com', given_name: 'Luisa', family_name: 'Mora' });

    const after = signedIn(await authService.loginWithGoogle('token-google-4'));

    expect(after).toMatchObject({ name: 'Luisa Mora', firstName: 'Luisa', lastName: 'Mora' });
  });
});

describe('Apple', () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => { config.apple.servicesId = 'com.zipp.test.services'; });

  it('nombre y apellido llegan por el callback, partidos', async () => {
    vi.spyOn(identityVerifiers, 'apple').mockResolvedValue({
      sub: 'a-nuevo',
      email: 'abc123@privaterelay.appleid.com',
      email_verified: 'true',
      nonce: sha256('nonce-apple-1'),
    } as any);

    const code = await authService.createAppleAuthCode('id-token-apple-1', 'Sara Gil', { firstName: 'Sara', lastName: 'Gil' });
    const outcome = await authService.loginWithApple({ code, nonce: 'nonce-apple-1' });
    if (outcome.requiresTOTP) throw new Error('no debería pedir 2FA');

    // El correo privado de Apple reenvía al real: queda verificado.
    expect(outcome.user).toMatchObject({
      firstName: 'Sara',
      lastName: 'Gil',
      name: 'Sara Gil',
      email: 'abc123@privaterelay.appleid.com',
      emailVerified: true,
    });
  });

  it('el callback reenvía el código de un solo uso con el nombre del primer form_post', async () => {
    const res = await request(app)
      .post('/api/v1/auth/apple/callback')
      .type('form')
      .send({ id_token: 'x'.repeat(40), state: 'st', user: JSON.stringify({ name: { firstName: 'Sara', lastName: 'Gil' } }) });

    expect(res.status).toBe(302);
    const location = new URL(res.headers.location);
    expect(location.searchParams.get('state')).toBe('st');
    expect(location.searchParams.get('code')).toBeTruthy();
  });

  it('sin el nonce correcto no se canjea', async () => {
    vi.spyOn(identityVerifiers, 'apple').mockResolvedValue({ sub: 'a-x', nonce: sha256('el-bueno') } as any);
    const code = await authService.createAppleAuthCode('id-token-apple-2');

    await expect(authService.loginWithApple({ code, nonce: 'otro' })).rejects.toMatchObject({ statusCode: 401 });
  });
});

describe('Facebook', () => {
  const original = { ...config.facebook };
  afterEach(() => {
    vi.restoreAllMocks();
    Object.assign(config.facebook, original);
  });
  beforeEach(() => {
    config.facebook.appId = 'fb-app-test';
    config.facebook.appSecret = 'fb-secret-test';
  });

  const verifier = 'v'.repeat(43);

  const facebook = (profile: Record<string, unknown>) => {
    vi.spyOn(facebookGraph, 'exchangeCode').mockResolvedValue('fb-access-token');
    vi.spyOn(facebookGraph, 'profile').mockResolvedValue(profile as any);
  };

  it('crea la cuenta con nombre y apellido, y el correo SIN verificar', async () => {
    facebook({ id: 'fb-1', first_name: 'Mario', last_name: 'Díaz', email: 'mario@ejemplo.com' });

    const outcome = await authService.loginWithFacebook({ code: 'code-1', codeVerifier: verifier });
    if (outcome.requiresTOTP) throw new Error('no debería pedir 2FA');

    expect(outcome.user).toMatchObject({
      firstName: 'Mario',
      lastName: 'Díaz',
      name: 'Mario Díaz',
      email: 'mario@ejemplo.com',
      emailVerified: false,
    });
    expect(outcome.needsPhone).toBe(true);
    expect((await User.findById(outcome.user._id).select('+facebookId'))!.facebookId).toBe('fb-1');
  });

  it('nunca vincula una cuenta existente por correo, ni aunque esté verificado', async () => {
    const owner = await makeUser({});
    await User.updateOne({ _id: owner._id }, { email: 'dueno@ejemplo.com', emailVerified: true });
    facebook({ id: 'fb-2', first_name: 'Otro', last_name: 'Alguien', email: 'dueno@ejemplo.com' });

    const outcome = await authService.loginWithFacebook({ code: 'code-2', codeVerifier: verifier });
    if (outcome.requiresTOTP) throw new Error('no debería pedir 2FA');

    expect(outcome.user._id.toString()).not.toBe(owner._id.toString());
    // El correo ya es de otra cuenta: se omite en silencio y el dueño lo conserva.
    expect(outcome.user.email).toBeUndefined();
    expect((await User.findById(owner._id))!.email).toBe('dueno@ejemplo.com');
  });

  it('si no puede traer la foto, el login sigue', async () => {
    facebook({
      id: 'fb-3',
      first_name: 'Sin',
      last_name: 'Foto',
      picture: { data: { url: 'https://127.0.0.1:9/no-existe.jpg', is_silhouette: false } },
    });

    const outcome = await authService.loginWithFacebook({ code: 'code-3', codeVerifier: verifier });
    if (outcome.requiresTOTP) throw new Error('no debería pedir 2FA');

    expect(outcome.user.avatar).toBeFalsy();
  });

  it('un código que Meta rechaza es un 401 controlado', async () => {
    vi.spyOn(facebookGraph, 'exchangeCode').mockRejectedValue(new Error('invalid code'));

    await expect(authService.loginWithFacebook({ code: 'malo', codeVerifier: verifier })).rejects.toMatchObject({
      statusCode: 401,
      code: 'FACEBOOK_CODE_INVALID',
    });
  });

  it('sin configurar responde 503', async () => {
    config.facebook.appId = '';

    const res = await request(app).post('/api/v1/auth/facebook').send({ code: 'code-cualquiera', codeVerifier: verifier });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('FACEBOOK_NOT_CONFIGURED');
  });

  it('el callback rebota code y state al deep link, o error si canceló', async () => {
    const ok = await request(app).get('/api/v1/auth/facebook/callback').query({ code: 'abc', state: 'st' });
    const okUrl = new URL(ok.headers.location);
    expect(okUrl.protocol).toBe(`${config.deepLinkScheme}:`);
    expect(okUrl.searchParams.get('code')).toBe('abc');
    expect(okUrl.searchParams.get('state')).toBe('st');

    const denied = await request(app).get('/api/v1/auth/facebook/callback').query({ error: 'access_denied', state: 'st' });
    expect(new URL(denied.headers.location).searchParams.get('error')).toBe('1');
  });

  it('eliminar la cuenta suelta la identidad de Facebook', async () => {
    facebook({ id: 'fb-4', first_name: 'Borra', last_name: 'Me' });
    const outcome = await authService.loginWithFacebook({ code: 'code-4', codeVerifier: verifier });
    if (outcome.requiresTOTP) throw new Error('no debería pedir 2FA');

    const { anonymizeAccount } = await import('../services/accountDeletion.service');
    await anonymizeAccount(outcome.user._id.toString());

    expect((await User.findById(outcome.user._id).select('+facebookId'))!.facebookId).toBeUndefined();
  });
});
