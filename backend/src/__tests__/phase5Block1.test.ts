import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { BusinessDocument, DriverDocument, Order } from '../models';
import { UserRole, PaymentMethod } from '../types';
import { classifyDriver, driverFunnel } from '../services/driverFunnel.service';
import { incidentCenterService } from '../services/incidentCenter.service';
import { orderService } from '../services/order.service';
import { featureFlagService } from '../services/featureFlag.service';
import { cache } from '../cache';
import { authHeader, makeBusiness, makeDriver, makePricingConfig, makeProduct, makeStaff, makeUser, GARZON } from './factories';

const DAY = 86_400_000;

describe('Fase 5 · bloque 1: altas, vencimientos y selfies', () => {
  beforeEach(async () => {
    await featureFlagService.upsert('rbac_enforce', { audience: 'staff' });
    await cache.flush();
  });

  describe('Embudo de alta de domiciliarios', () => {
    it('clasifica por lo que falta hacer', () => {
      expect(classifyDriver({ pending: 0, approved: 0, rejected: 0, expired: 0 })).toBe('no_documents');
      expect(classifyDriver({ pending: 1, approved: 2, rejected: 1, expired: 0 })).toBe('in_review');
      expect(classifyDriver({ pending: 0, approved: 2, rejected: 1, expired: 0 })).toBe('rejected_stuck');
      expect(classifyDriver({ pending: 0, approved: 1, rejected: 0, expired: 1 })).toBe('rejected_stuck');
      expect(classifyDriver({ pending: 0, approved: 5, rejected: 0, expired: 0 })).toBe('ready_to_approve');
    });

    it('encuentra a quien se registró sin perfil, sin papeles, rechazado y listo', async () => {
      const orphan = await makeUser({ role: UserRole.DRIVER, name: 'Sin Perfil' });
      const noDocs = await makeUser({ role: UserRole.DRIVER, name: 'Sin Papeles' });
      await makeDriver(noDocs._id, { isApproved: false });
      const rejected = await makeUser({ role: UserRole.DRIVER, name: 'Rechazado' });
      const rejectedDriver = await makeDriver(rejected._id, { isApproved: false });
      await DriverDocument.create({ driverId: rejectedDriver._id, type: 'soat', reference: 'A1', status: 'rejected' });
      const ready = await makeUser({ role: UserRole.DRIVER, name: 'Listo' });
      const readyDriver = await makeDriver(ready._id, { isApproved: false });
      await DriverDocument.create({ driverId: readyDriver._id, type: 'soat', reference: 'B1', status: 'approved' });
      const approved = await makeUser({ role: UserRole.DRIVER, name: 'Ya Aprobado' });
      await makeDriver(approved._id);

      const funnel = await driverFunnel();
      expect(funnel.counts).toEqual({ no_profile: 1, no_documents: 1, rejected_stuck: 1, in_review: 0, ready_to_approve: 1 });
      const byName = Object.fromEntries(funnel.items.map((i) => [i.name, i.stage]));
      expect(byName['Sin Perfil']).toBe('no_profile');
      expect(byName['Ya Aprobado']).toBeUndefined();
      expect(funnel.items.find((i) => i.name === 'Sin Perfil')!.driverId).toBeNull();
      expect(String(orphan._id)).toBe(funnel.items.find((i) => i.name === 'Sin Perfil')!.userId);
    });

    it('la ruta exige drivers:approve', async () => {
      const ops = await authHeader(await makeStaff({ roleSlug: 'operaciones' }));
      const soporte = await authHeader(await makeStaff({ roleSlug: 'soporte' }));
      await request(app).get('/api/v1/drivers/onboarding-funnel').set(ops).expect(200);
      await request(app).get('/api/v1/drivers/onboarding-funnel').set(soporte).expect(403);
    });
  });

  describe('Vencimientos', () => {
    it('la alerta de vencido no se esfuma cuando el documento pasa a "expired"', async () => {
      const owner = await makeUser({ role: UserRole.BUSINESS });
      const business = await makeBusiness(owner._id);
      const doc = await BusinessDocument.collection.insertOne({
        businessId: business._id, type: 'rut', reference: 'x', status: 'expired', expiresAt: new Date(Date.now() - DAY),
      });
      const inc = (await incidentCenterService.open(() => true)).filter((i) => i.kind === 'business_document_expiring');
      expect(inc).toHaveLength(1);
      expect(inc[0].key).toBe(`business_document_expiring:${doc.insertedId}:overdue`);
    });

    describe('comercio con un papel vencido', () => {
      let client: any; let business: any; let product: any;

      const buy = () => orderService.create({
        clientId: client._id.toString(), businessId: business._id.toString(),
        items: [{ productId: product._id.toString(), quantity: 1 }], paymentMethod: PaymentMethod.ONLINE,
        deliveryAddress: 'Cra 1 #2-3', deliveryLongitude: GARZON.lng, deliveryLatitude: GARZON.lat,
      } as never);

      beforeEach(async () => {
        await makePricingConfig();
        client = await makeUser({ role: UserRole.CLIENT });
        const owner = await makeUser({ role: UserRole.BUSINESS });
        business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
        product = await makeProduct(business._id);
      });

      it('no recibe pedidos; con el papel al día o en reenvío, sí', async () => {
        await expect(buy()).resolves.toBeTruthy();

        const doc = await BusinessDocument.collection.insertOne({
          businessId: business._id, type: 'rut', reference: 'x', status: 'approved', expiresAt: new Date(Date.now() - DAY),
        });
        await expect(buy()).rejects.toMatchObject({ statusCode: 404 });

        // Reenvía el papel nuevo: queda en revisión con vigencia futura y vuelve a vender.
        await BusinessDocument.collection.updateOne({ _id: doc.insertedId }, { $set: { status: 'pending', expiresAt: new Date(Date.now() + 200 * DAY) } });
        await expect(buy()).resolves.toBeTruthy();
        expect(await Order.countDocuments({ businessId: business._id })).toBe(2);
      });
    });
  });
});
