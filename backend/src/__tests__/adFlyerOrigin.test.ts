import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { cloudinary } from '../config';
import { BusinessStaff, BusinessRole, Advertisement } from '../models';
import { UserRole } from '../types';
import { advertisementService } from '../services/advertisement.service';
import { makeUser, makeBusiness, makePricingConfig, authHeader, counterAuthHeader } from './factories';

/**
 * El flyer de una campaña del comercio vive en nuestro Cloudinary
 * (auditoría 2026-10-17). Con un enlace libre, el comercio podía cambiar la
 * imagen después de aprobada y ver la IP de quien la abría.
 */

const API = '/api/v1';
const OWN = 'https://res.cloudinary.com/demo/image/upload/v1/ads/flyer.png';

// PNG con cabecera IHDR de 1080×1920: `readImageHeader` solo lee eso.
function png(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'), ihdr, Buffer.alloc(4),
  ]);
}

let owner: any;
let business: any;

const buy = async (headers: Record<string, string>, flyerUrl: string) =>
  request(app).post(`${API}/advertisements/business/${business._id}`).set(headers).send({
    campaignName: 'Promo de apertura', flyerUrl,
    startDate: new Date(Date.now() + 86_400_000), endDate: new Date(Date.now() + 8 * 86_400_000),
    pricingModel: 'cpc', cpmRate: 0, cpcRate: 500, budget: 50_000,
  });

beforeAll(() => {
  cloudinary.config({ cloud_name: 'demo', api_key: 'key', api_secret: 'secret' });
  vi.spyOn(advertisementService as any, 'store').mockResolvedValue({ url: OWN });
});
afterAll(() => vi.restoreAllMocks());

beforeEach(async () => {
  // Oferta de ejemplo: sin ella la compra respondería 409 antes de mirar el flyer.
  await makePricingConfig({
    adSelfServiceEnabled: true, adBillingEnabled: true, adCpcEnabled: true, adCpcMinRate: 100, adCpcMaxRate: 5000,
    adMinBudget: 10_000, adMaxBudget: 1_000_000, adMinDurationDays: 1, adMaxDurationDays: 30, adPlacements: ['splash'],
  });
  owner = await makeUser({ role: UserRole.BUSINESS });
  business = await makeBusiness(owner._id);
});

describe('Origen del flyer de las campañas del comercio', () => {
  it('rechaza un enlace externo, http, o de otra cuenta de Cloudinary', async () => {
    for (const url of [
      'https://evil.example/flyer.png',
      'http://res.cloudinary.com/demo/image/upload/v1/ads/flyer.png',
      'https://res.cloudinary.com/otra-cuenta/image/upload/v1/flyer.png',
      'https://api.cloudinary.com/v1_1/demo/image/download?x=1',
    ]) {
      const res = await buy(await authHeader(owner), url);
      expect(res.status, url).toBe(400);
    }
    expect(await Advertisement.countDocuments()).toBe(0);
  });

  it('acepta el flyer subido a Zipp y la campaña queda pendiente y apagada', async () => {
    const res = await buy(await authHeader(owner), OWN);
    expect(res.status).toBe(201);
    expect(res.body.data.flyerUrl).toBe(OWN);
    expect(res.body.data.isActive).toBe(false);
  });

  it('subir el flyer: el dueño sí; el mostrador, la sesión de mostrador y otro negocio no', async () => {
    const ok = await request(app)
      .post(`${API}/advertisements/business/${business._id}/flyer`)
      .set(await authHeader(owner))
      .attach('flyer', png(1080, 1920), { filename: 'flyer.png', contentType: 'image/png' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.url).toBe(OWN);

    const employee = await makeUser({ role: UserRole.BUSINESS });
    await BusinessStaff.create({ businessId: business._id, userId: employee._id, role: BusinessRole.EMPLOYEE, isActive: true, status: 'active' });
    const otherOwner = await makeUser({ role: UserRole.BUSINESS });
    await makeBusiness(otherOwner._id);

    for (const headers of [await authHeader(employee), await counterAuthHeader(owner), await authHeader(otherOwner)]) {
      const res = await request(app)
        .post(`${API}/advertisements/business/${business._id}/flyer`)
        .set(headers)
        .attach('flyer', png(1080, 1920), { filename: 'flyer.png', contentType: 'image/png' });
      expect(res.status).toBe(403);
    }
  });

  it('la subida inspecciona el archivo: un tipo declarado falso no pasa', async () => {
    const res = await request(app)
      .post(`${API}/advertisements/business/${business._id}/flyer`)
      .set(await authHeader(owner))
      .attach('flyer', png(1080, 1920), { filename: 'flyer.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(400);
  });
});
