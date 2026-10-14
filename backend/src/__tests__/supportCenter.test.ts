import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { Types } from 'mongoose';
import app from '../app';
import { Pqrs, Order, Refund, Payout, LedgerEntry, Settlement, HelpArticle, Business, BusinessStaff, BusinessRole } from '../models';
import { OrderStatus, PaymentMethod, PaymentStatus, PayoutBeneficiary, UserRole } from '../types';
import { Permission } from '../security/rbac';
import { featureFlagService } from '../services/featureFlag.service';
import { cache } from '../cache';
import { migrateSupportCenter, SEED_ARTICLES } from '../migrations/027-support-center';
import { authHeader, makeBusiness, makePricingConfig, makeStaff, makeUser, GARZON } from './factories';

const API = '/api/v1';
const DETAIL = 'Detalle suficientemente largo del problema ocurrido.';

/**
 * Centro de soporte del panel de comercios: solicitudes con número y
 * categoría, historial de estados, aislamiento entre negocios, gestión desde
 * administración y el Centro de ayuda.
 */
describe('Centro de soporte del comercio', () => {
  let owner: any; let business: any; let client: any;
  let other: any; let otherBusiness: any;

  const makeOrder = (biz: any, over: Record<string, unknown> = {}) => Order.create({
    orderNumber: `ZIPP-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    clientId: client._id,
    businessId: biz._id,
    items: [],
    status: OrderStatus.DELIVERED,
    paymentMethod: PaymentMethod.ONLINE,
    paymentStatus: PaymentStatus.PAID,
    deliveryAddress: 'Calle falsa 123',
    deliveryLocation: { type: 'Point', coordinates: [GARZON.lng, GARZON.lat] },
    subtotal: 20000, deliveryFee: 4000, total: 24000,
    platformCommission: 2000, businessPayout: 18000, driverPayout: 4000,
    finance: { productSubtotal: 20000, merchantCommission: 2000, businessPayout: 18000 },
    ...over,
  });

  const makeSettlement = (biz: any) => Settlement.create({
    beneficiary: PayoutBeneficiary.BUSINESS, businessId: biz._id, periodStart: new Date('2026-10-01'), periodEnd: new Date('2026-10-07'),
    payoutCount: 3, grossAmount: 90000, netAmount: 81000, reference: 'TRF-SECRETA-99', createdBy: new Types.ObjectId(),
  });

  const open = async (user: any, body: Record<string, unknown>) => request(app).post(`${API}/pqrs`).set(await authHeader(user))
    .send({ subject: 'Un problema', detail: DETAIL, businessId: String(business._id), ...body });

  beforeEach(async () => {
    await featureFlagService.upsert('rbac_enforce', { audience: 'staff' });
    await cache.flush();
    await makePricingConfig({});
    owner = await makeUser({ role: UserRole.BUSINESS });
    business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
    client = await makeUser({ role: UserRole.CLIENT });
    other = await makeUser({ role: UserRole.BUSINESS });
    otherBusiness = await makeBusiness(other._id, { lat: GARZON.lat, lng: GARZON.lng });
  });

  describe('Crear solicitudes', () => {
    it('numera, categoriza y toma el medio de pago del pedido', async () => {
      const order = await makeOrder(business, { paymentMethod: PaymentMethod.CASH_ON_DELIVERY, paymentStatus: PaymentStatus.PENDING });
      const first = await open(owner, { reason: 'cancelled_order_adjustment', orderId: String(order._id), paymentMethod: 'online' });
      expect(first.status).toBe(201);
      expect(first.body.data.code).toMatch(/^SOP-\d{6}$/);
      expect(first.body.data.category).toBe('financial');
      // El medio de pago lo dice el pedido, no lo que teclee el comercio.
      expect(first.body.data.paymentMethod).toBe('cash_on_delivery');
      expect(first.body.data.displayStatus).toBe('open');
      expect(first.body.data.statusHistory).toEqual([expect.objectContaining({ status: 'received', actor: 'requester' })]);

      const second = await open(owner, { reason: 'panel_issue' });
      expect(second.body.data.category).toBe('technical');
      expect(second.body.data.code).not.toBe(first.body.data.code);
      const numbers = (await Pqrs.find().select('ticketNumber').lean()).map((p) => p.ticketNumber);
      expect(new Set(numbers).size).toBe(2);
    });

    it('crear un caso financiero no toca pedido, reembolsos, payouts ni libro mayor', async () => {
      const order = await makeOrder(business, { status: OrderStatus.CANCELLED });
      const before = await Order.findById(order._id).lean();
      const counts = async () => [await Refund.countDocuments(), await Payout.countDocuments(), await LedgerEntry.countDocuments()];
      const baseline = await counts();

      for (const reason of ['cancelled_order_adjustment', 'refund_question', 'wrong_commission']) {
        const res = await open(owner, { reason, orderId: String(order._id) });
        expect(res.status).toBe(201);
        expect(res.body.data.refundStatus).toBeNull();
      }
      expect(await counts()).toEqual(baseline);
      expect(JSON.stringify(await Order.findById(order._id).lean())).toBe(JSON.stringify(before));
    });

    it('exige pedido en los motivos que hablan de uno y marca urgente lo operativo en curso', async () => {
      expect((await open(owner, { reason: 'preparation_issue' })).status).toBe(422);
      expect((await open(owner, { reason: 'cancelled_order_adjustment' })).status).toBe(422);
      expect((await open(owner, { reason: 'settlement_difference' })).status).toBe(201);

      const live = await makeOrder(business, { status: OrderStatus.PREPARING });
      const res = await open(owner, { reason: 'order_status_error', orderId: String(live._id) });
      expect(res.status).toBe(201);
      expect((await Pqrs.findById(res.body.data._id))!.priority).toBe('urgent');
    });

    it('sin pedido, el medio de pago solo se guarda en casos financieros', async () => {
      const financial = await open(owner, { reason: 'unidentified_payment', paymentMethod: 'cash_on_delivery' });
      expect(financial.body.data.paymentMethod).toBe('cash_on_delivery');
      const technical = await open(owner, { reason: 'panel_issue', paymentMethod: 'cash_on_delivery' });
      expect(technical.body.data.paymentMethod).toBeNull();
    });

    it('la liquidación citada debe ser del mismo negocio y el caso, financiero', async () => {
      const mine = await makeSettlement(business);
      const theirs = await makeSettlement(otherBusiness);

      expect((await open(owner, { reason: 'settlement_difference', settlementId: String(theirs._id) })).status).toBe(403);
      expect((await open(owner, { reason: 'settlement_difference', settlementId: String(new Types.ObjectId()) })).status).toBe(403);
      expect((await open(owner, { reason: 'panel_issue', settlementId: String(mine._id) })).status).toBe(422);

      const ok = await open(owner, { reason: 'settlement_difference', settlementId: String(mine._id) });
      expect(ok.status).toBe(201);
      expect(JSON.stringify(ok.body)).not.toContain('TRF-SECRETA-99');
    });
  });

  describe('Aislamiento entre negocios', () => {
    it('no se cuelga un pedido ni un negocio ajeno', async () => {
      const foreign = await makeOrder(otherBusiness);
      expect((await open(owner, { reason: 'order_issue', orderId: String(foreign._id) })).status).toBe(403);
      expect((await open(other, { reason: 'panel_issue' })).status).toBe(403);
    });

    it('otro negocio no ve, responde, cierra ni adjunta un caso ajeno', async () => {
      const created = await open(owner, { reason: 'panel_issue' });
      const id = created.body.data._id;
      await Pqrs.updateOne({ _id: id }, { $set: { status: 'answered' } });

      const list = await request(app).get(`${API}/pqrs/my`).set(await authHeader(other)).expect(200);
      expect(list.body.data).toHaveLength(0);
      await request(app).post(`${API}/pqrs/${id}/reply`).set(await authHeader(other)).send({ message: 'Hola, soy otro' }).expect(404);
      await request(app).post(`${API}/pqrs/${id}/resolve`).set(await authHeader(other)).expect(409);
      await request(app).get(`${API}/pqrs/business/${business._id}`).set(await authHeader(other)).expect(403);
      expect((await Pqrs.findById(id))!.responses).toHaveLength(0);
    });

    it('quien tiene dos locales ve solo los del local pedido', async () => {
      const second = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
      await open(owner, { reason: 'panel_issue' });
      await request(app).post(`${API}/pqrs`).set(await authHeader(owner))
        .send({ reason: 'panel_issue', subject: 'Otro local', detail: DETAIL, businessId: String(second._id) }).expect(201);

      const all = await request(app).get(`${API}/pqrs/my`).set(await authHeader(owner)).expect(200);
      expect(all.body.data).toHaveLength(2);
      const scoped = await request(app).get(`${API}/pqrs/my?businessId=${business._id}`).set(await authHeader(owner)).expect(200);
      expect(scoped.body.data).toHaveLength(1);
      expect(scoped.body.data[0].subject).toBe('Un problema');
      await request(app).get(`${API}/pqrs/my?businessId=nope`).set(await authHeader(owner)).expect(400);
    });

    it('la lista trae la liquidación citada solo con su periodo', async () => {
      const settlement = await makeSettlement(business);
      await open(owner, { reason: 'settlement_difference', settlementId: String(settlement._id) });
      const res = await request(app).get(`${API}/pqrs/my`).set(await authHeader(owner)).expect(200);
      expect(Object.keys(res.body.data[0].settlement).sort()).toEqual(['periodEnd', 'periodStart']);
      expect(JSON.stringify(res.body.data[0])).not.toContain('TRF-SECRETA-99');
    });

    it('la lista trae el pedido citado sin montos ni datos del cliente', async () => {
      const order = await makeOrder(business, { paymentMethod: PaymentMethod.CASH_ON_DELIVERY });
      await open(owner, { reason: 'order_issue', orderId: String(order._id) });
      const res = await request(app).get(`${API}/pqrs/my`).set(await authHeader(owner)).expect(200);
      expect(res.body.data[0].order).toEqual({ orderNumber: order.orderNumber, status: 'delivered', paymentMethod: 'cash_on_delivery' });
      const text = JSON.stringify(res.body.data[0].order);
      for (const key of ['total', 'subtotal', 'businessPayout', 'platformCommission', 'clientId']) expect(text).not.toContain(key);
    });
  });

  describe('Estados e historial', () => {
    it('recorre abierto → en revisión → esperando al negocio → resuelto y deja cada paso', async () => {
      const created = await open(owner, { reason: 'panel_issue' });
      const id = created.body.data._id;
      const agent = await makeStaff({ roleSlug: 'soporte' });

      const reply = await request(app).patch(`${API}/pqrs/${id}/respond`).set(await authHeader(agent)).send({ message: 'Revisamos tu caso.' });
      expect(reply.status).toBe(200);

      let mine = (await request(app).get(`${API}/pqrs/my`).set(await authHeader(owner))).body.data[0];
      expect(mine.displayStatus).toBe('waiting_business');

      await request(app).post(`${API}/pqrs/${id}/reply`).set(await authHeader(owner)).send({ message: 'Sigue pasando.' }).expect(201);
      mine = (await request(app).get(`${API}/pqrs/my`).set(await authHeader(owner))).body.data[0];
      expect(mine.displayStatus).toBe('in_review');

      await request(app).patch(`${API}/pqrs/${id}/respond`).set(await authHeader(agent)).send({ message: 'Ya quedó.' }).expect(200);
      await request(app).post(`${API}/pqrs/${id}/resolve`).set(await authHeader(owner)).expect(200);

      mine = (await request(app).get(`${API}/pqrs/my`).set(await authHeader(owner))).body.data[0];
      expect(mine.displayStatus).toBe('resolved');
      expect(mine.statusHistory.map((h: any) => h.status)).toEqual(['received', 'in_review', 'answered', 'in_review', 'answered', 'closed']);
      expect(mine.statusHistory.at(-1)).toMatchObject({ actor: 'requester', resolved: true });
      // Quién del personal movió el caso no sale al comercio.
      expect(JSON.stringify(mine.statusHistory)).not.toContain('actorId');
      expect(mine.assignedTo).toBeUndefined();
    });

    it('un cierre del personal es "cerrado" y reabrir queda en el historial', async () => {
      const id = (await open(owner, { reason: 'panel_issue' })).body.data._id;
      const agent = await makeStaff({ roleSlug: 'soporte' });
      await request(app).patch(`${API}/pqrs/${id}/close`).set(await authHeader(agent)).send({}).expect(200);
      expect((await request(app).get(`${API}/pqrs/my`).set(await authHeader(owner))).body.data[0].displayStatus).toBe('closed');

      await request(app).post(`${API}/pqrs/${id}/reopen`).set(await authHeader(owner)).send({ message: 'No quedó resuelto' }).expect(200);
      const row = await Pqrs.findById(id).lean();
      expect(row!.statusHistory!.map((h) => h.status)).toEqual(['received', 'closed', 'in_review']);
    });

    it('registrar el mismo estado dos veces no duplica la entrada', async () => {
      const id = (await open(owner, { reason: 'panel_issue' })).body.data._id;
      const agent = await makeStaff({ roleSlug: 'soporte' });
      await request(app).patch(`${API}/pqrs/${id}/assign`).set(await authHeader(agent)).send({}).expect(200);
      await request(app).patch(`${API}/pqrs/${id}/assign`).set(await authHeader(agent)).send({}).expect(200);
      expect((await Pqrs.findById(id).lean())!.statusHistory!.map((h) => h.status)).toEqual(['received', 'in_review']);
    });
  });

  describe('Administración', () => {
    it('la cola exige support:view, filtra por categoría y busca por número', async () => {
      const a = await open(owner, { reason: 'unidentified_payment' });
      await open(owner, { reason: 'panel_issue' });
      const agent = await makeStaff({ roleSlug: 'soporte' });
      const noSupport = await makeStaff({ roleSlug: null, permissions: [Permission.ORDERS_VIEW_ALL] });

      await request(app).get(`${API}/pqrs/support/queue`).set(await authHeader(noSupport)).expect(403);
      await request(app).get(`${API}/pqrs/support/queue`).set(await authHeader(owner)).expect(403);

      const financial = await request(app).get(`${API}/pqrs/support/queue?category=financial`).set(await authHeader(agent)).expect(200);
      expect(financial.body.data).toHaveLength(1);
      expect(financial.body.data[0].code).toBe(a.body.data.code);

      const byCode = await request(app).get(`${API}/pqrs/support/queue?q=${a.body.data.code}`).set(await authHeader(agent)).expect(200);
      expect(byCode.body.data.map((t: any) => t.code)).toEqual([a.body.data.code]);
    });

    it('la liquidación citada llega a soporte solo con su periodo, sin montos ni referencia', async () => {
      const settlement = await makeSettlement(business);
      await open(owner, { reason: 'settlement_difference', settlementId: String(settlement._id) });
      const agent = await makeStaff({ roleSlug: 'soporte' });
      const res = await request(app).get(`${API}/pqrs/support/queue`).set(await authHeader(agent)).expect(200);
      const text = JSON.stringify(res.body.data[0].settlementId);
      expect(text).toContain('periodStart');
      for (const secret of ['TRF-SECRETA-99', 'netAmount', 'grossAmount', 'reference']) expect(text).not.toContain(secret);
    });

    it('soporte pide el reembolso pero no lo hace: sigue siendo de Finanzas', async () => {
      const order = await makeOrder(business, { status: OrderStatus.CANCELLED });
      const id = (await open(owner, { reason: 'refund_question', orderId: String(order._id) })).body.data._id;
      const agent = await makeStaff({ roleSlug: 'soporte' });
      await request(app).patch(`${API}/pqrs/${id}/refund-request`).set(await authHeader(agent)).send({ reason: 'El cliente no recibió el pedido' }).expect(200);
      expect(await Refund.countDocuments()).toBe(0);
      const mine = (await request(app).get(`${API}/pqrs/my`).set(await authHeader(owner))).body.data[0];
      expect(mine.refundStatus).toBe('pending');
      expect(JSON.stringify(mine)).not.toContain('El cliente no recibió');
    });
  });

  describe('Centro de ayuda', () => {
    const article = { category: 'orders', question: '¿Cómo acepto un pedido?', answer: 'Desde la tarjeta del pedido pulsa Aceptar.' };

    it('el comercio lee solo lo publicado y no puede escribir', async () => {
      await HelpArticle.create({ ...article });
      await HelpArticle.create({ ...article, question: 'Borrador sin publicar', isPublished: false });

      const res = await request(app).get(`${API}/help-articles`).set(await authHeader(owner)).expect(200);
      expect(res.body.data.map((a: any) => a.question)).toEqual([article.question]);
      expect(res.body.data[0].createdBy).toBeUndefined();

      await request(app).post(`${API}/help-articles`).set(await authHeader(owner)).send(article).expect(403);
      await request(app).get(`${API}/help-articles/manage`).set(await authHeader(owner)).expect(403);
      await request(app).get(`${API}/help-articles`).expect(401);
    });

    it('administración gestiona con support:manage y queda auditado', async () => {
      const viewer = await makeStaff({ roleSlug: null, permissions: [Permission.SUPPORT_VIEW] });
      await request(app).post(`${API}/help-articles`).set(await authHeader(viewer)).send(article).expect(403);

      const agent = await makeStaff({ roleSlug: 'soporte' });
      const created = await request(app).post(`${API}/help-articles`).set(await authHeader(agent)).send(article).expect(201);
      const id = created.body.data._id;
      await request(app).post(`${API}/help-articles`).set(await authHeader(agent)).send({ ...article, category: 'inventada' }).expect(400);

      await request(app).patch(`${API}/help-articles/${id}`).set(await authHeader(agent)).send({ isPublished: false }).expect(200);
      expect((await request(app).get(`${API}/help-articles`).set(await authHeader(owner))).body.data).toHaveLength(0);
      expect((await request(app).get(`${API}/help-articles/manage`).set(await authHeader(agent))).body.data).toHaveLength(1);

      await request(app).delete(`${API}/help-articles/${id}`).set(await authHeader(agent)).expect(200);
      expect(await HelpArticle.countDocuments()).toBe(0);
    });
  });

  describe('Migración 027', () => {
    it('numera los casos viejos en orden y siembra los artículos una sola vez', async () => {
      const older = await Pqrs.create({ userId: owner._id, type: 'claim', subject: 'Viejo', detail: DETAIL, createdAt: new Date('2026-01-01') });
      const newer = await Pqrs.create({ userId: owner._id, type: 'claim', subject: 'Nuevo', detail: DETAIL, createdAt: new Date('2026-02-01') });

      expect(await migrateSupportCenter({ dryRun: true })).toMatchObject({ ticketsToNumber: 2, articlesToSeed: SEED_ARTICLES.length });
      expect((await Pqrs.findById(older._id))!.ticketNumber).toBeNull();

      await migrateSupportCenter();
      const [a, b] = [(await Pqrs.findById(older._id))!.ticketNumber!, (await Pqrs.findById(newer._id))!.ticketNumber!];
      expect(a).toBeLessThan(b);
      expect(await HelpArticle.countDocuments()).toBe(SEED_ARTICLES.length);

      expect(await migrateSupportCenter()).toMatchObject({ ticketsToNumber: 0, articlesToSeed: 0 });
      expect(await HelpArticle.countDocuments()).toBe(SEED_ARTICLES.length);
    });
  });

  it('un empleado del local abre casos del local y el empleado de otro no', async () => {
    const employee = await makeUser({ role: UserRole.BUSINESS });
    await BusinessStaff.create({ businessId: business._id, userId: employee._id, role: BusinessRole.EMPLOYEE });
    expect((await open(employee, { reason: 'panel_issue' })).status).toBe(201);
    const stranger = await makeUser({ role: UserRole.BUSINESS });
    expect((await open(stranger, { reason: 'panel_issue' })).status).toBe(403);
    expect(await Business.countDocuments()).toBe(2);
  });
});
