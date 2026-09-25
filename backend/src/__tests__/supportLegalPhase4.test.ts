import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { DataRequest, LegalAcceptance, LegalDocument, Order, Pqrs, SupportMacro } from '../models';
import { UserRole, PaymentMethod } from '../types';
import { Permission } from '../security/rbac';
import { createPqrs } from '../services/pqrs.service';
import { supportService } from '../services/support.service';
import { extendDataRequest, computeDataRequestLegalDueAt } from '../services/legal.service';
import { featureFlagService } from '../services/featureFlag.service';
import { orderService } from '../services/order.service';
import { cache } from '../cache';
import { addBusinessDays } from '../utils/businessDays';
import { authHeader, makeBusiness, makeDriver, makePricingConfig, makeProduct, makeStaff, makeUser, GARZON } from './factories';

const API = '/api/v1';
const LONG = 'Texto del documento legal suficientemente largo para pasar la validación mínima de contenido.';

describe('Fase 4 · Soporte y legal', () => {
  beforeEach(async () => {
    await featureFlagService.upsert('rbac_enforce', { audience: 'staff' });
    await cache.flush();
  });

  describe('Quién puede abrir un caso y sobre qué', () => {
    let client: any; let owner: any; let business: any; let driverUser: any; let driver: any; let order: any;

    beforeEach(async () => {
      await makePricingConfig();
      client = await makeUser({ role: UserRole.CLIENT });
      owner = await makeUser({ role: UserRole.BUSINESS });
      business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
      driverUser = await makeUser({ role: UserRole.DRIVER });
      driver = await makeDriver(driverUser._id);
      const product = await makeProduct(business._id);
      order = await orderService.create({
        clientId: client._id.toString(), businessId: business._id.toString(),
        items: [{ productId: product._id.toString(), quantity: 1 }], paymentMethod: PaymentMethod.ONLINE,
        deliveryAddress: 'Cra 1 #2-3', deliveryLongitude: GARZON.lng, deliveryLatitude: GARZON.lat,
      } as never);
      await Order.updateOne({ _id: order._id }, { $set: { driverId: driver._id } });
    });

    const base = { type: 'complaint' as const, subject: 'Un problema con el pedido', detail: 'Detalle suficientemente largo del problema ocurrido.' };

    it('nace con prioridad y SLA interno, y como caso de cliente', async () => {
      const item = await createPqrs({ ...base, userId: client._id.toString(), role: UserRole.CLIENT });
      expect(item.requesterRole).toBe('customer');
      expect(item.priority).toBe('normal');
      const hours = (item.dueAt!.getTime() - Date.now()) / 3_600_000;
      expect(hours).toBeGreaterThan(23);
      expect(hours).toBeLessThan(25);
    });

    it('un cliente no cuelga su caso de un pedido ajeno', async () => {
      const stranger = await makeUser({ role: UserRole.CLIENT });
      await expect(createPqrs({ ...base, userId: stranger._id.toString(), role: UserRole.CLIENT, orderId: order._id.toString() }))
        .rejects.toMatchObject({ statusCode: 403 });
      const mine = await createPqrs({ ...base, userId: client._id.toString(), role: UserRole.CLIENT, orderId: order._id.toString() });
      expect(String(mine.businessId)).toBe(String(business._id));
      expect(String(mine.driverId)).toBe(String(driver._id));
    });

    it('un comercio abre casos de SU negocio y de pedidos de su negocio', async () => {
      const item = await createPqrs({ ...base, userId: owner._id.toString(), role: UserRole.BUSINESS, businessId: business._id.toString(), orderId: order._id.toString() });
      expect(item.requesterRole).toBe('business');
      expect(String(item.businessId)).toBe(String(business._id));

      await expect(createPqrs({ ...base, userId: owner._id.toString(), role: UserRole.BUSINESS })).rejects.toMatchObject({ statusCode: 422 });

      const other = await makeUser({ role: UserRole.BUSINESS });
      await expect(createPqrs({ ...base, userId: other._id.toString(), role: UserRole.BUSINESS, businessId: business._id.toString() }))
        .rejects.toMatchObject({ statusCode: 403 });
    });

    it('un domiciliario abre casos propios y solo de pedidos que entregó', async () => {
      const item = await createPqrs({ ...base, userId: driverUser._id.toString(), role: UserRole.DRIVER, orderId: order._id.toString() });
      expect(item.requesterRole).toBe('driver');
      expect(String(item.driverId)).toBe(String(driver._id));

      const otherUser = await makeUser({ role: UserRole.DRIVER });
      await makeDriver(otherUser._id);
      await expect(createPqrs({ ...base, userId: otherUser._id.toString(), role: UserRole.DRIVER, orderId: order._id.toString() }))
        .rejects.toMatchObject({ statusCode: 403 });
    });

    it('el rol lo decide la cuenta, no el cuerpo de la petición', async () => {
      const res = await request(app).post(`${API}/pqrs`).set(await authHeader(client))
        .send({ ...base, requesterRole: 'business', businessId: business._id.toString() }).expect(201);
      expect(res.body.data.requesterRole).toBe('customer');
    });
  });

  describe('Bandeja única: filtros', () => {
    it('filtra por tipo, quién abrió y texto, y ve los respondidos aparte', async () => {
      const u = await makeUser({ role: UserRole.CLIENT });
      const agent = await makeStaff({ roleSlug: 'soporte' });
      const a = await createPqrs({ userId: u._id.toString(), type: 'claim', subject: 'Cobro (duplicado) [x]', detail: 'Me cobraron dos veces el mismo pedido.' });
      await createPqrs({ userId: u._id.toString(), type: 'suggestion', subject: 'Más filtros', detail: 'Filtrar por comida vegetariana ayudaría.' });

      expect((await supportService.queue({ type: 'claim' })).map((r: any) => String(r._id))).toEqual([String(a._id)]);
      expect(await supportService.queue({ requesterRole: 'business' })).toHaveLength(0);
      // Un término con caracteres de regex no revienta ni se interpreta como regex.
      expect(await supportService.queue({ q: '(duplicado) [x]' })).toHaveLength(1);
      expect(await supportService.queue({ q: '.*' })).toHaveLength(0);

      await supportService.reply(String(a._id), String(agent._id), 'Ya lo reembolsamos.');
      await Pqrs.updateOne({ _id: a._id }, { $set: { status: 'answered' } });
      expect(await supportService.queue({})).toHaveLength(1);
      expect(await supportService.queue({ view: 'answered' })).toHaveLength(1);
    });
  });

  describe('Respuestas predefinidas', () => {
    it('quien gestiona las crea; quien solo responde las usa; sin permiso no entra', async () => {
      const soporte = await authHeader(await makeStaff({ roleSlug: 'soporte' }));
      const ops = await authHeader(await makeStaff({ roleSlug: 'operaciones' }));

      const created = await request(app).post(`${API}/pqrs/macros`).set(soporte)
        .send({ title: 'Reembolso hecho', body: 'Hola {{cliente}}, reembolsamos el pedido {{pedido}}.', appliesTo: ['claim'] }).expect(201);
      expect((await request(app).get(`${API}/pqrs/macros`).set(soporte).expect(200)).body.data).toHaveLength(1);

      await request(app).get(`${API}/pqrs/macros`).set(ops).expect(403);
      await request(app).post(`${API}/pqrs/macros`).set(ops).send({ title: 'Otra', body: 'Texto de prueba' }).expect(403);

      await request(app).patch(`${API}/pqrs/macros/${created.body.data._id}`).set(soporte).send({ isActive: false }).expect(200);
      expect((await request(app).get(`${API}/pqrs/macros`).set(soporte).expect(200)).body.data).toHaveLength(0);
      expect((await request(app).get(`${API}/pqrs/macros?all=true`).set(soporte).expect(200)).body.data).toHaveLength(1);

      await request(app).delete(`${API}/pqrs/macros/${created.body.data._id}`).set(soporte).expect(200);
      expect(await SupportMacro.countDocuments()).toBe(0);
    });
  });

  describe('Documentos legales versionados', () => {
    const publish = (h: any, body: Record<string, unknown>) => request(app).post(`${API}/legal/admin/documents`).set(h).send(body);

    it('solo el Super Administrador publica; la nueva versión archiva la anterior y exige explicar el cambio', async () => {
      const sup = await authHeader(await makeStaff({ roleSlug: 'super_admin' }));
      const soporte = await authHeader(await makeStaff({ roleSlug: 'soporte' }));

      await publish(soporte, { kind: 'terms', version: '1.0', title: 'Términos', content: LONG }).expect(403);
      const v1 = await publish(sup, { kind: 'terms', version: '1.0', title: 'Términos', content: LONG }).expect(201);

      // Desde la segunda versión hay que decir qué cambió.
      await publish(sup, { kind: 'terms', version: '1.1', title: 'Términos', content: LONG }).expect(422);
      await publish(sup, { kind: 'terms', version: '1.0', title: 'Términos', content: LONG, changeNote: 'Repetida' }).expect(409);
      const v2 = await publish(sup, { kind: 'terms', version: '1.1', title: 'Términos', content: LONG, changeNote: 'Nuevo plazo de reclamos' }).expect(201);

      expect((await LegalDocument.findById(v1.body.data._id))!.isActive).toBe(false);
      expect((await LegalDocument.findById(v2.body.data._id))!.isActive).toBe(true);

      // La app solo ve la vigente, una por tipo.
      const active = await request(app).get(`${API}/legal/documents`).expect(200);
      expect(active.body.data).toHaveLength(1);
      expect(active.body.data[0].version).toBe('1.1');
    });

    it('sirve una sola versión por tipo aunque un fallo dejara dos vigentes', async () => {
      await LegalDocument.create({ kind: 'privacy', version: 'a', title: 'P', content: LONG, effectiveAt: new Date('2026-01-01') });
      await LegalDocument.create({ kind: 'privacy', version: 'b', title: 'P', content: LONG, effectiveAt: new Date('2026-06-01') });
      const active = await request(app).get(`${API}/legal/documents`).expect(200);
      expect(active.body.data).toHaveLength(1);
      expect(active.body.data[0].version).toBe('b');
    });

    it('lista versiones con cuántos aceptaron y quién', async () => {
      const sup = await authHeader(await makeStaff({ roleSlug: 'super_admin' }));
      const doc = await LegalDocument.create({ kind: 'terms', version: '1.0', title: 'T', content: LONG, effectiveAt: new Date() });
      const u = await makeUser({ name: 'Ana Titular' });
      await LegalAcceptance.create({ userId: u._id, documentId: doc._id, version: '1.0', ipHash: 'abc' });

      const list = await request(app).get(`${API}/legal/admin/documents`).set(sup).expect(200);
      expect(list.body.data[0].acceptances).toBe(1);
      expect(list.body.data[0].content).toBeUndefined();

      const who = await request(app).get(`${API}/legal/admin/documents/${doc._id}/acceptances`).set(sup).expect(200);
      expect(who.body.data.total).toBe(1);
      expect(who.body.data.rows[0].userId.name).toBe('Ana Titular');
      expect(who.body.data.rows[0].ipHash).toBeUndefined();
    });
  });

  describe('Ley 1581: prórroga del plazo', () => {
    const mk = async (type: 'access' | 'delete' = 'access', createdAt = new Date()) => {
      const u = await makeUser();
      return DataRequest.create({ userId: u._id, type, detail: 'Quiero saber qué datos suyos tienen.', legalDueAt: computeDataRequestLegalDueAt(type, createdAt), createdAt });
    };

    it('amplía una sola vez, 5 días hábiles la consulta y 8 el reclamo', async () => {
      const access = await mk('access');
      const before = access.legalDueAt!;
      const updated = await extendDataRequest(String(access._id), 'Estamos reuniendo los datos de varios sistemas.');
      expect(updated.legalDueAt!.getTime()).toBe(addBusinessDays(before, 5).getTime());
      expect(updated.extendedAt).not.toBeNull();
      await expect(extendDataRequest(String(access._id), 'Otra vez la misma razón por favor.')).rejects.toMatchObject({ statusCode: 422 });

      const del = await mk('delete');
      const d = await extendDataRequest(String(del._id), 'La supresión exige validar obligaciones contables.');
      expect(d.legalDueAt!.getTime()).toBe(addBusinessDays(del.legalDueAt!, 8).getTime());
    });

    it('no prorroga un plazo ya vencido ni una solicitud cerrada', async () => {
      const old = await mk('access', new Date(Date.now() - 40 * 86_400_000));
      await expect(extendDataRequest(String(old._id), 'Llegamos tarde con la prórroga.')).rejects.toMatchObject({ statusCode: 422 });
      const closed = await mk();
      await DataRequest.updateOne({ _id: closed._id }, { $set: { status: 'resolved' } });
      await expect(extendDataRequest(String(closed._id), 'Ya estaba resuelta la solicitud.')).rejects.toMatchObject({ statusCode: 422 });
    });

    it('dos prórrogas simultáneas suman una sola', async () => {
      const r = await mk('delete');
      const results = await Promise.allSettled([
        extendDataRequest(String(r._id), 'Primera persona que prorroga esto.'),
        extendDataRequest(String(r._id), 'Segunda persona que prorroga esto.'),
      ]);
      expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
      const fresh = await DataRequest.findById(r._id);
      expect(fresh!.legalDueAt!.getTime()).toBe(addBusinessDays(r.legalDueAt!, 8).getTime());
    });

    it('la ruta exige legal:manage; tomar la deja en revisión', async () => {
      const r = await mk();
      const legal = await authHeader(await makeStaff({ roleSlug: 'soporte', permissions: [Permission.ADMIN_PANEL, Permission.LEGAL_VIEW, Permission.LEGAL_MANAGE] }));
      const ops = await authHeader(await makeStaff({ roleSlug: 'operaciones' }));

      await request(app).patch(`${API}/legal/admin/data-requests/${r._id}/extend`).set(ops).send({ reason: 'Necesitamos más tiempo para reunir todo.' }).expect(403);
      await request(app).patch(`${API}/legal/admin/data-requests/${r._id}/take`).set(legal).expect(200);
      expect((await DataRequest.findById(r._id))!.status).toBe('in_review');
      await request(app).patch(`${API}/legal/admin/data-requests/${r._id}/take`).set(legal).expect(409);
      await request(app).patch(`${API}/legal/admin/data-requests/${r._id}/extend`).set(legal).send({ reason: 'corto' }).expect(400);
      await request(app).patch(`${API}/legal/admin/data-requests/${r._id}/extend`).set(legal).send({ reason: 'Necesitamos más tiempo para reunir todo.' }).expect(200);
    });
  });
  describe('Endurecimiento tras la revisión de seguridad', () => {
    it('una supresión ya rechazada no anonimiza la cuenta', async () => {
      const sup = await authHeader(await makeStaff({ roleSlug: 'super_admin' }));
      const u = await makeUser({ name: 'Titular Vivo' });
      const r = await DataRequest.create({ userId: u._id, type: 'delete', detail: 'Quiero que borren mi cuenta.', status: 'rejected', legalDueAt: new Date(Date.now() + 86_400_000) });
      await request(app).patch(`${API}/legal/admin/data-requests/${r._id}`).set(sup)
        .send({ status: 'resolved', response: 'Procede la supresión', anonymize: true }).expect(422);
      expect((await (await import('../models')).User.findById(u._id))!.name).toBe('Titular Vivo');
    });

    it('reclasificar un caso vencido a baja no le regala plazo nuevo', async () => {
      const u = await makeUser();
      const old = new Date(Date.now() - 30 * 3_600_000);
      const c = await Pqrs.create({ userId: u._id, type: 'complaint', subject: 'Vencido', detail: 'Caso abierto hace 30 horas.', createdAt: old, dueAt: new Date(old.getTime() + 24 * 3_600_000) });
      const t = await supportService.classify(String(c._id), 'low');
      expect(t.dueAt!.getTime()).toBe(old.getTime() + 72 * 3_600_000);
      const urgent = await supportService.classify(String(c._id), 'urgent');
      expect(urgent.dueAt!.getTime()).toBeLessThan(Date.now());
    });

    it('dos publicaciones simultáneas no dejan el tipo sin versión vigente', async () => {
      const { publishLegalDocument } = await import('../services/legalDocument.service');
      const admin = String((await makeStaff({ roleSlug: 'super_admin' }))._id);
      await publishLegalDocument({ kind: 'terms', version: '1', title: 'Términos', content: LONG, adminId: admin });
      await Promise.allSettled([
        publishLegalDocument({ kind: 'terms', version: '2', title: 'Términos', content: LONG, changeNote: 'A', adminId: admin }),
        publishLegalDocument({ kind: 'terms', version: '3', title: 'Términos', content: LONG, changeNote: 'B', adminId: admin }),
      ]);
      expect(await LegalDocument.countDocuments({ kind: 'terms', isActive: true })).toBeGreaterThanOrEqual(1);
    });

    it('volver a aceptar conserva la prueba original', async () => {
      const u = await makeUser();
      const doc = await LegalDocument.create({ kind: 'terms', version: '1', title: 'T', content: LONG, effectiveAt: new Date() });
      await request(app).post(`${API}/legal/documents/${doc._id}/accept`).set(await authHeader(u)).expect(200);
      const first = await LegalAcceptance.findOne({ userId: u._id });
      await new Promise((r) => setTimeout(r, 20));
      await request(app).post(`${API}/legal/documents/${doc._id}/accept`).set(await authHeader(u)).expect(200);
      const second = await LegalAcceptance.findOne({ userId: u._id });
      expect(second!.acceptedAt.getTime()).toBe(first!.acceptedAt.getTime());
    });

    it('limita los casos abiertos por persona y no revela si un pedido existe', async () => {
      const u = await makeUser({ role: UserRole.CLIENT });
      for (let i = 0; i < 10; i++) {
        await createPqrs({ userId: u._id.toString(), type: 'suggestion', subject: `Idea ${i}`, detail: 'Una sugerencia con detalle suficiente.' });
      }
      await expect(createPqrs({ userId: u._id.toString(), type: 'suggestion', subject: 'Una más', detail: 'Otra sugerencia con detalle.' }))
        .rejects.toMatchObject({ statusCode: 429 });
      const other = await makeUser({ role: UserRole.CLIENT });
      await expect(createPqrs({ userId: other._id.toString(), type: 'complaint', subject: 'Pedido fantasma', detail: 'Pedido que no existe en el sistema.', orderId: '64b000000000000000000000' }))
        .rejects.toMatchObject({ statusCode: 403 });
    });

    it('el cliente no ve ids del personal ni SLA internos; ?all=true de macros exige gestionar; asignar solo a personal', async () => {
      const client = await makeUser({ role: UserRole.CLIENT });
      const res = await request(app).post(`${API}/pqrs`).set(await authHeader(client))
        .send({ type: 'claim', subject: 'Cobro repetido', detail: 'Me cobraron dos veces este pedido.' }).expect(201);
      expect(res.body.data.dueAt).toBeUndefined();
      expect(res.body.data.priority).toBeUndefined();
      const mine = await request(app).get(`${API}/pqrs/my`).set(await authHeader(client)).expect(200);
      expect(mine.body.data[0].assignedTo).toBeUndefined();

      const ops = await makeStaff({ roleSlug: 'soporte', permissions: [Permission.ADMIN_PANEL, Permission.SUPPORT_VIEW] });
      await SupportMacro.create({ title: 'Archivada', body: 'Texto archivado', isActive: false, createdBy: ops._id });
      const view = await request(app).get(`${API}/pqrs/macros?all=true`).set(await authHeader(ops)).expect(200);
      expect(view.body.data).toHaveLength(0);

      const soporte = await authHeader(await makeStaff({ roleSlug: 'soporte' }));
      await request(app).patch(`${API}/pqrs/${res.body.data._id}/assign`).set(soporte).send({ agentId: String(client._id) }).expect(422);
    });
  });
});
