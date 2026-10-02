import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { BusinessStaff, BusinessRole, Product } from '../models';
import { UserRole } from '../types';
import { makeUser, makeBusiness, makeProduct, makePricingConfig, authHeader } from './factories';

/**
 * RBAC del panel de comercios, por la puerta de atrás.
 *
 * Esconder un botón no es seguridad: un operador con un token válido puede
 * llamar al endpoint directamente. Aquí se llama directamente.
 */

let owner: any;
let business: any;
let product: any;
const bid = () => business._id.toString();

async function member(role: BusinessRole) {
  const user = await makeUser({ role: UserRole.BUSINESS });
  await BusinessStaff.create({ businessId: business._id, userId: user._id, role });
  return user;
}

beforeEach(async () => {
  await makePricingConfig({});
  owner = await makeUser({ role: UserRole.BUSINESS });
  business = await makeBusiness(owner._id);
  product = await makeProduct(business._id, { price: 20000 });
});

describe('Catálogo', () => {
  it('el operador no modifica, crea ni elimina productos (403 con mensaje)', async () => {
    const operator = await member(BusinessRole.OPERATOR);
    const h = await authHeader(operator);

    const put = await request(app).put(`/api/v1/products/${product._id}`).set(h)
      .send({ businessId: bid(), name: 'Nuevo nombre' });
    expect(put.status).toBe(403);
    expect(put.body.message).toBe('Sin permisos para modificar productos.');

    const del = await request(app).delete(`/api/v1/products/${product._id}`).set(h).send({ businessId: bid() });
    expect(del.status).toBe(403);

    const post = await request(app).post('/api/v1/products').set(h)
      .send({ businessId: bid(), name: 'Nuevo plato', description: 'x', price: 1000, categoryId: String(product.categoryId ?? '000000000000000000000000') });
    expect(post.status).toBe(403);

    expect((await Product.findById(product._id))!.price).toBe(20000);
  });

  it('el cajero tampoco', async () => {
    const cashier = await member(BusinessRole.CASHIER);
    const res = await request(app).put(`/api/v1/products/${product._id}`).set(await authHeader(cashier))
      .send({ businessId: bid(), price: 1 });
    expect(res.status).toBe(403);
  });

  it('el administrador sí cambia el precio; el propietario también', async () => {
    const admin = await member(BusinessRole.MANAGER);
    const res = await request(app).put(`/api/v1/products/${product._id}`).set(await authHeader(admin))
      .send({ businessId: bid(), price: 25000 });
    expect(res.status).toBe(200);
    expect((await Product.findById(product._id))!.price).toBe(25000);

    const res2 = await request(app).put(`/api/v1/products/${product._id}`).set(await authHeader(owner))
      .send({ businessId: bid(), price: 26000 });
    expect(res2.status).toBe(200);
  });

  it('un empleado de otro negocio no toca este catálogo', async () => {
    const otherOwner = await makeUser({ role: UserRole.BUSINESS });
    const other = await makeBusiness(otherOwner._id);
    const alien = await makeUser({ role: UserRole.BUSINESS });
    await BusinessStaff.create({ businessId: other._id, userId: alien._id, role: BusinessRole.MANAGER });

    const res = await request(app).put(`/api/v1/products/${product._id}`).set(await authHeader(alien))
      .send({ businessId: bid(), price: 1 });
    expect(res.status).toBe(403);
  });
});

describe('Dinero y configuración', () => {
  it('operador y cajero no ven liquidaciones ni el resumen financiero', async () => {
    for (const role of [BusinessRole.OPERATOR, BusinessRole.CASHIER, BusinessRole.MANAGER]) {
      const h = await authHeader(await member(role));
      expect((await request(app).get(`/api/v1/businesses/${bid()}/statement`).set(h)).status).toBe(403);
      expect((await request(app).get(`/api/v1/businesses/${bid()}/statement/export`).set(h)).status).toBe(403);
      expect((await request(app).get(`/api/v1/businesses/${bid()}/daily-summary`).set(h)).status).toBe(403);
      expect((await request(app).get(`/api/v1/businesses/${bid()}/documents`).set(h)).status).toBe(403);
    }
  });

  it('el propietario sí ve su extracto', async () => {
    const res = await request(app).get(`/api/v1/businesses/${bid()}/statement`).set(await authHeader(owner));
    expect(res.status).toBe(200);
  });

  it('solo propietario y administrador consultan estadísticas', async () => {
    const operator = await member(BusinessRole.OPERATOR);
    expect((await request(app).get(`/api/v1/businesses/${bid()}/analytics`).set(await authHeader(operator))).status).toBe(403);
    const admin = await member(BusinessRole.MANAGER);
    expect((await request(app).get(`/api/v1/businesses/${bid()}/analytics`).set(await authHeader(admin))).status).toBe(200);
  });

  it('el administrador no cambia la información del negocio', async () => {
    const admin = await member(BusinessRole.MANAGER);
    const res = await request(app).put(`/api/v1/businesses/${bid()}`).set(await authHeader(admin)).send({ name: 'Otro' });
    expect(res.status).toBeGreaterThanOrEqual(403);
  });
});

describe('Promociones y publicidad', () => {
  it('el operador no lista ni crea promociones; el administrador las lista', async () => {
    const operator = await member(BusinessRole.OPERATOR);
    const list = await request(app).get(`/api/v1/coupons/business/${bid()}`).set(await authHeader(operator));
    expect(list.status).toBe(403);

    const admin = await member(BusinessRole.MANAGER);
    const ok = await request(app).get(`/api/v1/coupons/business/${bid()}`).set(await authHeader(admin));
    expect(ok.status).toBe(200);
  });

  it('el operador no lee la publicidad del negocio', async () => {
    const operator = await member(BusinessRole.OPERATOR);
    const res = await request(app).get(`/api/v1/advertisements/business/${bid()}`).set(await authHeader(operator));
    expect(res.status).toBe(403);
  });
});

describe('Equipo', () => {
  it('el operador no ve ni invita al equipo', async () => {
    const operator = await member(BusinessRole.OPERATOR);
    const h = await authHeader(operator);
    const list = await request(app).get(`/api/v1/businesses/${bid()}/staff`).set(h);
    expect(list.status).toBe(403);
    expect(list.body.message).toBe('Sin permisos para ver al equipo.');

    const invite = await request(app).post(`/api/v1/businesses/${bid()}/staff`).set(h)
      .send({ phone: '3001112233', role: 'cashier' });
    expect(invite.status).toBe(403);
  });

  it('el administrador invita operativos pero no administradores', async () => {
    const admin = await member(BusinessRole.MANAGER);
    const h = await authHeader(admin);
    const target: any = await makeUser({ role: UserRole.BUSINESS, phone: '3115550001' });

    const asAdmin = await request(app).post(`/api/v1/businesses/${bid()}/staff`).set(h)
      .send({ phone: target.phone, role: 'manager' });
    expect(asAdmin.status).toBe(403);

    const ok = await request(app).post(`/api/v1/businesses/${bid()}/staff`).set(h)
      .send({ phone: target.phone, role: 'cashier' });
    expect(ok.status).toBe(201);
    expect(ok.body.data.status).toBe('pending');
  });

  it('el invitado acepta por su propia ruta', async () => {
    const target: any = await makeUser({ role: UserRole.BUSINESS, phone: '3115550002' });
    const invite = await request(app).post(`/api/v1/businesses/${bid()}/staff`).set(await authHeader(owner))
      .send({ phone: target.phone, role: 'operator', name: 'Carlos Pérez' });
    expect(invite.status).toBe(201);

    const h = await authHeader(target);
    const pending = await request(app).get('/api/v1/businesses/my/invitations').set(h);
    expect(pending.body.data).toHaveLength(1);

    const accept = await request(app).post(`/api/v1/businesses/my/invitations/${invite.body.data._id}`).set(h).send({ accept: true });
    expect(accept.status).toBe(200);

    const perms = await request(app).get(`/api/v1/businesses/${bid()}/my-permissions`).set(h);
    expect(perms.body.data.role).toBe('operator');
  });
});
