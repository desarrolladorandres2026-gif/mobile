import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../app';
import { PromotionBanner } from '../models';
import { UserRole } from '../types';
import { makeUser, authHeader, makeBusiness } from './factories';

const BASE = '/api/v1/promotion-banners';
const hourFromNow = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

function bannerBody(overrides: Record<string, unknown> = {}) {
  return {
    imageUrl: 'https://res.cloudinary.com/demo/image/upload/sample.jpg',
    title: 'Dos por uno en hamburguesas',
    description: 'Solo hoy en Burger House',
    buttonText: 'Ver ahora',
    actionType: 'none',
    startDate: hourFromNow(-1),
    endDate: hourFromNow(24),
    isActive: true,
    durationSeconds: 5,
    placement: 'home',
    ...overrides,
  };
}

async function createBanner(admin: Awaited<ReturnType<typeof makeUser>>, overrides = {}) {
  const res = await request(app).post(BASE).set(await authHeader(admin)).send(bannerBody(overrides));
  expect(res.status).toBe(201);
  return res.body.data;
}

describe('Banners de inicio — autorización', () => {
  it('solo un administrador puede crear un banner', async () => {
    await request(app).post(BASE).send(bannerBody()).expect(401);

    const client = await makeUser({ role: UserRole.CLIENT });
    await request(app).post(BASE).set(await authHeader(client)).send(bannerBody()).expect(403);
  });

  it('un cliente no puede activar, editar, reordenar ni eliminar', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    const client = await makeUser({ role: UserRole.CLIENT });
    const banner = await createBanner(admin);

    await request(app).patch(`${BASE}/${banner._id}/toggle`).set(await authHeader(client)).expect(403);
    await request(app).patch(`${BASE}/${banner._id}`).set(await authHeader(client)).send({ isActive: false }).expect(403);
    await request(app).patch(`${BASE}/reorder`).set(await authHeader(client)).send({ ids: [banner._id] }).expect(403);
    await request(app).delete(`${BASE}/${banner._id}`).set(await authHeader(client)).expect(403);

    // Y nada cambió.
    const stored = await PromotionBanner.findById(banner._id);
    expect(stored!.isActive).toBe(true);
  });

  it('el listado completo y las opciones del formulario son solo para el admin', async () => {
    const client = await makeUser({ role: UserRole.CLIENT });
    await request(app).get(BASE).set(await authHeader(client)).expect(403);
    await request(app).get(`${BASE}/options`).set(await authHeader(client)).expect(403);
  });
});

describe('Banners de inicio — endpoint público de la app', () => {
  it('devuelve el banner vigente sin filtrar campos internos', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    await createBanner(admin);

    const res = await request(app).get(`${BASE}/active`).expect(200);

    expect(res.body.data).toHaveLength(1);
    const [banner] = res.body.data;
    expect(banner.title).toBe('Dos por uno en hamburguesas');
    expect(banner.durationSeconds).toBe(5);
    // La app no recibe nada con lo que pudiera re-decidir si el banner va.
    expect(banner.isActive).toBeUndefined();
    expect(banner.startDate).toBeUndefined();
    expect(banner.endDate).toBeUndefined();
    expect(banner.priority).toBeUndefined();
    expect(banner.displayOrder).toBeUndefined();
  });

  it('sin banners activos devuelve una lista vacía, no un error', async () => {
    const res = await request(app).get(`${BASE}/active`).expect(200);
    expect(res.body.data).toEqual([]);
  });

  it('ignora un banner programado a futuro', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    await createBanner(admin, { startDate: hourFromNow(2), endDate: hourFromNow(48) });

    const res = await request(app).get(`${BASE}/active`).expect(200);
    expect(res.body.data).toEqual([]);
  });

  it('ignora un banner vencido', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    await createBanner(admin, { startDate: hourFromNow(-48), endDate: hourFromNow(-1) });

    const res = await request(app).get(`${BASE}/active`).expect(200);
    expect(res.body.data).toEqual([]);
  });

  it('un banner desactivado deja de llegar a la app de inmediato', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    const banner = await createBanner(admin);

    await request(app).patch(`${BASE}/${banner._id}/toggle`).set(await authHeader(admin)).expect(200);

    const res = await request(app).get(`${BASE}/active`).expect(200);
    expect(res.body.data).toEqual([]);
  });

  it('un banner eliminado deja de llegar a la app', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    const banner = await createBanner(admin);

    await request(app).delete(`${BASE}/${banner._id}`).set(await authHeader(admin)).expect(200);

    const res = await request(app).get(`${BASE}/active`).expect(200);
    expect(res.body.data).toEqual([]);
  });

  it('respeta el orden de aparición y desempata por prioridad', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    await createBanner(admin, { title: 'Tercero', displayOrder: 2 });
    await createBanner(admin, { title: 'Primero', displayOrder: 0 });
    await createBanner(admin, { title: 'Segundo A', displayOrder: 1, priority: 10 });
    await createBanner(admin, { title: 'Segundo B', displayOrder: 1, priority: 90 });

    const res = await request(app).get(`${BASE}/active`).expect(200);
    expect(res.body.data.map((b: { title: string }) => b.title)).toEqual([
      'Primero', 'Segundo B', 'Segundo A', 'Tercero',
    ]);
  });

  it('un banner marcado "solo pantalla inicial" no sale en otra superficie', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    await createBanner(admin, { title: 'Solo inicio', placement: 'home' });
    await createBanner(admin, { title: 'Toda la app', placement: 'all' });

    const home = await request(app).get(`${BASE}/active?placement=home`).expect(200);
    expect(home.body.data.map((b: { title: string }) => b.title).sort()).toEqual([
      'Solo inicio', 'Toda la app',
    ]);

    const everywhere = await request(app).get(`${BASE}/active?placement=all`).expect(200);
    expect(everywhere.body.data.map((b: { title: string }) => b.title)).toEqual(['Toda la app']);
  });
});

describe('Banners de inicio — validación del destino', () => {
  it('rechaza un enlace externo que no sea http/https', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    await request(app)
      .post(BASE)
      .set(await authHeader(admin))
      .send(bannerBody({ actionType: 'url', actionValue: 'javascript:alert(1)' }))
      .expect(400);
  });

  it('rechaza una pantalla interna que no está en la lista blanca', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    await request(app)
      .post(BASE)
      .set(await authHeader(admin))
      .send(bannerBody({ actionType: 'screen', actionValue: 'checkout' }))
      .expect(400);

    await request(app)
      .post(BASE)
      .set(await authHeader(admin))
      .send(bannerBody({ actionType: 'screen', actionValue: 'rewards' }))
      .expect(400);

    await request(app)
      .post(BASE)
      .set(await authHeader(admin))
      .send(bannerBody({ actionType: 'screen', actionValue: 'offers' }))
      .expect(201);
  });

  it('acepta un término de búsqueda y rechaza uno vacío o demasiado largo', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    const banner = await createBanner(admin, { actionType: 'search', actionValue: 'pizza' });
    expect(banner.actionType).toBe('search');

    await request(app)
      .post(BASE)
      .set(await authHeader(admin))
      .send(bannerBody({ actionType: 'search', actionValue: ' ' }))
      .expect(400);

    await request(app)
      .post(BASE)
      .set(await authHeader(admin))
      .send(bannerBody({ actionType: 'search', actionValue: 'x'.repeat(61) }))
      .expect(400);
  });

  it('rechaza un negocio de destino que no existe', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    await request(app)
      .post(BASE)
      .set(await authHeader(admin))
      .send(bannerBody({ actionType: 'business', actionValue: '507f1f77bcf86cd799439011' }))
      .expect(400);
  });

  it('acepta un negocio de destino que sí existe', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id);

    const res = await request(app)
      .post(BASE)
      .set(await authHeader(admin))
      .send(bannerBody({ actionType: 'business', actionValue: business._id.toString() }))
      .expect(201);

    expect(res.body.data.actionValue).toBe(business._id.toString());
  });

  it('rechaza una fecha de fin anterior a la de inicio, también al editar solo el inicio', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    await request(app)
      .post(BASE)
      .set(await authHeader(admin))
      .send(bannerBody({ startDate: hourFromNow(10), endDate: hourFromNow(2) }))
      .expect(400);

    const banner = await createBanner(admin);
    await request(app)
      .patch(`${BASE}/${banner._id}`)
      .set(await authHeader(admin))
      .send({ startDate: hourFromNow(48) })
      .expect(400);
  });

  it('rechaza una duración fuera de los topes que valida el servidor', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    await request(app).post(BASE).set(await authHeader(admin)).send(bannerBody({ durationSeconds: 1 })).expect(400);
    await request(app).post(BASE).set(await authHeader(admin)).send(bannerBody({ durationSeconds: 120 })).expect(400);
  });
});

describe('Banners de inicio — administración', () => {
  it('un banner nuevo se agrega al final del carrusel', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    const first = await createBanner(admin, { title: 'Uno' });
    const second = await createBanner(admin, { title: 'Dos' });

    expect(first.displayOrder).toBe(0);
    expect(second.displayOrder).toBe(1);
  });

  it('reordenar reescribe las posiciones y la app lo ve en el mismo orden', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    const a = await createBanner(admin, { title: 'A' });
    const b = await createBanner(admin, { title: 'B' });
    const c = await createBanner(admin, { title: 'C' });

    await request(app)
      .patch(`${BASE}/reorder`)
      .set(await authHeader(admin))
      .send({ ids: [c._id, a._id, b._id] })
      .expect(200);

    const res = await request(app).get(`${BASE}/active`).expect(200);
    expect(res.body.data.map((x: { title: string }) => x.title)).toEqual(['C', 'A', 'B']);
  });

  it('reordenar con un banner que ya no existe no aplica nada', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    const a = await createBanner(admin, { title: 'A' });
    const b = await createBanner(admin, { title: 'B' });

    await request(app)
      .patch(`${BASE}/reorder`)
      .set(await authHeader(admin))
      .send({ ids: [b._id, a._id, '507f1f77bcf86cd799439011'] })
      .expect(400);

    const stored = await PromotionBanner.findById(a._id);
    expect(stored!.displayOrder).toBe(0);
  });

  it('el listado del panel trae el estado calculado de cada banner', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    await createBanner(admin, { title: 'Vigente' });
    await createBanner(admin, { title: 'Vencido', startDate: hourFromNow(-48), endDate: hourFromNow(-2) });
    await createBanner(admin, { title: 'Programado', startDate: hourFromNow(5), endDate: hourFromNow(48) });

    const res = await request(app).get(BASE).set(await authHeader(admin)).expect(200);
    const byTitle = Object.fromEntries(
      res.body.data.map((b: { title: string; status: string }) => [b.title, b.status])
    );
    expect(byTitle).toEqual({ Vigente: 'active', Vencido: 'expired', Programado: 'scheduled' });
  });

  it('las opciones del formulario salen del backend, no del panel', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    const res = await request(app).get(`${BASE}/options`).set(await authHeader(admin)).expect(200);

    const screenKeys = res.body.data.screens.map((s: { key: string }) => s.key);
    expect(screenKeys).toContain('offers');
    expect(screenKeys).not.toContain('rewards');
    expect(res.body.data.categories).toContain('restaurant');
    expect(res.body.data.duration.max).toBeGreaterThan(res.body.data.duration.min);
  });
});
