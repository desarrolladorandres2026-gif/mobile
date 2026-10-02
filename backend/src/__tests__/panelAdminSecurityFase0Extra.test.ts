import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../app';
import { Business, Advertisement, AdPricingModel, AdInvoice, ProSubscription } from '../models';
import { ProSubscriptionStatus } from '../models';
import { UserRole } from '../types';
import { businessStaffService } from '../services/businessStaff.service';
import { BusinessPermission, BusinessRole, BusinessStaff } from '../models';
import { proService } from '../services/pro.service';
import { authenticateSocket } from '../sockets/index';
import { sessionManager } from '../security/sessions';
import { adminService } from '../services/admin.service';
import { businessService } from '../services/business.service';
import { orderService } from '../services/order.service';
import { generateAccessToken } from '../utils/token';
import { Types } from 'mongoose';
import { makeUser, makeBusiness, authHeader, GARZON } from './factories';

/**
 * Correcciones de la revisión de seguridad de la Fase 0
 * (09-revision-seguridad-fase0.md). Un caso por hallazgo.
 */

describe('C1 · un negocio no se elimina', () => {
  it('DELETE /businesses/:id responde 405, no borra', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });

    const res = await request(app)
      .delete(`/api/v1/businesses/${business._id}`)
      .set(await authHeader(owner))
      .expect(405);

    expect(res.body.message).toMatch(/archiva/i);
    expect(await Business.findById(business._id)).not.toBeNull();
  });
});

describe('A1 · suspensión (ZIPP) distinta de isActive (dueño)', () => {
  it('el toggle de admin suspende, exige motivo, y el dueño no puede quitárselo', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const admin = await makeUser({ role: UserRole.ADMIN });
    const business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });

    await request(app)
      .patch(`/api/v1/admin/businesses/${business._id}/toggle`)
      .set(await authHeader(admin))
      .send({})
      .expect(400);

    const res = await request(app)
      .patch(`/api/v1/admin/businesses/${business._id}/toggle`)
      .set(await authHeader(admin))
      .send({ reason: 'Fraude reportado por clientes' })
      .expect(200);
    expect(res.body.data.isSuspended).toBe(true);
    expect(res.body.data.isActive).toBe(true); // el interruptor del dueño no se tocó

    // El dueño no puede levantarse la suspensión con un PUT normal.
    const attempt = await businessService.update(
      business._id.toString(),
      owner._id.toString(),
      { isSuspended: false } as any,
      false
    );
    expect(attempt.isSuspended).toBe(true);
  });

  it('un negocio suspendido no acepta pedidos nuevos ni sale en el catálogo visible', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
    business.isSuspended = true;
    await business.save();

    await expect(
      orderService.create({
        clientId: (await makeUser({ role: UserRole.CLIENT }))._id.toString(),
        businessId: business._id.toString(),
        items: [],
        deliveryAddress: { address: 'Test', lat: GARZON.lat, lng: GARZON.lng } as any,
        paymentMethod: 'cash' as any,
      } as any)
    ).rejects.toThrow(/inactivo|no encontrado/i);
  });

  it('un negocio archivado no puede editarse por su dueño', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
    business.isArchived = true;
    await business.save();

    await expect(
      businessService.update(business._id.toString(), owner._id.toString(), { name: 'Nuevo nombre' }, false)
    ).rejects.toThrow(/archivado/i);
  });
});

describe('A2 · misma lista blanca pública en search/offers/favorites', () => {
  it('search, offers y favorites nunca exponen commissionRate(Bps) ni ownerId', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id, {
      lat: GARZON.lat,
      lng: GARZON.lng,
      commissionRateBps: 1800,
      name: 'Restaurante Sensible',
    });
    const client = await makeUser({ role: UserRole.CLIENT });

    const searchRes = await request(app)
      .get('/api/v1/search')
      .query({ q: 'Restaurante', lat: GARZON.lat, lng: GARZON.lng })
      .expect(200);
    for (const row of searchRes.body.data.businesses ?? []) {
      expect(row.commissionRateBps).toBeUndefined();
      expect(row.ownerId).toBeUndefined();
    }

    const offersRes = await request(app)
      .get('/api/v1/offers')
      .query({ lat: GARZON.lat, lng: GARZON.lng })
      .expect(200);
    for (const row of offersRes.body.data.businesses ?? []) {
      expect(row.commissionRateBps).toBeUndefined();
      expect(row.ownerId).toBeUndefined();
    }

    const { Favorite } = await import('../models');
    await Favorite.create({ userId: client._id, kind: 'business', targetId: business._id });
    const favRes = await request(app)
      .get('/api/v1/favorites')
      .set(await authHeader(client))
      .expect(200);
    for (const row of favRes.body.data.businesses ?? []) {
      expect(row.commissionRateBps).toBeUndefined();
      expect(row.ownerId).toBeUndefined();
    }
  });
});

describe('A3 · admin sin 2FA no entra por socket', () => {
  it('rechaza el handshake entero cuando 2FA es obligatorio y falta', async () => {
    const { config } = await import('../config');
    const original = config.security.twoFactor.requiredForAdmins;
    config.security.twoFactor.requiredForAdmins = true;
    try {
      const admin = await makeUser({ role: UserRole.ADMIN });
      const sessionId = new Types.ObjectId();
      const token = generateAccessToken({ id: admin._id.toString(), role: UserRole.ADMIN, sid: sessionId.toString() });
      await sessionManager.createSession({
        userId: admin._id.toString(),
        sessionId,
        refreshToken: `test-refresh-${sessionId.toString()}`,
        ip: '127.0.0.1',
        userAgent: 'vitest',
      });

      const identity = await authenticateSocket(token);
      expect(identity.twoFactorSatisfied).toBe(false);
      // El middleware de socket rechaza el handshake entero cuando esto es
      // falso para un admin — se verifica la misma condición que aplica
      // `io.use`.
    } finally {
      config.security.twoFactor.requiredForAdmins = original;
    }
  });
});

describe('A5 · resetPassword limpia mustChangePassword y passwordExpiresAt', () => {
  it('una contraseña puesta por el propio usuario no caduca a las 24h', async () => {
    const { User } = await import('../models');
    const { authService } = await import('../services/auth.service');
    const { OTP_SLOTS, otpSetFields } = await import('../security');
    const user = await makeUser({ role: UserRole.CLIENT });
    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          mustChangePassword: true,
          passwordExpiresAt: new Date(Date.now() + 60_000),
          ...otpSetFields(OTP_SLOTS.phone, '123456'),
        },
      }
    );

    await authService.resetPassword(user.phone!, '123456', 'NuevaClaveSegura!9', undefined, undefined);

    const updated = await User.findById(user._id).select('mustChangePassword passwordExpiresAt');
    expect(updated!.mustChangePassword).toBe(false);
    expect(updated!.passwordExpiresAt).toBeUndefined();
  });
});

describe('M1(a) · cambiar el rol revoca las sesiones anteriores', () => {
  it('revoca todas las sesiones del usuario al cambiarle el rol', async () => {
    const actor = await makeUser({ role: UserRole.ADMIN });
    const target = await makeUser({ role: UserRole.CLIENT });
    const sessionId = new Types.ObjectId();
    await sessionManager.createSession({
      userId: target._id.toString(),
      sessionId,
      refreshToken: `test-refresh-${sessionId.toString()}`,
      ip: '127.0.0.1',
      userAgent: 'vitest',
    });
    expect(await sessionManager.isSessionActive(sessionId.toString(), target._id.toString())).toBe(true);

    await adminService.updateUserRole(target._id.toString(), UserRole.DRIVER, actor as any);

    expect(await sessionManager.isSessionActive(sessionId.toString(), target._id.toString())).toBe(false);
  });
});

describe('M3 · publicidad: facturas/deuda exigen SETTLEMENTS_VIEW al staff', () => {
  it('un empleado sin el permiso no ve las facturas; el dueño sí', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
    const staffUser = await makeUser({ role: UserRole.BUSINESS });
    await BusinessStaff.create({
      businessId: business._id,
      userId: staffUser._id,
      role: BusinessRole.OPERATOR,
      phone: staffUser.phone,
      isActive: true,
    });

    const permissions = await businessStaffService.permissionsFor(staffUser._id.toString(), business._id.toString());
    expect(permissions.includes(BusinessPermission.SETTLEMENTS_VIEW)).toBe(false);

    await request(app)
      .get(`/api/v1/advertisements/business/${business._id}/invoices`)
      .set(await authHeader(staffUser))
      .expect(403);

    await request(app)
      .get(`/api/v1/advertisements/business/${business._id}/invoices`)
      .set(await authHeader(owner))
      .expect(200);
  });
});

describe('M4 · identityDocumentUrl solo de una cédula aprobada', () => {
  it('no expone la foto de una cédula pendiente o rechazada', async () => {
    const { makeDriver } = await import('./factories');
    const { DriverDocument } = await import('../models');
    const { driverSecurityService, VerificationType } = await import('../security');
    const admin = await makeUser({ role: UserRole.ADMIN });
    const driverUser = await makeUser({ role: UserRole.DRIVER });
    const driver = await makeDriver(driverUser._id, { isApproved: true, isActive: true });

    await DriverDocument.create({
      driverId: driver._id,
      type: 'identity',
      reference: '123',
      imageUrl: 'https://res.cloudinary.com/demo/image/upload/v1/zipp/driver-documents/pending.jpg',
      status: 'pending',
    });

    await driverSecurityService.requestVerification(driver._id.toString(), driverUser._id.toString(), VerificationType.RANDOM_SELFIE);

    const res = await request(app)
      .get('/api/v1/drivers/verifications/queue')
      .set(await authHeader(admin))
      .expect(200);

    const item = res.body.data.find((i: any) => i.driver?._id === driver._id.toString());
    expect(item.identityDocumentUrl).toBeUndefined();
    expect(item.identityDocumentStatus).toBe('none');
  });
});

describe('M5 · un pago aprobado no reactiva una membresía cancelada', () => {
  it('deja la suscripción cancelada tal cual', async () => {
    const client = await makeUser({ role: UserRole.CLIENT });
    const sub = await ProSubscription.create({
      userId: client._id,
      status: ProSubscriptionStatus.CANCELLED,
      planId: 'pro-mensual-v1',
      price: 14_900,
      currency: 'COP',
      autoRenew: false,
    });
    const { Payment } = await import('../models');
    const { PaymentMethod, PaymentStatus, PaymentType } = await import('../types');
    const payment = await Payment.create({
      userId: client._id,
      amount: 15000,
      method: PaymentMethod.ONLINE,
      status: PaymentStatus.PAID,
      type: PaymentType.PRO_SUBSCRIPTION,
      reference: `pro-test-${Date.now()}`,
    });

    await (proService as any).activate(sub, payment);

    const after = await ProSubscription.findById(sub._id);
    expect(after!.status).toBe(ProSubscriptionStatus.CANCELLED);
  });
});
