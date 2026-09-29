import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { AuditLog, FraudAlert } from '../security';
import { AuditAction } from '../security';
import { FeatureFlag, Order, Position, Role, User } from '../models';
import { Permission, STAFF_ROLE_PERMISSIONS, SUPER_ADMIN_ROLE_SLUG } from '../security/rbac';
import { UserRole } from '../types';
import { adminService } from '../services/admin.service';
import { positionService } from '../services/position.service';
import { roleService } from '../services/role.service';
import { featureFlagService } from '../services/featureFlag.service';
import { dailySummaryService } from '../services/dailySummary.service';
import { incidentCenterService } from '../services/incidentCenter.service';
import { profile360 } from '../services/userProfile360.service';
import { resolveAuthorization, actorIsSuperAdmin } from '../services/authorization.service';
import * as emitter from '../sockets/emitter';
import { cache } from '../cache';
import { authHeader, makeBusiness, makeProduct, makeStaff, makeUser } from './factories';

/**
 * Revisión de seguridad de la Fase 1: escalada por asignación de roles,
 * roles en cuentas no admin, modo ante fallo del flag, sockets y máscaras.
 * Por defecto se está en modo OBSERVACIÓN (sin flag): la guarda "no otorgar
 * más de lo que posees" debe valer igual, porque se evalúa contra `strict`.
 */

const A = '/api/v1';

async function roleWith(slug: string, permissions: Permission[]) {
  return Role.create({ name: slug, slug, permissions, isActive: true });
}

/** Admin cuyo único rol tiene esos permisos (más admin:panel implícito). */
async function adminWith(permissions: Permission[]) {
  const role = await roleWith(`r_${Date.now()}_${Math.round(Math.random() * 1e6)}`, permissions);
  const user = await makeUser({ role: UserRole.ADMIN });
  await User.updateOne({ _id: user._id }, { $set: { roleIds: [role._id] } });
  return (await User.findById(user._id))!;
}

async function finanzasRole() {
  return Role.findOneAndUpdate(
    { slug: 'finanzas' },
    {
      $set: { permissions: STAFF_ROLE_PERMISSIONS.finanzas.permissions, isActive: true },
      $setOnInsert: { name: 'Finanzas', description: 'x', isSystem: false },
    },
    { upsert: true, new: true }
  );
}

beforeEach(async () => {
  await featureFlagService.remove('rbac_enforce');
  await cache.flush();
});

afterEach(() => vi.restoreAllMocks());

describe('Escalada por asignación de roles (CRÍTICO 2)', () => {
  it('un admin sin rol NO puede asignar finanzas a un colega (modo observación)', async () => {
    const fin = await finanzasRole();
    const bare = await makeUser({ role: UserRole.ADMIN });
    const colleague = await makeUser({ role: UserRole.ADMIN });

    // En observación el admin sin rol conserva permisos heredados, pero la guarda mira `strict`.
    expect((await resolveAuthorization(bare)).mode).toBe('observe');
    await expect(adminService.assignRoles(colleague._id.toString(), [fin._id.toString()], bare)).rejects.toMatchObject({
      statusCode: 403,
      code: 'PRIVILEGE_ESCALATION_BLOCKED',
    });
    expect((await User.findById(colleague._id))!.roleIds).toHaveLength(0);
    expect(
      await AuditLog.findOne({ action: AuditAction.PRIVILEGE_ESCALATION_BLOCKED, userId: bare._id.toString() })
    ).toBeTruthy();
  });

  it('un rol con users:role_change pero sin finance:manage no puede otorgar finanzas', async () => {
    const fin = await finanzasRole();
    const actor = await adminWith([Permission.USERS_ROLE_CHANGE]);
    const colleague = await makeUser({ role: UserRole.ADMIN });

    await expect(adminService.assignRoles(colleague._id.toString(), [fin._id.toString()], actor)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('otorgar un rol cuyos permisos son subconjunto de los propios sí funciona', async () => {
    const small = await roleWith('subset', [Permission.ORDERS_VIEW_ALL]);
    const actor = await adminWith([Permission.USERS_ROLE_CHANGE, Permission.ORDERS_VIEW_ALL]);
    const colleague = await makeUser({ role: UserRole.ADMIN });

    await adminService.assignRoles(colleague._id.toString(), [small._id.toString()], actor);
    expect((await User.findById(colleague._id))!.roleIds.map(String)).toEqual([small._id.toString()]);
  });

  it('un Super Administrador sí puede otorgar finanzas', async () => {
    const fin = await finanzasRole();
    const boss = await makeStaff({ roleSlug: 'super_admin' });
    const colleague = await makeUser({ role: UserRole.ADMIN });

    await adminService.assignRoles(colleague._id.toString(), [fin._id.toString()], boss);
    expect((await User.findById(colleague._id))!.roleIds.map(String)).toContain(fin._id.toString());
  });

  it('asignar un Cargo también aplica la guarda (los roles del cargo se otorgan transitivamente)', async () => {
    const fin = await finanzasRole();
    const position = await Position.create({ name: 'Tesoreria', slug: 'tesoreria', roleIds: [fin._id], isActive: true });
    const bare = await makeUser({ role: UserRole.ADMIN });
    const colleague = await makeUser({ role: UserRole.ADMIN });

    await expect(adminService.assignPosition(colleague._id.toString(), position._id.toString(), bare)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('crear o editar un Cargo con roles que el actor no posee se rechaza', async () => {
    const fin = await finanzasRole();
    const actor = await adminWith([Permission.POSITIONS_CREATE, Permission.POSITIONS_UPDATE]);

    await expect(
      positionService.create({ name: 'Cargo caro', roleIds: [fin._id.toString()] }, actor)
    ).rejects.toMatchObject({ statusCode: 403 });

    const harmless = await Position.create({ name: 'Inocuo', slug: 'inocuo', roleIds: [], isActive: true });
    await expect(
      positionService.update(harmless._id.toString(), { roleIds: [fin._id.toString()] }, actor)
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('autoescalada vía Cargo: no se edita el Cargo propio ni se asigna uno a sí mismo', async () => {
    const own = await roleWith('own_role', [Permission.POSITIONS_UPDATE, Permission.USERS_ROLE_CHANGE]);
    const extra = await roleWith('extra_role', [Permission.ORDERS_VIEW_ALL]);
    const position = await Position.create({ name: 'Mi cargo', slug: 'mi_cargo', roleIds: [own._id], isActive: true });
    const actor = await makeUser({ role: UserRole.ADMIN });
    await User.updateOne({ _id: actor._id }, { $set: { positionId: position._id } });
    const me = (await User.findById(actor._id))!;

    await expect(
      positionService.update(position._id.toString(), { roleIds: [own._id.toString(), extra._id.toString()] }, me)
    ).rejects.toMatchObject({ statusCode: 403, code: 'PRIVILEGE_ESCALATION_BLOCKED' });
    expect((await Position.findById(position._id))!.roleIds).toHaveLength(1);

    await expect(adminService.assignPosition(me._id.toString(), position._id.toString(), me)).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(adminService.assignRoles(me._id.toString(), [extra._id.toString()], me)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('reactivar un Rol o un Cargo desactivado con permisos ajenos también se rechaza', async () => {
    const fin = await finanzasRole();
    await Role.updateOne({ _id: fin._id }, { $set: { isActive: false } });
    const actor = await adminWith([Permission.ROLES_UPDATE]);
    await expect(roleService.update(fin._id.toString(), { isActive: true }, actor, [])).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('Roles solo en cuentas admin (ALTO 3)', () => {
  it('assignRoles/assignPosition rechazan un destino que no es admin; vaciar sí se permite', async () => {
    const role = await roleWith('some_role', [Permission.ADMIN_PANEL]);
    const position = await Position.create({ name: 'P', slug: 'p', roleIds: [], isActive: true });
    const boss = await makeStaff({ roleSlug: 'super_admin' });
    const client = await makeUser({ role: UserRole.CLIENT });

    await expect(adminService.assignRoles(client._id.toString(), [role._id.toString()], boss)).rejects.toMatchObject({ statusCode: 400 });
    await expect(adminService.assignPosition(client._id.toString(), position._id.toString(), boss)).rejects.toMatchObject({ statusCode: 400 });
    await expect(adminService.assignRoles(client._id.toString(), [], boss)).resolves.toBeTruthy();
    await expect(adminService.assignPosition(client._id.toString(), null, boss)).resolves.toBeTruthy();
  });

  it('los roleIds guardados en una cuenta no admin no le dan permisos ni la vuelven super admin', async () => {
    const superRole = await roleWith(SUPER_ADMIN_ROLE_SLUG, Object.values(Permission));
    const shop = await makeUser({ role: UserRole.BUSINESS });
    const before = (await resolveAuthorization(shop)).strict;
    await User.updateOne({ _id: shop._id }, { $set: { roleIds: [superRole._id] } });
    const shopWithRole = (await User.findById(shop._id))!;

    const authz = await resolveAuthorization(shopWithRole);
    expect(new Set(authz.strict)).toEqual(new Set(before));
    expect(authz.strict).not.toContain(Permission.FINANCE_MANAGE);
    expect(authz.roleSlugs).toEqual([]);
    expect(await actorIsSuperAdmin(shopWithRole)).toBe(false);
  });

  it('el constructor de Explorar exige cuenta admin además del permiso', async () => {
    const superRole = await roleWith(SUPER_ADMIN_ROLE_SLUG, Object.values(Permission));
    const owner = await makeUser({ role: UserRole.BUSINESS });
    await User.updateOne({ _id: owner._id }, { $set: { roleIds: [superRole._id] } });
    const res = await request(app).get(`${A}/explore-layout/draft`).set(await authHeader((await User.findById(owner._id))!));
    expect(res.status).toBe(403);
  });

  it('POST /businesses: el admin necesita businesses:create; el dueño sigue igual', async () => {
    await featureFlagService.upsert('rbac_enforce', { audience: 'staff' });
    const bare = await makeUser({ role: UserRole.ADMIN });
    const denied = await request(app).post(`${A}/businesses`).set(await authHeader(bare)).send({});
    expect(denied.status).toBe(403);

    const owner = await makeUser({ role: UserRole.BUSINESS });
    const res = await request(app).post(`${A}/businesses`).set(await authHeader(owner)).send({});
    expect(res.status).not.toBe(403); // pasa a validación (400), no lo frena el permiso
    expect(res.status).toBe(400);
  });
});

describe('Modo del flag rbac_enforce (MEDIO 4)', () => {
  it('rechaza audiencias distintas de all, staff u off', async () => {
    await expect(featureFlagService.upsert('rbac_enforce', { audience: 'percentage', percentage: 50 })).rejects.toMatchObject({ statusCode: 400 });
    await expect(featureFlagService.upsert('rbac_enforce', { audience: 'staff' })).resolves.toBeTruthy();
    await expect(featureFlagService.upsert('rbac_enforce', { audience: 'all' })).resolves.toBeTruthy();
    await expect(featureFlagService.upsert('rbac_enforce', { audience: 'off' })).resolves.toBeTruthy();
    // otras claves conservan todas las audiencias
    await expect(featureFlagService.upsert('otra_funcion', { audience: 'percentage', percentage: 10 })).resolves.toBeTruthy();
  });

  it('si la lectura del flag falla, se conserva el último valor conocido', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    await featureFlagService.upsert('rbac_enforce', { audience: 'staff' });
    expect((await resolveAuthorization(admin)).mode).toBe('enforce');

    featureFlagService.invalidate();
    vi.spyOn(FeatureFlag, 'find').mockImplementation(() => {
      throw new Error('mongo caído');
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect((await resolveAuthorization(admin)).mode).toBe('enforce');
  });
});

describe('Sockets se recalculan (MEDIO 5)', () => {
  function fakeIO() {
    const disconnectSockets = vi.fn();
    const io = { in: vi.fn().mockReturnValue({ disconnectSockets }) };
    vi.spyOn(emitter, 'getIO').mockReturnValue(io as any);
    return { io, disconnectSockets };
  }

  it('cambiar rbac_enforce desconecta los sockets de todas las cuentas admin (y solo de ellas)', async () => {
    const a1 = await makeUser({ role: UserRole.ADMIN });
    const a2 = await makeUser({ role: UserRole.ADMIN });
    const client = await makeUser({ role: UserRole.CLIENT });
    const { io, disconnectSockets } = fakeIO();

    await featureFlagService.upsert('rbac_enforce', { audience: 'all' });
    const rooms: string[] = io.in.mock.calls.flatMap((c) => c[0]);
    expect(rooms).toEqual(expect.arrayContaining([`user:${a1._id}`, `user:${a2._id}`]));
    expect(rooms).not.toContain(`user:${client._id}`);
    expect(disconnectSockets).toHaveBeenCalledWith(true);

    io.in.mockClear();
    await featureFlagService.upsert('otra_funcion', { audience: 'all' });
    expect(io.in).not.toHaveBeenCalled();
  });

  it('editar un Rol desconecta a quien lo tiene directo o por Cargo', async () => {
    const role = await roleWith('editable', [Permission.ORDERS_VIEW_ALL]);
    const direct = await makeUser({ role: UserRole.ADMIN });
    await User.updateOne({ _id: direct._id }, { $set: { roleIds: [role._id] } });
    const position = await Position.create({ name: 'Por cargo', slug: 'por_cargo', roleIds: [role._id], isActive: true });
    const viaPosition = await makeUser({ role: UserRole.ADMIN });
    await User.updateOne({ _id: viaPosition._id }, { $set: { positionId: position._id } });
    const unrelated = await makeUser({ role: UserRole.ADMIN });
    const boss = await makeStaff({ roleSlug: 'super_admin' });
    const { io } = fakeIO();

    await roleService.update(role._id.toString(), { permissions: [Permission.ORDERS_VIEW_ALL, Permission.DRIVERS_TRACK] }, boss, []);
    const rooms: string[] = io.in.mock.calls.flatMap((c) => c[0]);
    expect(rooms).toEqual(expect.arrayContaining([`user:${direct._id}`, `user:${viaPosition._id}`]));
    expect(rooms).not.toContain(`user:${unrelated._id}`);
  });

  it('editar un Cargo desconecta a sus usuarios', async () => {
    const position = await Position.create({ name: 'Editable', slug: 'editable', roleIds: [], isActive: true });
    const holder = await makeUser({ role: UserRole.ADMIN });
    await User.updateOne({ _id: holder._id }, { $set: { positionId: position._id } });
    const boss = await makeStaff({ roleSlug: 'super_admin' });
    const { io } = fakeIO();

    await positionService.update(position._id.toString(), { name: 'Editable 2' }, boss);
    expect(io.in.mock.calls.flatMap((c) => c[0])).toContain(`user:${holder._id}`);
  });
});

describe('Vistas enmascaradas sin fugas (MEDIO 6)', () => {
  it('el resumen diario sin finance:view no lleva cifras en pesos en los flags', async () => {
    // En observación un admin conserva finance:view heredado; la máscara solo se ve con el bloqueo activo.
    await featureFlagService.upsert('rbac_enforce', { audience: 'staff' });
    const viewer = await makeStaff({ roleSlug: 'operaciones', permissions: [Permission.ADMIN_PANEL, Permission.REPORTS_VIEW] });
    const snapshot = { gmv: 1, ordersCreated: 1 };
    vi.spyOn(dailySummaryService, 'generate').mockResolvedValue({
      date: '2026-09-24',
      today: snapshot,
      baseline: snapshot,
      comparison: [],
      topBusinessesByOrders: [],
      flags: [
        { level: 'critical', code: 'MARGEN_NEGATIVO', message: 'El día cerró con margen negativo ($-1.234.567). Revisa.' },
        { level: 'warn', code: 'PROMOCION_CARA', message: 'Las promociones costaron $500.000, más del 10 % del GMV ($3.000.000).' },
        { level: 'warn', code: 'REEMBOLSOS_ALTOS', message: 'Se reembolsó $80.000 (3 pedidos), más del 5 % del GMV.' },
        { level: 'warn', code: 'CANCELACION_ALTA', message: 'Cancelaciones por encima de lo normal: 20 % (2 de 10).' },
      ],
    } as any);

    const res = await request(app).get(`${A}/admin/daily-summary`).set(await authHeader(viewer));
    expect(res.status).toBe(200);
    const flags = res.body.data.flags as Array<{ code: string; message: string }>;
    expect(flags).toHaveLength(4);
    expect(JSON.stringify(flags)).not.toMatch(/\$/);
    expect(flags.find((f) => f.code === 'CANCELACION_ALTA')!.message).toMatch(/2 de 10/);
  });

  it('resumen diario sin finance:view: ni el mes anterior, ni pendientes, ni detalle por pedido', async () => {
    await featureFlagService.upsert('rbac_enforce', { audience: 'staff' });
    const viewer = await makeStaff({ roleSlug: 'operaciones', permissions: [Permission.ADMIN_PANEL, Permission.REPORTS_VIEW] });
    const snapshot = { gmv: 1, netRevenue: 1, deliveryFees: 1, ordersCreated: 1 };
    vi.spyOn(dailySummaryService, 'generate').mockResolvedValue({
      date: '2026-09-24',
      today: snapshot,
      baseline: snapshot,
      monthBaseline: snapshot,
      comparison: [],
      monthComparison: [
        { metric: 'gmv', label: 'GMV' },
        { metric: 'ordersCreated', label: 'Pedidos creados' },
      ],
      pending: { merchants: { ledgerBalance: 999 } },
      gateway: { state: 'ok' },
      topBusinessesByOrders: [],
      flags: [],
    } as any);

    const res = await request(app).get(`${A}/admin/daily-summary`).set(await authHeader(viewer));
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.monthBaseline.gmv).toBeUndefined();
    expect(data.monthBaseline.deliveryFees).toBeUndefined();
    expect(data.monthBaseline.ordersCreated).toBe(1);
    expect(data.monthComparison.map((r: { metric: string }) => r.metric)).toEqual(['ordersCreated']);
    expect(data.pending).toBeUndefined();
    expect(data.gateway).toBeUndefined();

    const detail = await request(app).get(`${A}/admin/daily-summary/finance-detail`).set(await authHeader(viewer));
    expect(detail.status).toBe(403);
  });

  it('ficha 360 enmascarada: sin IP/deviceId/accountIds, sin metadata libre y sin comisión', async () => {
    const client = await makeUser({ role: UserRole.CLIENT });
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id);
    const product = await makeProduct(business._id);
    await FraudAlert.create({
      userId: client._id.toString(),
      type: 'multiple_accounts_device',
      status: 'open',
      riskLevel: 'high',
      riskScore: 75,
      description: '3 cuentas',
      evidence: { deviceId: 'dev-secret', accountIds: ['a', 'b'], ip: '10.9.8.7', accountCount: 3 },
    });
    await AuditLog.create({
      userId: client._id.toString(),
      action: AuditAction.ROLE_CHANGED,
      entity: 'user',
      description: 'x',
      ip: '10.9.8.7',
      userAgent: 'ua',
      metadata: { previousRole: 'client', newRole: 'driver', secretNote: 'no salir', ip: '10.9.8.7' },
    } as any);
    await Order.collection.insertOne({
      clientId: client._id,
      businessId: business._id,
      orderNumber: 'Z-1',
      status: 'delivered',
      total: 20000,
      createdAt: new Date(),
      finance: { customerTotal: 20000, productSubtotal: 18000, merchantCommission: 2700, businessPayout: 15300, appliedCommissionBps: 1500 },
    });
    void product;

    const masked: any = await profile360(client._id.toString());
    const alert = masked.risk.openAlerts[0];
    expect(alert.evidence).toEqual({ accountCount: 3 });
    expect(JSON.stringify(masked)).not.toMatch(/dev-secret|10\.9\.8\.7|secretNote/);
    expect(masked.recentActions[0].metadata).toEqual({ previousRole: 'client', newRole: 'driver' });
    expect(masked.recentOrders[0].finance).toEqual({ customerTotal: 20000, productSubtotal: 18000 });

    const withCommissions: any = await profile360(client._id.toString(), { commissions: true });
    expect(withCommissions.recentOrders[0].finance.merchantCommission).toBe(2700);
    const sensitive: any = await profile360(client._id.toString(), { sensitive: true, commissions: true });
    expect(sensitive.risk.openAlerts[0].evidence.deviceId).toBe('dev-secret');
    expect(sensitive.recentActions[0].metadata.secretNote).toBe('no salir');
  });
});

describe('Centro de incidentes falla cerrado (BAJO)', () => {
  it('sin predicado explícito no devuelve nada', async () => {
    expect(await incidentCenterService.open()).toEqual([]);
    const summary: any = await incidentCenterService.summary();
    expect(Object.values(summary).filter((v) => typeof v === 'number').every((v) => v === 0)).toBe(true);
  });
});
