import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../app';
import { makeUser, makeBusiness } from './factories';

/**
 * `GET /negocio/:slug`: el HTML con etiquetas `og:` que lee WhatsApp al
 * pegar el enlace que comparte la app. Ver `businessShare.controller.ts`
 * para el porqué de que exista aparte de `/businesses/slug/:slug/share`.
 */
describe('GET /negocio/:slug', () => {
  it('trae las etiquetas og: con los datos del negocio', async () => {
    const owner = await makeUser();
    const business = await makeBusiness(owner._id, {
      name: 'Panadería El Trigal',
      description: 'Pan recién horneado todos los días',
    });

    const res = await request(app).get(`/negocio/${business.slug}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('og:title" content="Panadería El Trigal — Zipp"');
    expect(res.text).toContain('Pan recién horneado todos los días');
    expect(res.text).toContain(`og:url" content="https://45-93-100-122.sslip.io/negocio/${business.slug}"`);
  });

  it('escapa el nombre del negocio: nada rompe fuera del atributo ni inyecta HTML', async () => {
    const owner = await makeUser();
    const business = await makeBusiness(owner._id, {
      name: `Pizza" onmouseover="alert(1)<script>alert(2)</script>`,
    });

    const res = await request(app).get(`/negocio/${business.slug}`);

    expect(res.status).toBe(200);
    expect(res.text).not.toContain('<script>alert(2)</script>');
    expect(res.text).not.toContain('onmouseover="alert(1)"');
  });

  it('404 con una página amable en un slug que no existe', async () => {
    const res = await request(app).get('/negocio/no-existe-esto');

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('No encontramos este negocio');
  });

  it('404 en un negocio que nunca se aprobó', async () => {
    const owner = await makeUser();
    const business = await makeBusiness(owner._id, { isApproved: false });

    const res = await request(app).get(`/negocio/${business.slug}`);

    expect(res.status).toBe(404);
  });

  it('sin logo ni portada, no manda una og:image rota', async () => {
    const owner = await makeUser();
    const business = await makeBusiness(owner._id);

    const res = await request(app).get(`/negocio/${business.slug}`);

    expect(res.text).not.toContain('og:image');
  });
});
