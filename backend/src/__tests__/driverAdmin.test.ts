import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { Order, Driver, User, CashReconciliation, SosAlert, Pqrs, Review, DriverDocument } from '../models';
import { AuditLog, AuditAction } from '../security';
import { UserRole, OrderStatus, PaymentMethod, CashReconciliationStatus } from '../types';
import { authHeader, makeUser, makeDriver, makeBusiness, GARZON, makeZone } from './factories';
import { driverService } from '../services/driver.service';

/**
 * Módulo "Domiciliarios" del panel admin: listado con filtros, ficha 360,
 * y suspensión con su guarda.
 *
 * Lo que más pesa aquí es la guarda: suspender a alguien a mitad de una
 * entrega ya pagada deja a cliente y comercio esperando a quien ya no puede
 * repartir, y nada lo impedía.
 */

const API = '/api/v1';

async function order(
  driverId: any,
  businessId: any,
  clientId: any,
  status: OrderStatus,
  extra: Record<string, unknown> = {}
) {
  return Order.create({
    orderNumber: `ZIPP-${Math.random().toString(36).slice(2, 9).toUpperCase()}`,
    clientId,
    businessId,
    driverId,
    items: [],
    status,
    ...(status === OrderStatus.DELIVERED ? { deliveredAt: new Date() } : {}),
    paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
    deliveryAddress: 'Calle falsa 123',
    deliveryLocation: { type: 'Point', coordinates: [GARZON.lng, GARZON.lat] },
    subtotal: 20000,
    deliveryFee: 4000,
    tip: 1000,
    total: 25000,
    platformCommission: 2000,
    businessPayout: 18000,
    driverPayout: 5000,
    finance: { driverDeliveryPayout: 4000, tip: 1000 },
    ...extra,
  });
}

async function makeNamedDriver(
  name: string,
  opts: {
    email?: string;
    documentNumber?: string;
    plate?: string;
    isApproved?: boolean;
    isActive?: boolean;
    vehicleType?: string;
    status?: string;
    rating?: number;
    totalDeliveries?: number;
    createdAt?: Date;
  } = {}
) {
  const user = await makeUser({ role: UserRole.DRIVER, name, email: opts.email });
  if (opts.documentNumber) await User.updateOne({ _id: user._id }, { documentNumber: opts.documentNumber, documentType: 'CC' });
  const driver = await makeDriver(user._id, { isApproved: opts.isApproved, isActive: opts.isActive });
  const $set: Record<string, unknown> = {};
  if (opts.plate) $set.licensePlate = opts.plate;
  if (opts.vehicleType) $set.vehicleType = opts.vehicleType;
  if (opts.status) $set.status = opts.status;
  if (opts.rating !== undefined) $set.rating = opts.rating;
  if (opts.totalDeliveries !== undefined) $set.totalDeliveries = opts.totalDeliveries;
  if (Object.keys($set).length) await Driver.updateOne({ _id: driver._id }, { $set });
  // `createdAt` es inmutable en updates normales: hay que bajar al driver nativo.
  if (opts.createdAt) await Driver.collection.updateOne({ _id: driver._id }, { $set: { createdAt: opts.createdAt } });
  return { user, driver };
}

const waitForAudit = async (filter: Record<string, unknown>) => {
  for (let i = 0; i < 40; i++) {
    const found = await AuditLog.findOne(filter).lean();
    if (found) return found;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
};

describe('Suspender y reactivar domiciliarios', () => {
  let admin: any;
  let headers: Record<string, string>;
  let business: any;
  let client: any;

  beforeEach(async () => {
    admin = await makeUser({ role: UserRole.ADMIN });
    headers = await authHeader(admin);
    const owner = await makeUser({ role: UserRole.BUSINESS });
    business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
    client = await makeUser({ role: UserRole.CLIENT });
  });

  it('rechaza con 409 si tiene un pedido en curso, y no lo suspende', async () => {
    const { driver } = await makeNamedDriver('Con Pedido');
    await order(driver._id, business._id, client._id, OrderStatus.ON_WAY);

    const res = await request(app).patch(`${API}/admin/drivers/${driver._id}/suspend`).set(headers).expect(409);

    expect(res.body.message).toMatch(/pedido en curso/i);
    expect((await Driver.findById(driver._id))!.isActive).toBe(true);
  });

  it('suspende si solo tiene pedidos terminales y deja constancia en auditoría', async () => {
    const { driver } = await makeNamedDriver('Sin Pedido Activo');
    await order(driver._id, business._id, client._id, OrderStatus.DELIVERED);
    await order(driver._id, business._id, client._id, OrderStatus.CANCELLED);

    const res = await request(app).patch(`${API}/admin/drivers/${driver._id}/suspend`).set(headers).expect(200);

    expect(res.body.data.isActive).toBe(false);
    expect((await Driver.findById(driver._id))!.isActive).toBe(false);
    const log = await waitForAudit({ action: AuditAction.DRIVER_SUSPENDED, entityId: driver._id.toString() });
    expect(log).not.toBeNull();
    expect(log!.userId).toBe(admin._id.toString());
  });

  it('suspender a quien ya está suspendido da 409; reactivar restablece y audita', async () => {
    const { driver } = await makeNamedDriver('Ciclo');

    await request(app).patch(`${API}/admin/drivers/${driver._id}/suspend`).set(headers).expect(200);
    await request(app).patch(`${API}/admin/drivers/${driver._id}/suspend`).set(headers).expect(409);

    const res = await request(app).patch(`${API}/admin/drivers/${driver._id}/reactivate`).set(headers).expect(200);
    expect(res.body.data.isActive).toBe(true);
    expect(await waitForAudit({ action: AuditAction.DRIVER_REACTIVATED, entityId: driver._id.toString() })).not.toBeNull();

    await request(app).patch(`${API}/admin/drivers/${driver._id}/reactivate`).set(headers).expect(409);
  });

  it('id inexistente 404, id mal formado 400, sin permiso de admin 403', async () => {
    await request(app).patch(`${API}/admin/drivers/64b7f0f0f0f0f0f0f0f0f0f0/suspend`).set(headers).expect(404);
    await request(app).patch(`${API}/admin/drivers/no-es-id/suspend`).set(headers).expect(400);

    const { user, driver } = await makeNamedDriver('Intruso');
    const driverHeaders = await authHeader(user);
    await request(app).patch(`${API}/admin/drivers/${driver._id}/suspend`).set(driverHeaders).expect(403);
  });

  it('aprobar deja constancia en auditoría', async () => {
    const { driver } = await makeNamedDriver('Pendiente', { isApproved: false });

    await request(app).patch(`${API}/drivers/${driver._id}/approve`).set(headers).expect(200);

    expect((await Driver.findById(driver._id))!.isApproved).toBe(true);
    expect(await waitForAudit({ action: AuditAction.DRIVER_APPROVED, entityId: driver._id.toString() })).not.toBeNull();
  });
});

describe('Listado de domiciliarios (GET /drivers)', () => {
  let headers: Record<string, string>;
  const ids: Record<string, string> = {};

  beforeEach(async () => {
    headers = await authHeader(await makeUser({ role: UserRole.ADMIN }));

    const d = async (key: string, name: string, opts: Parameters<typeof makeNamedDriver>[1]) => {
      ids[key] = (await makeNamedDriver(name, opts)).driver._id.toString();
    };
    await d('ana', 'Ana Beltrán', {
      email: 'ana.beltran@zipp.test', documentNumber: '1075001', plate: 'AAA111',
      rating: 4.9, totalDeliveries: 50, createdAt: new Date('2026-01-10T15:00:00Z'),
    });
    await d('bruno', 'bruno Cárdenas', {
      documentNumber: '1075002', plate: 'BBB222', vehicleType: 'bicycle', status: 'busy',
      rating: 3.5, totalDeliveries: 200, createdAt: new Date('2026-02-10T15:00:00Z'),
    });
    await d('carla', 'Carla Díaz', {
      plate: 'CCC333', isApproved: false, status: 'offline',
      rating: 4.2, totalDeliveries: 5, createdAt: new Date('2026-03-10T15:00:00Z'),
    });
    await d('diego', 'Diego Eslava', {
      plate: 'DDD444', isActive: false, status: 'offline',
      rating: 4.5, totalDeliveries: 90, createdAt: new Date('2026-04-10T15:00:00Z'),
    });
  });

  const get = (qs: string) => request(app).get(`${API}/drivers${qs}`).set(headers).expect(200);
  const idsOf = (res: request.Response) => res.body.data.map((x: any) => x._id);

  it('sin filtros devuelve todos, con la forma del contrato y meta de paginación', async () => {
    const res = await get('');

    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(4);
    expect(res.body.meta).toMatchObject({ page: 1, limit: 20, total: 4, totalPages: 1 });

    const item = res.body.data.find((x: any) => x._id === ids.ana);
    expect(item.userId).toMatchObject({ name: 'Ana Beltrán', email: 'ana.beltran@zipp.test', documentNumber: '1075001', documentType: 'CC' });
    expect(typeof item.userId._id).toBe('string');
    expect(item).toMatchObject({ vehicleType: 'motorcycle', licensePlate: 'AAA111', isActive: true, isApproved: true, rating: 4.9, totalDeliveries: 50 });
    expect(item).toHaveProperty('baseFund');
    expect(item).toHaveProperty('currentFund');
  });

  it('nunca expone reputationScore ni credenciales del usuario', async () => {
    const res = await get('');
    const raw = JSON.stringify(res.body);

    expect(raw).not.toMatch(/reputationScore|reputationUpdatedAt/);
    expect(raw).not.toMatch(/password|twoFactorSecret|recoveryCodes|otpCode|pushTokens/i);
    expect(Object.keys(res.body.data[0].userId).sort()).toEqual(
      expect.arrayContaining(['_id', 'name', 'phone', 'createdAt'])
    );
  });

  it('busca por nombre, correo, documento y placa (sin distinguir mayúsculas)', async () => {
    expect(idsOf(await get('?search=ANA%20belt'))).toEqual([ids.ana]);
    expect(idsOf(await get('?search=ana.beltran@zipp'))).toEqual([ids.ana]);
    expect(idsOf(await get('?search=1075002'))).toEqual([ids.bruno]);
    expect(idsOf(await get('?search=ccc333'))).toEqual([ids.carla]);
  });

  it('busca por teléfono', async () => {
    const bruno = await Driver.findById(ids.bruno).populate<{ userId: { phone: string } }>('userId', 'phone');
    expect(idsOf(await get(`?search=${bruno!.userId.phone}`))).toEqual([ids.bruno]);
  });

  it('el término se escapa: un patrón de regex no rompe ni casa con todo', async () => {
    const res = await get('?search=' + encodeURIComponent('(a+)+$'));
    expect(res.body.data).toHaveLength(0);
    expect(idsOf(await get('?search=' + encodeURIComponent('.*')))).toEqual([]);
  });

  it('filtra por estado de cuenta derivado', async () => {
    expect(idsOf(await get('?driverStatus=pending'))).toEqual([ids.carla]);
    expect(idsOf(await get('?driverStatus=suspended'))).toEqual([ids.diego]);
    expect((await get('?driverStatus=active')).body.data.map((x: any) => x._id).sort()).toEqual([ids.ana, ids.bruno].sort());
  });

  it('filtra por disponibilidad y tipo de vehículo', async () => {
    expect(idsOf(await get('?availability=busy'))).toEqual([ids.bruno]);
    expect((await get('?availability=offline')).body.data).toHaveLength(2);
    expect(idsOf(await get('?vehicleType=bicycle'))).toEqual([ids.bruno]);
  });

  it('filtra por rango de fecha de registro (día completo, inclusive)', async () => {
    expect(idsOf(await get('?dateFrom=2026-02-01&dateTo=2026-03-31')).sort()).toEqual([ids.bruno, ids.carla].sort());
    expect(idsOf(await get('?dateFrom=2026-04-10&dateTo=2026-04-10'))).toEqual([ids.diego]);
    expect(idsOf(await get('?dateTo=2026-01-31'))).toEqual([ids.ana]);
  });

  it('combina filtros', async () => {
    expect(idsOf(await get('?driverStatus=active&availability=busy&vehicleType=bicycle&search=bruno'))).toEqual([ids.bruno]);
    expect((await get('?driverStatus=pending&vehicleType=bicycle')).body.data).toHaveLength(0);
  });

  it('ordena por nombre sin distinguir mayúsculas y por rating', async () => {
    expect(idsOf(await get('?sortBy=name&sortOrder=asc'))).toEqual([ids.ana, ids.bruno, ids.carla, ids.diego]);
    expect(idsOf(await get('?sortBy=name&sortOrder=desc'))).toEqual([ids.diego, ids.carla, ids.bruno, ids.ana]);
    expect(idsOf(await get('?sortBy=rating&sortOrder=desc'))).toEqual([ids.ana, ids.diego, ids.carla, ids.bruno]);
    expect(idsOf(await get('?sortBy=totalDeliveries&sortOrder=asc'))).toEqual([ids.carla, ids.ana, ids.diego, ids.bruno]);
  });

  it('por defecto los más recientes primero', async () => {
    expect(idsOf(await get(''))).toEqual([ids.diego, ids.carla, ids.bruno, ids.ana]);
  });

  it('pagina sin repetir ni saltarse filas, y el total respeta los filtros', async () => {
    const p1 = await get('?sortBy=name&sortOrder=asc&limit=3&page=1');
    const p2 = await get('?sortBy=name&sortOrder=asc&limit=3&page=2');

    expect(idsOf(p1)).toEqual([ids.ana, ids.bruno, ids.carla]);
    expect(idsOf(p2)).toEqual([ids.diego]);
    expect(p1.body.meta).toMatchObject({ page: 1, limit: 3, total: 4, totalPages: 2 });

    const filtered = await get('?driverStatus=active&limit=1');
    expect(filtered.body.meta).toMatchObject({ total: 2, totalPages: 2, limit: 1 });
  });

  it('rechaza parámetros inválidos con 400 y mantiene getAll compatible', async () => {
    await request(app).get(`${API}/drivers?vehicleType=car`).set(headers).expect(400);
    await request(app).get(`${API}/drivers?sortBy=reputationScore`).set(headers).expect(400);
    await request(app).get(`${API}/drivers?dateFrom=ayer`).set(headers).expect(400);

    const legacy = await driverService.getAll(1, 2);
    expect(legacy.drivers).toHaveLength(2);
    expect(legacy.meta).toMatchObject({ page: 1, limit: 2, total: 4, totalPages: 2 });
  });
});

describe('GET /drivers/:id y orden de rutas', () => {
  let headers: Record<string, string>;

  beforeEach(async () => {
    headers = await authHeader(await makeUser({ role: UserRole.ADMIN }));
  });

  it('devuelve el detalle con los campos extra y sin reputationScore', async () => {
    const { driver } = await makeNamedDriver('Detalle', { email: 'detalle@zipp.test' });
    await Driver.updateOne(
      { _id: driver._id },
      { emergencyContact: { name: 'Mamá', phone: '3001112222' }, batteryLevel: 64, totalEarnings: 120000, reputationScore: 77 }
    );

    const res = await request(app).get(`${API}/drivers/${driver._id}`).set(headers).expect(200);

    expect(res.body.data).toMatchObject({
      _id: driver._id.toString(),
      batteryLevel: 64,
      totalEarnings: 120000,
      emergencyContact: { name: 'Mamá', phone: '3001112222' },
    });
    expect(res.body.data.userId.email).toBe('detalle@zipp.test');
    expect(JSON.stringify(res.body)).not.toMatch(/reputationScore|password/i);
  });

  it('rutas estáticas siguen funcionando y no las captura /:id', async () => {
    const reasons = await request(app).get(`${API}/drivers/decline-reasons`).set(headers).expect(200);
    expect(Array.isArray(reasons.body.data)).toBe(true);

    await request(app).get(`${API}/drivers/documents/queue`).set(headers).expect(200);
    await request(app).get(`${API}/drivers/verifications/queue`).set(headers).expect(200);

    // /profile es del propio domiciliario: un admin no debe caer en /:id con "profile".
    const driverUser = await makeUser({ role: UserRole.DRIVER });
    await makeDriver(driverUser._id);
    await request(app).get(`${API}/drivers/profile`).set(await authHeader(driverUser)).expect(200);
  });

  it('404 si no existe, 400 si el id es inválido, 403 para un domiciliario', async () => {
    await request(app).get(`${API}/drivers/64b7f0f0f0f0f0f0f0f0f0f0`).set(headers).expect(404);
    await request(app).get(`${API}/drivers/no-es-un-id`).set(headers).expect(400);

    const { user, driver } = await makeNamedDriver('Curioso');
    await request(app).get(`${API}/drivers/${driver._id}`).set(await authHeader(user)).expect(403);
  });
});

describe('Ficha 360 (GET /admin/drivers/:id/profile-360)', () => {
  let admin: any;
  let headers: Record<string, string>;
  let driver: any;
  let driverUser: any;
  let business: any;
  let client: any;

  beforeEach(async () => {
    admin = await makeUser({ role: UserRole.ADMIN, name: 'Admin Ana' });
    headers = await authHeader(admin);
    ({ user: driverUser, driver } = await makeNamedDriver('Perfil Completo'));
    await Driver.updateOne({ _id: driver._id }, { totalEarnings: 90000, reputationScore: 88 });
    const owner = await makeUser({ role: UserRole.BUSINESS });
    business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
    client = await makeUser({ role: UserRole.CLIENT });
  });

  it('devuelve las cuatro secciones con los datos del domiciliario', async () => {
    const zone = await makeZone(GARZON, 3, { name: 'Centro' });
    const d1 = await order(driver._id, business._id, client._id, OrderStatus.DELIVERED, { zoneId: zone._id });
    await order(driver._id, business._id, client._id, OrderStatus.DELIVERED, { zoneId: zone._id });
    await order(driver._id, business._id, client._id, OrderStatus.DELIVERED);
    const cancelledOrder = await order(driver._id, business._id, client._id, OrderStatus.CANCELLED);
    await order(driver._id, business._id, client._id, OrderStatus.ON_WAY);

    // Un pedido entregado hace 40 días no cuenta en los últimos 30.
    await order(driver._id, business._id, client._id, OrderStatus.DELIVERED, {
      deliveredAt: new Date(Date.now() - 40 * 86_400_000),
    });

    await DriverDocument.create({ driverId: driver._id, type: 'soat', reference: 'SOAT-1', status: 'approved' });
    await Review.create({
      orderId: d1._id, userId: client._id, businessId: business._id, driverId: driver._id,
      driverRating: 4, comment: 'Llegó rápido',
    });
    await CashReconciliation.create({
      driverId: driver._id,
      orderId: d1._id,
      amount: 12000,
      status: CashReconciliationStatus.PENDING,
      dueAt: new Date(Date.now() + 24 * 3600_000),
    });
    // Ya liquidada, de otro pedido (orderId es único por conciliación) que
    // no cuenta como entrega: no debe sumar a la deuda viva ni tocar
    // `activity.totals`.
    await CashReconciliation.create({
      driverId: driver._id,
      orderId: cancelledOrder._id,
      amount: 8000,
      status: CashReconciliationStatus.SETTLED,
      dueAt: new Date(Date.now() + 24 * 3600_000),
      settledAt: new Date(),
    });
    await SosAlert.create({
      driverId: driver._id, userId: driverUser._id,
      location: { type: 'Point', coordinates: [GARZON.lng, GARZON.lat] }, note: 'Ayuda',
    });
    await Pqrs.create({
      userId: client._id, type: 'complaint', subject: 'Pedido frío', detail: 'Llegó frío', orderId: d1._id,
    });
    // Un PQRS de un pedido de otro domiciliario no debe aparecer.
    const other = await makeNamedDriver('Otro');
    const foreign = await order(other.driver._id, business._id, client._id, OrderStatus.DELIVERED);
    await Pqrs.create({ userId: client._id, type: 'claim', subject: 'Ajeno', detail: 'x', orderId: foreign._id });

    await request(app).patch(`${API}/admin/drivers/${driver._id}/suspend`).set(headers).expect(409); // hay uno en curso
    await Order.updateMany({ driverId: driver._id, status: OrderStatus.ON_WAY }, { status: OrderStatus.DELIVERED });
    await request(app).patch(`${API}/admin/drivers/${driver._id}/suspend`).set(headers).expect(200);
    await waitForAudit({ action: AuditAction.DRIVER_SUSPENDED, entityId: driver._id.toString() });

    const res = await request(app).get(`${API}/admin/drivers/${driver._id}/profile-360`).set(headers).expect(200);
    const p = res.body.data;

    expect(p.driver).toMatchObject({ _id: driver._id.toString(), totalEarnings: 90000, isActive: false });
    expect(p.driver.userId.name).toBe('Perfil Completo');

    expect(p.documents).toHaveLength(1);
    expect(p.documents[0]).toMatchObject({ type: 'soat', reference: 'SOAT-1', status: 'approved' });

    expect(p.activity.totals).toEqual({ delivered: 5, cancelled: 1 });
    expect(p.activity.recentOrders.length).toBeLessThanOrEqual(10);
    expect(p.activity.recentOrders[0]).toHaveProperty('orderNumber');
    expect(p.activity.reviews).toHaveLength(1);
    expect(p.activity.reviews[0]).toMatchObject({ rating: 4, comment: 'Llegó rápido' });
    // Sin zona se usa la ciudad del pedido (por defecto 'Garzón').
    expect(p.activity.coverageZones).toEqual([{ zone: 'Garzón', count: 3 }, { zone: 'Centro', count: 2 }]);

    expect(p.finance).toMatchObject({ baseFund: 50000, currentFund: 50000, totalEarnings: 90000 });
    // Tres entregas con fecha de hoy x (4000 + 1000). Quedan fuera la de hace 40 días
    // y la que se marcó entregada a mano sin `deliveredAt`.
    expect(p.finance.earningsLast30Days).toBe(3 * 5000);
    expect(Number.isInteger(p.finance.earningsLast30Days)).toBe(true);
    expect(p.finance.pendingDebts).toMatchObject({ count: 1, total: 12000 });
    expect(p.finance.pendingDebts.items).toHaveLength(1);
    expect(Array.isArray(p.finance.payouts)).toBe(true);
    expect(p.finance.settlements).toEqual([]);

    expect(p.incidents.sos).toHaveLength(1);
    expect(p.incidents.sos[0]).toMatchObject({ status: 'active', note: 'Ayuda' });
    expect(p.incidents.pqrs.map((x: any) => x.subject)).toEqual(['Pedido frío']);
    expect(p.incidents.notes).toEqual([]);
    expect(p.incidents.sanctions).toHaveLength(1);
    expect(p.incidents.sanctions[0]).toMatchObject({
      action: AuditAction.DRIVER_SUSPENDED,
      actorName: 'Admin Ana',
    });
    expect(p.incidents.sanctions[0]).toHaveProperty('createdAt');
  });

  it('nunca contiene reputationScore ni credenciales', async () => {
    const res = await request(app).get(`${API}/admin/drivers/${driver._id}/profile-360`).set(headers).expect(200);
    const raw = JSON.stringify(res.body);

    expect(raw).not.toMatch(/reputationScore|reputationUpdatedAt/);
    expect(raw).not.toMatch(/password|twoFactorSecret|recoveryCodes/i);
    expect(Object.keys(res.body.data).sort()).toEqual(['activity', 'documents', 'driver', 'finance', 'incidents']);
  });

  it('un domiciliario sin historial devuelve secciones vacías, no error', async () => {
    const res = await request(app).get(`${API}/admin/drivers/${driver._id}/profile-360`).set(headers).expect(200);
    const p = res.body.data;

    expect(p.activity.totals).toEqual({ delivered: 0, cancelled: 0 });
    expect(p.activity.coverageZones).toEqual([]);
    expect(p.finance.earningsLast30Days).toBe(0);
    expect(p.finance.pendingDebts).toEqual({ count: 0, total: 0, items: [] });
    expect(p.incidents.pqrs).toEqual([]);
  });

  it('404, 400 y 403 según el caso', async () => {
    await request(app).get(`${API}/admin/drivers/64b7f0f0f0f0f0f0f0f0f0f0/profile-360`).set(headers).expect(404);
    await request(app).get(`${API}/admin/drivers/xyz/profile-360`).set(headers).expect(400);
    await request(app).get(`${API}/admin/drivers/${driver._id}/profile-360`).set(await authHeader(driverUser)).expect(403);
  });
});
