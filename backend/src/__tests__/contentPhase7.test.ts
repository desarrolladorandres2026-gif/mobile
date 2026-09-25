import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { CuratedHomeBlock, DiscoveryCollection, SearchLog, SearchRule } from '../models';
import { UserRole } from '../types';
import { searchService } from '../services/search.service';
import { searchDictionaryService } from '../services/searchDictionary.service';
import { homeSectionsService } from '../services/homeSections.service';
import { featureFlagService } from '../services/featureFlag.service';
import { cache } from '../cache';
import { authHeader, makeBusiness, makeProduct, makeStaff, makeUser } from './factories';

const RULES = '/api/v1/search/rules';

async function seed() {
  const owner = await makeUser({ role: UserRole.BUSINESS });
  const pizzeria = await makeBusiness(owner._id, { name: 'Pizzería del Centro' });
  await makeProduct(pizzeria._id, { name: 'Pechuga apanada' });
  searchDictionaryService.invalidate();
  return { owner, pizzeria };
}

describe('Fase 7 · Contenido', () => {
  beforeEach(async () => {
    await featureFlagService.upsert('rbac_enforce', { audience: 'staff' });
    await cache.flush();
  });

  describe('Reglas de búsqueda', () => {
    it('un sinónimo solo entra cuando la búsqueda vendría vacía', async () => {
      await seed();
      const admin = await authHeader(await makeStaff({ roleSlug: 'super_admin' }));
      await request(app).put(RULES).set(admin).send({ term: 'Milanesa', kind: 'synonym', synonymOf: 'pechuga apanada' }).expect(200);

      const hit = await searchService.search('milanesa');
      expect(hit.strategy).toBe('synonym');
      expect(hit.suggestedTerm).toBe('pechuga apanada');
      expect(hit.products.length).toBeGreaterThan(0);

      // Si el término literal ya devuelve algo, la regla no pisa el resultado.
      const literal = await searchService.search('pechuga');
      expect(literal.strategy).not.toBe('synonym');
    });

    it('rechaza un sinónimo cuyo destino tampoco devuelve nada, o que apunta a sí mismo', async () => {
      await seed();
      const admin = await authHeader(await makeStaff({ roleSlug: 'super_admin' }));
      await request(app).put(RULES).set(admin).send({ term: 'sushi', kind: 'synonym', synonymOf: 'ramen' }).expect(400);
      await request(app).put(RULES).set(admin).send({ term: 'sushi', kind: 'synonym', synonymOf: 'Sushi' }).expect(400);
    });

    it('una redirección viaja solo con resultados vacíos', async () => {
      const { pizzeria } = await seed();
      const admin = await authHeader(await makeStaff({ roleSlug: 'super_admin' }));
      await request(app).put(RULES).set(admin).send({ term: 'sushi', kind: 'redirect', redirect: { kind: 'category', category: 'restaurant' } }).expect(200);
      await request(app).put(RULES).set(admin).send({ term: 'lasaña', kind: 'redirect', redirect: { kind: 'business', businessId: String(pizzeria._id) } }).expect(200);

      const empty = await searchService.search('sushi');
      expect(empty.redirect).toEqual({ kind: 'category', category: 'restaurant' });
      const biz = await searchService.search('lasana');
      expect(biz.redirect).toMatchObject({ kind: 'business', businessId: String(pizzeria._id), label: 'Pizzería del Centro' });
      const found = await searchService.search('pechuga');
      expect(found.redirect).toBeUndefined();
    });

    it('valida categoría y negocio de la redirección', async () => {
      await seed();
      const admin = await authHeader(await makeStaff({ roleSlug: 'super_admin' }));
      await request(app).put(RULES).set(admin).send({ term: 'sushi', kind: 'redirect', redirect: { kind: 'category', category: 'inventada' } }).expect(400);
      await request(app).put(RULES).set(admin).send({ term: 'sushi', kind: 'redirect', redirect: { kind: 'business', businessId: '507f1f77bcf86cd799439011' } }).expect(404);
      await request(app).put(RULES).set(admin).send({ term: 'sushi', kind: 'redirect' }).expect(400);
      await request(app).put(RULES).set(admin).send({ term: 'sushi', kind: 'otra' }).expect(400);
    });

    it('"atendido" saca el término de las búsquedas sin resultado, y la regla se puede quitar', async () => {
      await seed();
      const admin = await authHeader(await makeStaff({ roleSlug: 'super_admin' }));
      await SearchLog.create([
        { termRaw: 'Sushi', term: 'sushi', resultCount: 0 },
        { termRaw: 'sushi', term: 'sushi', resultCount: 0 },
        { termRaw: 'tamales', term: 'tamales', resultCount: 0 },
      ]);

      const before = await searchService.insights();
      expect(before.empty.map((e) => e.key).sort()).toEqual(['sushi', 'tamales']);
      expect(before.empty.find((e) => e.key === 'sushi')!.count).toBe(2);

      const saved = await request(app).put(RULES).set(admin).send({ term: 'Sushi', kind: 'handled', note: 'Ya hablé con un local' }).expect(200);
      const after = await searchService.insights();
      expect(after.empty.map((e) => e.key)).toEqual(['tamales']);

      await request(app).delete(`${RULES}/${saved.body.data._id}`).set(admin).expect(200);
      expect((await searchService.insights()).empty).toHaveLength(2);
      await request(app).delete(`${RULES}/${saved.body.data._id}`).set(admin).expect(404);
      expect(await SearchRule.countDocuments()).toBe(0);
    });

    it('escribir exige content:manage; leer, content:view', async () => {
      await seed();
      const soporte = await authHeader(await makeStaff({ roleSlug: 'soporte' }));
      const contenido = await authHeader(await makeStaff({ roleSlug: 'comercios_contenido' }));
      await request(app).get(RULES).set(soporte).expect(403);
      await request(app).put(RULES).set(soporte).send({ term: 'sushi', kind: 'handled' }).expect(403);
      await request(app).get(RULES).set(contenido).expect(200);
    });
  });

  describe('Bloques curados: franja y día', () => {
    const NOW = new Date('2026-09-25T15:00:00-05:00'); // viernes, tarde en Bogotá

    beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
    afterEach(() => { vi.useRealTimers(); });

    let items: Array<{ _id: unknown }>;
    beforeEach(async () => {
      const owner = await makeUser({ role: UserRole.BUSINESS });
      items = await Promise.all([1, 2, 3].map((n) => makeBusiness(owner._id, { name: `Negocio ${n}` })));
    });

    async function block(extra: Record<string, unknown>) {
      return CuratedHomeBlock.create({
        kind: 'businessBanner', title: 'Antojo', items: items.map((b) => b._id), order: 5, ...extra,
      });
    }
    const titles = async () => {
      await cache.flush();
      const feed: any = await homeSectionsService.getHomeSections({});
      const list = Array.isArray(feed) ? feed : feed.sections ?? [];
      return list.map((s: any) => s.title);
    };

    it('respeta la franja y el día, en hora de Bogotá', async () => {
      await block({ title: 'Solo noche', dayparts: ['noche'] });
      await block({ title: 'Tarde', dayparts: ['tarde'] });
      await block({ title: 'Fin de semana', weekdays: [0, 6] });
      await block({ title: 'Viernes tarde', weekdays: [5], dayparts: ['tarde'] });
      await block({ title: 'Siempre' });

      const shown = await titles();
      expect(shown).toContain('Tarde');
      expect(shown).toContain('Viernes tarde');
      expect(shown).toContain('Siempre');
      expect(shown).not.toContain('Solo noche');
      expect(shown).not.toContain('Fin de semana');
    });

    it('guardar un bloque sin rango de fechas (null) ya no se rechaza', async () => {
      const admin = await authHeader(await makeStaff({ roleSlug: 'super_admin' }));
      const owner = await makeUser({ role: UserRole.BUSINESS });
      const items = await Promise.all([1, 2, 3].map((n) => makeBusiness(owner._id, { name: `N ${n}` })));
      const res = await request(app)
        .post('/api/v1/curated-home-blocks').set(admin)
        .send({ kind: 'businessBanner', title: 'Sin fechas', items: items.map((b) => String(b._id)), order: 10, startDate: null, endDate: null, dayparts: ['noche'], weekdays: [5, 6] })
        .expect(201);
      expect(res.body.data.dayparts).toEqual(['noche']);

      await request(app).patch(`/api/v1/curated-home-blocks/${res.body.data._id}`).set(admin).send({ dayparts: ['algo'] }).expect(400);
      await request(app).patch(`/api/v1/curated-home-blocks/${res.body.data._id}`).set(admin).send({ weekdays: [9] }).expect(400);
      const cleared = await request(app).patch(`/api/v1/curated-home-blocks/${res.body.data._id}`).set(admin).send({ dayparts: [], startDate: null }).expect(200);
      expect(cleared.body.data.dayparts).toEqual([]);
    });
  });

  describe('Orden del Inicio', () => {
    it('la colección automática gana el hueco sobre el bloque curado, y lo dice', async () => {
      const owner = await makeUser({ role: UserRole.BUSINESS });
      const items = await Promise.all([1, 2, 3].map((n) => makeBusiness(owner._id, { name: `Neg ${n}` })));
      await DiscoveryCollection.collection.insertOne({
        key: 'losMasPedidos', title: 'Los más pedidos', feed: 'home', order: 10, isActive: true, dayparts: [], weekdays: [],
      });
      await CuratedHomeBlock.create({ kind: 'businessBanner', title: 'Mi bloque', items: items.map((b) => b._id), order: 10 });
      await CuratedHomeBlock.create({ kind: 'businessBanner', title: 'Apagado', items: items.map((b) => b._id), order: 20, isActive: false });

      const admin = await authHeader(await makeStaff({ roleSlug: 'comercios_contenido' }));
      const res = await request(app).get('/api/v1/curated-home-blocks/order-map').set(admin).expect(200);
      const slots = res.body.data as Array<{ title: string; outranked: boolean; live: boolean; reason: string | null }>;
      expect(slots.map((s) => s.title)).toEqual(['Los más pedidos', 'Mi bloque', 'Apagado']);
      expect(slots[0].outranked).toBe(false);
      expect(slots[1].outranked).toBe(true);
      expect(slots[2]).toMatchObject({ live: false, reason: 'Desactivado' });

      const soporte = await authHeader(await makeStaff({ roleSlug: 'soporte' }));
      await request(app).get('/api/v1/curated-home-blocks/order-map').set(soporte).expect(403);
    });
  });
});
