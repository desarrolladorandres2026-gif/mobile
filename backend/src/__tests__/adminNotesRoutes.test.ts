import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { Types } from 'mongoose';
import app from '../app';
import { UserRole } from '../types';
import { Permission } from '../security/rbac';
import { AuditAction, AuditLog } from '../security/audit';
import { InternalNote } from '../models/InternalNote';
import { featureFlagService } from '../services/featureFlag.service';
import { cache } from '../cache';
import { makeUser, makeBusiness, makeDriver, makeStaff, authHeader } from './factories';

const A = '/api/v1/admin/notes';
const setEnforce = (on: boolean) => featureFlagService.upsert('rbac_enforce', { audience: on ? 'staff' : 'off' });
const fakeId = () => new Types.ObjectId().toString();

describe('B1: rutas de notas internas', () => {
  beforeEach(async () => {
    await featureFlagService.remove('rbac_enforce');
    await cache.flush();
  });

  describe('acceso por rol', () => {
    it('403 con tokens de cliente, comercio y domiciliario en las tres rutas', async () => {
      const client = await makeUser({ role: UserRole.CLIENT });
      const owner = await makeUser({ role: UserRole.BUSINESS });
      await makeBusiness(owner._id);
      const driverUser = await makeUser({ role: UserRole.DRIVER });
      await makeDriver(driverUser._id);
      for (const u of [client, owner, driverUser]) {
        const h = await authHeader(u);
        expect((await request(app).get(`${A}?entityType=user&entityId=${fakeId()}`).set(h)).status).toBe(403);
        expect((await request(app).post(A).set(h).send({ entityType: 'user', entityId: fakeId(), body: 'x' })).status).toBe(403);
        expect((await request(app).delete(`${A}/${fakeId()}`).set(h).send({ reason: 'motivo valido' })).status).toBe(403);
      }
    });
  });

  describe('enforce', () => {
    beforeEach(async () => {
      await setEnforce(true);
      await cache.flush();
    });

    it('403 por tipo: quien solo tiene drivers:view no lee ni escribe notas de pedido', async () => {
      const staff = await makeStaff({ roleSlug: 'soporte', permissions: [Permission.ADMIN_PANEL, Permission.DRIVERS_VIEW] });
      const h = await authHeader(staff);
      expect((await request(app).get(`${A}?entityType=order&entityId=${fakeId()}`).set(h)).status).toBe(403);
      expect((await request(app).post(A).set(h).send({ entityType: 'order', entityId: fakeId(), body: 'hola' })).status).toBe(403);
      // y sí en su tipo (la entidad no existe: 404, no 403)
      expect((await request(app).post(A).set(h).send({ entityType: 'driver', entityId: fakeId(), body: 'hola' })).status).toBe(404);
      expect((await request(app).get(`${A}?entityType=driver&entityId=${fakeId()}`).set(h)).status).toBe(200);
    });

    it('admin sin rol: 403 en todos los tipos', async () => {
      const bare = await makeStaff({ roleSlug: null });
      const h = await authHeader(bare);
      for (const t of ['order', 'business', 'driver', 'user', 'pqrs']) {
        expect((await request(app).get(`${A}?entityType=${t}&entityId=${fakeId()}`).set(h)).status, t).toBe(403);
      }
    });
  });

  describe('crear, listar y borrar (enforce)', () => {
    let su: any;
    let target: any;
    beforeEach(async () => {
      await setEnforce(true);
      await cache.flush();
      su = await makeStaff({ roleSlug: 'super_admin' });
      target = await makeUser({ role: UserRole.CLIENT });
    });
    const post = async (user: any, body: object) => request(app).post(A).set(await authHeader(user)).send(body);

    it('201 con NoteView; GET la devuelve', async () => {
      const res = await post(su, { entityType: 'user', entityId: target._id.toString(), body: '  cliente amable  ' });
      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.body).toBe('cliente amable');
      expect(res.body.data.canDelete).toBe(true);
      const list = await request(app).get(`${A}?entityType=user&entityId=${target._id}`).set(await authHeader(su));
      expect(list.status).toBe(200);
      expect(list.body.data.items).toHaveLength(1);
      expect(list.body.data.nextBefore).toBeNull();
    });

    it('404 si la entidad no existe', async () => {
      expect((await post(su, { entityType: 'user', entityId: fakeId(), body: 'hola' })).status).toBe(404);
    });

    it('400 con más de 2000 caracteres, con número de tarjeta, vacía y con id inválido', async () => {
      const id = target._id.toString();
      expect((await post(su, { entityType: 'user', entityId: id, body: 'a'.repeat(2001) })).status).toBe(400);
      expect((await post(su, { entityType: 'user', entityId: id, body: 'tarjeta 4111 1111 1111 1111 ok' })).status).toBe(400);
      expect((await post(su, { entityType: 'user', entityId: id, body: '   ' })).status).toBe(400);
      expect((await post(su, { entityType: 'user', entityId: 'nope', body: 'x' })).status).toBe(400);
      expect((await request(app).get(`${A}?entityType=user&entityId=${id}&limit=51`).set(await authHeader(su))).status).toBe(400);
    });

    it('borrar: el autor antes de 15 min sí; después no; Super Admin sí con motivo', async () => {
      const author = await makeStaff({ roleSlug: 'soporte', permissions: [Permission.ADMIN_PANEL, Permission.USERS_VIEW] });
      const id = target._id.toString();
      const mine = (await post(author, { entityType: 'user', entityId: id, body: 'mía' })).body.data._id;
      const old = (await post(author, { entityType: 'user', entityId: id, body: 'vieja' })).body.data._id;
      await InternalNote.collection.updateOne({ _id: new Types.ObjectId(old) }, { $set: { createdAt: new Date(Date.now() - 20 * 60 * 1000) } });

      const ok = await request(app).delete(`${A}/${mine}`).set(await authHeader(author)).send({});
      expect(ok.status).toBe(200);
      expect(ok.body.data.deletedAt).toBeTruthy();

      const late = await request(app).delete(`${A}/${old}`).set(await authHeader(author)).send({ reason: 'motivo suficiente' });
      expect(late.status).toBe(403);

      const noReason = await request(app).delete(`${A}/${old}`).set(await authHeader(su)).send({});
      expect(noReason.status).toBe(400);
      const sa = await request(app).delete(`${A}/${old}`).set(await authHeader(su)).send({ reason: 'limpieza de datos' });
      expect(sa.status).toBe(200);

      // El autor ya no la ve; el Super Admin la ve como eliminada.
      const asAuthor = await request(app).get(`${A}?entityType=user&entityId=${id}`).set(await authHeader(author));
      expect(asAuthor.body.data.items).toHaveLength(0);
      const asSu = await request(app).get(`${A}?entityType=user&entityId=${id}`).set(await authHeader(su));
      expect(asSu.body.data.items).toHaveLength(2);
    });

    it('el AuditLog no contiene el texto de la nota', async () => {
      const secret = 'texto-secreto-de-la-nota';
      const res = await post(su, { entityType: 'user', entityId: target._id.toString(), body: secret });
      await request(app).delete(`${A}/${res.body.data._id}`).set(await authHeader(su)).send({ reason: 'ya no aplica' });
      const logs = await AuditLog.find({ action: { $in: [AuditAction.INTERNAL_NOTE_CREATED, AuditAction.INTERNAL_NOTE_DELETED] } }).lean();
      expect(logs).toHaveLength(2);
      expect(JSON.stringify(logs)).not.toContain(secret);
      expect(logs.every((l: any) => l.ip)).toBe(true);
    });
  });

  describe('observe', () => {
    it('un admin sin rol conserva el acceso legacy; cliente sigue en 403', async () => {
      const bare = await makeStaff({ roleSlug: null });
      const target = await makeUser({ role: UserRole.CLIENT });
      const r = await request(app).post(A).set(await authHeader(bare)).send({ entityType: 'user', entityId: target._id.toString(), body: 'observe' });
      expect(r.status).toBe(201);
      const client = await makeUser({ role: UserRole.CLIENT });
      expect((await request(app).get(`${A}?entityType=user&entityId=${target._id}`).set(await authHeader(client))).status).toBe(403);
    });
  });
});
