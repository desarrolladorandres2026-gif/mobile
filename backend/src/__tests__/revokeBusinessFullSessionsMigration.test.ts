import { describe, it, expect } from 'vitest';
import { Types } from 'mongoose';
import { Session, sessionManager } from '../security';
import { UserRole } from '../types';
import { migrateRevokeBusinessFullSessions } from '../migrations/028-revoke-business-full-sessions';
import { makeUser, authHeader, counterAuthHeader } from './factories';

/**
 * Migración 028: corte manual de C1. Revoca solo las sesiones COMPLETAS de
 * cuentas de comercio (`scope: 'full'`, sin `elevatedFrom`). Deja las de
 * mostrador, las elevadas y las de cualquier otro rol.
 */
const active = (userId: string) => Session.countDocuments({ userId, isActive: true });

async function elevatedSession(userId: string, parentSessionId: string) {
  const sessionId = new Types.ObjectId();
  await sessionManager.createSession({
    userId,
    sessionId,
    refreshToken: `test-refresh-${sessionId.toString()}`,
    ip: '127.0.0.1',
    userAgent: 'vitest',
    scope: 'full',
    elevatedFrom: parentSessionId,
  });
}

describe('Migración 028: sesiones completas de comercio', () => {
  it('revoca la completa del comercio y deja mostrador, elevadas y otros roles', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const ownerId = owner._id.toString();
    const client = await makeUser({ role: UserRole.CLIENT });

    await authHeader(owner); // full, sin elevatedFrom: la que se revoca
    await counterAuthHeader(owner);
    const counter = await Session.findOne({ userId: ownerId, scope: 'counter' });
    await elevatedSession(ownerId, counter!._id.toString());
    await authHeader(client);

    expect(await active(ownerId)).toBe(3);

    const dry = await migrateRevokeBusinessFullSessions({ dryRun: true });
    expect(dry).toMatchObject({ businessUsers: 1, sessionsRevoked: 1, dryRun: true });
    expect(await active(ownerId)).toBe(3);

    const report = await migrateRevokeBusinessFullSessions();
    expect(report).toMatchObject({ businessUsers: 1, sessionsRevoked: 1, dryRun: false });
    expect(await active(ownerId)).toBe(2);
    expect(await Session.countDocuments({ userId: ownerId, isActive: true, scope: 'counter' })).toBe(1);
    expect(await Session.countDocuments({ userId: ownerId, isActive: true, elevatedFrom: { $ne: null } })).toBe(1);
    expect(await active(client._id.toString())).toBe(1);
  });

  it('es idempotente', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    await authHeader(owner);
    expect((await migrateRevokeBusinessFullSessions()).sessionsRevoked).toBe(1);
    expect((await migrateRevokeBusinessFullSessions()).sessionsRevoked).toBe(0);
  });
});
