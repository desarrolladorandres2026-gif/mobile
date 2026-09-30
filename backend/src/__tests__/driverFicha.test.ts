import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { Driver, DriverDocument, DriverLocation, DriverShift, Order, User } from '../models';
import { AuditLog, AuditAction } from '../security';
import { OrderStatus, PaymentMethod, UserRole } from '../types';
import { cache } from '../cache';
import { authHeader, makeUser, makeDriver, makeBusiness, GARZON } from './factories';
import { buildFicha, haversineKm } from '../services/driverFicha.service';
import { driverShiftService } from '../services/driverShift.service';
import { driverService } from '../services/driver.service';

const API = '/api/v1';
const DAY = 86_400_000;

describe('Ficha del domiciliario', () => {
  let admin: any, driverUser: any, driver: any;

  beforeEach(async () => {
    await cache.flush();
    admin = await makeUser({ role: UserRole.ADMIN, name: 'Ana Admin' });
    driverUser = await makeUser({ role: UserRole.DRIVER, name: 'Juan Moto' });
    driver = await makeDriver(driverUser._id, { isApproved: true });
    await DriverDocument.deleteMany({ driverId: driver._id });
  });

  it('haversine: ~111 km por grado de latitud', () => {
    expect(haversineKm([0, 0], [0, 1])).toBeCloseTo(111.19, 1);
    expect(haversineKm([-75.6, 2.2], [-75.6, 2.2])).toBe(0);
  });

  it('el tiempo conectado sale de los turnos; sin turnos es null, no cero', async () => {
    const now = new Date();
    expect(await driverShiftService.connectedSeconds(driver._id, 7, undefined, now)).toBeNull();

    await DriverShift.create({
      driverId: driver._id,
      startedAt: new Date(now.getTime() - 3 * DAY),
      endedAt: new Date(now.getTime() - 3 * DAY + 2 * 3600_000),
      open: false,
    });
    expect(await driverShiftService.connectedSeconds(driver._id, 7, undefined, now)).toBe(2 * 3600);

    // Un turno abierto con la última señal hace horas se corta en esa señal, no sigue contando.
    await DriverShift.create({ driverId: driver._id, startedAt: new Date(now.getTime() - 5 * 3600_000), open: true });
    const withStale = await driverShiftService.connectedSeconds(driver._id, 7, new Date(now.getTime() - 4 * 3600_000), now);
    expect(withStale).toBe(2 * 3600 + 3600);
  });

  it('conectarse y desconectarse abre y cierra el turno, sin duplicar', async () => {
    await Driver.updateOne({ _id: driver._id }, { $set: { status: 'offline' } });
    await driverService.updateStatus(String(driverUser._id), 'available' as any);
    expect(await DriverShift.countDocuments({ driverId: driver._id, open: true })).toBe(1);
    await driverService.updateStatus(String(driverUser._id), 'offline' as any);
    expect(await DriverShift.countDocuments({ driverId: driver._id, open: true })).toBe(0);
    expect(await DriverShift.countDocuments({ driverId: driver._id, open: false })).toBe(1);
  });

  it('la ficha trae operación, rendimiento y cuenta sin datos sensibles', async () => {
    await User.collection.updateOne(
      { _id: driverUser._id },
      { $set: { birthDate: new Date('1990-05-01'), twoFactorEnabled: true, pushTokens: [{ token: 'ExponentPushToken[secreto]', platform: 'android', updatedAt: new Date() }] } }
    );
    await Driver.updateOne(
      { _id: driver._id },
      {
        $set: {
          vehicle: { brand: 'Yamaha', engineCc: 150, ownerName: 'Juan Moto' },
          license: { category: 'A2' },
          emergencyContact: { name: 'Ana', phone: '3001112222', relationship: 'Madre', updatedAt: new Date() },
        },
      }
    );
    await DriverDocument.create({
      driverId: driver._id, type: 'license', reference: 'LIC-998877', imageKey: 'k/l', isPrivate: true, status: 'approved',
      issuedAt: new Date('2024-01-01'), expiresAt: new Date(Date.now() - DAY), reviewedAt: new Date(),
    });

    const business = await makeBusiness((await makeUser({ role: UserRole.BUSINESS }))._id);
    const client = await makeUser();
    const mk = (status: OrderStatus, extra: Record<string, unknown> = {}) =>
      Order.create({
        orderNumber: `Z-${Math.random().toString(36).slice(2, 9)}`, clientId: client._id, businessId: business._id, driverId: driver._id, items: [], status,
        paymentMethod: PaymentMethod.CASH_ON_DELIVERY, deliveryAddress: 'x', deliveryLocation: { type: 'Point', coordinates: [GARZON.lng, GARZON.lat] },
        subtotal: 1, deliveryFee: 1, total: 2, platformCommission: 0, businessPayout: 1, driverPayout: 1, ...extra,
      });
    const now = Date.now();
    await mk(OrderStatus.DELIVERED, { pickedUpAt: new Date(now - 30 * 60_000), deliveredAt: new Date(now - 10 * 60_000) });
    await mk(OrderStatus.CANCELLED);
    await mk(OrderStatus.PICKED_UP);

    const res = await request(app).get(`${API}/admin/drivers/${driver._id}/profile-360`).set(await authHeader(admin));
    expect(res.status).toBe(200);
    const f = res.body.data.ficha;

    expect(f.summary.quick.license).toBe('expired');
    expect(f.summary.docsUpToDate).toBe(false);
    expect(f.driving).toMatchObject({ category: 'A2', indicator: 'expired' });
    expect(f.vehicle).toMatchObject({ brand: 'Yamaha', engineCc: 150, ownerName: 'Juan Moto' });
    expect(f.operation.activeOrders).toBe(1);
    expect(f.operation.completed).toBe(1);
    expect(f.operation.cancelled).toBe(1);
    expect(f.operation.cancellationRate).toBe(50);
    expect(f.operation.connectedSeconds7d).toBeNull();
    expect(f.performance.avgDeliveryMinutes).toBe(20);
    expect(f.account).toMatchObject({ twoFactorEnabled: true, device: { platform: 'android' } });
    expect(f.security.emergencyContact.updatedAt).toBeTruthy();

    // Vista enmascarada: sin nacimiento, sin número de licencia completo; y jamás tokens.
    expect(f.identity.birthDate).toBeUndefined();
    expect(f.driving.licenseNumber).not.toBe('LIC-998877');
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('ExponentPushToken');
    expect(raw).not.toContain('twoFactorSecret');
    expect(raw).not.toContain('k/l');
  });

  it('la vista completa incluye nacimiento y número; la última ubicación solo con permiso de tracking', async () => {
    await User.updateOne({ _id: driverUser._id }, { $set: { birthDate: new Date('1990-05-01') } });
    await DriverDocument.create({ driverId: driver._id, type: 'license', reference: 'LIC-998877', imageKey: 'k/l', isPrivate: true, status: 'approved' });
    await Driver.updateOne({ _id: driver._id }, { $set: { lastLocationAt: new Date() } });

    const full = await buildFicha(String(driver._id), { sensitive: true, track: true });
    expect(full.identity.birthDate).toBeInstanceOf(Date);
    expect(full.driving.licenseNumber).toBe('LIC-998877');
    expect(full.operation.lastLocation).toMatchObject({ lat: GARZON.lat, lng: GARZON.lng });

    const noTrack = await buildFicha(String(driver._id), { sensitive: true });
    expect(noTrack.operation.lastLocation).toBeUndefined();

    // Sin `lastLocationAt` no se inventa ubicación aunque haya coordenadas por defecto.
    await Driver.updateOne({ _id: driver._id }, { $unset: { lastLocationAt: 1 } });
    const none = await buildFicha(String(driver._id), { track: true });
    expect(none.operation.lastLocation).toBeUndefined();
  });

  it('la distancia suma tramos del rastro, ignora saltos de señal y dice el periodo cubierto', async () => {
    const t0 = Date.now() - 2 * DAY;
    const pt = (lat: number, min: number, extra: Record<string, unknown> = {}) => ({
      driverId: driver._id, userId: driverUser._id,
      location: { type: 'Point', coordinates: [-75.6, lat] },
      recordedAt: new Date(t0 + min * 60_000), ...extra,
    });
    await DriverLocation.create([
      pt(2.0, 0), pt(2.01, 1), // ~1.11 km
      pt(2.5, 60), // hueco de 59 min: no cuenta
      pt(2.51, 61), // ~1.11 km
      pt(3.0, 62, { accuracy: 500 }), // impreciso: se descarta
    ]);
    const f = await buildFicha(String(driver._id));
    expect(f.operation.distanceKm.last7d).toBeCloseTo(2.2, 1);
    expect(f.operation.distanceKm.last30d).toBeCloseTo(2.2, 1);
    expect(f.operation.distanceKm.coveredDays).toBeGreaterThanOrEqual(2);
  });

  it('suspender guarda el motivo y aparece en suspensiones e historial con quién lo hizo', async () => {
    const res = await request(app).patch(`${API}/admin/drivers/${driver._id}/suspend`).set(await authHeader(admin)).send({ reason: 'Documentos falsos' });
    expect(res.status).toBe(200);
    expect(await AuditLog.countDocuments({ action: AuditAction.DRIVER_SUSPENDED, 'metadata.reason': 'Documentos falsos' })).toBe(1);

    const f = (await request(app).get(`${API}/admin/drivers/${driver._id}/profile-360`).set(await authHeader(admin))).body.data.ficha;
    expect(f.security.suspensions[0]).toMatchObject({ action: 'suspended', reason: 'Documentos falsos', by: 'Ana Admin' });
    expect(f.history.find((h: any) => h.kind === 'suspension')).toMatchObject({ by: 'Ana Admin', detail: 'Documentos falsos' });
  });

  it('las cifras de dinero de la ficha solo se calculan con permiso de finanzas', async () => {
    const withFin = await buildFicha(String(driver._id), { finance: true });
    expect(withFin.financeExtra).toMatchObject({ totalPaid: 0, totalPending: 0 });
    const without = await buildFicha(String(driver._id), {});
    expect(without.financeExtra).toBeNull();
  });
});
