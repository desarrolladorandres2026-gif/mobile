import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../app';
import { User, Position, Role } from '../models';
import { AuditLog, AuditAction } from '../security';
import { UserRole } from '../types';
import { Permission, SUPER_ADMIN_ROLE_SLUG } from '../security/rbac';
import { makeUser, authHeader } from './factories';

/**
 * Cobertura de la sección 19 de la especificación: autenticación,
 * autorización por permiso, estados de cuenta, escalamiento de
 * privilegios y que los cambios de rol/permiso se reflejan de inmediato
 * (sin reemitir el token — `authenticate` recalcula en cada request).
 */

async function makeRole(overrides: Partial<{ name: string; slug: string; permissions: Permission[]; isSystem: boolean; isActive: boolean }> = {}) {
  return Role.create({
    name: overrides.name ?? `Rol de prueba ${Date.now()}-${Math.random()}`,
    slug: overrides.slug ?? `role_${Date.now()}_${Math.round(Math.random() * 1e6)}`,
    permissions: overrides.permissions ?? [],
    isSystem: overrides.isSystem ?? false,
    isActive: overrides.isActive ?? true,
  });
}

/** El rol de sistema tal como lo produce migrations/002-rbac.ts. */
function makeSuperAdminRole() {
  return makeRole({
    name: 'Super Administrador',
    slug: SUPER_ADMIN_ROLE_SLUG,
    permissions: Object.values(Permission),
    isSystem: true,
  });
}

async function makeAdmin(overrides: Partial<{ roleIds: any[]; positionId: any }> = {}) {
  const user = await makeUser({ role: UserRole.ADMIN });
  if (overrides.roleIds) {
    user.roleIds = overrides.roleIds;
    await user.save();
  }
  if (overrides.positionId) {
    user.positionId = overrides.positionId;
    await user.save();
  }
  return user;
}

describe('Autenticación — casos base', () => {
  it('sin token no se puede acceder a una ruta protegida (401)', async () => {
    await request(app).get('/api/v1/admin/users').expect(401);
  });

  it('usuario autenticado sin el permiso requerido recibe 403', async () => {
    // Un admin "legacy" (sin roles de RBAC) no trae ROLES_CREATE por
    // defecto — solo ROLES_VIEW. Ver rbac.ts.
    const admin = await makeAdmin();
    await request(app)
      .post('/api/v1/rbac/roles')
      .set(await authHeader(admin))
      .send({ name: 'Rol nuevo', permissions: [] })
      .expect(403);
  });

  it('usuario con el permiso puede ejecutar la operación', async () => {
    const role = await makeRole({ permissions: [Permission.ROLES_CREATE, Permission.ROLES_VIEW] });
    const admin = await makeAdmin({ roleIds: [role._id] });

    const res = await request(app)
      .post('/api/v1/rbac/roles')
      .set(await authHeader(admin))
      .send({ name: 'Soporte Nivel 1', permissions: [] })
      .expect(201);

    expect(res.body.data.slug).toBe('soporte_nivel_1');
  });

  it('usuario bloqueado no puede acceder aunque el token sea válido', async () => {
    const admin = await makeAdmin();
    admin.isBlocked = true;
    await admin.save();

    await request(app)
      .get('/api/v1/auth/me')
      .set(await authHeader(admin))
      .expect(401);
  });

  it('usuario inactivo no puede acceder', async () => {
    const admin = await makeAdmin();
    admin.isActive = false;
    await admin.save();

    await request(app)
      .get('/api/v1/auth/me')
      .set(await authHeader(admin))
      .expect(401);
  });
});

describe('Protección contra escalamiento de privilegios', () => {
  it('un ADMIN no puede asignarse a sí mismo el rol SUPER_ADMIN', async () => {
    const superAdminRole = await makeSuperAdminRole();
    const permRole = await makeRole({ permissions: [Permission.USERS_ROLE_CHANGE, Permission.USERS_UPDATE] });
    const admin = await makeAdmin({ roleIds: [permRole._id] });

    const res = await request(app)
      .patch(`/api/v1/admin/users/${admin._id}/roles`)
      .set(await authHeader(admin))
      .send({ roleIds: [superAdminRole._id.toString()] })
      .expect(403);

    expect(res.body.message).toMatch(/asignarte roles/i);
  });

  it('un ADMIN sin SUPER_ADMIN no puede otorgar SUPER_ADMIN a otro usuario', async () => {
    const superAdminRole = await makeSuperAdminRole();
    const permRole = await makeRole({ permissions: [Permission.USERS_ROLE_CHANGE, Permission.USERS_UPDATE] });
    const actor = await makeAdmin({ roleIds: [permRole._id] });
    const target = await makeAdmin();

    const res = await request(app)
      .patch(`/api/v1/admin/users/${target._id}/roles`)
      .set(await authHeader(actor))
      .send({ roleIds: [superAdminRole._id.toString()] })
      .expect(403);

    expect(res.body.message).toMatch(/Super Administrador/i);

    const escalationLog = await AuditLog.findOne({
      action: AuditAction.PRIVILEGE_ESCALATION_BLOCKED,
      userId: actor._id.toString(),
    });
    expect(escalationLog).toBeTruthy();
  });

  it('un SUPER_ADMIN sí puede otorgar SUPER_ADMIN a otro usuario', async () => {
    const superAdminRole = await makeSuperAdminRole();
    const grantorPermRole = await makeRole({ permissions: [Permission.USERS_ROLE_CHANGE, Permission.USERS_UPDATE] });
    const grantor = await makeAdmin({ roleIds: [superAdminRole._id, grantorPermRole._id] });
    const target = await makeAdmin();

    await request(app)
      .patch(`/api/v1/admin/users/${target._id}/roles`)
      .set(await authHeader(grantor))
      .send({ roleIds: [superAdminRole._id.toString()] })
      .expect(200);

    const updated = await User.findById(target._id);
    expect(updated!.roleIds.map((id) => id.toString())).toContain(superAdminRole._id.toString());
  });

  it('nadie por debajo de SUPER_ADMIN puede bloquear a una cuenta SUPER_ADMIN', async () => {
    const superAdminRole = await makeSuperAdminRole();
    const superAdminAccount = await makeAdmin({ roleIds: [superAdminRole._id] });
    const ordinaryAdmin = await makeAdmin(); // legacy admin: tiene users:block por defecto

    await request(app)
      .patch(`/api/v1/admin/users/${superAdminAccount._id}/status`)
      .set(await authHeader(ordinaryAdmin))
      .send({ status: 'blocked' })
      .expect(403);

    const stillActive = await User.findById(superAdminAccount._id);
    expect(stillActive!.isBlocked).toBe(false);
  });

  it('el rol de sistema SUPER_ADMIN no se puede editar ni eliminar', async () => {
    const superAdminRole = await makeSuperAdminRole();
    const grantorPermRole = await makeRole({ permissions: [Permission.ROLES_UPDATE, Permission.ROLES_DELETE] });
    const actor = await makeAdmin({ roleIds: [superAdminRole._id, grantorPermRole._id] });

    await request(app)
      .patch(`/api/v1/rbac/roles/${superAdminRole._id}`)
      .set(await authHeader(actor))
      .send({ description: 'intento de edición' })
      .expect(403);

    await request(app)
      .delete(`/api/v1/rbac/roles/${superAdminRole._id}`)
      .set(await authHeader(actor))
      .expect(403);
  });

  it('no se pueden otorgar permisos que el propio actor no posee (creación de roles)', async () => {
    const role = await makeRole({ permissions: [Permission.ROLES_CREATE, Permission.ROLES_VIEW] });
    const admin = await makeAdmin({ roleIds: [role._id] });

    const res = await request(app)
      .post('/api/v1/rbac/roles')
      .set(await authHeader(admin))
      .send({ name: 'Rol con más poder', permissions: [Permission.FINANCE_MANAGE] })
      .expect(403);

    expect(res.body.message).toMatch(/no posees/i);
  });
});

describe('SUPER_ADMIN — acceso completo', () => {
  it('un SUPER_ADMIN puede ejecutar cualquier operación administrativa', async () => {
    const superAdminRole = await makeSuperAdminRole();
    const superAdmin = await makeAdmin({ roleIds: [superAdminRole._id] });

    await request(app)
      .get('/api/v1/rbac/roles')
      .set(await authHeader(superAdmin))
      .expect(200);

    await request(app)
      .get('/api/v1/security/audit-logs')
      .set(await authHeader(superAdmin))
      .expect(200);

    await request(app)
      .get('/api/v1/finance/config')
      .set(await authHeader(superAdmin))
      .expect(200);
  });
});

describe('Efectos inmediatos: permisos y roles', () => {
  it('quitar un permiso a un rol se refleja en la siguiente request, sin reemitir el token', async () => {
    // ROLES_CREATE (a diferencia de ROLES_VIEW) no forma parte del mapa
    // legacy de `admin`, así que el único permiso en juego es el del Rol
    // de RBAC — aísla el efecto que se quiere probar.
    const superAdminRole = await makeSuperAdminRole();
    const grantorRole = await makeRole({ permissions: [Permission.ROLES_UPDATE, Permission.ROLES_VIEW] });
    const grantor = await makeAdmin({ roleIds: [superAdminRole._id, grantorRole._id] });

    const role = await makeRole({ permissions: [Permission.ROLES_CREATE] });
    const admin = await makeAdmin({ roleIds: [role._id] });

    // Antes: el rol trae ROLES_CREATE, la ruta gateada por él responde 201.
    await request(app)
      .post('/api/v1/rbac/roles')
      .set(await authHeader(admin))
      .send({ name: 'Rol de prueba A' })
      .expect(201);

    // Se le quita el permiso directamente en la colección (simula lo que
    // haría un cambio desde el panel).
    await Role.updateOne({ _id: role._id }, { $set: { permissions: [] } });

    // Mismo token, sin reemitir: ya no alcanza.
    await request(app)
      .post('/api/v1/rbac/roles')
      .set(await authHeader(admin))
      .send({ name: 'Rol de prueba B' })
      .expect(403);

    // Se lo devuelven vía API (el flujo real de administración).
    await request(app)
      .patch(`/api/v1/rbac/roles/${role._id}`)
      .set(await authHeader(grantor))
      .send({ permissions: [Permission.ROLES_CREATE] })
      .expect(200);

    // El mismo token, sin reemitir, ya alcanza otra vez — el próximo
    // request recalcula los permisos efectivos desde la base de datos.
    await request(app)
      .post('/api/v1/rbac/roles')
      .set(await authHeader(admin))
      .send({ name: 'Rol de prueba C' })
      .expect(201);
  });

  it('cambiar los roles de un usuario actualiza sus permisos efectivos', async () => {
    const superAdminRole = await makeSuperAdminRole();
    const grantorRole = await makeRole({ permissions: [Permission.USERS_ROLE_CHANGE, Permission.USERS_UPDATE, Permission.USERS_VIEW] });
    const grantor = await makeAdmin({ roleIds: [superAdminRole._id, grantorRole._id] });

    const financeRole = await makeRole({ permissions: [Permission.FINANCE_MANAGE, Permission.FINANCE_VIEW] });
    const target = await makeAdmin();

    const before = await request(app)
      .get(`/api/v1/admin/users/${target._id}/access`)
      .set(await authHeader(grantor))
      .expect(200);
    expect(before.body.data.permissions).not.toContain(Permission.FINANCE_MANAGE);

    await request(app)
      .patch(`/api/v1/admin/users/${target._id}/roles`)
      .set(await authHeader(grantor))
      .send({ roleIds: [financeRole._id.toString()] })
      .expect(200);

    const after = await request(app)
      .get(`/api/v1/admin/users/${target._id}/access`)
      .set(await authHeader(grantor))
      .expect(200);
    expect(after.body.data.permissions).toContain(Permission.FINANCE_MANAGE);
  });
});

describe('Desactivación / bloqueo invalida sesiones', () => {
  it('bloquear a un usuario revoca sus sesiones y su token deja de servir', async () => {
    const permRole = await makeRole({ permissions: [Permission.USERS_BLOCK, Permission.USERS_UPDATE, Permission.USERS_VIEW] });
    const actor = await makeAdmin({ roleIds: [permRole._id] });
    const target = await makeAdmin();

    // El token del objetivo funciona antes de bloquearlo.
    await request(app).get('/api/v1/auth/me').set(await authHeader(target)).expect(200);

    await request(app)
      .patch(`/api/v1/admin/users/${target._id}/status`)
      .set(await authHeader(actor))
      .send({ status: 'blocked', reason: 'prueba' })
      .expect(200);

    // Mismo token, ya no sirve: authenticate revisa isBlocked en cada request.
    await request(app).get('/api/v1/auth/me').set(await authHeader(target)).expect(401);

    const stored = await User.findById(target._id);
    expect(stored!.isBlocked).toBe(true);
    expect(stored!.status).toBe('blocked');
  });
});

describe('Auditoría', () => {
  it('crear un rol genera un registro de auditoría', async () => {
    const role = await makeRole({ permissions: [Permission.ROLES_CREATE, Permission.ROLES_VIEW] });
    const admin = await makeAdmin({ roleIds: [role._id] });

    const res = await request(app)
      .post('/api/v1/rbac/roles')
      .set(await authHeader(admin))
      .send({ name: 'Rol auditado', permissions: [] })
      .expect(201);

    const log = await AuditLog.findOne({
      action: AuditAction.RBAC_ROLE_CREATED,
      entityId: res.body.data._id,
    });
    expect(log).toBeTruthy();
    expect(log!.userId).toBe(admin._id.toString());
  });

  it('crear un cargo genera un registro de auditoría', async () => {
    const role = await makeRole({ permissions: [Permission.POSITIONS_CREATE, Permission.POSITIONS_VIEW] });
    const admin = await makeAdmin({ roleIds: [role._id] });

    const res = await request(app)
      .post('/api/v1/rbac/positions')
      .set(await authHeader(admin))
      .send({ name: 'Cargo auditado' })
      .expect(201);

    const log = await AuditLog.findOne({
      action: AuditAction.POSITION_CREATED,
      entityId: res.body.data._id,
    });
    expect(log).toBeTruthy();
  });
});

describe('Cargos y Roles — CRUD básico', () => {
  it('un cargo hereda los permisos de sus roles asociados vía el usuario', async () => {
    const role = await makeRole({ permissions: [Permission.DRIVERS_APPROVE] });
    const positionRole = await makeRole({ permissions: [Permission.POSITIONS_CREATE, Permission.POSITIONS_VIEW, Permission.ROLES_VIEW] });
    const admin = await makeAdmin({ roleIds: [positionRole._id] });

    const res = await request(app)
      .post('/api/v1/rbac/positions')
      .set(await authHeader(admin))
      .send({ name: 'Cargo con rol', roleIds: [role._id.toString()] })
      .expect(201);

    const position = await Position.findById(res.body.data._id);
    expect(position!.roleIds.map((id) => id.toString())).toContain(role._id.toString());

    // Asigna el cargo a otro usuario y verifica que hereda el permiso.
    const other = await makeAdmin({ roleIds: [positionRole._id] }); // reutiliza el permiso para poder llamar al endpoint
    const target = await makeAdmin();

    await request(app)
      .patch(`/api/v1/admin/users/${target._id}/position`)
      .set(await authHeader(other))
      .send({ positionId: position!._id.toString() })
      .expect(200);

    const access = await request(app)
      .get(`/api/v1/admin/users/${target._id}/access`)
      .set(await authHeader(other))
      .expect(200);
    expect(access.body.data.permissions).toContain(Permission.DRIVERS_APPROVE);
  });

  it('no se puede eliminar un rol que sigue asignado a un usuario', async () => {
    const role = await makeRole({ permissions: [Permission.ROLES_DELETE, Permission.ROLES_VIEW] });
    const admin = await makeAdmin({ roleIds: [role._id] });

    const res = await request(app)
      .delete(`/api/v1/rbac/roles/${role._id}`)
      .set(await authHeader(admin))
      .expect(409);

    expect(res.body.message).toMatch(/asignado/i);
  });
});
