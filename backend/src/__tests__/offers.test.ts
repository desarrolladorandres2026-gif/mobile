import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { Business } from '../models';
import { UserRole } from '../types';
import { GARZON, offsetKm, makeUser, makeBusiness, makeProduct } from './factories';

const API = '/api/v1/offers';

/**
 * Lo que está en oferta cerca de un punto.
 *
 * Las tres cosas que agrega este endpoint —productos rebajados, negocios
 * con envío gratis, cupones públicos— ya se podían consultar por separado;
 * lo que estas pruebas fijan es que el agregado respeta las mismas reglas
 * de visibilidad que la búsqueda: un negocio no aprobado o fuera del radio
 * no debe aparecer solo porque su producto está barato.
 */
describe('GET /api/offers', () => {
  let owner: any;

  beforeEach(async () => {
    owner = await makeUser({ role: UserRole.BUSINESS });
  });

  it('encuentra un producto rebajado dentro del radio', async () => {
    const business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
    await makeProduct(business._id, {
      name: 'Hamburguesa doble',
      price: 20000,
      discountPrice: 15000,
    });

    const res = await request(app)
      .get(API)
      .query({ lat: GARZON.lat, lng: GARZON.lng, maxDistance: 5000 })
      .expect(200);

    const names = res.body.data.products.map((p: any) => p.name);
    expect(names).toContain('Hamburguesa doble');
    expect(res.body.data.products[0].discountPercent).toBe(25);
  });

  it('descarta un negocio fuera del radio aunque su producto esté rebajado', async () => {
    const far = offsetKm(GARZON, 20);
    const business = await makeBusiness(owner._id, { lat: far.lat, lng: far.lng });
    await makeProduct(business._id, { price: 20000, discountPrice: 10000 });

    const res = await request(app)
      .get(API)
      .query({ lat: GARZON.lat, lng: GARZON.lng, maxDistance: 5000 })
      .expect(200);

    expect(res.body.data.products).toHaveLength(0);
    expect(res.body.data.businesses).toHaveLength(0);
  });

  it('no anuncia un "descuento" que no baja el precio', async () => {
    const business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
    await makeProduct(business._id, { price: 20000, discountPrice: 20000 });

    const res = await request(app)
      .get(API)
      .query({ lat: GARZON.lat, lng: GARZON.lng, maxDistance: 5000 })
      .expect(200);

    expect(res.body.data.products).toHaveLength(0);
  });

  it('un negocio no aprobado no aparece aunque su producto esté rebajado', async () => {
    const business = await makeBusiness(owner._id, {
      lat: GARZON.lat,
      lng: GARZON.lng,
      isApproved: false,
    });
    await makeProduct(business._id, { price: 20000, discountPrice: 10000 });

    const res = await request(app)
      .get(API)
      .query({ lat: GARZON.lat, lng: GARZON.lng, maxDistance: 5000 })
      .expect(200);

    expect(res.body.data.products).toHaveLength(0);
    expect(res.body.data.businesses).toHaveLength(0);
  });

  it('un negocio con envío gratis aparece con ese motivo', async () => {
    const business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
    await Business.updateOne({ _id: business._id }, { freeDeliveryThreshold: 30000 });

    const res = await request(app)
      .get(API)
      .query({ lat: GARZON.lat, lng: GARZON.lng, maxDistance: 5000 })
      .expect(200);

    const found = res.body.data.businesses.find((b: any) => b._id === business._id.toString());
    expect(found).toBeTruthy();
    expect(found.offer.kind).toBe('free_delivery');
  });

  it('sin coordenadas, sigue respondiendo con los cupones públicos', async () => {
    const res = await request(app).get(API).expect(200);
    expect(Array.isArray(res.body.data.coupons)).toBe(true);
  });
});
