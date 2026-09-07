import { describe, it, expect } from 'vitest';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { User } from '../models';
import { UserRole } from '../types';
import { authenticateSocket } from '../sockets';
import { makeUser } from './factories';

/**
 * El handshake del socket.
 *
 * Es la única puerta por la que entra el seguimiento GPS en vivo, así que
 * quien la cruce sin permiso no solo escucha pedidos: aparece en el mapa de
 * flota emitiendo posiciones. Estas pruebas fijan que comprueba el estado
 * ACTUAL de la cuenta y no solo la firma del token.
 */
const signFor = (id: string, role: string, issuedAt?: number) =>
  jwt.sign(
    { id, role, ...(issuedAt ? { iat: issuedAt } : {}) },
    config.jwt.secret,
    issuedAt ? {} : { expiresIn: '15m' }
  );

describe('authenticateSocket: el handshake del socket', () => {
  it('deja entrar a un usuario activo', async () => {
    const user = await makeUser({ role: UserRole.DRIVER });
    const identity = await authenticateSocket(signFor(user._id.toString(), 'driver'));

    expect(identity.userId).toBe(user._id.toString());
    expect(identity.role).toBe(UserRole.DRIVER);
  });

  it('rechaza a un usuario borrado aunque su token siga siendo válido', async () => {
    const user = await makeUser({ role: UserRole.DRIVER });
    const token = signFor(user._id.toString(), 'driver');
    await User.findByIdAndDelete(user._id);

    // Este es el caso que se vio en los logs: tras un seed, el teléfono
    // conservaba un token perfectamente firmado de un usuario que ya no
    // existía, y el socket lo aceptaba.
    await expect(authenticateSocket(token)).rejects.toThrow(/no encontrado|desactivado/i);
  });

  it('rechaza a un usuario bloqueado', async () => {
    const user = await makeUser({ role: UserRole.DRIVER });
    const token = signFor(user._id.toString(), 'driver');
    await User.findByIdAndUpdate(user._id, { isBlocked: true });

    // Un repartidor bloqueado por fraude no puede seguir emitiendo su
    // posición al mapa de flota hasta que caduque su access token.
    await expect(authenticateSocket(token)).rejects.toThrow(/bloqueada/i);
  });

  it('rechaza a un usuario desactivado', async () => {
    const user = await makeUser({ role: UserRole.CLIENT });
    const token = signFor(user._id.toString(), 'client');
    await User.findByIdAndUpdate(user._id, { isActive: false });

    await expect(authenticateSocket(token)).rejects.toThrow(/no encontrado|desactivado/i);
  });

  it('cierra el socket cuando la contraseña cambió después de emitir el token', async () => {
    const user = await makeUser({ role: UserRole.CLIENT });
    const issuedAt = Math.floor(Date.now() / 1000) - 60;
    const token = signFor(user._id.toString(), 'client', issuedAt);

    await User.findByIdAndUpdate(user._id, { passwordChangedAt: new Date() });

    // Cambiar la contraseña es lo que hace alguien que cree que le robaron
    // la cuenta. Sería inútil si el socket del atacante sobreviviera.
    await expect(authenticateSocket(token)).rejects.toThrow(/contraseña/i);
  });

  it('toma el rol de la base, no del token', async () => {
    const user = await makeUser({ role: UserRole.CLIENT });
    // Token que se declara admin. Si se creyera, entraría a la sala `admin`.
    const token = signFor(user._id.toString(), 'admin');

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
