import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { Advertisement, AdInvoice, AdApprovalStatus, AdPricingModel, Role, Business } from '../models';
import { UserRole } from '../types';
import { advertisementService, adOrigin, adminEditProblems, adOffer } from '../services/advertisement.service';
import { featureFlagService } from '../services/featureFlag.service';
import { cache } from '../cache';
import { makeUser, makeBusiness, makePricingConfig, authHeader } from './factories';

/**
 * Auditoría 2026-10-19 · campañas pagadas por un comercio vs. campañas de
 * ZIPP. Las de ZIPP (precio cerrado, sin cobro por evento) no se miden contra
 * la oferta comercial, pero el flujo de administrador tampoco puede servir para
 * deshacer lo que un comercio compró ni para fabricar una campaña cobrable.
 */

const API = '/api/v1';
const DAY = 86_400_000;
const OFFER = {
  adSelfServiceEnabled: true, adBillingEnabled: true, adCpcEnabled: true, adCpcMinRate: 100, adCpcMaxRate: 1000,
  adMinBudget: 10_000, adMaxBudget: 500_000, adMinDurationDays: 1, adMaxDurationDays: 30, adPlacements: ['explore'],
};

let owner: any;
let business: any;
let admin: any;

async function makeAdmin() {
  const user = await makeUser({ role: UserRole.ADMIN });
  const role = await Role.create({ name: 'super_admin', slug: 'super_admin', permissions: [], isActive: true, isSystem: false });
  user.roleIds = [role._id] as any;
  await user.save();
  return user;
}

const buy = (over: Record<string, unknown> = {}) =>
  advertisementService.requestFromBusiness({
    ownerId: owner._id.toString(),
    businessId: business._id.toString(),
    campaignName: 'Campaña comprada',
    flyerUrl: 'https://res.cloudinary.com/demo/image/upload/f.png',
    startDate: new Date(Date.now() + DAY),
    endDate: new Date(Date.now() + 8 * DAY),
    pricingModel: AdPricingModel.CPC,
    cpmRate: 0, cpcRate: 500, budget: 100_000, placement: 'explore',
    ...over,
  } as never);

const internalBody = (over: Record<string, unknown> = {}) => ({
  campaignName: 'Comunicado ZIPP',
  advertiserName: 'ZIPP',
  flyerUrl: 'https://res.cloudinary.com/demo/image/upload/z.png',
  startDate: new Date(Date.now() - DAY).toISOString(),
  endDate: new Date(Date.now() + 400 * DAY).toISOString(),
  actionType: 'none',
  ...over,
});

beforeEach(async () => {
  await featureFlagService.remove('rbac_enforce');
  await cache.flush();
  await makePricingConfig(OFFER);
  owner = await makeUser({ role: UserRole.BUSINESS });
  business = await makeBusiness(owner._id);
  admin = await makeAdmin();
});

describe('Dos modelos: comprada por un comercio / interna de ZIPP', () => {
  it('el origen se deriva de los datos', async () => {
    const bought = await buy();
    expect(adOrigin(bought)).toBe('business_purchase');
    expect(adOrigin({ billedToBusinessId: null, pricePaid: 500_000 })).toBe('zipp_sold');
    expect(adOrigin({ billedToBusinessId: null, pricePaid: 0 })).toBe('zipp_internal');
  });

  it('la campaña interna NO se mide contra los límites comerciales (400 días, sin tarifa ni tope)', async () => {
    const res = await request(app).post(`${API}/advertisements`).set(await authHeader(admin)).send(internalBody());
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ pricingModel: 'flat', cpcRate: 0, budget: 0, billedToBusinessId: null, approvalStatus: 'approved' });
  });

  it('por el flujo de admin no se puede fabricar una campaña cobrable: tarifa, tope, comercio facturado y aprobación se descartan', async () => {
    const res = await request(app).post(`${API}/advertisements`).set(await authHeader(admin)).send(internalBody({
      pricingModel: 'cpc', cpcRate: 5, cpmRate: 5, budget: 1, maxClicks: 99999,
      billedToBusinessId: business._id.toString(), approvalStatus: 'pending',
    }));
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ pricingModel: 'flat', cpcRate: 0, cpmRate: 0, budget: 0, maxClicks: 0, billedToBusinessId: null, approvalStatus: 'approved' });
  });

  it('un comercio no puede usar los endpoints de administrador', async () => {
    const bought = await buy();
    const h = await authHeader(owner);
    expect((await request(app).post(`${API}/advertisements`).set(h).send(internalBody())).status).toBe(403);
    expect((await request(app).patch(`${API}/advertisements/${bought._id}`).set(h).send({ endDate: new Date(Date.now() + 365 * DAY) })).status).toBe(403);
    expect((await request(app).patch(`${API}/advertisements/${bought._id}/approve`).set(h)).status).toBe(403);
    expect((await request(app).patch(`${API}/advertisements/${bought._id}/toggle`).set(h)).status).toBe(403);
    expect((await request(app).delete(`${API}/advertisements/${bought._id}`).set(h)).status).toBe(403);
    expect((await request(app).post(`${API}/advertisements/${bought._id}/close`).set(h)).status).toBe(403);
  });

  it('el comercio sigue sujeto a la oferta: tarifa, tope y duración fuera de rango se rechazan', async () => {
    await expect(buy({ cpcRate: 5000 })).rejects.toMatchObject({ statusCode: 422, code: 'AD_OUT_OF_OFFER' });
    await expect(buy({ budget: 5_000_000 })).rejects.toMatchObject({ statusCode: 422 });
    await expect(buy({ endDate: new Date(Date.now() + 90 * DAY) })).rejects.toMatchObject({ statusCode: 422 });
  });
});

describe('El admin no deshace lo que pagó un comercio', () => {
  it('no puede estirar la campaña más allá de la duración máxima, ni mover su destino', async () => {
    const bought = await buy();
    const h = await authHeader(admin);
    const longer = await request(app).patch(`${API}/advertisements/${bought._id}`).set(h)
      .send({ endDate: new Date(bought.startDate.getTime() + 120 * DAY).toISOString() });
    expect(longer.status).toBe(422);
    expect(longer.body.code).toBe('AD_ADMIN_EDIT_BLOCKED');

    const other = await makeBusiness((await makeUser({ role: UserRole.BUSINESS }))._id);
    const redirect = await request(app).patch(`${API}/advertisements/${bought._id}`).set(h).send({ businessId: other._id.toString() });
    expect(redirect.status).toBe(422);

    const fresh = await Advertisement.findById(bought._id);
    expect(fresh!.endDate.getTime()).toBe(bought.endDate.getTime());
    expect(String(fresh!.businessId)).toBe(String(business._id));
  });

  it('sí puede lo operativo: prioridad, notas internas y acortar la duración dentro de la oferta', async () => {
    const bought = await buy();
    const h = await authHeader(admin);
    const res = await request(app).patch(`${API}/advertisements/${bought._id}`).set(h)
      .send({ priority: 5, internalNotes: 'revisada', endDate: new Date(bought.startDate.getTime() + 3 * DAY).toISOString() });
    expect(res.status).toBe(200);
    expect(res.body.data.priority).toBe(5);
  });

  it('una campaña que ya quedó fuera de oferta (cambió la tarifa) sigue editándose en lo que no la empeora', async () => {
    const bought = await buy();
    await makePricingConfig({ ...OFFER, adCpcMaxRate: 300 });
    const res = await request(app).patch(`${API}/advertisements/${bought._id}`).set(await authHeader(admin)).send({ priority: 9 });
    expect(res.status).toBe(200);
  });

  it('no se enciende una campaña pendiente o rechazada, ni por toggle ni por PATCH', async () => {
    const bought = await buy();
    const h = await authHeader(admin);
    expect((await request(app).patch(`${API}/advertisements/${bought._id}/toggle`).set(h)).status).toBe(409);
    expect((await request(app).patch(`${API}/advertisements/${bought._id}`).set(h).send({ isActive: true })).status).toBe(409);
    expect((await Advertisement.findById(bought._id))!.isActive).toBe(false);

    await advertisementService.approve(bought._id.toString());
    expect((await Advertisement.findById(bought._id))!.approvalStatus).toBe(AdApprovalStatus.APPROVED);
    // Ya aprobada: pausar y reactivar funciona.
    expect((await request(app).patch(`${API}/advertisements/${bought._id}/toggle`).set(h)).status).toBe(200);
    expect((await request(app).patch(`${API}/advertisements/${bought._id}/toggle`).set(h)).status).toBe(200);
  });

  it('no se elimina una campaña que mueve dinero (comprada, vendida o con factura): se cancela', async () => {
    const bought = await buy();
    const h = await authHeader(admin);
    const del = await request(app).delete(`${API}/advertisements/${bought._id}`).set(h);
    expect(del.status).toBe(409);
    expect(await Advertisement.countDocuments({ _id: bought._id })).toBe(1);

    const sold = await request(app).post(`${API}/advertisements`).set(h).send(internalBody({ pricePaid: 300_000 }));
    expect((await request(app).delete(`${API}/advertisements/${sold.body.data._id}`).set(h)).status).toBe(409);

    const cancel = await request(app).patch(`${API}/advertisements/${bought._id}/cancel`).set(h);
    expect(cancel.status).toBe(200);
  });

  it('una interna sin factura sí se elimina; con factura no', async () => {
    const h = await authHeader(admin);
    const created = await request(app).post(`${API}/advertisements`).set(h).send(internalBody());
    const id = created.body.data._id;
    await AdInvoice.collection.insertOne({ campaignId: new (await import('mongoose')).Types.ObjectId(id), amount: 0 });
    expect((await request(app).delete(`${API}/advertisements/${id}`).set(h)).status).toBe(409);
    await AdInvoice.collection.deleteMany({});
    expect((await request(app).delete(`${API}/advertisements/${id}`).set(h)).status).toBe(200);
  });
});

describe('Destino de las campañas internas', () => {
  it('apuntar a un comercio inexistente, suspendido o archivado se rechaza', async () => {
    const h = await authHeader(admin);
    const ghost = '64b7f0f0f0f0f0f0f0f0f0f0';
    expect((await request(app).post(`${API}/advertisements`).set(h).send(internalBody({ actionType: 'business', businessId: ghost }))).status).toBe(422);

    await Business.updateOne({ _id: business._id }, { isSuspended: true });
    expect((await request(app).post(`${API}/advertisements`).set(h).send(internalBody({ actionType: 'business', businessId: business._id.toString() }))).status).toBe(422);

    await Business.updateOne({ _id: business._id }, { isSuspended: false });
    const ok = await request(app).post(`${API}/advertisements`).set(h).send(internalBody({ actionType: 'business', businessId: business._id.toString() }));
    expect(ok.status).toBe(201);
  });
});

describe('adminEditProblems (puro)', () => {
  it('una campaña de ZIPP no tiene restricciones comerciales', async () => {
    const offer = adOffer(await makePricingConfig(OFFER));
    const ad = { billedToBusinessId: null, businessId: null, actionType: 'none', pricingModel: 'flat', cpcRate: 0, cpmRate: 0, budget: 0, startDate: new Date(), endDate: new Date(Date.now() + 400 * DAY), placement: 'splash', advertiserName: 'ZIPP' };
    expect(adminEditProblems(offer, ad as never, { endDate: new Date(Date.now() + 900 * DAY), placement: 'splash', businessId: 'x' })).toEqual([]);
  });
});
