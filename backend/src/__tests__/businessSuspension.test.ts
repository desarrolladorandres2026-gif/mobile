import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { Business, BusinessStaff, BusinessRole, Order } from '../models';
import { AuditLog, AuditAction } from '../security';
import { Permission } from '../security/rbac';
import { OrderStatus, PaymentMethod, UserRole } from '../types';
import { featureFlagService } from '../services/featureFlag.service';
import { businessService } from '../services/business.service';
import { orderService } from '../services/order.service';
import { cache } from '../cache';
import { GARZON, offsetKm, makeUser, makeBusiness, makeProduct, makePricingConfig, makeStaff, authHeader } from './factories';

/**
 * M-026 — cierre voluntario, suspensión administrativa y desactivación definitiva.
 *
 * Tres cosas distintas sobre estados que ya existían:
 *  · cierre voluntario  → `isActive` (+ `reopenAt`): lo abre y cierra el dueño;
 *  · suspensión de ZIPP → `isSuspended`: la levanta solo un administrador, con motivo;
 *  · desactivación definitiva → `isArchived`: se reactiva con `restore`, con motivo.
 * La suspensión prevalece sobre el interruptor del dueño en TODOS los puntos de entrada.
 */

const API = '/api/v1';
const DESTINATION = offsetKm(GARZON, 1);

let owner: any;
let business: any;
let admin: any;
let adminHeaders: Record<string, string>;

const open = async (user: any, isActive: boolean, id = business._id, body: Record<string, unknown> = {}) =>
  request(app).patch(`${API}/businesses/${id}/open`).set(await authHeader(user)).send({ isActive, ...body });

const suspend = (suspended: boolean, reason = 'Incumplimiento comprobado del contrato') =>
  request(app).patch(`${API}/admin/businesses/${business._id}/suspension`).set(adminHeaders).send({ suspended, reason });

const fresh = () => Business.findById(business._id).select('+adminStatusLog');

beforeEach(async () => {
  await featureFlagService.upsert('rbac_enforce', { audience: 'staff' });
  await cache.flush();
  await makePricingConfig({ cashOnDeliveryEnabled: true, cashOnDeliveryMaxAmount: 1_000_000 });
  owner = await makeUser({ role: UserRole.BUSINESS });
  business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
  admin = await makeStaff({ roleSlug: 'operaciones', permissions: Object.values(Permission) });
  adminHeaders = await authHeader(admin);
});

describe('Cierre temporal voluntario', () => {
  it('el dueño cierra y vuelve a abrir cuando quiere', async () => {
    expect((await open(owner, false)).status).toBe(200);
    expect((await fresh())!.isActive).toBe(false);
    expect((await open(owner, true)).status).toBe(200);
    expect((await fresh())!.isActive).toBe(true);
  });

  it('un cierre por minutos se reabre solo al vencer', async () => {
    await open(owner, false, business._id, { closeMinutes: 30 });
    expect((await fresh())!.reopenAt).toBeTruthy();
    expect(await businessService.reopenDue(new Date())).toBe(0);
    expect(await businessService.reopenDue(new Date(Date.now() + 31 * 60_000))).toBe(1);
    expect((await fresh())!.isActive).toBe(true);
  });

  it('el personal con store:toggle también abre y cierra', async () => {
    const manager = await makeUser({ role: UserRole.BUSINESS });
    await BusinessStaff.create({ businessId: business._id, userId: manager._id, role: BusinessRole.MANAGER, isActive: true, status: 'active' });
    expect((await open(manager, false)).status).toBe(200);
    expect((await open(manager, true)).status).toBe(200);
  });
});

describe('Suspensión administrativa', () => {
  it('el dueño no puede levantarla abriendo el negocio, por ninguna de las dos vías', async () => {
    await suspend(true).expect(200);

    const viaOpen = await open(owner, true);
    expect(viaOpen.status).toBe(403);
    expect(viaOpen.body.code).toBe('BUSINESS_SUSPENDED');

    const viaPut = await request(app).put(`${API}/businesses/${business._id}`).set(await authHeader(owner)).send({ isActive: true });
    expect(viaPut.status).toBe(403);
    expect(viaPut.body.code).toBe('BUSINESS_SUSPENDED');

    const state = (await fresh())!;
    expect(state.isSuspended).toBe(true);
    expect(state.suspensionReason).toBe('Incumplimiento comprobado del contrato');
  });

  it('tampoco el personal del local', async () => {
    const manager = await makeUser({ role: UserRole.BUSINESS });
    await BusinessStaff.create({ businessId: business._id, userId: manager._id, role: BusinessRole.MANAGER, isActive: true, status: 'active' });
    await suspend(true).expect(200);
    expect((await open(manager, true)).status).toBe(403);
  });

  it('ni un administrador por el camino de abrir y cerrar: la suspensión se levanta con su procedimiento', async () => {
    await suspend(true).expect(200);
    const res = await request(app).patch(`${API}/businesses/${business._id}/open`).set(adminHeaders).send({ isActive: true });
    expect(res.status).toBe(403);
    expect((await fresh())!.isSuspended).toBe(true);
  });

  it('el dueño sí puede cerrar su local mientras está suspendido, y la suspensión sigue', async () => {
    await suspend(true).expect(200);
    expect((await open(owner, false)).status).toBe(200);
    const state = (await fresh())!;
    expect(state.isActive).toBe(false);
    expect(state.isSuspended).toBe(true);
  });

  it('el cierre voluntario que vence durante la suspensión no reabre solo: la suspensión prevalece', async () => {
    await open(owner, false, business._id, { closeMinutes: 30 });
    await suspend(true).expect(200);
    expect(await businessService.reopenDue(new Date(Date.now() + 60 * 60_000))).toBe(0);
    expect((await fresh())!.isActive).toBe(false);

    // Levantada la suspensión, el barrido siguiente reabre lo que ya había vencido.
    await suspend(false, 'Subsanó el incumplimiento').expect(200);
    expect(await businessService.reopenDue(new Date(Date.now() + 60 * 60_000))).toBe(1);
    expect((await fresh())!.isActive).toBe(true);
  });

  it('solo la levanta un administrador autorizado, y exige motivo', async () => {
    await suspend(true).expect(200);
    // Sin motivo, no.
    await request(app).patch(`${API}/admin/businesses/${business._id}/suspension`).set(adminHeaders).send({ suspended: false }).expect(400);
    // Dueño, cliente y administrador sin permiso, no.
    const lift = { suspended: false, reason: 'Subsanó el incumplimiento' };
    await request(app).patch(`${API}/admin/businesses/${business._id}/suspension`).set(await authHeader(owner)).send(lift).expect(403);
    const viewer = await makeStaff({ roleSlug: 'soporte', permissions: [Permission.BUSINESSES_VIEW] });
    await request(app).patch(`${API}/admin/businesses/${business._id}/suspension`).set(await authHeader(viewer)).send(lift).expect(403);
    expect((await fresh())!.isSuspended).toBe(true);

    await request(app).patch(`${API}/admin/businesses/${business._id}/suspension`).set(adminHeaders).send(lift).expect(200);
    expect((await fresh())!.isSuspended).toBe(false);
  });

  it('queda escrito quién suspendió, quién levantó, cuándo y por qué', async () => {
    await suspend(true, 'Fraude confirmado en tres pedidos').expect(200);
    const second = await makeStaff({ roleSlug: 'finanzas', permissions: Object.values(Permission) });
    await request(app).patch(`${API}/admin/businesses/${business._id}/suspension`).set(await authHeader(second))
      .send({ suspended: false, reason: 'Apelación aceptada con evidencia' }).expect(200);

    const log = (await fresh())!.adminStatusLog!;
    expect(log.map((e) => e.action)).toEqual(['suspended', 'suspension_lifted']);
    expect(String(log[0].by)).toBe(String(admin._id));
    expect(log[0].reason).toBe('Fraude confirmado en tres pedidos');
    expect(String(log[1].by)).toBe(String(second._id));
    expect(log[1].reason).toBe('Apelación aceptada con evidencia');
    expect(log[1].at.getTime()).toBeGreaterThanOrEqual(log[0].at.getTime());

    expect(await AuditLog.countDocuments({ action: AuditAction.BUSINESS_SUSPENSION_SET, entityId: String(business._id) })).toBe(2);
  });

  it('el historial no lo ve nadie por accidente: no viaja en las consultas normales', async () => {
    await suspend(true).expect(200);
    const plain = await Business.findById(business._id).lean();
    expect((plain as any).adminStatusLog).toBeUndefined();
    const mine = await request(app).get(`${API}/businesses/my`).set(await authHeader(owner));
    expect(JSON.stringify(mine.body)).not.toContain('adminStatusLog');
  });

  it('dos peticiones simultáneas (suspender y levantar) no dejan un estado a medias', async () => {
    await suspend(true).expect(200);
    const results = await Promise.all([suspend(false, 'Levanto la suspensión ahora'), suspend(true, 'La vuelvo a suspender')]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const state = (await fresh())!;
    // Sea cual sea el orden, el estado es coherente: suspendido con motivo, o libre sin motivo.
    expect(state.isSuspended ? !!state.suspensionReason : state.suspensionReason == null).toBe(true);
  });
});

describe('La suspensión prevalece sobre el interruptor del dueño', () => {
  let client: any;
  let product: any;

  const placeOrder = () => orderService.create({
    clientId: client._id.toString(),
    businessId: business._id.toString(),
    items: [{ productId: product._id.toString(), quantity: 1 }],
    paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
    cashPayment: { needsChange: false },
    deliveryAddress: 'Calle 5 # 3-21',
    deliveryLatitude: DESTINATION.lat,
    deliveryLongitude: DESTINATION.lng,
  } as never);

  beforeEach(async () => {
    client = await makeUser({ role: UserRole.CLIENT });
    product = await makeProduct(business._id, { price: 20_000 });
  });

  it('no recibe pedidos nuevos aunque su interruptor diga «abierto»', async () => {
    await suspend(true).expect(200);
    expect((await fresh())!.isActive).toBe(true);
    await expect(placeOrder()).rejects.toMatchObject({ statusCode: 404 });
  });

  it('no aparece en el catálogo público', async () => {
    const before = await request(app).get(`${API}/businesses`);
    expect(JSON.stringify(before.body)).toContain(String(business._id));
    await suspend(true).expect(200);
    const after = await request(app).get(`${API}/businesses`);
    expect(JSON.stringify(after.body)).not.toContain(String(business._id));
  });

  it('no acepta un pedido que quedó pendiente, y a esa cocina no le suena el pedido nuevo', async () => {
    const order = await placeOrder();
    await suspend(true).expect(200);

    expect(await orderService.announceToBusiness(order._id.toString())).toBe(false);
    await expect(
      orderService.updateStatus(order._id.toString(), OrderStatus.ACCEPTED, owner._id.toString(), UserRole.BUSINESS)
    ).rejects.toMatchObject({ statusCode: 403, code: 'BUSINESS_SUSPENDED' });
    expect((await Order.findById(order._id))!.status).toBe(OrderStatus.PENDING);
  });

  it('lo que aceptó antes de la suspensión sí lo termina: el cliente está esperando', async () => {
    const order = await placeOrder();
    await orderService.updateStatus(order._id.toString(), OrderStatus.ACCEPTED, owner._id.toString(), UserRole.BUSINESS);
    await suspend(true).expect(200);
    await orderService.updateStatus(order._id.toString(), OrderStatus.PREPARING, owner._id.toString(), UserRole.BUSINESS);
    expect((await Order.findById(order._id))!.status).toBe(OrderStatus.PREPARING);
  });

  it('un pedido programado que se activa durante la suspensión no se anuncia', async () => {
    const order = await placeOrder();
    await suspend(true).expect(200);
    await Order.updateOne({ _id: order._id }, { $set: { scheduledFor: new Date(Date.now() + 5 * 60_000), scheduledActivatedAt: null } });
    await orderService.activateScheduledOrders();
    // Se marca activado (el barrido no lo reintenta), pero no suena en una cocina que no puede atenderlo.
    expect(await orderService.announceToBusiness(order._id.toString())).toBe(false);
  });
});

describe('Desactivar desde los términos comerciales', () => {
  const terms = async (body: Record<string, unknown>) =>
    request(app).patch(`${API}/finance/businesses/${business._id}/terms`).set(adminHeaders).send(body);

  it('«desactivar» es suspender: pide motivo, y el dueño ya no lo deshace abriendo', async () => {
    expect((await terms({ isActive: false })).status).toBe(400);
    expect((await terms({ isActive: false, statusReason: 'Cierre ordenado por incumplimiento' })).status).toBe(200);

    const state = (await fresh())!;
    expect(state.isSuspended).toBe(true);
    expect(state.suspensionReason).toBe('Cierre ordenado por incumplimiento');
    expect(String(state.suspendedBy)).toBe(String(admin._id));
    // El interruptor del dueño quedó como él lo tenía.
    expect(state.isActive).toBe(true);

    expect((await open(owner, true)).status).toBe(403);
    expect((await request(app).put(`${API}/businesses/${business._id}`).set(await authHeader(owner)).send({ isActive: true })).status).toBe(403);
  });

  it('«reactivar» desde los términos levanta la suspensión, con motivo, y no abre un local que el dueño cerró', async () => {
    await open(owner, false);
    await terms({ isActive: false, statusReason: 'Cierre ordenado por incumplimiento' }).then((r) => expect(r.status).toBe(200));
    expect((await terms({ isActive: true })).status).toBe(400);
    expect((await terms({ isActive: true, statusReason: 'Subsanó lo pedido' })).status).toBe(200);

    const state = (await fresh())!;
    expect(state.isSuspended).toBe(false);
    expect(state.isActive).toBe(false); // sigue cerrado: eso es del dueño
    expect(state.adminStatusLog!.map((e) => e.action)).toEqual(['suspended', 'suspension_lifted']);
  });

  it('cambiar la comisión o el pedido mínimo sigue sin necesitar motivo de estado', async () => {
    const res = await terms({ minOrder: 15_000 });
    expect(res.status).toBe(200);
    expect((await fresh())!.minOrder).toBe(15_000);
    expect((await fresh())!.isSuspended).toBe(false);
  });
});

describe('Desactivación definitiva (archivar) y su reactivación', () => {
  const archive = (reason = 'Cierre definitivo del establecimiento') =>
    request(app).patch(`${API}/admin/businesses/${business._id}/archive`).set(adminHeaders).send({ reason });
  const restore = (body: Record<string, unknown> = { reason: 'Reabrió con documentos al día' }) =>
    request(app).patch(`${API}/admin/businesses/${business._id}/restore`).set(adminHeaders).send(body);

  it('un negocio archivado no lo abre su dueño', async () => {
    await archive().expect(200);
    const res = await open(owner, true);
    expect(res.status).toBe(403);
    expect((await fresh())!.isActive).toBe(false);
  });

  it('reactivarlo es un procedimiento administrativo: exige motivo y queda a nombre de quien lo autoriza', async () => {
    await archive().expect(200);
    await restore({}).then((r) => expect(r.status).toBe(400));
    await request(app).patch(`${API}/admin/businesses/${business._id}/restore`).set(await authHeader(owner)).send({ reason: 'Me reactivo yo mismo' }).expect(403);
    expect((await fresh())!.isArchived).toBe(true);

    await restore().then((r) => expect(r.status).toBe(200));
    const state = (await fresh())!;
    expect(state.isArchived).toBe(false);
    expect(String(state.restoredBy)).toBe(String(admin._id));
    expect(state.restoreReason).toBe('Reabrió con documentos al día');
    expect(state.restoredAt).toBeTruthy();
    expect(state.adminStatusLog!.map((e) => e.action)).toEqual(['archived', 'restored']);
    expect(String(state.adminStatusLog![0].by)).toBe(String(admin._id));
  });

  it('al reactivarlo queda cerrado: el dueño decide cuándo abrir, y si además estaba suspendido, no puede', async () => {
    await suspend(true).expect(200);
    await archive().expect(200);
    await restore().then((r) => expect(r.status).toBe(200));
    const state = (await fresh())!;
    expect(state.isActive).toBe(false);
    expect(state.isSuspended).toBe(true);
    expect((await open(owner, true)).status).toBe(403);

    await suspend(false, 'Se levanta tras revisión').expect(200);
    expect((await open(owner, true)).status).toBe(200);
  });
});
