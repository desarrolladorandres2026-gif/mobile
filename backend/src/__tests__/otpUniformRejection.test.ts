import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { User } from '../models';
import { OTP_SLOTS, otpSetFields } from '../security';
import { LoginAttempt } from '../security/bruteforce';
import { UserRole } from '../types';
import { makeUser } from './factories';

/**
 * `POST /auth/verify-otp` y `POST /auth/reset-password` no tienen sesión: lo
 * único que ve quien los llama es la respuesta. Antes un número inexistente
 * daba OTP_INVALID, uno sin código pendiente OTP_MISSING, uno vencido
 * OTP_EXPIRED y uno con los 5 intentos gastados OTP_LOCKED (429): cuatro
 * respuestas distintas, y tres de ellas solo posibles si la cuenta existe.
 *
 * Además los fallos del código no sumaban al freno por celular, y cada
 * `send-otp` reiniciaba los 5 intentos del código, así que el único tope era
 * el límite por IP.
 */
const API = '/api/v1';
const GOOD = 'Nueva.Clave789';
const REJECTED = 'Código inválido o vencido. Pide uno nuevo.';

let ipCounter = 0;
/** Una IP distinta por petición: el tope por IP/celular no interfiere con lo que se mide. */
const freshIp = () => `10.20.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

type Flow = 'verify-otp' | 'reset-password';
const call = (flow: Flow, phone: string, otpCode: string, ip = freshIp()) =>
  request(app)
    .post(`${API}/auth/${flow}`)
    .set('X-Forwarded-For', ip)
    .send(flow === 'verify-otp' ? { phone, otpCode } : { phone, otpCode, password: GOOD });

/** Lo que el cliente puede observar de un rechazo. */
const observable = (res: request.Response) => ({
  status: res.status,
  code: res.body.code ?? res.body.error?.code,
  message: res.body.message ?? res.body.error?.message,
});

const identifierCount = async (phone: string) =>
  (await LoginAttempt.findOne({ scope: 'identifier', key: phone }).lean())?.count ?? 0;

let ghostPhone: string;
beforeEach(() => {
  ghostPhone = '3190000001'; // sin cuenta
});

async function userWith(state: 'none' | 'pending' | 'expired' | 'locked') {
  const user = await makeUser({ role: UserRole.CLIENT });
  if (state === 'pending') {
    await User.updateOne({ _id: user._id }, { $set: otpSetFields(OTP_SLOTS.phone, '123456') });
  } else if (state === 'expired') {
    await User.updateOne(
      { _id: user._id },
      { $set: { ...otpSetFields(OTP_SLOTS.phone, '123456'), [OTP_SLOTS.phone.expires]: new Date(Date.now() - 60_000) } }
    );
  } else if (state === 'locked') {
    await User.updateOne({ _id: user._id }, { $set: { ...otpSetFields(OTP_SLOTS.phone, '123456'), [OTP_SLOTS.phone.attempts]: 5 } });
  }
  return user;
}

describe.each<Flow>(['verify-otp', 'reset-password'])('%s: un rechazo del código no distingue por qué', (flow) => {
  it('número inexistente, sin código pendiente, vencido, agotado y erróneo dan la misma respuesta', async () => {
    const none = await userWith('none');
    const expired = await userWith('expired');
    const locked = await userWith('locked');
    const wrong = await userWith('pending');

    const responses = [
      await call(flow, ghostPhone, '123456'),
      await call(flow, none.phone!, '123456'),
      await call(flow, expired.phone!, '123456'),
      await call(flow, locked.phone!, '123456'),
      await call(flow, wrong.phone!, '000000'),
    ].map(observable);

    expect(responses[0]).toEqual({ status: 400, code: 'OTP_INVALID', message: REJECTED });
    for (const r of responses) expect(r).toEqual(responses[0]);
  });

  it('el código correcto y vigente sigue funcionando', async () => {
    const user = await userWith('pending');
    const res = await call(flow, user.phone!, '123456');
    expect(res.status).toBe(200);
  });

  it('cada fallo del código suma al contador del celular, exista o no la cuenta', async () => {
    const expired = await userWith('expired');
    const none = await userWith('none');
    const wrong = await userWith('pending');

    for (const phone of [ghostPhone, expired.phone!, none.phone!]) {
      await call(flow, phone, '123456');
      await call(flow, phone, '123456');
      expect(await identifierCount(phone)).toBe(2);
    }
    await call(flow, wrong.phone!, '000000');
    expect(await identifierCount(wrong.phone!)).toBe(1);
  });

  it('un acierto no suma al contador del celular', async () => {
    const user = await userWith('pending');
    await call(flow, user.phone!, '123456').expect(200);
    expect(await identifierCount(user.phone!)).toBe(0);
  });

  it('26 fallos en 15 min a un mismo celular desde IPs distintas terminan en 429 (también sin cuenta)', async () => {
    const real = await userWith('pending');
    for (const phone of [real.phone!, ghostPhone]) {
      for (let i = 0; i < 25; i++) {
        const res = await call(flow, phone, '000000');
        expect(res.status, `fallo ${i + 1} de ${phone}`).toBe(400);
      }
      // Ni siquiera el código correcto pasa ya: el bloqueo es por celular.
      const blocked = await call(flow, phone, '123456');
      expect(blocked.status).toBe(429);
      expect(observable(blocked).message).toBe('Demasiados intentos para esta cuenta. Intenta más tarde.');
    }
  });
});
