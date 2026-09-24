import { describe, it, expect, vi, beforeEach } from 'vitest';
import { adminService } from '../services/admin.service';
import * as emitter from '../sockets/emitter';
import { cashIncidentService } from '../services/cashIncident.service';
import { notificationService } from '../services/notification.service';
import { Role } from '../models';
import { Permission } from '../security/rbac';
import { UserRole } from '../types';
import { makeStaff, makeUser } from './factories';

describe('Equipo: sockets, bloqueo y avisos', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('cambiar roles desconecta los sockets de la persona', async () => {
    const disconnectSockets = vi.fn();
    const io = { in: vi.fn().mockReturnValue({ disconnectSockets }) };
    vi.spyOn(emitter, 'getIO').mockReturnValue(io as any);
    const boss = await makeStaff({ roleSlug: 'super_admin' });
    const target = await makeStaff();
    const role = await Role.create({ name: 'X', slug: 'x', permissions: [Permission.ADMIN_PANEL] });

    await adminService.assignRoles(target._id.toString(), [role._id.toString()], boss);
    expect(io.in).toHaveBeenCalledWith(`user:${target._id}`);
    expect(disconnectSockets).toHaveBeenCalledWith(true);
  });

  it('solo el Super Administrador bloquea o activa cuentas', async () => {
    const boss = await makeStaff({ roleSlug: 'super_admin' });
    const ops = await makeStaff({ roleSlug: 'operaciones', permissions: [Permission.ADMIN_PANEL, Permission.USERS_BLOCK] });
    const victim = await makeUser();

    await expect(adminService.setUserStatus(victim._id.toString(), 'blocked', ops, 'x')).rejects.toMatchObject({ statusCode: 403 });
    const blocked = await adminService.setUserStatus(victim._id.toString(), 'blocked', boss, 'x');
    expect(blocked.isBlocked).toBe(true);
    await expect(adminService.setUserStatus(victim._id.toString(), 'active', ops, 'x')).rejects.toMatchObject({ statusCode: 403 });
  });

  it('el aviso de faltantes va a quien tiene finance:manage, no a quien solo tiene isFinanceAdmin', async () => {
    const spy = vi.spyOn(notificationService, 'notifySystem').mockResolvedValue(undefined as any);
    const fin = await makeStaff({ roleSlug: 'finanzas' });
    const legacy = await makeUser({ role: UserRole.ADMIN, isFinanceAdmin: true });

    await (cashIncidentService as any).notifyFinanceAdmins(
      { _id: fin._id, orderNumber: 'A1' },
      { _id: fin._id, amount: 1000 }
    );
    const targets = spy.mock.calls.map((c) => c[0]);
    expect(targets).toContain(fin._id.toString());
    expect(targets).not.toContain(legacy._id.toString());
  });
});
