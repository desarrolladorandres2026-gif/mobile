import { describe, it, expect, beforeEach } from 'vitest';
import {
  IdentityLink,
  LoginAttempt,
  antiFraudService,
  checkBruteForce,
  recordFailedAttempt,
  clearAttempts,
  getRemainingAttempts,
  FraudAlertType,
} from '../security';

/**
 * Persistencia del antifraude.
 *
 * Estas dos piezas vivían en `Map` de memoria del proceso. Eso tenía tres
 * consecuencias que ninguna prueba podía observar mientras el estado
 * estuviera en memoria: se perdía al reiniciar, no se compartía entre
 * instancias y crecía sin límite.
 *
 * Ahora que el estado está en la base de datos, se puede afirmar lo que
 * antes solo se podía prometer. Cada caso consulta la colección
 * directamente: es exactamente lo que vería otra instancia del servidor.
 */
describe('Vínculos identidad ↔ cuenta', () => {
  it('deja rastro en la base, no en la memoria del proceso', async () => {
    await antiFraudService.checkMultipleAccounts('user-1', 'device-abc', '10.0.0.1');

    const links = await IdentityLink.find({ key: 'device-abc' });
    expect(links).toHaveLength(1);
    expect(links[0].userId).toBe('user-1');
  });

  it('no duplica la fila cuando la misma cuenta vuelve por el mismo sitio', async () => {
    await antiFraudService.checkMultipleAccounts('user-1', 'device-abc', '10.0.0.1');
    await antiFraudService.checkMultipleAccounts('user-1', 'device-abc', '10.0.0.1');
    await antiFraudService.checkMultipleAccounts('user-1', 'device-abc', '10.0.0.1');

    expect(await IdentityLink.countDocuments({ kind: 'device', key: 'device-abc' })).toBe(1);
  });

  it('avisa a partir de la tercera cuenta en el mismo teléfono', async () => {
    const first = await antiFraudService.checkMultipleAccounts('user-1', 'device-abc', '10.0.0.1');
    const second = await antiFraudService.checkMultipleAccounts('user-2', 'device-abc', '10.0.0.2');
    expect(first.suspicious).toBe(false);
    expect(second.suspicious).toBe(false);

    const third = await antiFraudService.checkMultipleAccounts('user-3', 'device-abc', '10.0.0.3');
    expect(third.suspicious).toBe(true);
    expect(third.alert!.type).toBe(FraudAlertType.MULTIPLE_ACCOUNTS_DEVICE);
    expect(third.alert!.evidence!.accountIds).toHaveLength(3);
  });

  it('el recuento sobrevive a un reinicio del servidor', async () => {
    // Dos cuentas ya vistas. Con los `Map` de antes, esto se perdía entero
    // en cada despliegue: bastaba con esperar a uno para volver a cero.
    await antiFraudService.checkMultipleAccounts('user-1', 'device-abc', '10.0.0.1');
    await antiFraudService.checkMultipleAccounts('user-2', 'device-abc', '10.0.0.2');

    // Un proceso nuevo no comparte nada con el anterior salvo la base de
    // datos, que es justo lo que se consulta aquí.
    const seen = await IdentityLink.find({ kind: 'device', key: 'device-abc' }).distinct('userId');
    expect(seen).toHaveLength(2);

    // Y la tercera cuenta dispara igual, aunque las dos primeras las viera
    // "otra instancia".
    const third = await antiFraudService.checkMultipleAccounts('user-3', 'device-abc', '10.0.0.3');
    expect(third.suspicious).toBe(true);
  });

  it('avisa de creación masiva a partir de la sexta cuenta por IP', async () => {
    let last;
    for (let i = 1; i <= 6; i++) {
      // Dispositivo distinto cada vez para aislar la señal de la IP.
      last = await antiFraudService.checkMultipleAccounts(`user-${i}`, `device-${i}`, '10.0.0.9');
    }

    expect(last!.suspicious).toBe(true);
    expect(last!.alert!.type).toBe(FraudAlertType.MASS_ACCOUNT_CREATION);
  });
});

describe('Fuerza bruta', () => {
  const ip = '10.0.0.1';
  const phone = '3001234567';

  beforeEach(async () => {
    await LoginAttempt.deleteMany({});
  });

  it('deja entrar cuando no hay historial', async () => {
    expect((await checkBruteForce(ip, phone)).allowed).toBe(true);
  });

  it('cuenta los intentos fallidos en la base de datos', async () => {
    await recordFailedAttempt(ip, phone);
    await recordFailedAttempt(ip, phone);

    // La clave del contador por cuenta va atada a la IP desde la que se
    // intentó (`${identificador}|${ip}`): sin eso, cualquiera podía dejar
    // bloqueado a otro fallando cinco veces con su número, sin saber su
    // contraseña.
    const record = await LoginAttempt.findOne({ scope: 'user', key: `${phone}|${ip}` });
    expect(record!.count).toBe(2);
    expect(await getRemainingAttempts(phone, ip)).toBe(3);
  });

  it('bloquea la cuenta al quinto intento', async () => {
    for (let i = 0; i < 4; i++) {
      const partial = await recordFailedAttempt(ip, phone);
      expect(partial.allowed).toBe(true);
    }

    const fifth = await recordFailedAttempt(ip, phone);
    expect(fifth.allowed).toBe(false);
    expect(fifth.retryAfterMs).toBeGreaterThan(0);

    // Y el bloqueo se ve desde cualquier instancia, porque está escrito.
    const check = await checkBruteForce(ip, phone);
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain('cuenta');
  });

  it('el bloqueo sobrevive a un reinicio', async () => {
    for (let i = 0; i < 5; i++) await recordFailedAttempt(ip, phone);

    // Un proceso nuevo solo hereda la base de datos. Antes, reiniciar era
    // una amnistía: el atacante solo tenía que esperar a un despliegue.
    const record = await LoginAttempt.findOne({ scope: 'user', key: `${phone}|${ip}` }).lean();
    expect(record!.lockedUntil).toBeInstanceOf(Date);
    expect(record!.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
  });

  it('entrar bien libera la cuenta pero no perdona la IP entera', async () => {
    await recordFailedAttempt(ip, phone);
    await recordFailedAttempt(ip, phone);
    await recordFailedAttempt(ip, phone);

    await clearAttempts(ip, phone);

    expect(await LoginAttempt.findOne({ scope: 'user', key: `${phone}|${ip}` })).toBeNull();

    // Detrás de una IP hay una casa o un café: que uno acierte no demuestra
    // que los demás intentos fueran legítimos, así que solo baja un punto.
    const ipRecord = await LoginAttempt.findOne({ scope: 'ip', key: ip });
    expect(ipRecord!.count).toBe(2);
  });

  it('cuentas distintas no se bloquean entre sí', async () => {
    for (let i = 0; i < 5; i++) await recordFailedAttempt(ip, phone);

    const otro = await checkBruteForce(ip, '3009999999');
    expect(otro.allowed).toBe(true);
  });
});
