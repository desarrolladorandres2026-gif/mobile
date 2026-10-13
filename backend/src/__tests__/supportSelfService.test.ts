import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { Writable } from 'stream';
import app from '../app';
import { cloudinary } from '../config';
import { Pqrs, BusinessRole } from '../models';
import { UserRole } from '../types';
import { Permission } from '../security/rbac';
import { createPqrs } from '../services/pqrs.service';
import { businessStaffService } from '../services/businessStaff.service';
import { featureFlagService } from '../services/featureFlag.service';
import { cache } from '../cache';
import { authHeader, makeBusiness, makeStaff, makeUser, GARZON } from './factories';

const API = '/api/v1';
const DETAIL = 'Detalle suficientemente largo del problema ocurrido.';

// PNG mínimo válido para `readImageHeader` (firma + IHDR con 10x10).
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0, 0, 0, 13]),
  Buffer.from('IHDR'),
  Buffer.from([0, 0, 0, 10, 0, 0, 0, 10, 8, 6, 0, 0, 0]),
  Buffer.alloc(12),
]);

let uploads = 0;

beforeAll(() => {
  cloudinary.config({ cloud_name: 'demo', api_key: 'key', api_secret: 'secret' });
  vi.spyOn(cloudinary.uploader, 'upload_stream').mockImplementation(((options: any, cb: any) => {
    const id = `${options.public_id ?? `${options.folder}/file`}-${++uploads}`;
    return new Writable({
      write(_chunk, _enc, next) { next(); },
      final(done) { cb(null, { public_id: id }); done(); },
    });
  }) as any);
});

afterAll(() => vi.restoreAllMocks());

/**
 * Lo que el comercio puede hacer por su cuenta con un caso: ver el de su
 * equipo, adjuntar, confirmar que se resolvió y reabrir.
 */
describe('Soporte del comercio: autoservicio', () => {
  let owner: any; let manager: any; let cashier: any; let business: any; let other: any;

  const open = (user: any, extra: Record<string, unknown> = {}) =>
    createPqrs({
      userId: user._id.toString(), role: UserRole.BUSINESS, businessId: business._id.toString(),
      type: 'complaint', subject: 'Un problema en el local', detail: DETAIL, ...extra,
    } as never);

  beforeEach(async () => {
    await featureFlagService.upsert('rbac_enforce', { audience: 'staff' });
    await cache.flush();
    owner = await makeUser({ role: UserRole.BUSINESS });
    business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
    manager = await makeUser({ role: UserRole.BUSINESS, phone: '3001112233' });
    cashier = await makeUser({ role: UserRole.BUSINESS, phone: '3004445566' });
    other = await makeUser({ role: UserRole.BUSINESS });
    await makeBusiness(other._id, { lat: GARZON.lat, lng: GARZON.lng });
    for (const [user, role] of [[manager, BusinessRole.MANAGER], [cashier, BusinessRole.EMPLOYEE]] as const) {
      const row = (await businessStaffService.invite(business._id.toString(), { phone: user.phone, role }, owner._id.toString()))!;
      await businessStaffService.respondToInvitation(user._id.toString(), row._id.toString(), true);
    }
  });

  describe('Casos de todo el local', () => {
    it('el propietario y el administrador ven lo que abrió el equipo; el empleado, no', async () => {
      await open(cashier, { subject: 'El domiciliario no llegó' });
      const url = `${API}/pqrs/business/${business._id}`;

      for (const viewer of [owner, manager]) {
        const res = await request(app).get(url).set(await authHeader(viewer)).expect(200);
        expect(res.body.data).toHaveLength(1);
        expect(res.body.data[0].subject).toBe('El domiciliario no llegó');
        expect(res.body.data[0].mine).toBe(false);
        expect(res.body.data[0].openedBy).toBeTruthy();
        expect(res.body.data[0].priority).toBeUndefined();
        expect(res.body.data[0].userId).toBeUndefined();
        expect(JSON.stringify(res.body.data[0])).not.toContain('@');
      }
      await request(app).get(url).set(await authHeader(cashier)).expect(403);
      await request(app).get(url).set(await authHeader(other)).expect(403);
    });

    it('no mezcla los reclamos de clientes que citan este local', async () => {
      const client = await makeUser({ role: UserRole.CLIENT });
      const mine = await open(owner);
      await Pqrs.create({
        userId: client._id, type: 'claim', subject: 'Reclamo de un cliente', detail: DETAIL,
        requesterRole: 'customer', businessId: business._id,
      });
      const res = await request(app).get(`${API}/pqrs/business/${business._id}`).set(await authHeader(owner)).expect(200);
      expect(res.body.data.map((c: any) => c._id)).toEqual([String(mine._id)]);
      expect(res.body.data[0].mine).toBe(true);
    });

    it('el permiso es del local: ser propietario de otro no abre este', async () => {
      await request(app).get(`${API}/pqrs/business/${business._id}`).set(await authHeader(other)).expect(403);
    });
  });

  describe('Confirmar resolución y reabrir', () => {
    it('confirmar cierra solo un caso respondido y solo para quien lo abrió', async () => {
      const ticket = await open(cashier);
      const url = `${API}/pqrs/${ticket._id}/resolve`;

      await request(app).post(url).set(await authHeader(cashier)).expect(409);

      await Pqrs.updateOne({ _id: ticket._id }, { $set: { status: 'answered' } });
      await request(app).post(url).set(await authHeader(manager)).expect(409);

      const res = await request(app).post(url).set(await authHeader(cashier)).expect(200);
      expect(res.body.data.status).toBe('closed');
      expect(res.body.data.resolvedByRequester).toBe(true);
      expect(res.body.data.canReopen).toBe(true);
    });

    it('reabrir exige mensaje, vuelve a la cola sin regalar plazo legal y tiene tope', async () => {
      const ticket = await open(cashier);
      await Pqrs.updateOne({ _id: ticket._id }, { $set: { status: 'closed', closedAt: new Date() } });
      const before = (await Pqrs.findById(ticket._id))!;
      const url = `${API}/pqrs/${ticket._id}/reopen`;
      const as = async (u: any, message: string) => request(app).post(url).set(await authHeader(u)).send({ message });

      expect((await as(cashier, 'no')).status).toBe(400);
      expect((await as(manager, 'Sigue sin llegar el domiciliario')).status).toBe(409);

      const res = await as(cashier, 'Sigue sin llegar el domiciliario');
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('in_review');
      expect(res.body.data.reopenCount).toBe(1);
      expect(res.body.data.responses.at(-1)).toMatchObject({ from: 'requester', message: 'Sigue sin llegar el domiciliario' });
      const after = (await Pqrs.findById(ticket._id))!;
      expect(after.legalDueAt?.getTime()).toBe(before.legalDueAt?.getTime());
      expect(after.dueAt?.getTime()).toBe(before.dueAt?.getTime());

      // Abierto no se reabre; cerrado de nuevo, la segunda vez pasa y la tercera no.
      expect((await as(cashier, 'Otra vez el mismo problema')).status).toBe(409);
      await Pqrs.updateOne({ _id: ticket._id }, { $set: { status: 'closed', closedAt: new Date() } });
      expect((await as(cashier, 'Otra vez el mismo problema')).status).toBe(200);
      await Pqrs.updateOne({ _id: ticket._id }, { $set: { status: 'closed', closedAt: new Date() } });
      expect((await as(cashier, 'Una más, ya van tres')).status).toBe(409);
    });

    it('pasados 7 días ya no se reabre', async () => {
      const ticket = await open(cashier);
      await Pqrs.updateOne({ _id: ticket._id }, { $set: { status: 'closed', closedAt: new Date(Date.now() - 8 * 24 * 3600_000) } });
      await request(app).post(`${API}/pqrs/${ticket._id}/reopen`).set(await authHeader(cashier))
        .send({ message: 'Quiero reabrirlo ahora' }).expect(409);
      const list = await request(app).get(`${API}/pqrs/my`).set(await authHeader(cashier)).expect(200);
      expect(list.body.data[0].canReopen).toBe(false);
    });

    it('el personal que cierra sella closedAt y reabrir lo limpia', async () => {
      const ticket = await open(cashier);
      const agent = await makeUser({ role: UserRole.ADMIN });
      await Pqrs.updateOne({ _id: ticket._id }, { $set: { status: 'answered' } });
      const { supportService } = await import('../services/support.service');
      expect((await supportService.close(String(ticket._id), String(agent._id)))?.closedAt).toBeTruthy();
      expect((await supportService.reopen(String(ticket._id), String(agent._id)))?.closedAt).toBeNull();
    });
  });

  describe('Adjuntos', () => {
    const attach = async (user: any, ticketId: string, file: Buffer = PNG, name = 'cobro.png', type = 'image/png') =>
      request(app).post(`${API}/pqrs/${ticketId}/evidence`).set(await authHeader(user)).attach('file', file, { filename: name, contentType: type });

    it('sube un archivo privado: guarda la llave, no una URL, y no la devuelve al solicitante', async () => {
      const ticket = await open(cashier);
      const res = await attach(cashier, String(ticket._id));
      expect(res.status).toBe(201);
      const item = res.body.data.evidence[0];
      expect(item).toMatchObject({ name: 'cobro.png' });
      expect(item.storageKey).toBeUndefined();
      expect(item.url).toBeUndefined();

      const row = (await Pqrs.findById(ticket._id))!;
      expect(row.evidence[0].storageKey).toContain(`zipp/pqrs-evidence/${ticket._id}`);
      expect(row.evidence[0].url).toBeUndefined();

      const signed = await request(app).get(`${API}/pqrs/${ticket._id}/evidence/${item._id}/url`).set(await authHeader(cashier)).expect(200);
      expect(signed.body.data.url).toMatch(/^https:\/\/res\.cloudinary\.com\//);
    });

    it('rechaza lo que no es imagen ni PDF aunque diga serlo', async () => {
      const ticket = await open(cashier);
      const res = await attach(cashier, String(ticket._id), Buffer.from('<?php echo 1; ?>'), 'foto.jpg', 'image/jpeg');
      expect(res.status).toBe(400);
      expect((await Pqrs.findById(ticket._id))!.evidence).toHaveLength(0);

      const gif = await attach(cashier, String(ticket._id), Buffer.from('GIF89a'), 'a.gif', 'image/gif');
      expect(gif.status).toBe(400);
    });

    it('solo quien abrió el caso adjunta, mientras esté abierto y hasta el tope', async () => {
      const ticket = await open(cashier);
      expect((await attach(manager, String(ticket._id))).status).toBe(404);

      for (let i = 0; i < 5; i += 1) expect((await attach(cashier, String(ticket._id))).status).toBe(201);
      expect((await attach(cashier, String(ticket._id))).status).toBe(409);

      const closed = await open(cashier, { subject: 'Otro caso distinto' });
      await Pqrs.updateOne({ _id: closed._id }, { $set: { status: 'closed' } });
      expect((await attach(cashier, String(closed._id))).status).toBe(404);
    });

    it('la URL firmada es del dueño o de soporte; nadie más, y un adjunto antiguo con URL suelta no se sirve', async () => {
      const ticket = await open(cashier);
      const res = await attach(cashier, String(ticket._id));
      const evidenceId = res.body.data.evidence[0]._id;

      await request(app).get(`${API}/pqrs/${ticket._id}/evidence/${evidenceId}/url`).set(await authHeader(manager)).expect(404);

      const agent = await makeStaff({ roleSlug: 'super_admin' });
      const asStaff = await request(app).get(`${API}/pqrs/support/${ticket._id}/evidence/${evidenceId}/url`).set(await authHeader(agent)).expect(200);
      expect(asStaff.body.data.url).toMatch(/cloudinary/);
      const noSupport = await makeStaff({ roleSlug: null, permissions: [Permission.ORDERS_VIEW_ALL] });
      await request(app).get(`${API}/pqrs/support/${ticket._id}/evidence/${evidenceId}/url`).set(await authHeader(noSupport)).expect(403);

      await Pqrs.updateOne({ _id: ticket._id }, { $push: { evidence: { name: 'viejo', url: 'https://evil.example/x' } } });
      const legacy = (await Pqrs.findById(ticket._id))!.evidence.at(-1)!;
      await request(app).get(`${API}/pqrs/${ticket._id}/evidence/${legacy._id}/url`).set(await authHeader(cashier)).expect(404);
    });
  });
});
