import { describe, it, expect } from 'vitest';
import { User } from '../models';
import { UserRole } from '../types';
import { migrateAuthHardening } from '../migrations/004-auth-hardening';
import { makeUser } from './factories';

/**
 * `refreshToken` ya no está en el esquema de `IUser` (ver `models/User.ts`).
 * Se escribe y se lee con el driver crudo, sin pasar por el tipado de
 * Mongoose (que en modo `strict` descarta al escribir cualquier campo que
 * no esté declarado en el esquema) — es justo la forma en que quedó el dato
 * en un documento de antes de este cambio.
 */
async function setRawRefreshToken(userId: unknown, value: string): Promise<void> {
  await User.collection.updateOne({ _id: userId as any }, { $set: { refreshToken: value } });
}

async function rawRefreshToken(userId: unknown): Promise<unknown> {
  const doc = await User.collection.findOne({ _id: userId as any });
  return doc?.refreshToken;
}

/**
 * Migración 004: retira `refreshToken` en claro y marca `phoneVerified` en
 * las cuentas que ya lo demostraron por OTP antes de que existiera el campo.
 */
describe('Migración 004 — endurecimiento de autenticación', () => {
  it('retira el refreshToken legado y marca phoneVerified solo donde corresponde', async () => {
    const clientVerified = await makeUser({ role: UserRole.CLIENT });
    await User.updateOne({ _id: clientVerified._id }, { $set: { isVerified: true } });
    await setRawRefreshToken(clientVerified._id, 'token-legado-en-claro');

    // Un cliente sin verificar: no se toca.
    const clientUnverified = await makeUser({ role: UserRole.CLIENT });
    await User.updateOne({ _id: clientUnverified._id }, { $set: { isVerified: false } });

    // Una cuenta de Google sin celular todavía: tampoco se toca, aunque
    // isVerified sea true en algún estado intermedio.
    const googleUser = await makeUser({ role: UserRole.CLIENT });
    await User.updateOne({ _id: googleUser._id }, { $set: { isVerified: true, googleId: 'google-sub-1' } });

    // Un admin: no lo alcanza el filtro (solo `client`).
    const admin = await makeUser({ role: UserRole.ADMIN });
    await setRawRefreshToken(admin._id, 'otro-token-legado');

    const report = await migrateAuthHardening();

    expect(report.usersWithLegacyRefreshTokenCleared).toBe(2);
    expect(report.usersMarkedPhoneVerified).toBe(1);

    expect(await rawRefreshToken(clientVerified._id)).toBeUndefined();
    const refreshed = await User.findById(clientVerified._id);
    expect(refreshed!.phoneVerified).toBe(true);

    expect((await User.findById(clientUnverified._id))!.phoneVerified).toBeFalsy();
    expect((await User.findById(googleUser._id))!.phoneVerified).toBeFalsy();

    expect(await rawRefreshToken(admin._id)).toBeUndefined();
  });

  it('es segura de correr dos veces (no vuelve a contar lo ya migrado)', async () => {
    const client = await makeUser({ role: UserRole.CLIENT });
    await User.updateOne({ _id: client._id }, { $set: { isVerified: true } });
    await setRawRefreshToken(client._id, 'x');

    const first = await migrateAuthHardening();
    expect(first.usersMarkedPhoneVerified).toBeGreaterThan(0);

    const second = await migrateAuthHardening();
    expect(second.usersWithLegacyRefreshTokenCleared).toBe(0);
    expect(second.usersMarkedPhoneVerified).toBe(0);
  });

  it('en modo `dryRun` cuenta pero no escribe nada', async () => {
    const client = await makeUser({ role: UserRole.CLIENT });
    await User.updateOne({ _id: client._id }, { $set: { isVerified: true } });
    await setRawRefreshToken(client._id, 'x');

    const report = await migrateAuthHardening({ dryRun: true });
    expect(report.usersMarkedPhoneVerified).toBe(1);

    expect(await rawRefreshToken(client._id)).toBe('x');
    const untouched = await User.findById(client._id);
    expect(untouched!.phoneVerified).toBeFalsy();
  });
});
