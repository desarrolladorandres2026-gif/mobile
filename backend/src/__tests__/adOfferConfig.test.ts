import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { Advertisement, AdClick, AdEvent, BusinessStaff, BusinessRole, PricingConfigAudit } from '../models';
import { UserRole } from '../types';
import { featureFlagService } from '../services/featureFlag.service';
import { advertisementService } from '../services/advertisement.service';
import { cache } from '../cache';
import { makeUser, makeBusiness, makePricingConfig, makeStaff, authHeader, counterAuthHeader } from './factories';

/**
 * La oferta de publicidad vive en Tarifas y Monetización (2026-10-17):
 * versionada, auditada y editable solo con `finance:manage`. Nace apagada, sin
 * tarifas inventadas; CPM y la renovación automática no se pueden encender.
 */

const API = '/api/v1';
const OFFER = {
  adSelfServiceEnabled: true, adBillingEnabled: true, adCpcEnabled: true, adCpcMinRate: 300, adCpcMaxRate: 2000,
  adMinBudget: 20_000, adMaxBudget: 500_000, adMinDurationDays: 3, adMaxDurationDays: 30, adPlacements: ['splash'],
};

let owner: any;
let business: any;

beforeEach(async () => {
  await featureFlagService.upsert('rbac_enforce', { audience: 'staff' });
  await cache.flush();
  owner = await makeUser({ role: UserRole.BUSINESS });
  business = await makeBusiness(owner._id);
});

const offerOf = async (headers: Record<string, string>) =>
  request(app).get(`${API}/advertisements/business/${business._id}/offer`).set(headers);

describe('Oferta de publicidad para el comercio', () => {
  it('recién creada: trae los rangos de lanzamiento pero sigue cerrada hasta encender los interruptores', async () => {
    await makePricingConfig({});
    const res = await offerOf(await authHeader(owner));
    expect(res.body.data.available).toBe(false);
    expect(res.body.data.reasons).toHaveLength(3);
    expect(res.body.data.budget).toEqual({ min: 10_000, max: 500_000 });
    expect(res.body.data.durationDays).toEqual({ min: 1, max: 30 });
    expect(res.body.data.placements).toEqual(['explore']);
  });

  it('sin configurar: no disponible, con los motivos y sin tarifas', async () => {
    await makePricingConfig({
      adCpcMinRate: 0, adCpcMaxRate: 0, adMinBudget: 0, adMaxBudget: 0,
      adMinDurationDays: 0, adMaxDurationDays: 0, adPlacements: [],
    });
    const res = await offerOf(await authHeader(owner));
    expect(res.status).toBe(200);
    expect(res.body.data.available).toBe(false);
    expect(res.body.data.reasons.length).toBeGreaterThanOrEqual(4);
    expect(res.body.data.models.cpc).toMatchObject({ enabled: false, minRate: 0, maxRate: 0 });
    expect(res.body.data.autoRenew).toBe(false);
  });

  it('configurada: CPC con su rango, CPM cerrado', async () => {
    await makePricingConfig(OFFER);
    const res = await offerOf(await authHeader(owner));
    expect(res.body.data).toMatchObject({
      available: true,
      reasons: [],
      models: { cpc: { enabled: true, minRate: 300, maxRate: 2000 }, cpm: { enabled: false } },
      budget: { min: 20_000, max: 500_000 },
      durationDays: { min: 3, max: 30 },
      placements: ['splash'],
    });
  });

  it('la oferta es de quien gestiona publicidad: el mostrador y otro negocio no', async () => {
    await makePricingConfig(OFFER);
    const employee = await makeUser({ role: UserRole.BUSINESS });
    await BusinessStaff.create({ businessId: business._id, userId: employee._id, role: BusinessRole.EMPLOYEE, isActive: true, status: 'active' });
    const otherOwner = await makeUser({ role: UserRole.BUSINESS });
    await makeBusiness(otherOwner._id);

    expect((await offerOf(await authHeader(employee))).status).toBe(403);
    expect((await offerOf(await counterAuthHeader(owner))).status).toBe(403);
    expect((await offerOf(await authHeader(otherOwner))).status).toBe(403);
    expect((await offerOf(await authHeader(await makeUser({ role: UserRole.CLIENT })))).status).toBe(403);
  });
});

describe('Configurar la oferta desde Tarifas y Monetización', () => {
  const put = async (user: any, body: Record<string, unknown>) =>
    request(app).put(`${API}/finance/config`).set(await authHeader(user)).send({ reason: 'Abrimos publicidad por clic', ...body });

  it('finanzas la publica como nueva versión auditada', async () => {
    await makePricingConfig({});
    const finanzas = await makeStaff({ roleSlug: 'finanzas' });
    const res = await put(finanzas, OFFER);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.config.version).toBe(2);
    const audit = await PricingConfigAudit.findOne({ toVersion: 2 }).lean();
    expect(Object.keys(audit!.changes)).toEqual(expect.arrayContaining(['adCpcMinRate', 'adBillingEnabled']));
  });

  it('sin finance:manage no se cambia', async () => {
    await makePricingConfig({});
    const soporte = await makeStaff({ roleSlug: 'soporte' });
    expect((await put(soporte, OFFER)).status).toBe(403);
    expect((await put(owner, OFFER)).status).toBe(403);
  });

  it('CPM, renovación automática y rangos al revés no se guardan', async () => {
    await makePricingConfig({});
    const finanzas = await makeStaff({ roleSlug: 'finanzas' });
    expect((await put(finanzas, { adCpmEnabled: true })).status).toBe(400);
    expect((await put(finanzas, { adAutoRenewEnabled: true })).status).toBe(400);
    expect((await put(finanzas, { adCpcMinRate: 5000, adCpcMaxRate: 1000 })).status).toBeGreaterThanOrEqual(400);
    expect((await put(finanzas, { adPlacements: ['banner'] })).status).toBe(400);
  });
});

describe('El clic por HTTP', () => {
  it('lleva clickId, no dice si se cobró y el reintento no cobra dos veces', async () => {
    await makePricingConfig(OFFER);
    const ad = await advertisementService.requestFromBusiness({
      ownerId: owner._id.toString(), businessId: business._id.toString(), campaignName: 'Promo',
      flyerUrl: 'https://res.cloudinary.com/demo/image/upload/v1/ads/a.jpg',
      startDate: new Date(Date.now() - 86_400_000), endDate: new Date(Date.now() + 3 * 86_400_000),
      pricingModel: 'cpc', cpmRate: 0, cpcRate: 500, budget: 50_000,
    } as never);
    await advertisementService.approve(ad._id.toString());

    await request(app).post(`${API}/advertisements/${ad._id}/impression`).send({ deviceId: 'dev-1' }).expect(200);
    // Una persona tarda más de medio segundo en tocar el anuncio.
    await AdEvent.updateMany({ campaignId: ad._id }, { $set: { timestamp: new Date(Date.now() - 5000) } });
    const UA = 'ZippApp/1.0 (Android 14; okhttp/4.12)';
    const first = await request(app).post(`${API}/advertisements/${ad._id}/click`).set('User-Agent', UA).send({ deviceId: 'dev-1', clickId: 'tap-1234-abcd' });
    const again = await request(app).post(`${API}/advertisements/${ad._id}/click`).set('User-Agent', UA).send({ deviceId: 'dev-1', clickId: 'tap-1234-abcd' });

    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(first.body.data).toBeUndefined();
    expect(await AdClick.countDocuments({ campaignId: ad._id })).toBe(1);
    expect((await Advertisement.findById(ad._id))!.clickCount).toBe(1);
    expect(await AdEvent.countDocuments({ campaignId: ad._id, eventType: 'click' })).toBe(1);

    const bad = await request(app).post(`${API}/advertisements/${ad._id}/click`).send({ deviceId: 'dev-1', clickId: '<script>' });
    expect(bad.status).toBe(400);
  });

  it('quien tiene sesión queda identificado: otro dispositivo de la misma cuenta no abre otro clic cobrable', async () => {
    await makePricingConfig(OFFER);
    const ad = await advertisementService.requestFromBusiness({
      ownerId: owner._id.toString(), businessId: business._id.toString(), campaignName: 'Promo',
      flyerUrl: 'https://res.cloudinary.com/demo/image/upload/v1/ads/a.jpg',
      startDate: new Date(Date.now() - 86_400_000), endDate: new Date(Date.now() + 3 * 86_400_000),
      pricingModel: 'cpc', cpmRate: 0, cpcRate: 500, budget: 50_000,
    } as never);
    await advertisementService.approve(ad._id.toString());
    const client = await makeUser({ role: UserRole.CLIENT });
    const headers = { ...(await authHeader(client)), 'User-Agent': 'ZippApp/1.0 (Android 14; okhttp/4.12)' };

    const tap = async (deviceId: string, clickId: string) => {
      await request(app).post(`${API}/advertisements/${ad._id}/impression`).set(headers).send({ deviceId }).expect(200);
      await AdEvent.updateMany({ campaignId: ad._id, deviceId }, { $set: { timestamp: new Date(Date.now() - 5000) } });
      return request(app).post(`${API}/advertisements/${ad._id}/click`).set(headers).send({ deviceId, clickId });
    };
    expect((await tap('tel-1', 'cuenta-0001-a')).status).toBe(200);
    expect((await tap('tel-2', 'cuenta-0002-b')).status).toBe(200);

    const rows = await AdClick.find({ campaignId: ad._id }).sort({ createdAt: 1 }).lean();
    expect(rows.map((r) => r.billable)).toEqual([true, false]);
    expect(rows[1].rejection).toBe('duplicate_user');
    expect(String(rows[0].userId)).toBe(String(client._id));
  });

  it('un token malo no tumba el clic: sigue como visitante anónimo', async () => {
    await makePricingConfig(OFFER);
    const ad = await advertisementService.requestFromBusiness({
      ownerId: owner._id.toString(), businessId: business._id.toString(), campaignName: 'Promo',
      flyerUrl: 'https://res.cloudinary.com/demo/image/upload/v1/ads/a.jpg',
      startDate: new Date(Date.now() - 86_400_000), endDate: new Date(Date.now() + 3 * 86_400_000),
      pricingModel: 'cpc', cpmRate: 0, cpcRate: 500, budget: 50_000,
    } as never);
    await advertisementService.approve(ad._id.toString());
    const res = await request(app).post(`${API}/advertisements/${ad._id}/impression`)
      .set('Authorization', 'Bearer token.que.no.sirve').send({ deviceId: 'anon-1' });
    expect(res.status).toBe(200);
    expect(await AdEvent.countDocuments({ campaignId: ad._id, userId: null })).toBe(1);
  });
});
