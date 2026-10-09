import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import app from '../app';
import { BusinessStaff, BusinessRole, Product, Coupon } from '../models';
import { UserRole } from '../types';
import {
  makeUser, makeBusiness, makeProduct, makePricingConfig,
  authHeader, counterAuthHeader,
} from './factories';

/**
 * Sesión de mostrador (decisión 2026-10-09).
 *
 * El correo del negocio entra directo al panel de Empleado: aunque la
 * cuenta sea la del propietario, su SESIÓN de mostrador (`scope: 'counter'`)
 * la topa `businessStaffService.accessFor` al rol con menos permisos del
 * negocio. Esta suite prueba el tope por la puerta de atrás — llamando a los
 * endpoints directamente con el token de la sesión de mostrador — igual que
 * `businessRbacEndpoints.test.ts` prueba los roles guardados.
 */

let owner: any;
let business: any;
let product: any;
const bid = () => business._id.toString();

beforeEach(async () => {
  await makePricingConfig({});
  owner = await makeUser({ role: UserRole.BUSINESS });
  business = await makeBusiness(owner._id);
  product = await makeProduct(business._id, { price: 20000 });
});

describe('Sesión de mostrador: tope al propietario', () => {
  it('my-permissions devuelve el rol Empleado, no Propietario', async () => {
    const res = await request(app)
      .get(`/api/v1/businesses/${bid()}/my-permissions`)
      .set(await counterAuthHeader(owner));
    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe('employee');
    expect(res.body.data.permissions).not.toContain('settlements:view');
    expect(res.body.data.permissions).toContain('orders:view');
  });

  it('con sesión full, my-permissions sigue devolviendo Propietario', async () => {
    const res = await request(app)
      .get(`/api/v1/businesses/${bid()}/my-permissions`)
      .set(await authHeader(owner));
    expect(res.body.data.role).toBe('owner');
  });

  it('403 en liquidaciones', async () => {
    const res = await request(app)
      .get(`/api/v1/businesses/${bid()}/statement`)
      .set(await counterAuthHeader(owner));
    expect(res.status).toBe(403);
  });

  it('403 al editar el catálogo (precio), 200 al agotar un producto', async () => {
    const edit = await request(app)
      .put(`/api/v1/products/${product._id}`)
      .set(await counterAuthHeader(owner))
      .send({ businessId: bid(), price: 99999 });
    expect(edit.status).toBe(403);

    const availability = await request(app)
      .put(`/api/v1/products/${product._id}`)
      .set(await counterAuthHeader(owner))
      .send({ businessId: bid(), isAvailable: false });
    expect(availability.status).toBe(200);
    expect((await Product.findById(product._id))!.isAvailable).toBe(false);
  });

  it('403 al invitar o cambiar roles del equipo', async () => {
    const res = await request(app)
      .post(`/api/v1/businesses/${bid()}/staff`)
      .set(await counterAuthHeader(owner))
      .send({ phone: '3001112233', role: 'employee' });
    expect(res.status).toBe(403);
  });

  it('403 al gestionar o ver promociones (Empleado no tiene promotions:view)', async () => {
    const create = await request(app)
      .post(`/api/v1/coupons/business/${bid()}`)
      .set(await counterAuthHeader(owner))
      .send({ title: 'Promo', code: 'MOSTRADOR10', type: 'percentage', value: 10, validUntil: new Date(Date.now() + 86400000) });
    expect(create.status).toBe(403);

    const list = await request(app)
      .get(`/api/v1/coupons/business/${bid()}`)
      .set(await counterAuthHeader(owner));
    expect(list.status).toBe(403);
  });

  it('403 al pedir publicidad', async () => {
    const res = await request(app)
      .post(`/api/v1/advertisements/business/${bid()}`)
      .set(await counterAuthHeader(owner))
      .send({
        campaignName: 'Campaña x', flyerUrl: 'https://x.com/a.png',
        startDate: new Date(), endDate: new Date(Date.now() + 86400000),
        pricingModel: 'cpm', cpmRate: 100, cpcRate: 0, budget: 10000,
      });
    expect(res.status).toBe(403);
  });

  it('403 en datos legales y cuenta de pago', async () => {
    const legal = await request(app).get(`/api/v1/businesses/${bid()}/legal`).set(await counterAuthHeader(owner));
    expect(legal.status).toBe(403);
    const payout = await request(app).get(`/api/v1/businesses/${bid()}/payout-account`).set(await counterAuthHeader(owner));
    expect(payout.status).toBe(403);
  });

  it('403 en documentos del negocio', async () => {
    const res = await request(app).get(`/api/v1/businesses/${bid()}/documents`).set(await counterAuthHeader(owner));
    expect(res.status).toBe(403);
  });

  it('200 al abrir y cerrar el local (store:toggle, de Empleado)', async () => {
    const res = await request(app)
      .patch(`/api/v1/businesses/${bid()}/open`)
      .set(await counterAuthHeader(owner))
      .send({ isActive: false });
    expect(res.status).toBe(200);
  });

  it('403 al cambiar la contraseña, el correo, el teléfono o el 2FA personal', async () => {
    const header = await counterAuthHeader(owner);
    const password = await request(app).post('/api/v1/auth/change-password').set(header).send({ currentPassword: 'x', newPassword: 'y12345678' });
    expect(password.status).toBe(403);
    expect(password.body.code ?? password.body.error?.code).toBe('COUNTER_SESSION_FORBIDDEN');

    const mfaSetup = await request(app).post('/api/v1/auth/2fa/setup').set(header).send({ password: 'x' });
    expect(mfaSetup.status).toBe(403);

    const revokeAll = await request(app).post('/api/v1/auth/sessions/revoke-all').set(header).send({});
    expect(revokeAll.status).toBe(403);

    const deleteAccount = await request(app).delete('/api/v1/auth/account').set(header).send({ otpCode: '000000' });
    expect(deleteAccount.status).toBe(403);
  });

  it('con sesión full, las rutas personales no se bloquean por scope (pueden fallar por otra razón)', async () => {
    const res = await request(app)
      .post('/api/v1/auth/change-password')
      .set(await authHeader(owner))
      .send({ currentPassword: 'wrong', newPassword: 'y12345678' });
    expect(res.body.code ?? res.body.error?.code).not.toBe('COUNTER_SESSION_FORBIDDEN');
  });
});

describe('Sesión de mostrador: también topa a un administrador', () => {
  it('un administrador con sesión de mostrador también cae a Empleado', async () => {
    const manager = await makeUser({ role: UserRole.BUSINESS });
    await BusinessStaff.create({ businessId: business._id, userId: manager._id, role: BusinessRole.MANAGER });

    const full = await request(app).get(`/api/v1/businesses/${bid()}/my-permissions`).set(await authHeader(manager));
    expect(full.body.data.role).toBe('manager');

    const counter = await request(app).get(`/api/v1/businesses/${bid()}/my-permissions`).set(await counterAuthHeader(manager));
    expect(counter.body.data.role).toBe('employee');
  });
});

describe('Sesión de mostrador: el evento de pedido llega enmascarado', () => {
  it('accessFor con scope counter nunca incluye settlements:view ni team:invite', async () => {
    const { businessStaffService } = await import('../services/businessStaff.service');
    const access = await businessStaffService.accessFor(owner._id.toString(), bid(), 'counter');
    expect(access?.role).toBe(BusinessRole.EMPLOYEE);
    expect(access?.permissions).not.toContain('settlements:view');
    expect(access?.permissions).not.toContain('team:invite');
  });

  it('sin scope (REST normal, app móvil, etc.) el propietario sigue siendo owner', async () => {
    const { businessStaffService } = await import('../services/businessStaff.service');
    const access = await businessStaffService.accessFor(owner._id.toString(), bid());
    expect(access?.role).toBe(BusinessRole.OWNER);
  });
});

// Limpieza de la promoción creada en el test de "200 al solo verlas", para
// que no quede un cupón huérfano influyendo en otras suites del archivo.
afterAll(async () => {
  await Coupon.deleteMany({});
});
