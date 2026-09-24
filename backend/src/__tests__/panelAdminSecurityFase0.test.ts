import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../app';
import { Business, Role, User } from '../models';
import { Session } from '../security/sessions';
import { UserRole } from '../types';
import { SUPER_ADMIN_ROLE_SLUG, Permission } from '../security/rbac';
import { makeUser, makeBusiness, authHeader, GARZON } from './factories';

/**
 * Fase 0 del plan de seguridad del panel admin (docs/PANEL-ADMIN.md §1.2,
 * §1.3). Un caso por hallazgo, atacando directamente lo que el hallazgo
 * describe — no repite lo que ya cubren `rbac.test.ts`/`securityAudit.test.ts`.
 */

async function makeSuperAdminRole() {
  return Role.create({
    name: 'Super Administrador',
    slug: SUPER_ADMIN_ROLE_SLUG,
    permissions: Object.values(Permission),
    isSystem: true,
    isActive: true,
  });
}

async function makeSuperAdmin() {
  const role = await makeSuperAdminRole();
  const user = await makeUser({ role: UserRole.ADMIN });
  user.roleIds = [role._id] as any;
  await user.save();
  return user;
}

describe('S1 · ficha pública de comercio', () => {
  it('GET /businesses/:id nunca expone commissionRateBps ni ownerId', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng, commissionRateBps: 1500 });

    const res = await request(app).get(`/api/v1/businesses/${business._id}`).expect(200);

    expect(res.body.data.commissionRateBps).toBeUndefined();
    expect(res.body.data.commissionRate).toBeUndefined();
    expect(res.body.data.ownerId).toBeUndefined();
    expect(res.body.data.name).toBe(business.name);
  });

  it('GET /businesses/slug/:slug oculta lo mismo', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });

    const res = await request(app).get(`/api/v1/businesses/slug/${business.slug}`).expect(200);

    expect(res.body.data.commissionRateBps).toBeUndefined();
    expect(res.body.data.ownerId).toBeUndefined();
  });

  it('un comercio no aprobado no tiene ficha pública por id ni por slug', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng, isApproved: false });

    await request(app).get(`/api/v1/businesses/${business._id}`).expect(404);
    await request(app).get(`/api/v1/businesses/slug/${business.slug}`).expect(404);
  });

  it('el listado público tampoco expone comisión ni dueño, con o sin coordenadas', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    await makeBusiness(owner._id, { name: 'Listado', lat: GARZON.lat, lng: GARZON.lng, commissionRateBps: 1500 });

    for (const qs of ['', `?lat=${GARZON.lat}&lng=${GARZON.lng}`]) {
      const res = await request(app).get(`/api/v1/businesses${qs}`).expect(200);
      const item = res.body.data.find((b: { name: string }) => b.name === 'Listado');
      expect(item).toBeDefined();
      expect(item.commissionRateBps).toBeUndefined();
      expect(item.commissionRate).toBeUndefined();
      expect(item.ownerId).toBeUndefined();
    }
  });

  it('includeInactive / all en la URL pública no destapan comercios sin aprobar', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    await makeBusiness(owner._id, { name: 'Oculto', lat: GARZON.lat, lng: GARZON.lng, isApproved: false });

    for (const qs of ['?includeInactive=true', '?all=true']) {
      const res = await request(app).get(`/api/v1/businesses${qs}`).expect(200);
      expect(res.body.data.find((b: { name: string }) => b.name === 'Oculto')).toBeUndefined();
    }
  });

  it('un comercio archivado tampoco', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
    await Business.updateOne({ _id: business._id }, { $set: { isArchived: true } });

    await request(app).get(`/api/v1/businesses/${business._id}`).expect(404);
  });

  it('el dueño autenticado sigue viendo el documento completo en "mis negocios"', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng, commissionRateBps: 1200 });

    const res = await request(app)
      .get('/api/v1/businesses/my/businesses')
      .set(await authHeader(owner))
      .expect(200);

    expect(res.body.data[0].commissionRateBps).toBe(1200);
  });
});

describe('S2 · IDOR en publicidad', () => {
  it('un comercio no puede leer las campañas ni las facturas de otro comercio', async () => {
    const ownerA = await makeUser({ role: UserRole.BUSINESS });
    const businessA = await makeBusiness(ownerA._id, { lat: GARZON.lat, lng: GARZON.lng });
    const ownerB = await makeUser({ role: UserRole.BUSINESS, phone: '3009991122' });
    await makeBusiness(ownerB._id, { lat: GARZON.lat, lng: GARZON.lng });

    await request(app)
      .get(`/api/v1/advertisements/business/${businessA._id}`)
      .set(await authHeader(ownerB))
      .expect(403);

    await request(app)
      .get(`/api/v1/advertisements/business/${businessA._id}/invoices`)
      .set(await authHeader(ownerB))
      .expect(403);
  });

  it('el dueño sí puede leer lo suyo, y admin puede leer cualquiera', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
    const admin = await makeUser({ role: UserRole.ADMIN });

    await request(app)
      .get(`/api/v1/advertisements/business/${business._id}`)
      .set(await authHeader(owner))
      .expect(200);

    await request(app)
      .get(`/api/v1/advertisements/business/${business._id}`)
      .set(await authHeader(admin))
      .expect(200);
  });
});

describe('S6 · bloquear un usuario desconecta sus sesiones', () => {
  it('blockUser marca la sesión inactiva (revoke, no solo el flag de cuenta)', async () => {
    // Bloquear usuarios es solo del Super Administrador (Fase 1).
    const admin = await makeSuperAdmin();
    const target = await makeUser({ role: UserRole.CLIENT });
    const header = await authHeader(target);

    await request(app)
      .post(`/api/v1/security/block-user/${target._id}`)
      .set(await authHeader(admin))
      .send({ reason: 'prueba' })
      .expect(200);

    const sessions = await Session.find({ userId: target._id.toString() });
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every((s) => s.isActive === false)).toBe(true);
  });
});

describe('S12 · revokeUserSessions con guardas', () => {
  it('rechaza revocar las propias sesiones', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    await request(app)
      .delete(`/api/v1/security/sessions/user/${admin._id}`)
      .set(await authHeader(admin))
      .expect(403);
  });

  it('un admin normal no puede revocar las sesiones del Super Administrador', async () => {
    const superAdmin = await makeSuperAdmin();
    const regularAdmin = await makeUser({ role: UserRole.ADMIN });

    await request(app)
      .delete(`/api/v1/security/sessions/user/${superAdmin._id}`)
      .set(await authHeader(regularAdmin))
      .expect(403);
  });
});

describe('S9 · crear/ascender admins es solo del Super Administrador', () => {
  it('un admin sin el rol Super Administrador no puede crear cuentas de equipo', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });

    const res = await request(app)
      .post('/api/v1/admin/users')
      .set(await authHeader(admin))
      .send({ name: 'Nuevo Staff', email: `staff${Date.now()}@zipp.test`, password: 'Aa1!aaaaaaaa' });

    expect(res.status).toBe(403);
  });

  it('el Super Administrador sí puede', async () => {
    const superAdmin = await makeSuperAdmin();

    const res = await request(app)
      .post('/api/v1/admin/users')
      .set(await authHeader(superAdmin))
      .send({ name: 'Nuevo Staff', email: `staff${Date.now()}@zipp.test`, password: 'Aa1!aaaaaaaa' });

    expect(res.status).toBe(201);
  });

  it('un admin normal no puede ascender a otra cuenta a admin', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    const client = await makeUser({ role: UserRole.CLIENT });

    const res = await request(app)
      .patch(`/api/v1/admin/users/${client._id}/role`)
      .set(await authHeader(admin))
      .send({ role: UserRole.ADMIN });

    expect(res.status).toBe(403);

    const stillClient = await User.findById(client._id);
    expect(stillClient!.role).toBe(UserRole.CLIENT);
  });
});

describe('S11 · archivar en vez de borrar', () => {
  it('DELETE /admin/businesses/:id archiva, no borra el documento', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });

    await request(app)
      .delete(`/api/v1/admin/businesses/${business._id}`)
      .set(await authHeader(admin))
      .send({ reason: 'Cerró definitivamente' })
      .expect(200);

    const stillThere = await Business.findById(business._id);
    expect(stillThere).not.toBeNull();
    expect(stillThere!.isArchived).toBe(true);
    expect(stillThere!.archiveReason).toBe('Cerró definitivamente');
    expect(stillThere!.isActive).toBe(false);
  });

  it('exige un motivo', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });

    await request(app)
      .delete(`/api/v1/admin/businesses/${business._id}`)
      .set(await authHeader(admin))
      .send({})
      .expect(400);
  });

  it('un comercio archivado se puede restaurar', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
    await Business.updateOne({ _id: business._id }, { $set: { isArchived: true, archiveReason: 'x', archivedAt: new Date() } });

    await request(app)
      .patch(`/api/v1/admin/businesses/${business._id}/restore`)
      .set(await authHeader(admin))
      .expect(200);

    const restored = await Business.findById(business._id);
    expect(restored!.isArchived).toBe(false);
  });

  it('updateTerms ya no puede aprobar un comercio', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN, isFinanceAdmin: true });
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng, isApproved: false });

    await request(app)
      .patch(`/api/v1/finance/businesses/${business._id}/terms`)
      .set(await authHeader(admin))
      .send({ isApproved: true, commissionRateBps: 900 })
      .expect(400); // `.strict()` rechaza el campo desconocido

    const stillUnapproved = await Business.findById(business._id);
    expect(stillUnapproved!.isApproved).toBe(false);
  });
});
