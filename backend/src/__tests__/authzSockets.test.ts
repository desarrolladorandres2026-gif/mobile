import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import { config } from '../config';
import { authenticateSocket, adminRoomsFor } from '../sockets';
import { sessionManager } from '../security';
import { featureFlagService } from '../services/featureFlag.service';
import { cache } from '../cache';
import { makeStaff } from './factories';

const signFor = async (id: string) => {
  const sessionId = new Types.ObjectId();
  await sessionManager.createSession({ userId: id, sessionId, refreshToken: `t-${sessionId}`, ip: '127.0.0.1', userAgent: 'vitest' });
  return jwt.sign({ id, role: 'admin', sid: sessionId.toString() }, config.jwt.secret, { expiresIn: '15m' });
};

const roomsOf = async (user: { _id: any }) => adminRoomsFor((await authenticateSocket(await signFor(user._id.toString()))).authz);

describe('salas de admin por permiso', () => {
  beforeEach(async () => {
    await featureFlagService.remove('rbac_enforce');
    await cache.flush();
  });
  afterEach(() => {
    config.security.twoFactor.requiredForAdmins = false;
  });

  it('enforce: soporte no recibe SOS ni flota; operaciones si; super_admin todo', async () => {
    await featureFlagService.upsert('rbac_enforce', { audience: 'staff' });
    await cache.flush();
    const soporte = await roomsOf(await makeStaff({ roleSlug: 'soporte' }));
    expect(soporte).toContain('admin:orders');
    expect(soporte).not.toContain('admin:sos');
    expect(soporte).not.toContain('admin:fleet');

    const ops = await roomsOf(await makeStaff({ roleSlug: 'operaciones' }));
    expect([...ops].sort()).toEqual(['admin:alerts', 'admin:fleet', 'admin:live', 'admin:orders', 'admin:sos']);

    expect(await roomsOf(await makeStaff({ roleSlug: null }))).toEqual(['admin:alerts', 'admin:live']);
    expect((await roomsOf(await makeStaff({ roleSlug: 'super_admin' }))).length).toBe(5);
  });

  it('observe: nadie pierde eventos (legacyUnion)', async () => {
    const soporte = await roomsOf(await makeStaff({ roleSlug: 'soporte' }));
    // legacyUnion del admin: incluye orders:view_all y drivers:track (soporte los tiene o los tenia).
    expect(soporte).toContain('admin:fleet');
    expect(soporte).toContain('admin:orders');
  });

  it('el 2FA sigue exigido en el handshake', async () => {
    config.security.twoFactor.requiredForAdmins = true;
    const admin = await makeStaff({ roleSlug: 'super_admin' });
    const identity = await authenticateSocket(await signFor(admin._id.toString()));
    expect(identity.twoFactorSatisfied).toBe(false);
  });
});
