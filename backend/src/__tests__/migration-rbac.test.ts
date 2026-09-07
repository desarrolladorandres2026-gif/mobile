import { describe, it, expect } from 'vitest';
import { migrateRbac } from '../migrations/002-rbac';
import { Position, Role, User } from '../models';
import { UserRole } from '../types';
import { SUPER_ADMIN_ROLE_SLUG } from '../security/rbac';
import { makeUser } from './factories';

describe('Migración 002 — Seguridad y Acceso', () => {
  it('sin cuentas admin: siembra Roles/Cargos pero no asigna Super Admin a nadie', async () => {
    const report = await migrateRbac();

    expect(report.rolesCreated).toContain(SUPER_ADMIN_ROLE_SLUG);
    expect(report.positionsCreated).toContain('superadministrador');
    expect(report.superAdminAssignedTo).toBeNull();

    const superAdminRole = await Role.findOne({ slug: SUPER_ADMIN_ROLE_SLUG });
    expect(superAdminRole!.permissions.length).toBeGreaterThan(30);
    expect(superAdminRole!.isSystem).toBe(true);
  });

  it('asigna Super Admin a la cuenta `role: admin` más antigua, sin tocar a las demás', async () => {
    const older = await makeUser({ role: UserRole.ADMIN, name: 'Admin viejo' });
    // Fuerza un createdAt anterior — el orden real de creación en el test
    // puede quedar dentro del mismo milisegundo.
    await User.updateOne({ _id: older._id }, { $set: { createdAt: new Date(Date.now() - 60_000) } });
    const newer = await makeUser({ role: UserRole.ADMIN, name: 'Admin nuevo' });

    const report = await migrateRbac();

    expect(report.superAdminAssignedTo).toBe(older._id.toString());

    const superAdminRole = await Role.findOne({ slug: SUPER_ADMIN_ROLE_SLUG });
    const refreshedOlder = await User.findById(older._id);
    const refreshedNewer = await User.findById(newer._id);

    expect(refreshedOlder!.roleIds.map((id) => id.toString())).toContain(superAdminRole!._id.toString());
    expect(refreshedNewer!.roleIds.length).toBe(0);
  });

  it('es idempotente: correr dos veces no duplica roles/cargos ni reasigna nada raro', async () => {
    await makeUser({ role: UserRole.ADMIN });

    await migrateRbac();
    const firstRoleCount = await Role.countDocuments();
    const firstPositionCount = await Position.countDocuments();

    const secondReport = await migrateRbac();
    const secondRoleCount = await Role.countDocuments();
    const secondPositionCount = await Position.countDocuments();

    expect(secondRoleCount).toBe(firstRoleCount);
    expect(secondPositionCount).toBe(firstPositionCount);
    expect(secondReport.rolesCreated.length).toBe(0);
    expect(secondReport.positionsCreated.length).toBe(0);
  });

  it('resincroniza los permisos del rol SUPER_ADMIN con el enum actual si ya existía', async () => {
    await Role.create({
      name: 'Super Administrador',
      slug: SUPER_ADMIN_ROLE_SLUG,
      permissions: ['users:view'], // simula un rol de sistema desactualizado
      isSystem: true,
      isActive: true,
    });

    await migrateRbac();

    const role = await Role.findOne({ slug: SUPER_ADMIN_ROLE_SLUG });
    expect(role!.permissions.length).toBeGreaterThan(30);
  });
});
