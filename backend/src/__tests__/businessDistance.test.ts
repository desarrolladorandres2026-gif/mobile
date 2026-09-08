import { describe, it, expect, beforeEach } from 'vitest';
import { UserRole } from '../types';
import { businessService } from '../services/business.service';
import { makeUser, makeBusiness, GARZON, offsetKm } from './factories';

/**
 * Distancia al negocio.
 *
 * El listado enseñaba minutos estimados sin decir de dónde salían, y entre
 * dos sitios parecidos la distancia es justo lo que decide. La consulta
 * pasó de `$geoWithin` a `$geoNear` para poder devolverla: el primero
 * filtra pero no mide.
 */
describe('Listado de negocios por cercanía', () => {
  let owner: any;

  beforeEach(async () => {
    owner = await makeUser({ role: UserRole.BUSINESS });
  });

  it('devuelve la distancia cuando se consulta con coordenadas', async () => {
    const cerca = offsetKm(GARZON, 0.5);
    await makeBusiness(owner._id, { name: 'El cercano', lat: cerca.lat, lng: cerca.lng });

    const { businesses } = await businessService.getAll({
      lat: GARZON.lat,
      lng: GARZON.lng,
    });

    const found = businesses.find((b: any) => b.name === 'El cercano') as any;
    expect(found).toBeDefined();
    expect(found.distanceMeters).toBeGreaterThan(0);
    // Medio kilómetro, con holgura para la curvatura y el redondeo.
    expect(found.distanceMeters).toBeLessThan(700);
  });

  it('sin coordenadas no inventa una distancia', async () => {
    await makeBusiness(owner._id, { name: 'Sin geo', lat: GARZON.lat, lng: GARZON.lng });

    const { businesses } = await businessService.getAll({});
    const found = businesses.find((b: any) => b.name === 'Sin geo') as any;

    expect(found).toBeDefined();
    expect(found.distanceMeters).toBeUndefined();
  });

  it('deja fuera lo que está más lejos del radio pedido', async () => {
    const lejos = offsetKm(GARZON, 40);
    await makeBusiness(owner._id, { name: 'El lejano', lat: lejos.lat, lng: lejos.lng });

    const { businesses } = await businessService.getAll({
      lat: GARZON.lat,
      lng: GARZON.lng,
      maxDistance: 5000,
    });

    expect(businesses.find((b: any) => b.name === 'El lejano')).toBeUndefined();
  });

  it('sigue respetando los filtros aunque ahora viajen dentro de $geoNear', async () => {
    await makeBusiness(owner._id, {
      name: 'Farmacia',
      category: 'pharmacy',
      lat: GARZON.lat,
      lng: GARZON.lng,
    });
    await makeBusiness(owner._id, {
      name: 'Restaurante',
      category: 'restaurant',
      lat: GARZON.lat,
      lng: GARZON.lng,
    });

    const { businesses } = await businessService.getAll({
      lat: GARZON.lat,
      lng: GARZON.lng,
      category: 'pharmacy',
    });

    expect(businesses).toHaveLength(1);
    expect((businesses[0] as any).name).toBe('Farmacia');
  });

  it('no muestra negocios sin aprobar aunque estén al lado', async () => {
    await makeBusiness(owner._id, {
      name: 'Sin aprobar',
      lat: GARZON.lat,
      lng: GARZON.lng,
      isApproved: false,
    });

    const { businesses } = await businessService.getAll({
      lat: GARZON.lat,
      lng: GARZON.lng,
    });

    expect(businesses.find((b: any) => b.name === 'Sin aprobar')).toBeUndefined();
  });
});
