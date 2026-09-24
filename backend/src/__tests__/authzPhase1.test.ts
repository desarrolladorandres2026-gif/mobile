import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { Role, User } from '../models';
import { UserRole } from '../types';
import { Permission, SUPER_ADMIN_ROLE_SLUG, STAFF_ROLE_PERMISSIONS, getPermissionsForRole, mapToExtendedRole } from '../security/rbac';
import { AuditAction, AuditLog } from '../security/audit';
import {
  authenticate,
  authorize,
  adminRequires,
  requirePermission,
  requireAnyPermission,
  requireFinanceAdmin,
  can,
} from '../middlewares/auth';
import { errorHandler } from '../middlewares/errorHandler';
import { resolveAuthorization, usersWithPermission } from '../services/authorization.service';
import { featureFlagService } from '../services/featureFlag.service';
import { cache } from '../cache';
import { makeUser, authHeader } from './factories';

/**
 * Fase 1 del panel admin: permisos reales por cargo con modo observación.
 * Monta un router mínimo para probar los middlewares de `auth.ts` sin depender
 * de qué rutas de producción los usen todavía.
 */

const ok = (_req: express.Request, res: express.Response) => {
  res.json({ ok: true });
};

const testApp = () => {
  const app = express();
  app.use(express.json());
  app.get('/perm', authenticate, requirePermission(Permission.REFUNDS_CREATE), ok);
  app.get('/any', authenticate, requireAnyPermission(Permission.REFUNDS_CREATE, Permission.PAYOUTS_REVEAL_ACCOUNT), ok);
  app.get('/finance', authenticate, requireFinanceAdmin, ok);
  app.get('/shared', authenticate, authorize(UserRole.ADMIN, UserRole.BUSINESS), adminRequires(Permission.ORDERS_CANCEL), ok);
  app.get('/inline', authenticate, (req, res) => {
    res.json({ can: can(req, Permission.REFUNDS_CREATE) });
  });
  app.get('/me', authenticate, (req, res) => {
    res.json({ authz: req.authz, permissions: req.permissions });
  });
  app.use(errorHandler);
  return app;
};

async function makeRole(slug: string, permissions: Permission[], extra: Record<string, unknown> = {}) {
  return Role.create({ name: slug, slug, permissions, isActive: true, isSystem: false, ...extra });
}

async function makeAdmin(roles: Array<{ _id: unknown }> = [], overrides: Record<string, unknown> = {}) {
  const user = await makeUser({ role: UserRole.ADMIN, ...overrides });
  if (roles.length) {
    user.roleIds = roles.map((r) => r._id) as any;
    await user.save();
  }
  return user;
}

async function setEnforce(on: boolean) {
  await featureFlagService.upsert('rbac_enforce', { audience: on ? 'staff' : 'off' });
}

const shadowLogs = (userId: string) =>
  AuditLog.find({ userId, action: AuditAction.PERMISSION_SHADOW_DENIED }).lean();

async function waitForShadow(userId: string, n: number) {
  for (let i = 0; i < 40; i++) {
    if ((await shadowLogs(userId)).length >= n) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  // margen para detectar duplicados que llegaran tarde
  await new Promise((r) => setTimeout(r, 100));
  return shadowLogs(userId);
}

describe('Fase 1: núcleo de permisos', () => {
  const app = testApp();

  beforeEach(async () => {
    await featureFlagService.remove('rbac_enforce');
    await cache.flush();
  });

  it('(a) super_admin recibe todos los permisos aunque su rol guardado esté desactualizado', async () => {
    const stale = await makeRole(SUPER_ADMIN_ROLE_SLUG, [Permission.ADMIN_PANEL], { isSystem: true });
    const owner = await makeAdmin([stale]);
    const authz = await resolveAuthorization(owner);
    expect(new Set(authz.strict)).toEqual(new Set(Object.values(Permission)));

    const res = await request(app).get('/perm').set(await authHeader(owner));
    expect(res.status).toBe(200);
  });

  it('(b) admin sin roles solo tiene admin:panel; con rol soporte, solo lo suyo', async () => {
    const bare = await makeAdmin();
    expect((await resolveAuthorization(bare)).strict).toEqual([Permission.ADMIN_PANEL]);

    const soporte = await makeRole('soporte', STAFF_ROLE_PERMISSIONS.soporte.permissions);
    const agent = await makeAdmin([soporte]);
    const { strict, legacyUnion } = await resolveAuthorization(agent);
    expect(new Set(strict)).toEqual(new Set(STAFF_ROLE_PERMISSIONS.soporte.permissions));
    expect(strict).not.toContain(Permission.REFUNDS_CREATE);
    expect(strict).toContain(Permission.REFUNDS_VIEW);
    // el conjunto legacy conserva lo que el admin tenía antes
    expect(legacyUnion).toContain(Permission.USERS_BLOCK);
  });

  it('roles base: decisiones del dueño', () => {
    const all = Object.values(STAFF_ROLE_PERMISSIONS).flatMap((r) => r.permissions);
    expect(all).not.toContain(Permission.USERS_BLOCK);
    expect(all).not.toContain(Permission.USERS_ROLE_CHANGE);
    expect(STAFF_ROLE_PERMISSIONS.finanzas.permissions).toContain(Permission.ZONES_MANAGE);
    expect(STAFF_ROLE_PERMISSIONS.operaciones.permissions).not.toContain(Permission.ZONES_MANAGE);
    expect(STAFF_ROLE_PERMISSIONS.soporte.permissions).not.toContain(Permission.REFUNDS_CREATE);
    for (const def of Object.values(STAFF_ROLE_PERMISSIONS)) {
      for (const p of def.permissions) expect(Object.values(Permission)).toContain(p);
    }
  });

  it('(c) comercio, domiciliario y cliente conservan exactamente su set legacy', async () => {
    for (const role of [UserRole.BUSINESS, UserRole.DRIVER, UserRole.CLIENT]) {
      const user = await makeUser({ role });
      const authz = await resolveAuthorization(user);
      const legacy = getPermissionsForRole(mapToExtendedRole(role));
      expect(new Set(authz.strict)).toEqual(new Set(legacy));
      expect(new Set(authz.legacyUnion)).toEqual(new Set(legacy));
    }
    const shop = await makeUser({ role: UserRole.BUSINESS });
    const res = await request(app).get('/finance').set(await authHeader(shop));
    expect(res.status).toBe(403);
  });

  it('(d) observe: pasa y deja UN solo AuditLog aunque se repita', async () => {
    const soporte = await makeRole('soporte', STAFF_ROLE_PERMISSIONS.soporte.permissions);
    const agent = await makeAdmin([soporte]);
    // REFUNDS_CREATE no está en legacy del admin: no es "observado". Usamos ORDERS_CANCEL,
    // que el admin legacy sí tenía y soporte no.
    const headers = await authHeader(agent);
    for (let i = 0; i < 3; i++) {
      const res = await request(app).get('/shared').set(headers);
      expect(res.status).toBe(200);
    }
    const logs = await waitForShadow(agent._id.toString(), 1);
    expect(logs).toHaveLength(1);
    expect(logs[0].metadata).toMatchObject({ permission: Permission.ORDERS_CANCEL, route: '/shared', roleSlugs: ['soporte'] });
    expect(logs[0].metadata?.path).toBe('/shared');

    const me = await request(app).get('/me').set(headers);
    expect(me.body.authz.mode).toBe('observe');
  });

  it('(d) observe: un permiso que ni el legacy tenía sigue dando 403', async () => {
    const agent = await makeAdmin();
    const res = await request(app).get('/perm').set(await authHeader(agent));
    expect(res.status).toBe(403);
    expect((await shadowLogs(agent._id.toString())).length).toBe(0);
  });

  it('(d) enforce: el mismo caso da 403 y no registra sombra', async () => {
    await setEnforce(true);
    const soporte = await makeRole('soporte', STAFF_ROLE_PERMISSIONS.soporte.permissions);
    const agent = await makeAdmin([soporte]);
    const res = await request(app).get('/shared').set(await authHeader(agent));
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/permisos suficientes/);
    expect((await shadowLogs(agent._id.toString())).length).toBe(0);
  });

  it('requireAnyPermission y can() siguen la misma lógica', async () => {
    const finanzas = await makeRole('finanzas', STAFF_ROLE_PERMISSIONS.finanzas.permissions);
    const fin = await makeAdmin([finanzas]);
    expect((await request(app).get('/any').set(await authHeader(fin))).status).toBe(200);
    expect((await request(app).get('/inline').set(await authHeader(fin))).body.can).toBe(true);

    const bare = await makeAdmin();
    expect((await request(app).get('/any').set(await authHeader(bare))).status).toBe(403);
    expect((await request(app).get('/inline').set(await authHeader(bare))).body.can).toBe(false);
  });

  it('(e) adminRequires no abre la ruta a otros roles ni la cierra para el comercio', async () => {
    const shop = await makeUser({ role: UserRole.BUSINESS });
    expect((await request(app).get('/shared').set(await authHeader(shop))).status).toBe(200);
    // el comercio no tiene orders:cancel y aun así pasa: el permiso solo aplica al admin

    const client = await makeUser({ role: UserRole.CLIENT });
    expect((await request(app).get('/shared').set(await authHeader(client))).status).toBe(403);

    await setEnforce(true);
    const bare = await makeAdmin();
    expect((await request(app).get('/shared').set(await authHeader(bare))).status).toBe(403);
    expect((await request(app).get('/shared').set(await authHeader(shop))).status).toBe(200);
  });

  it('los middlewares declaran __permissions', () => {
    expect((requirePermission(Permission.REFUNDS_VIEW, Permission.REFUNDS_CREATE) as any).__permissions).toEqual([
      'refunds:view',
      'refunds:create',
    ]);
    expect((adminRequires(Permission.ORDERS_CANCEL) as any).__permissions).toEqual(['orders:cancel']);
    expect((requireFinanceAdmin as any).__permissions).toEqual(['finance:manage']);
  });

  it('(f) requireFinanceAdmin ya no lee isFinanceAdmin (enforce)', async () => {
    await setEnforce(true);
    const flagged = await makeAdmin([], { isFinanceAdmin: true });
    expect((await request(app).get('/finance').set(await authHeader(flagged))).status).toBe(403);

    const finanzas = await makeRole('finanzas', STAFF_ROLE_PERMISSIONS.finanzas.permissions);
    const fin = await makeAdmin([finanzas]);
    expect((await request(app).get('/finance').set(await authHeader(fin))).status).toBe(200);
  });

  it('(f) en observación quien tenía isFinanceAdmin no pierde acceso, queda registrado', async () => {
    const flagged = await makeAdmin([], { isFinanceAdmin: true });
    expect((await request(app).get('/finance').set(await authHeader(flagged))).status).toBe(200);
    expect((await waitForShadow(flagged._id.toString(), 1)).length).toBe(1);
  });

  it('(g) usersWithPermission lista admins activos con el permiso estricto', async () => {
    const finanzas = await makeRole('finanzas', STAFF_ROLE_PERMISSIONS.finanzas.permissions);
    const fin = await makeAdmin([finanzas]);
    const superRole = await makeRole(SUPER_ADMIN_ROLE_SLUG, [], { isSystem: true });
    const owner = await makeAdmin([superRole]);
    const legacyFlag = await makeAdmin([], { isFinanceAdmin: true });
    const blocked = await makeAdmin([finanzas]);
    await User.updateOne({ _id: blocked._id }, { isBlocked: true });
    const shop = await makeUser({ role: UserRole.BUSINESS });

    const ids = (await usersWithPermission(Permission.FINANCE_MANAGE)).map((u) => u._id.toString());
    expect(ids).toContain(fin._id.toString());
    expect(ids).toContain(owner._id.toString());
    expect(ids).not.toContain(legacyFlag._id.toString());
    expect(ids).not.toContain(blocked._id.toString());
    expect(ids).not.toContain(shop._id.toString());
  });

  it('/auth/me: permissions estrictos, authzMode y observedPermissions', async () => {
    const soporte = await makeRole('soporte', STAFF_ROLE_PERMISSIONS.soporte.permissions);
    const agent = await makeAdmin([soporte]);
    const res = await request((await import('../app')).default).get('/api/v1/auth/me').set(await authHeader(agent));
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.authzMode).toBe('observe');
    expect(new Set(data.permissions)).toEqual(new Set(STAFF_ROLE_PERMISSIONS.soporte.permissions));
    expect(data.observedPermissions).toContain(Permission.ORDERS_CANCEL);
    expect(data.observedPermissions).not.toContain(Permission.SUPPORT_VIEW);

    await setEnforce(true);
    const enforced = await request((await import('../app')).default).get('/api/v1/auth/me').set(await authHeader(agent));
    expect(enforced.body.data.authzMode).toBe('enforce');
    expect(enforced.body.data.observedPermissions).toEqual([]);

    const shop = await makeUser({ role: UserRole.BUSINESS });
    const shopMe = await request((await import('../app')).default).get('/api/v1/auth/me').set(await authHeader(shop));
    expect(shopMe.body.data.observedPermissions).toEqual([]);
  });
});
