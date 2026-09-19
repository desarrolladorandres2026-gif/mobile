import { describe, it, expect, vi, afterEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { cache, CachePrefix } from '../cache';
import { MemoryStore } from '../cache/memoryStore';
import { Business, Category, Product, Zone, Role } from '../models';
import { UserRole } from '../types';
import { makeUser, makeBusiness, makeProduct, makePricingConfig, authHeader } from './factories';

/**
 * La caché de lecturas.
 *
 * Lo que se fija aquí no es "que sea rápida" sino las promesas que la hacen
 * segura de tener: una escritura se ve en la siguiente lectura, un almacén
 * caído no rompe nada, y quien lee nunca recibe un objeto compartido.
 */

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('cache.wrap', () => {
  it('calcula una vez y sirve el resto de la caché', async () => {
    const fn = vi.fn(async () => ({ n: 1 }));
    expect(await cache.wrap('t:a', 60, fn)).toEqual({ n: 1 });
    expect(await cache.wrap('t:a', 60, fn)).toEqual({ n: 1 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('cien lecturas simultáneas de la misma clave hacen una sola consulta', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return { ok: true };
    };
    const results = await Promise.all(Array.from({ length: 100 }, () => cache.wrap('t:flight', 60, fn)));
    expect(calls).toBe(1);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('cada llamada recibe su propia copia: mutarla no toca la de otro', async () => {
    const a = await cache.wrap('t:copy', 60, async () => ({ list: [1, 2] }));
    a.list.push(3);
    const b = await cache.wrap('t:copy', 60, async () => ({ list: [9] }));
    expect(b.list).toEqual([1, 2]);
  });

  it('devuelve JSON plano también en el primer cálculo (fechas como texto, ids como texto)', async () => {
    const date = new Date('2026-01-01T00:00:00.000Z');
    const value = await cache.wrap('t:plain', 60, async () => ({ date }));
    expect(value.date).toBe('2026-01-01T00:00:00.000Z');
  });

  it('una invalidación durante el cálculo impide guardar el valor ya viejo', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const reading = new Promise<void>((r) => (started = r));
    const slow = cache.wrap('t:race:x', 60, async () => {
      started(); // ya leyó "de la base": lo que devuelva es de antes de la escritura
      await gate;
      return { version: 'vieja' };
    });
    await reading;
    await cache.delByPrefix('t:race:');
    release();
    expect(await slow).toEqual({ version: 'vieja' });

    const fresh = vi.fn(async () => ({ version: 'nueva' }));
    expect(await cache.wrap('t:race:x', 60, fresh)).toEqual({ version: 'nueva' });
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it('delByPrefix borra solo lo que empieza por el prefijo', async () => {
    await cache.set('t:p:1', 1, 60);
    await cache.set('t:p:2', 2, 60);
    await cache.set('t:q:1', 3, 60);
    await cache.delByPrefix('t:p:');
    expect(await cache.get('t:p:1')).toBeUndefined();
    expect(await cache.get('t:p:2')).toBeUndefined();
    expect(await cache.get('t:q:1')).toBe(3);
  });

  it('si el almacén falla, la lectura sigue funcionando contra la fuente', async () => {
    vi.spyOn(MemoryStore.prototype, 'get').mockRejectedValue(new Error('redis caído'));
    vi.spyOn(MemoryStore.prototype, 'set').mockRejectedValue(new Error('redis caído'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fn = vi.fn(async () => ({ from: 'mongo' }));
    expect(await cache.wrap('t:down', 60, fn)).toEqual({ from: 'mongo' });
    expect(await cache.wrap('t:down', 60, fn)).toEqual({ from: 'mongo' });
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('MemoryStore', () => {
  it('caduca por TTL', async () => {
    vi.useFakeTimers();
    const store = new MemoryStore(10);
    await store.set('k', 'v', 5);
    expect(await store.get('k')).toBe('v');
    vi.advanceTimersByTime(5_001);
    expect(await store.get('k')).toBeNull();
  });

  it('al llenarse saca lo que lleva más tiempo sin usarse', async () => {
    const store = new MemoryStore(2);
    await store.set('a', '1', 60);
    await store.set('b', '2', 60);
    await store.get('a'); // "a" pasa a ser la más reciente
    await store.set('c', '3', 60);
    expect(await store.get('a')).toBe('1');
    expect(await store.get('b')).toBeNull();
    expect(await store.get('c')).toBe('3');
  });
});

describe('Invalidación de punta a punta', () => {
  async function scenario() {
    await makePricingConfig();
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id, { name: 'Antes' });
    const product = await makeProduct(business._id, { name: 'Perro sencillo' });
    return { owner, business, product };
  }

  it('la carta refleja un producto nuevo en la siguiente lectura', async () => {
    const { business } = await scenario();
    const first = await request(app).get(`/api/v1/products/business/${business._id}`);
    expect(first.body.data).toHaveLength(1);

    await makeProduct(business._id, { name: 'Perro especial' });

    const second = await request(app).get(`/api/v1/products/business/${business._id}`);
    expect(second.body.data.map((p: any) => p.name).sort()).toEqual(['Perro especial', 'Perro sencillo']);
  });

  it('apagar un producto con updateOne lo saca de la carta cacheada', async () => {
    const { business, product } = await scenario();
    await request(app).get(`/api/v1/products/business/${business._id}`);

    await Product.updateOne({ _id: product._id }, { isAvailable: false });

    const res = await request(app).get(`/api/v1/products/business/${business._id}`);
    expect(res.body.data).toHaveLength(0);
  });

  it('la ficha refleja un cambio de nombre hecho con save()', async () => {
    const { business } = await scenario();
    const first = await request(app).get(`/api/v1/businesses/${business._id}`);
    expect(first.body.data.name).toBe('Antes');

    const doc = await Business.findById(business._id);
    doc!.name = 'Después';
    await doc!.save();

    const second = await request(app).get(`/api/v1/businesses/${business._id}`);
    expect(second.body.data.name).toBe('Después');
  });

  it('las secciones de un negocio se invalidan al crear una categoría', async () => {
    const { business } = await scenario();
    const first = await request(app).get(`/api/v1/categories/business/${business._id}`);
    const before = first.body.data.length;

    await Category.create({ businessId: business._id, name: 'Bebidas', sortOrder: 9 });

    const second = await request(app).get(`/api/v1/categories/business/${business._id}`);
    expect(second.body.data).toHaveLength(before + 1);
  });

  it('una zona nueva limpia las fichas (el "Desde $X" sale de las zonas)', async () => {
    const { business } = await scenario();
    await request(app).get(`/api/v1/businesses/${business._id}`);
    expect(await cache.get(`${CachePrefix.business(business._id)}detail`)).toBeDefined();

    await Zone.create({
      name: 'Centro',
      city: 'Garzón',
      area: {
        type: 'Polygon',
        coordinates: [[[-75.7, 2.1], [-75.5, 2.1], [-75.5, 2.3], [-75.7, 2.3], [-75.7, 2.1]]],
      },
      isActive: true,
    } as any);

    expect(await cache.get(`${CachePrefix.business(business._id)}detail`)).toBeUndefined();
  });

  it('la ficha ya no trae la carta embebida', async () => {
    const { business } = await scenario();
    const res = await request(app).get(`/api/v1/businesses/${business._id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.products).toBeUndefined();
    expect(res.headers['cache-control']).toBe('public, no-cache');
  });

  it('el panel del comercio (includeUnavailable) nunca sale de caché', async () => {
    const { business, product } = await scenario();
    await Product.updateOne({ _id: product._id }, { isAvailable: false });
    const res = await request(app).get(`/api/v1/products/business/${business._id}?includeUnavailable=true`);
    expect(res.body.data).toHaveLength(1);
    expect(res.headers['cache-control']).toBe('private, no-store');
  });

  it('editar un rol limpia los permisos cacheados', async () => {
    await cache.set(`${CachePrefix.AUTHZ}-:x`, [{ slug: 'x', permissions: [] }], 60);
    await Role.create({ name: 'Soporte', slug: 'soporte_test', permissions: [] } as any);
    expect(await cache.get(`${CachePrefix.AUTHZ}-:x`)).toBeUndefined();
  });
});

describe('GET /businesses/:id/storefront', () => {
  it('devuelve la tienda completa en una sola petición', async () => {
    await makePricingConfig();
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id);
    await makeProduct(business._id, { name: 'Salchipapa' });
    await makeProduct(business._id, { name: 'Apagado', isAvailable: false });

    const res = await request(app).get(`/api/v1/businesses/${business._id}/storefront`);

    expect(res.status).toBe(200);
    expect(res.body.data.business._id).toBe(String(business._id));
    expect(res.body.data.business).toHaveProperty('deliveryFeeFrom');
    expect(res.body.data.products.map((p: any) => p.name)).toEqual(['Salchipapa']);
    expect(Array.isArray(res.body.data.categories)).toBe(true);
    expect(Array.isArray(res.body.data.topSellers)).toBe(true);
    expect(res.body.data.sentiment).toBeDefined();
  });

  it('responde 404 con un negocio que no existe', async () => {
    const res = await request(app).get('/api/v1/businesses/64b000000000000000000000/storefront');
    expect(res.status).toBe(404);
  });

  it('la ficha de /storefront y la de /businesses/:id son la misma entrada de caché', async () => {
    await makePricingConfig();
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id);
    await request(app).get(`/api/v1/businesses/${business._id}/storefront`);

    const spy = vi.spyOn(Business, 'findById');
    await request(app).get(`/api/v1/businesses/${business._id}`);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('Autenticación con la caché de permisos', () => {
  it('quitarle un permiso a un rol se aplica en la siguiente petición', async () => {
    const role = await Role.create({
      name: 'Operador',
      slug: 'operador_test',
      permissions: ['orders:view_all'],
    } as any);
    const staff = await makeUser({ role: UserRole.ADMIN } as any);
    await (await import('../models')).User.updateOne({ _id: staff._id }, { roleIds: [role._id] });
    const headers = await authHeader(staff as any);

    const first = await request(app).get('/api/v1/auth/me').set(headers);
    expect(first.status).toBe(200);
    const key = `${CachePrefix.AUTHZ}-:${String(role._id)}`;
    expect(await cache.get(key)).toBeDefined();

    await Role.updateOne({ _id: role._id }, { permissions: [] });
    expect(await cache.get(key)).toBeUndefined();
  });
});
