import { describe, it, expect, afterEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import { config } from '../config';
import { User } from '../models';
import { UserRole } from '../types';
import { authenticateSocket } from '../sockets';
import { sessionManager } from '../security';
import { makeUser } from './factories';

/**
 * El handshake del socket.
 *
 * Es la única puerta por la que entra el seguimiento GPS en vivo, así que
 * quien la cruce sin permiso no solo escucha pedidos: aparece en el mapa de
 * flota emitiendo posiciones. Estas pruebas fijan que comprueba el estado
 * ACTUAL de la cuenta y no solo la firma del token.
 *
 * `authenticateSocket` ahora exige que el `sid` del token corresponda a una
 * `Session` activa (misma corrección que `authenticate`, ver A9 de la
 * auditoría), así que estos tokens de prueba también necesitan una sesión
 * real detrás — no solo una firma válida.
 */
const signFor = async (id: string, role: string, issuedAt?: number) => {
  const sessionId = new Types.ObjectId();
  await sessionManager.createSession({
    userId: id,
    sessionId,
    refreshToken: `test-refresh-${sessionId.toString()}`,
    ip: '127.0.0.1',
    userAgent: 'vitest',
  });
  return jwt.sign(
    { id, role, sid: sessionId.toString(), ...(issuedAt ? { iat: issuedAt } : {}) },
    config.jwt.secret,
    issuedAt ? {} : { expiresIn: '15m' }
  );
};

describe('authenticateSocket: el handshake del socket', () => {
  it('deja entrar a un usuario activo', async () => {
    const user = await makeUser({ role: UserRole.DRIVER });
    const identity = await authenticateSocket(await signFor(user._id.toString(), 'driver'));

    expect(identity.userId).toBe(user._id.toString());
    expect(identity.role).toBe(UserRole.DRIVER);
  });

  describe('S5: 2FA en la sala `admin`', () => {
    afterEach(() => {
      config.security.twoFactor.requiredForAdmins = false;
    });

    it('un admin sin TOTP identifica pero no satisface el 2FA cuando el flag está encendido', async () => {
      config.security.twoFactor.requiredForAdmins = true;
      const admin = await makeUser({ role: UserRole.ADMIN });

      const identity = await authenticateSocket(await signFor(admin._id.toString(), 'admin'));

      expect(identity.role).toBe(UserRole.ADMIN);
      expect(identity.twoFactorSatisfied).toBe(false);
    });

    it('un admin con TOTP activo sí lo satisface', async () => {
      config.security.twoFactor.requiredForAdmins = true;
      const admin = await makeUser({ role: UserRole.ADMIN });
      await User.updateOne({ _id: admin._id }, { $set: { twoFactorEnabled: true } });

      const identity = await authenticateSocket(await signFor(admin._id.toString(), 'admin'));

      expect(identity.twoFactorSatisfied).toBe(true);
    });

    it('con el flag apagado, cualquier admin lo satisface', async () => {
      const admin = await makeUser({ role: UserRole.ADMIN });
      const identity = await authenticateSocket(await signFor(admin._id.toString(), 'admin'));
      expect(identity.twoFactorSatisfied).toBe(true);
    });
  });

  it('rechaza a un usuario borrado aunque su token siga siendo válido', async () => {
    const user = await makeUser({ role: UserRole.DRIVER });
    const token = await signFor(user._id.toString(), 'driver');
    await User.findByIdAndDelete(user._id);

    // Este es el caso que se vio en los logs: tras un seed, el teléfono
    // conservaba un token perfectamente firmado de un usuario que ya no
    // existía, y el socket lo aceptaba.
    await expect(authenticateSocket(token)).rejects.toThrow(/no encontrado|desactivado/i);
  });

  it('rechaza a un usuario bloqueado', async () => {
    const user = await makeUser({ role: UserRole.DRIVER });
    const token = await signFor(user._id.toString(), 'driver');
    await User.findByIdAndUpdate(user._id, { isBlocked: true });

    // Un repartidor bloqueado por fraude no puede seguir emitiendo su
    // posición al mapa de flota hasta que caduque su access token.
    await expect(authenticateSocket(token)).rejects.toThrow(/bloqueada/i);
  });

  it('rechaza a un usuario desactivado', async () => {
    const user = await makeUser({ role: UserRole.CLIENT });
    const token = await signFor(user._id.toString(), 'client');
    await User.findByIdAndUpdate(user._id, { isActive: false });

    await expect(authenticateSocket(token)).rejects.toThrow(/no encontrado|desactivado/i);
  });

  it('cierra el socket cuando la contraseña cambió después de emitir el token', async () => {
    const user = await makeUser({ role: UserRole.CLIENT });
    const issuedAt = Math.floor(Date.now() / 1000) - 60;
    const token = await signFor(user._id.toString(), 'client', issuedAt);

    await User.findByIdAndUpdate(user._id, { passwordChangedAt: new Date() });

    // Cambiar la contraseña es lo que hace alguien que cree que le robaron
    // la cuenta. Sería inútil si el socket del atacante sobreviviera.
    await expect(authenticateSocket(token)).rejects.toThrow(/contraseña/i);
  });

  it('toma el rol de la base, no del token', async () => {
    const user = await makeUser({ role: UserRole.CLIENT });
    // Token que se declara admin. Si se creyera, entraría a la sala `admin`.
    const token = await signFor(user._id.toString(), 'admin');

    const identity = await authenticateSocket(token);
    expect(identity.role).toBe(UserRole.CLIENT);
  });

  it('rechaza un token ausente, vacío o con firma falsa', async () => {
    await expect(authenticateSocket(undefined)).rejects.toThrow(/requerido/i);
    await expect(authenticateSocket('')).rejects.toThrow(/requerido/i);
    await expect(authenticateSocket('no-es-un-jwt')).rejects.toThrow(/inválido/i);

    const user = await makeUser({ role: UserRole.DRIVER });
    const forged = jwt.sign({ id: user._id.toString(), role: 'admin' }, 'secreto-equivocado');
    await expect(authenticateSocket(forged)).rejects.toThrow(/inválido/i);
  });
});
