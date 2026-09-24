import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { Role } from '../models';
import { UserRole } from '../types';
import { Permission, STAFF_ROLE_PERMISSIONS } from '../security/rbac';
import { featureFlagService } from '../services/featureFlag.service';
import { cache } from '../cache';
import { makeUser, makeBusiness, authHeader } from './factories';

/**
 * B2b: permisos por modulo en cupones, publicidad, contenido de Inicio,
 * resenas, productos y categorias. Matriz rol x ruta en modo bloqueo, mas
 * regresion: el comercio sigue gestionando lo suyo exactamente igual.
 */

const API = '/api/v1';

async function makeRole(slug: string, permissions: Permission[]) {
  return Role.create({ name: slug, slug, permissions, isActive: true, isSystem: false });
}

async function makeAdmin(roles: Array<{ _id: unknown }> = []) {
  const user = await makeUser({ role: UserRole.ADMIN });
  if (roles.length) {
    user.roleIds = roles.map((r) => r._id) as any;
    await user.save();
  }
  return user;
}

async function setEnforce(on: boolean) {
  await featureFlagService.upsert('rbac_enforce', { audience: on ? 'staff' : 'off' });
}

describe('B2b: permisos de contenido y crecimiento', () => {
  let bare: any, soporte: any, contenido: any, finanzas: any, superAdmin: any;

  beforeEach(async () => {
    await featureFlagService.remove('rbac_enforce');
    await cache.flush();
    bare = await makeAdmin();
    soporte = await makeAdmin([await makeRole('soporte', STAFF_ROLE_PERMISSIONS.soporte.permissions)]);
    contenido = await makeAdmin([
      await makeRole('comercios_contenido', STAFF_ROLE_PERMISSIONS.comercios_contenido.permissions),
    ]);
    finanzas = await makeAdmin([await makeRole('finanzas', STAFF_ROLE_PERMISSIONS.finanzas.permissions)]);
    superAdmin = await makeAdmin([await makeRole('super_admin', [])]);
  });

  const status = async (method: 'get' | 'post' | 'patch' | 'delete', path: string, user: any, body?: object) => {
    const r = (request(app) as any)[method](`${API}${path}`).set(await authHeader(user));
    return (body ? r.send(body) : r).then((x: any) => x.status as number);
  };
  const ID = '507f1f77bcf86cd799439011';

  it('enforce: lecturas de cupones, publicidad, contenido y resenas', async () => {
    await setEnforce(true);
    const reads: Array<[string, Record<string, number>]> = [
      // ruta, [rol -> esperado]; 403 = denegado, cualquier otro = paso el permiso
      ['/coupons', { bare: 403, soporte: 403, contenido: 200, finanzas: 200, superAdmin: 200 }],
      ['/advertisements', { bare: 403, soporte: 403, contenido: 200, finanzas: 200, superAdmin: 200 }],
      ['/promotion-banners', { bare: 403, soporte: 403, contenido: 200, finanzas: 403, superAdmin: 200 }],
      ['/home-categories/admin', { bare: 403, soporte: 403, contenido: 200, finanzas: 403, superAdmin: 200 }],
      ['/curated-home-blocks', { bare: 403, soporte: 403, contenido: 200, finanzas: 403, superAdmin: 200 }],
      ['/reviews/moderation', { bare: 403, soporte: 403, contenido: 200, finanzas: 403, superAdmin: 200 }],
      ['/search/insights', { bare: 403, soporte: 403, contenido: 200, finanzas: 403, superAdmin: 200 }],
    ];
    const who: Record<string, any> = { bare, soporte, contenido, finanzas, superAdmin };
    for (const [path, expected] of reads) {
      for (const [name, code] of Object.entries(expected)) {
        const got = await status('get', path, who[name]);
        if (code === 403) expect(got, `${name} ${path}`).toBe(403);
        else expect(got, `${name} ${path}`).not.toBe(403);
      }
    }
  });

  it('enforce: escrituras exigen manage; finanzas (solo view) no escribe', async () => {
    await setEnforce(true);
    const writes: Array<['post' | 'patch' | 'delete', string]> = [
      ['post', '/coupons'],
      ['patch', `/coupons/${ID}`],
      ['delete', `/coupons/${ID}`],
      ['post', '/advertisements'],
      ['patch', `/advertisements/${ID}/approve`],
      ['post', '/promotion-banners'],
      ['patch', '/promotion-banners/reorder'],
      ['delete', `/promotion-banners/${ID}`],
      ['post', '/home-categories'],
      ['delete', `/home-categories/${ID}`],
      ['post', '/curated-home-blocks'],
      ['patch', `/reviews/${ID}/moderate`],
    ];
    for (const [m, path] of writes) {
      for (const u of [bare, soporte, finanzas]) {
        expect(await status(m, path, u, {}), `${m} ${path}`).toBe(403);
      }
      expect(await status(m, path, contenido, {}), `contenido ${m} ${path}`).not.toBe(403);
    }
  });

  it('cerrar y facturar campana exige ads:manage Y finance:manage', async () => {
    await setEnforce(true);
    // contenido tiene ads:manage pero no finance:manage
    expect(await status('post', `/advertisements/${ID}/close`, contenido)).toBe(403);
    // super_admin tiene ambos: pasa el permiso (404 por id inexistente)
    expect(await status('post', `/advertisements/${ID}/close`, superAdmin)).not.toBe(403);
  });

  it('regresion: el comercio sigue gestionando lo suyo', async () => {
    await setEnforce(true);
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id);
    const client = await makeUser({ role: UserRole.CLIENT });

    // cupones self-service
    const coupon = {
      code: 'MIPROMO1', title: 'Mi promo', type: 'percentage', value: 10,
      validUntil: new Date(Date.now() + 86400000).toISOString(),
    };
    expect(await status('post', `/coupons/business/${business._id}`, owner, coupon)).toBe(201);
    expect(await status('get', `/coupons/business/${business._id}`, owner)).toBe(200);
    expect(await status('post', `/coupons/business/${business._id}`, client, coupon)).toBe(403);

    // publicidad self-service: la ruta de compra sigue abierta al comercio
    expect(await status('get', `/advertisements/business/${business._id}`, owner)).toBe(200);
    expect(await status('get', `/advertisements/business/${business._id}`, client)).toBe(403);
    // y el admin sin ads:view queda fuera de la "puerta trasera"
    expect(await status('get', `/advertisements/business/${business._id}`, bare)).toBe(403);
    expect(await status('get', `/advertisements/business/${business._id}`, finanzas)).toBe(200);

    // categorias y productos
    const cat = await request(app).post(`${API}/categories`).set(await authHeader(owner))
      .send({ businessId: business._id.toString(), name: 'Bebidas' });
    expect(cat.status).toBe(201);
    const catId = cat.body.data._id;
    expect(await status('post', '/categories', client, { businessId: business._id.toString(), name: 'X' })).toBe(403);
    expect(await status('post', '/categories', bare, { businessId: business._id.toString(), name: 'X' })).toBe(403);

    const prod = await request(app).post(`${API}/products`).set(await authHeader(owner))
      .send({ businessId: business._id.toString(), categoryId: catId, name: 'Jugo', price: 5000 });
    expect(prod.status).toBe(201);
    const put = await request(app).put(`${API}/products/${prod.body.data._id}`).set(await authHeader(owner))
      .send({ businessId: business._id.toString(), name: 'Jugo grande' });
    expect(put.status).toBe(200);
    const putClient = await request(app).put(`${API}/products/${prod.body.data._id}`).set(await authHeader(client))
      .send({ businessId: business._id.toString(), name: 'x' });
    expect(putClient.status).toBe(403);
    const putBare = await request(app).put(`${API}/products/${prod.body.data._id}`).set(await authHeader(bare))
      .send({ businessId: business._id.toString(), name: 'x' });
    expect(putBare.status).toBe(403);
    const putContenido = await request(app).put(`${API}/products/${prod.body.data._id}`).set(await authHeader(contenido))
      .send({ businessId: business._id.toString(), name: 'Jugo XL' });
    expect(putContenido.status).toBe(200);
  });
});
