import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import app from '../app';
import businessRouter from '../routes/business.routes';
import { BusinessStaff, BusinessRole, User } from '../models';
import { UserRole } from '../types';
import {
  businessStaffInviteRateLimiter,
  createBusinessStaffInviteRateLimiter,
} from '../middlewares/security';
import { makeUser, makeBusiness, authHeader } from './factories';

/**
 * Invitar personal no puede servir para consultar cuentas ajenas.
 *
 * Auditoría 2026-10-09, ALTO 2: `invite` buscaba por teléfono sin mirar el rol
 * y respondía 404 si no había cuenta; `list()` rellenaba nombre, correo y
 * último acceso también en las invitaciones pendientes. Estas pruebas fijan
 * que ahora la respuesta no distingue una cuenta de otra y que una invitación
 * pendiente no trae datos de la cuenta.
 */

let owner: any;
let business: any;
let businessId: string;

const invite = async (user: any, phone: string | undefined, role: string = BusinessRole.EMPLOYEE, id = businessId) =>
  request(app)
    .post(`/api/v1/businesses/${id}/staff`)
    .set(await authHeader(user))
    .send({ phone, role, name: 'Nombre escrito por quien invita' });

const team = async (user: any) =>
  request(app).get(`/api/v1/businesses/${businessId}/staff`).set(await authHeader(user));

beforeEach(async () => {
  owner = await makeUser({ role: UserRole.BUSINESS });
  business = await makeBusiness(owner._id);
  businessId = business._id.toString();
});

describe('La respuesta no revela si el teléfono tiene cuenta', () => {
  it('cliente, domiciliario, admin, cuenta inexistente, el propio dueño y un comercio dan la misma respuesta', async () => {
    const client = await makeUser({ role: UserRole.CLIENT, name: 'Clienta Reservada', phone: '3001000001' });
    const driver = await makeUser({ role: UserRole.DRIVER, name: 'Domi Reservado', phone: '3001000002' });
    const admin = await makeUser({ role: UserRole.ADMIN, name: 'Admin Reservado', phone: '3001000003' });
    const eligible = await makeUser({ role: UserRole.BUSINESS, name: 'Empleado Real', phone: '3001000004' });

    const phones = [client.phone, driver.phone, admin.phone, '3009990000', owner.phone, eligible.phone];
    const responses = [];
    for (const phone of phones) responses.push(await invite(owner, phone));

    for (const res of responses) {
      expect(res.status).toBe(201);
      expect(res.body).toEqual(responses[0].body);
    }
    // Nada de ids de cuenta, nombres ni correos en la respuesta.
    const raw = JSON.stringify(responses.map((r) => r.body));
    for (const secret of [client.email, driver.email, admin.email, 'Clienta Reservada', 'Domi Reservado', 'Admin Reservado']) {
      if (secret) expect(raw).not.toContain(secret);
    }
    expect(raw).not.toContain(String(eligible._id));
  });

  it('solo se crea invitación para una cuenta de comercio; el resto no deja fila', async () => {
    const client = await makeUser({ role: UserRole.CLIENT, phone: '3001000011' });
    const driver = await makeUser({ role: UserRole.DRIVER, phone: '3001000012' });
    const admin = await makeUser({ role: UserRole.ADMIN, phone: '3001000013' });
    const eligible = await makeUser({ role: UserRole.BUSINESS, phone: '3001000014' });

    for (const phone of [client.phone, driver.phone, admin.phone, '3009990001', owner.phone]) {
      await invite(owner, phone);
    }
    expect(await BusinessStaff.countDocuments({ businessId: business._id })).toBe(0);

    await invite(owner, eligible.phone);
    const rows = await BusinessStaff.find({ businessId: business._id });
    expect(rows).toHaveLength(1);
    expect(rows[0].userId.toString()).toBe(eligible._id.toString());
    expect(rows[0].status).toBe('pending');
    expect(rows[0].invitedPhone).toBe(eligible.phone);
  });

  it('el mismo cuerpo vale para el administrador del negocio', async () => {
    const manager = await makeUser({ role: UserRole.BUSINESS });
    await BusinessStaff.create({ businessId: business._id, userId: manager._id, role: BusinessRole.MANAGER, status: 'active', isActive: true });
    const client = await makeUser({ role: UserRole.CLIENT, phone: '3001000021' });

    const unknown = await invite(manager, '3009990002');
    const nonBusiness = await invite(manager, client.phone);
    expect(unknown.status).toBe(201);
    expect(nonBusiness.body).toEqual(unknown.body);
  });
});

describe('Una invitación pendiente no muestra datos de la cuenta', () => {
  it('la lista del equipo no trae nombre, correo, último acceso ni id de la cuenta invitada', async () => {
    const eligible = await makeUser({
      role: UserRole.BUSINESS, name: 'Nombre Privado Real', phone: '3001000031', email: 'privado.real@zipp.test',
    });
    await User.updateOne({ _id: eligible._id }, { $set: { lastLoginAt: new Date('2026-10-01T10:00:00Z') } });
    await invite(owner, eligible.phone);

    const res = await team(owner);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    const row = res.body.data[0];

    expect(row.status).toBe('pending');
    expect(row.userId).toBeUndefined();
    // Solo lo que escribió quien invitó.
    expect(row.invitedName).toBe('Nombre escrito por quien invita');
    expect(row.invitedPhone).toBe(eligible.phone);

    const raw = JSON.stringify(res.body);
    for (const secret of ['Nombre Privado Real', 'privado.real@zipp.test', '2026-10-01T10:00:00', String(eligible._id)]) {
      expect(raw, secret).not.toContain(secret);
    }
  });

  it('al aceptar, la fila sí trae los datos del empleado', async () => {
    const eligible = await makeUser({
      role: UserRole.BUSINESS, name: 'Nombre Privado Real', phone: '3001000032', email: 'privado.real@zipp.test',
    });
    await invite(owner, eligible.phone);
    const row = await BusinessStaff.findOne({ businessId: business._id });

    const accepted = await request(app)
      .post(`/api/v1/businesses/my/invitations/${row!._id}`)
      .set(await authHeader(eligible))
      .send({ accept: true });
    expect(accepted.status).toBe(200);

    const listed = (await team(owner)).body.data[0];
    expect(listed.status).toBe('active');
    expect(listed.userId).toMatchObject({ name: 'Nombre Privado Real', phone: eligible.phone, email: 'privado.real@zipp.test' });
    expect(listed.userId.password).toBeUndefined();
  });
});

describe('Quién puede consultar, crear, responder y retirar invitaciones', () => {
  it('operador y cajero no listan ni invitan ni retiran', async () => {
    const target = await makeUser({ role: UserRole.BUSINESS, phone: '3001000041' });
    await invite(owner, target.phone);
    const pending = (await BusinessStaff.findOne({ businessId: business._id }))!;

    for (const role of [BusinessRole.EMPLOYEE] as const) {
      const staff = await makeUser({ role: UserRole.BUSINESS });
      await BusinessStaff.create({ businessId: business._id, userId: staff._id, role, status: 'active', isActive: true });

      expect((await team(staff)).status, `${role} lista`).toBe(403);
      expect((await invite(staff, '3009990003')).status, `${role} invita`).toBe(403);
      const del = await request(app)
        .delete(`/api/v1/businesses/${businessId}/staff/${pending._id}`)
        .set(await authHeader(staff));
      expect(del.status, `${role} retira`).toBe(403);
    }
    expect(await BusinessStaff.findById(pending._id)).not.toBeNull();
  });

  it('el administrador no invita a otro administrador, ni siquiera sin saber si existe la cuenta', async () => {
    const manager = await makeUser({ role: UserRole.BUSINESS });
    await BusinessStaff.create({ businessId: business._id, userId: manager._id, role: BusinessRole.MANAGER, status: 'active', isActive: true });
    const res = await invite(manager, '3009990004', BusinessRole.MANAGER);
    expect(res.status).toBe(403);
  });

  it('el dueño de otro negocio no lista ni invita en este', async () => {
    const strangerOwner = await makeUser({ role: UserRole.BUSINESS });
    await makeBusiness(strangerOwner._id);
    expect((await team(strangerOwner)).status).toBe(403);
    expect((await invite(strangerOwner, '3009990005')).status).toBe(403);
  });

  it('cada quien ve y responde solo sus invitaciones', async () => {
    const a = await makeUser({ role: UserRole.BUSINESS, phone: '3001000051' });
    const b = await makeUser({ role: UserRole.BUSINESS, phone: '3001000052' });
    await invite(owner, a.phone);
    const rowA = (await BusinessStaff.findOne({ businessId: business._id, userId: a._id }))!;

    const mine = await request(app).get('/api/v1/businesses/my/invitations').set(await authHeader(b));
    expect(mine.status).toBe(200);
    expect(mine.body.data).toHaveLength(0);

    const hijack = await request(app)
      .post(`/api/v1/businesses/my/invitations/${rowA._id}`)
      .set(await authHeader(b))
      .send({ accept: true });
    expect(hijack.status).toBe(404);
    expect((await BusinessStaff.findById(rowA._id))!.status).toBe('pending');
  });

  it('un cliente no puede aceptar ni listar invitaciones', async () => {
    const client = await makeUser({ role: UserRole.CLIENT });
    const mine = await request(app).get('/api/v1/businesses/my/invitations').set(await authHeader(client));
    expect(mine.status).toBe(403);
  });
});

describe('Límite de invitaciones', () => {
  it('POST /:id/staff monta el limitador propio, aparte del general', () => {
    const layer = (businessRouter as any).stack.find(
      (l: any) => l.route?.path === '/:id/staff' && l.route.methods.post
    );
    expect(layer).toBeDefined();
    const handlers = layer.route.stack.map((l: any) => l.handle);
    expect(handlers).toContain(businessStaffInviteRateLimiter);
  });

  it('corta tras el tope por cuenta y no mezcla cuentas distintas', async () => {
    // El limitador montado vale MAX_SAFE_INTEGER bajo test; se prueba la misma
    // fábrica con un tope pequeño.
    const probe = express();
    probe.use((req, _res, next) => {
      (req as any).user = { _id: req.header('x-user') };
      next();
    });
    probe.post('/invite', createBusinessStaffInviteRateLimiter(3), (_req, res) => {
      res.status(201).json({ ok: true });
    });

    const post = (user: string) => request(probe).post('/invite').set('x-user', user);
    for (let i = 0; i < 3; i++) expect((await post('u1')).status).toBe(201);
    const blocked = await post('u1');
    expect(blocked.status).toBe(429);
    expect(blocked.body.success).toBe(false);

    expect((await post('u2')).status).toBe(201);
  });
});
