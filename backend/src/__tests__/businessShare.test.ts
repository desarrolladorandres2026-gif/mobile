import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../app';
import { makeUser, makeBusiness } from './factories';

/**
 * La ficha pública que carga `web/` desde el enlace del botón "Compartir".
 *
 * Lo que importa proteger aquí no es la forma del JSON —eso ya lo vigila
 * `apiContract.test.ts` para las rutas que consume la app— sino dos cosas
 * que esta ruta tiene de especial por ser la única pensada para un
 * desconocido sin sesión: que nunca se cuelen los términos comerciales del
 * negocio, y que un negocio que nunca llegó a aprobarse no tenga ficha
 * circulando aunque alguien adivine su slug.
 */
describe('GET /businesses/slug/:slug/share', () => {
  it('no exige sesión', async () => {
    const owner = await makeUser();
    const business = await makeBusiness(owner._id, { name: 'Panadería Compartida' });

    const res = await request(app).get(`/api/v1/businesses/slug/${business.slug}/share`);

    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Panadería Compartida');
  });

  it('nunca incluye comisión ni datos internos del negocio', async () => {
    const owner = await makeUser();
    const business = await makeBusiness(owner._id, { commissionRateBps: 1500 });

    const res = await request(app).get(`/api/v1/businesses/slug/${business.slug}/share`);

    expect(res.body.data.commissionRate).toBeUndefined();
    expect(res.body.data.commissionRateBps).toBeUndefined();
    expect(res.body.data.ownerId).toBeUndefined();
    expect(res.body.data.reputationScore).toBeUndefined();
  });

  it('404 en un negocio que nunca se aprobó, aunque el slug sea real', async () => {
    const owner = await makeUser();
    const business = await makeBusiness(owner._id, { isApproved: false });

    const res = await request(app).get(`/api/v1/businesses/slug/${business.slug}/share`);

    expect(res.status).toBe(404);
  });

  it('404 en un slug que no existe', async () => {
    const res = await request(app).get('/api/v1/businesses/slug/no-existe-esto/share');
    expect(res.status).toBe(404);
  });
});
