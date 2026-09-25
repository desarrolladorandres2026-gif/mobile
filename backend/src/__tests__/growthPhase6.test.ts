import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { Address, CampaignSend, Order, Payment, ProSubscription, User } from '../models';
import { FraudAlert, FraudAlertType } from '../security';
import { OrderStatus, PaymentMethod, PaymentStatus, PaymentType, UserRole } from '../types';
import { pricingConfigService } from '../services/pricingConfig.service';
import { campaignService } from '../services/campaign.service';
import { featureFlagService } from '../services/featureFlag.service';
import { cache } from '../cache';
import { authHeader, makePricingConfig, makeStaff, makeUser, GARZON } from './factories';

const G = '/api/v1/admin/growth';

const optIn = (users: Array<{ _id: unknown }>) =>
  User.updateMany({ _id: { $in: users.map((u) => u._id) } }, { $set: { marketingConsent: true } });

describe('Fase 6 · Crecimiento', () => {
  beforeEach(async () => {
    await featureFlagService.upsert('rbac_enforce', { audience: 'staff' });
    await cache.flush();
  });

  describe('Envíos dirigidos', () => {
    it('el segmento por ciudad usa las direcciones y respeta el consentimiento', async () => {
      const yes = await makeUser({ role: UserRole.CLIENT });
      const noConsent = await makeUser({ role: UserRole.CLIENT });
      const otherCity = await makeUser({ role: UserRole.CLIENT });
      await optIn([yes, otherCity]);
      const addr = (userId: unknown, city: string) =>
        Address.create({
          userId,
          label: 'Casa',
          address: 'Cra 1',
          city,
          location: { type: 'Point', coordinates: [GARZON.lng, GARZON.lat] },
        });
      await addr(yes._id, 'Garzón');
      await addr(noConsent._id, 'Garzón');
      await addr(otherCity._id, 'Neiva');

      const ids = await campaignService.resolve({ city: 'garzón' });
      expect(ids).toEqual([String(yes._id)]);
    });

    it('rechaza cuerpos inválidos y exige el permiso', async () => {
      const superAdmin = await authHeader(await makeStaff({ roleSlug: 'super_admin' }));
      const soporte = await authHeader(await makeStaff({ roleSlug: 'soporte' }));
      await request(app).post(`${G}/campaigns/preview`).set(soporte).send({ segment: {} }).expect(403);
      await request(app).post(`${G}/campaigns/preview`).set(superAdmin).send({ segment: { role: 'admin' } }).expect(400);
      await request(app).post(`${G}/campaigns/preview`).set(superAdmin).send({ segment: { inactiveForDays: 0 } }).expect(400);
      await request(app)
        .post(`${G}/campaigns/send`)
        .set(superAdmin)
        .send({ segment: {}, message: { title: 'hi', body: 'x' }, confirmedReach: 1 })
        .expect(400);
    });

    it('no envía a un segmento vacío y tampoco si el alcance creció', async () => {
      const superAdmin = await authHeader(await makeStaff({ roleSlug: 'super_admin' }));
      const msg = { title: 'Promo de hoy', body: 'Pide con envío gratis' };
      await request(app).post(`${G}/campaigns/send`).set(superAdmin).send({ segment: {}, message: msg, confirmedReach: 5 }).expect(400);

      const users = await Promise.all([1, 2, 3, 4, 5].map(() => makeUser({ role: UserRole.CLIENT })));
      await optIn(users);
      await request(app).post(`${G}/campaigns/send`).set(superAdmin).send({ segment: {}, message: msg, confirmedReach: 1 }).expect(409);
    });

    it('registra el envío y no deja lanzar otro mientras hay uno en curso', async () => {
      const staff = await makeStaff({ roleSlug: 'super_admin' });
      const superAdmin = await authHeader(staff);
      const users = await Promise.all([1, 2].map(() => makeUser({ role: UserRole.CLIENT })));
      await optIn(users);
      const msg = { title: 'Promo de hoy', body: 'Pide con envío gratis' };

      await CampaignSend.create({ sentBy: staff._id, title: 'previo', body: 'x', status: 'sending' });
      await request(app).post(`${G}/campaigns/send`).set(superAdmin).send({ segment: {}, message: msg, confirmedReach: 2 }).expect(409);

      await CampaignSend.deleteMany({});
      const ok = await request(app).post(`${G}/campaigns/send`).set(superAdmin).send({ segment: {}, message: msg, confirmedReach: 2 }).expect(202);
      expect(ok.body.data.status).toBe('sending');

      const history = await request(app).get(`${G}/campaigns/history`).set(superAdmin).expect(200);
      expect(history.body.data.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Referidos', () => {
    it('separa pendiente, cumplida y bloqueada, y solo muestra nombre corto', async () => {
      const referrer = await makeUser({ role: UserRole.CLIENT, name: 'Ana Pérez Gómez' });
      const pending = await makeUser({ role: UserRole.CLIENT, name: 'Luis Rojas' });
      const done = await makeUser({ role: UserRole.CLIENT, name: 'Marta Díaz' });
      const blocked = await makeUser({ role: UserRole.CLIENT, name: 'Falso Uno' });
      await User.updateOne({ _id: pending._id }, { $set: { referredBy: referrer._id } });
      await User.updateOne({ _id: done._id }, { $set: { referredBy: referrer._id, referralRewardedAt: new Date() } });
      await User.updateOne({ _id: blocked._id }, { $set: { referredBy: referrer._id, referralRewardedAt: new Date() } });
      await FraudAlert.create({
        userId: String(referrer._id),
        type: FraudAlertType.PROMOTION_ABUSE,
        riskLevel: 'high',
        riskScore: 70,
        description: 'Invitación no premiada: mismo dispositivo',
        evidence: { inviteeId: String(blocked._id), reason: 'mismo dispositivo' },
      } as never);

      const header = await authHeader(await makeStaff({ roleSlug: 'finanzas' }));
      const res = await request(app).get(`${G}/referrals`).set(header).expect(200);
      expect(res.body.data.summary).toEqual({ invited: 3, converted: 1, blocked: 1, pending: 1 });
      const byInvitee = Object.fromEntries(res.body.data.invitations.map((i: { invitee: string; status: string }) => [i.invitee, i.status]));
      expect(byInvitee['Marta D.']).toBe('converted');
      expect(byInvitee['Falso U.']).toBe('blocked');
      expect(byInvitee['Luis R.']).toBe('pending');
      expect(res.body.data.topReferrers[0]).toMatchObject({ name: 'Ana P.', invited: 3 });

      const only = await request(app).get(`${G}/referrals?status=blocked`).set(header).expect(200);
      expect(only.body.data.invitations).toHaveLength(1);
      await request(app).get(`${G}/referrals?status=zzz`).set(header).expect(400);
    });

    it('exige coupons:view', async () => {
      const soporte = await authHeader(await makeStaff({ roleSlug: 'soporte' }));
      await request(app).get(`${G}/referrals`).set(soporte).expect(403);
    });
  });

  describe('Zipp Pro', () => {
    it('cuenta miembros vigentes, ingreso bruto recurrente y renovaciones fallidas', async () => {
      const soon = new Date(Date.now() + 10 * 86_400_000);
      const mk = async (name: string, extra: Record<string, unknown>) => {
        const u = await makeUser({ role: UserRole.CLIENT, name });
        return ProSubscription.create({ userId: u._id, planId: 'pro-mensual-v1', price: 14_900, startedAt: new Date(), currentPeriodEnd: soon, ...extra });
      };
      await mk('Activo Uno', { status: 'active', autoRenew: true });
      await mk('Activo Dos', { status: 'active', autoRenew: true, renewalFailures: 1, lastRenewalAttemptAt: new Date() });
      await mk('Cancelado Vigente', { status: 'cancelled', autoRenew: false });
      await mk('Vencido', { status: 'expired', currentPeriodEnd: new Date(Date.now() - 86_400_000) });

      const header = await authHeader(await makeStaff({ roleSlug: 'finanzas' }));
      const res = await request(app).get(`${G}/pro`).set(header).expect(200);
      expect(res.body.data.members).toMatchObject({ active: 3, renewing: 2, cancelledStillValid: 1, expired: 1 });
      expect(res.body.data.monthlyRecurringGross).toBe(29_800);
      expect(res.body.data.atRisk).toHaveLength(1);

      const soporte = await authHeader(await makeStaff({ roleSlug: 'soporte' }));
      await request(app).get(`${G}/pro`).set(soporte).expect(403);
    });

    it('30 días: cobrado, comisión estimada de Wompi, coste de beneficios y margen', async () => {
      await makePricingConfig({ gatewayCardBps: 300, gatewayCardFixed: 0 });
      pricingConfigService.invalidate();
      const u = await makeUser({ role: UserRole.CLIENT });
      await Payment.create({
        userId: u._id, type: PaymentType.PRO_SUBSCRIPTION, method: PaymentMethod.ONLINE,
        paymentMethodType: 'CARD', status: PaymentStatus.PAID, amount: 20_000, processedAt: new Date(),
      });
      const now = new Date();
      const finance = (pro?: { d: number; s: number }) => ({
        productSubtotal: 30_000, customerTotal: 30_000,
        ...(pro ? { proDeliveryDiscount: pro.d, proServiceFeeDiscount: pro.s } : {}),
      });
      await Order.collection.insertMany([
        { orderNumber: 'PRO-1', status: OrderStatus.DELIVERED, deliveredAt: now, finance: finance({ d: 4_000, s: 1_000 }) },
        { orderNumber: 'PRO-2', status: OrderStatus.DELIVERED, deliveredAt: now, finance: finance({ d: 0, s: 0 }) },
        // Anterior al desglose: no tiene los campos.
        { orderNumber: 'PRO-3', status: OrderStatus.DELIVERED, deliveredAt: now, finance: finance() },
      ]);

      const header = await authHeader(await makeStaff({ roleSlug: 'finanzas' }));
      const res = await request(app).get(`${G}/pro`).set(header).expect(200);
      const m = res.body.data.last30Days;
      expect(m.collected).toBe(20_000);
      expect(m.gatewayFee).toBe(600);
      expect(m.benefitsCost).toMatchObject({ delivery: 4_000, serviceFee: 1_000, total: 5_000, orders: 1 });
      expect(m.margin).toBe(20_000 - 600 - 5_000);
      expect(m.ordersWithoutData).toBe(1);
      expect(m.complete).toBe(false);
    });
  });

  describe('Interruptores', () => {
    it('rechaza claves y audiencias inventadas, y solo deja guardar las válidas', async () => {
      const superAdmin = await authHeader(await makeStaff({ roleSlug: 'super_admin' }));
      const url = '/api/v1/admin/feature-flags';
      await request(app).put(`${url}/MAYUSCULAS`).set(superAdmin).send({ audience: 'off' }).expect(400);
      await request(app).put(`${url}/pedidos.programados`).set(superAdmin).send({ audience: 'todos' }).expect(400);
      await request(app).put(`${url}/pedidos.programados`).set(superAdmin).send({ audience: 'off', extra: 1 }).expect(400);
      await request(app).put(`${url}/pedidos.programados`).set(superAdmin).send({ audience: 'staff', description: 'Programados' }).expect(200);
    });
  });
});
