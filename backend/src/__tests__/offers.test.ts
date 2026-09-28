import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { Business } from '../models';
import { UserRole, CouponFundedBy, CouponScope, CouponType } from '../types';
import { GARZON, offsetKm, makeUser, makeBusiness, makeProduct, makeCoupon } from './factories';

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

  it('un producto sin discountPrice propio, cubierto por una promoción automática, aparece con su porcentaje real', async () => {
    const business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
    const product = await makeProduct(business._id, { name: 'Pizza familiar', price: 40000 });

    await makeCoupon({
      type: CouponType.PERCENTAGE,
      value: 25,
      fundedBy: CouponFundedBy.BUSINESS,
      scope: CouponScope.PRODUCT,
      businessId: business._id,
      autoApply: true,
      productIds: [product._id],
    });

    const res = await request(app)
      .get(API)
      .query({ lat: GARZON.lat, lng: GARZON.lng, maxDistance: 5000 })
      .expect(200);

    const found = res.body.data.products.find((p: any) => p.name === 'Pizza familiar');
    expect(found).toBeTruthy();
    expect(found.discountPercent).toBe(25);
    expect(found.discountPrice).toBe(30000);
  });

  it('una promoción automática todavía programada no hace aparecer el producto', async () => {
    const business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
    const product = await makeProduct(business._id, { name: 'Pastel de mañana', price: 12000 });

    await makeCoupon({
      type: CouponType.PERCENTAGE,
      value: 25,
      fundedBy: CouponFundedBy.BUSINESS,
      scope: CouponScope.PRODUCT,
      businessId: business._id,
      autoApply: true,
      productIds: [product._id],
      validFrom: new Date(Date.now() + 24 * 3600_000),
    });

    const res = await request(app)
      .get(API)
      .query({ lat: GARZON.lat, lng: GARZON.lng, maxDistance: 5000 })
      .expect(200);

    expect(res.body.data.products.find((p: any) => p.name === 'Pastel de mañana')).toBeUndefined();
  });

  it('sin coordenadas, sigue respondiendo con los cupones públicos', async () => {
    const res = await request(app).get(API).expect(200);
    expect(Array.isArray(res.body.data.coupons)).toBe(true);
  });
});
