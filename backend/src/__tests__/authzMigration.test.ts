import { describe, it, expect } from 'vitest';
import { migrateStaffRoles, StaffMigrationAbort } from '../migrations/019-staff-roles';
import { Role, User } from '../models';
import { STAFF_ROLE_PERMISSIONS, SUPER_ADMIN_ROLE_SLUG, Permission } from '../security/rbac';
import { UserRole } from '../types';
import { makeUser } from './factories';

describe('Migracion 019 - roles del equipo', () => {
  it('en seco no escribe nada pero informa', async () => {
    const a = await makeUser({ role: UserRole.ADMIN });
    const report = await migrateStaffRoles({ dryRun: true });
    expect(await Role.countDocuments()).toBe(0);
    expect((await User.findById(a._id))!.roleIds.length).toBe(0);
    expect(report.roles.map((r) => r.slug)).toContain('finanzas');
    expect(report.superAdminsAssigned).toContain(a.email);
  });

  it('crea los roles, asigna Super Admin y es idempotente', async () => {
    const a = await makeUser({ role: UserRole.ADMIN });
    await migrateStaffRoles();
    const superRole = await Role.findOne({ slug: SUPER_ADMIN_ROLE_SLUG });
    expect(superRole!.permissions.length).toBe(Object.values(Permission).length);
    expect((await User.findById(a._id))!.roleIds.map(String)).toContain(String(superRole!._id));
    for (const slug of Object.keys(STAFF_ROLE_PERMISSIONS)) expect(await Role.findOne({ slug })).toBeTruthy();

    const count = await Role.countDocuments();
    const second = await migrateStaffRoles();
    expect(await Role.countDocuments()).toBe(count);
    expect((await User.findById(a._id))!.roleIds.length).toBe(1);
    expect(second.superAdminsAssigned).toEqual([]);
  });

  it('respeta un rol editado por el dueno salvo --force-roles', async () => {
    const editor = await makeUser({ role: UserRole.ADMIN });
    await Role.create({ name: 'Finanzas', slug: 'finanzas', permissions: [Permission.ADMIN_PANEL], updatedBy: editor._id });
    const r = await migrateStaffRoles();
    expect(r.roles.find((x) => x.slug === 'finanzas')!.action).toBe('skipped_edited');
    expect((await Role.findOne({ slug: 'finanzas' }))!.permissions).toEqual([Permission.ADMIN_PANEL]);
    await migrateStaffRoles({ forceRoles: true });
    expect((await Role.findOne({ slug: 'finanzas' }))!.permissions).toContain(Permission.FINANCE_MANAGE);
  });

  it('aborta con mas de 2 admins y funciona con --super-admins', async () => {
    const a = await makeUser({ role: UserRole.ADMIN });
    const b = await makeUser({ role: UserRole.ADMIN });
    const c = await makeUser({ role: UserRole.ADMIN });
    await expect(migrateStaffRoles()).rejects.toBeInstanceOf(StaffMigrationAbort);
    expect(await Role.countDocuments()).toBe(0);

    await migrateStaffRoles({ superAdmins: [a.email!] });
    const superRole = await Role.findOne({ slug: SUPER_ADMIN_ROLE_SLUG });
    expect((await User.findById(a._id))!.roleIds.map(String)).toContain(String(superRole!._id));
    expect((await User.findById(b._id))!.roleIds.length).toBe(0);
    expect((await User.findById(c._id))!.roleIds.length).toBe(0);
  });

  it('migra isFinanceAdmin al rol finanzas sin borrar el campo, y el informe lista lo que pierde', async () => {
    const boss = await makeUser({ role: UserRole.ADMIN });
    const fin = await makeUser({ role: UserRole.ADMIN, isFinanceAdmin: true });
    const plain = await makeUser({ role: UserRole.ADMIN });
    const report = await migrateStaffRoles({ superAdmins: [boss.email!] });

    const finRole = await Role.findOne({ slug: 'finanzas' });
    const finAfter = (await User.findById(fin._id))!;
    expect(finAfter.roleIds.map(String)).toContain(String(finRole!._id));
    expect(finAfter.isFinanceAdmin).toBe(true);
    expect((await User.findById(plain._id))!.roleIds.length).toBe(0);

    const plainRep = report.people.find((p) => p.email === plain.email)!;
    expect(plainRep.roles).toEqual([]);
    expect(plainRep.loses).toContain(Permission.ORDERS_VIEW_ALL);
    expect(report.people.find((p) => p.email === boss.email)!.loses).toEqual([]);
    expect(report.people.find((p) => p.email === fin.email)!.roles).toContain('finanzas');
  });
});
