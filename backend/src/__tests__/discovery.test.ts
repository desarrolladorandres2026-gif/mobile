import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { Types } from 'mongoose';
import app from '../app';
import { Business, DiscoveryCollection } from '../models';
import { UserRole } from '../types';
import {
  GARZON, makeUser, makeBusiness, makeProduct, makePricingConfig,
  makeDiscoveryCollections,
} from './factories';
import {
  compileRule, compileDSL, isEligibleNow, dailySeed, hash32,
  type CompileContext,
} from '../services/discovery.service';
import { daypartAt } from '../models';

const HOME_API = '/api/v1/home-sections';
const EXPLORE_API = '/api/v1/explore';

/** Abre el negocio las 24 horas, para que la hora a la que corra la prueba no importe. */
async function openAllDay(businessId: any) {
  const day = { open: '00:00', close: '23:59', isOpen: true };
  await Business.updateOne(
    { _id: businessId },
    { schedule: { monday: day, tuesday: day, wednesday: day, thursday: day, friday: day, saturday: day, sunday: day } }
  );
}

const ctx = (over: Partial<CompileContext> = {}): CompileContext => ({
  now: new Date('2026-09-20T15:00:00Z'),
  salesIds: {},
  fallbackKeywords: false,
  ...over,
});

/**
 * El compilador del lenguaje de reglas.
 *
 * Lo que se comprueba aquí no es que Mongo entienda el `$match`, sino la
 * única promesa que de verdad importa: **nada que venga del panel acaba
 * siendo una clave ni un operador**. Un administrador escribe operandos, no
 * consultas.
 */
describe('compileRule', () => {
  it('una regla por etiquetas consulta el campo indexado', () => {
    expect(compileRule({ source: 'tags', any: ['pizza', 'perro'] }, ctx()))
      .toEqual({ tags: { $in: ['pizza', 'perro'] } });
  });

  it('con respaldo activo añade la regex de palabras clave, sin perder el índice', () => {
    const compiled = compileRule(
      { source: 'tags', any: ['pizza'] },
      ctx({ fallbackKeywords: true })
    ) as any;

    expect(compiled.$or[0]).toEqual({ tags: { $in: ['pizza'] } });
    expect(compiled.$or[1].searchName.$regex).toContain('pizza');
  });

  it('un rango de precio abierto por un lado solo pone ese lado', () => {
    expect(compileRule({ source: 'price', max: 10000 }, ctx()))
      .toEqual({ effectivePrice: { $lte: 10000 } });
    expect(compileRule({ source: 'price', min: 35000 }, ctx()))
      .toEqual({ effectivePrice: { $gte: 35000 } });
  });

  it('"recién llegado" distingue el producto del negocio', () => {
    const producto = compileRule({ source: 'new', withinDays: 21, of: 'product' }, ctx()) as any;
    const negocio = compileRule({ source: 'new', withinDays: 30, of: 'business' }, ctx()) as any;

    expect(Object.keys(producto)).toEqual(['createdAt']);
    expect(Object.keys(negocio)).toEqual(['business.createdAt']);
  });

  it('sin ventas todavía, la regla no encuentra nada en vez de encontrarlo todo', () => {
    expect(compileRule({ source: 'sales', window: 'mostOrdered' }, ctx()))
      .toEqual({ _id: { $in: [] } });
  });

  it('las reglas que no filtran el catálogo devuelven null', () => {
    expect(compileRule({ source: 'nearby' }, ctx())).toBeNull();
    expect(compileRule({ source: 'personal', kind: 'neverTried' }, ctx())).toBeNull();
  });

  it('dos condiciones sobre el mismo campo no se pisan', () => {
    // Fusionar objetos perdería uno de los dos límites sin avisar: por eso
    // varias condiciones van siempre bajo un `$and` explícito.
    const compiled = compileDSL(
      { all: [{ source: 'price', max: 20000 }, { source: 'price', min: 5000 }], sortBy: 'price_asc' },
      ctx()
    ) as any;

    expect(compiled.$and).toHaveLength(2);
    expect(compiled.$and[0]).toEqual({ effectivePrice: { $lte: 20000 } });
    expect(compiled.$and[1]).toEqual({ effectivePrice: { $gte: 5000 } });
  });
});

describe('Elegibilidad por franja y fecha', () => {
  const base = { isActive: true, dayparts: [], weekdays: [], startDate: undefined, endDate: undefined };
  const now = new Date('2026-09-20T12:00:00Z'); // sábado

  it('sin franja declarada, entra a cualquier hora', () => {
    expect(isEligibleNow(base as any, now, 'madrugada')).toBe(true);
  });

  it('"Para empezar el día" no entra de noche', () => {
    const desayuno = { ...base, dayparts: ['manana'] };
    expect(isEligibleNow(desayuno as any, now, 'manana')).toBe(true);
    expect(isEligibleNow(desayuno as any, now, 'noche')).toBe(false);
  });

  it('una colección apagada no entra aunque su franja coincida', () => {
    expect(isEligibleNow({ ...base, isActive: false } as any, now, 'manana')).toBe(false);
  });

  it('respeta la ventana de fechas', () => {
    const futura = { ...base, startDate: new Date('2026-12-01T00:00:00Z') };
    const caducada = { ...base, endDate: new Date('2026-01-01T00:00:00Z') };
    expect(isEligibleNow(futura as any, now, 'tarde')).toBe(false);
    expect(isEligibleNow(caducada as any, now, 'tarde')).toBe(false);
  });
});

describe('Rotación', () => {
  it('la semilla es estable dentro del mismo día y franja', () => {
    const now = new Date('2026-09-20T15:00:00Z');
    expect(dailySeed('u1', 'tarde', now)).toBe(dailySeed('u1', 'tarde', now));
  });

  it('cambia de persona a persona y de franja a franja', () => {
    const now = new Date('2026-09-20T15:00:00Z');
    expect(dailySeed('u1', 'tarde', now)).not.toBe(dailySeed('u2', 'tarde', now));
    expect(dailySeed('u1', 'tarde', now)).not.toBe(dailySeed('u1', 'noche', now));
  });

  it('el hash no se desborda ni devuelve negativos', () => {
    for (const input of ['', 'a', 'una clave razonablemente larga:2026-09-20:tarde']) {
      const h = hash32(input);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe('daypartAt', () => {
  it('corta el día en cuatro, en hora de Bogotá', () => {
    // 13:00 UTC = 08:00 en Bogotá. Si esto se calculara con la hora local
    // del proceso, en un servidor en UTC daría "tarde".
    expect(daypartAt(new Date('2026-09-20T13:00:00Z'))).toBe('manana');
    expect(daypartAt(new Date('2026-09-20T20:00:00Z'))).toBe('tarde');
    expect(daypartAt(new Date('2026-09-21T01:00:00Z'))).toBe('noche');
    expect(daypartAt(new Date('2026-09-21T07:00:00Z'))).toBe('madrugada');
  });
});

/**
 * El reparto entre las dos pantallas.
 *
 * Es la garantía que sostiene el rediseño: Inicio se queda con lo justo para
 * quien ya sabe qué quiere, y el grueso del descubrimiento se muda a
 * Explorar. Si una colección apareciera en los dos, el usuario vería lo
 * mismo dos veces y Explorar se sentiría redundante.
 */
describe('Reparto entre Inicio y Explorar', () => {
  let owner: any;

  beforeEach(async () => {
    await makePricingConfig();
    await makeDiscoveryCollections();
    owner = await makeUser({ role: UserRole.BUSINESS });
  });

  async function seedCatalog(count = 12) {
    const business = await makeBusiness(owner._id, { isApproved: true, isActive: true });
    await openAllDay(business._id);
    for (let i = 0; i < count; i++) {
      await makeProduct(business._id, {
        name: `Pizza ${i}`,
        price: 20000,
        discountPrice: 10000,
      });
    }
    return business;
  }

  it('ninguna colección aparece en los dos feeds', async () => {
    await seedCatalog();

    const [home, explore] = await Promise.all([
      request(app).get(HOME_API).expect(200),
      request(app).get(EXPLORE_API).expect(200),
    ]);

    const homeKeys = home.body.data
      .filter((e: any) => e.kind === 'collection')
      .map((e: any) => e.key);
    const exploreKeys = explore.body.data.entries
      .filter((e: any) => e.kind === 'collection')
      .map((e: any) => e.key);

    expect(homeKeys.length).toBeGreaterThan(0);
    expect(homeKeys.filter((k: string) => exploreKeys.includes(k))).toEqual([]);
  });

  it('Inicio se queda corto a propósito: menos colecciones que Explorar', async () => {
    await seedCatalog();

    const [home, explore] = await Promise.all([
      request(app).get(HOME_API).expect(200),
      request(app).get(EXPLORE_API).expect(200),
    ]);

    const homeCount = home.body.data.filter((e: any) => e.kind === 'collection').length;
    const exploreCount = explore.body.data.entries.filter((e: any) => e.kind === 'collection').length;

    expect(exploreCount).toBeGreaterThan(homeCount);
  });

  it('Explorar dice en qué franja se armó el feed', async () => {
    await seedCatalog();
    const res = await request(app).get(EXPLORE_API).expect(200);

    expect(['madrugada', 'manana', 'tarde', 'noche']).toContain(res.body.data.daypart);
    expect(res.body.data.personalized).toBe(false);
  });

  it('no se cachea en proxies compartidos: el feed puede llevar datos de quien mira', async () => {
    await seedCatalog();
    const res = await request(app).get(EXPLORE_API).expect(200);

    expect(res.headers['cache-control']).toContain('private');
    expect(res.headers['cache-control']).not.toContain('public');
  });

  it('una colección desactivada desde el panel desaparece del feed', async () => {
    await seedCatalog();

    await DiscoveryCollection.updateOne({ key: 'descuentosLocos' }, { isActive: false });

    const res = await request(app).get(HOME_API).expect(200);
    expect(res.body.data.find((e: any) => e.key === 'descuentosLocos')).toBeUndefined();
  });

  it('cambiar el título desde el panel se ve sin desplegar nada', async () => {
    await seedCatalog();

    await DiscoveryCollection.updateOne(
      { key: 'descuentosLocos' },
      { title: 'Rebajas de hoy' }
    );

    const res = await request(app).get(HOME_API).expect(200);
    const section = res.body.data.find((e: any) => e.key === 'descuentosLocos');
    expect(section?.title).toBe('Rebajas de hoy');
  });
});

/**
 * El tope de exposición por negocio.
 *
 * Es lo que faltaba: hasta ahora el contador solo miraba el producto, así
 * que un comercio con carta grande podía copar una sección entera. Los
 * propios tests antiguos lo esquivaban eligiendo categorías que no
 * colisionaran.
 */
describe('Presupuesto de exposición', () => {
  let owner: any;

  beforeEach(async () => {
    await makePricingConfig();
    await makeDiscoveryCollections();
    owner = await makeUser({ role: UserRole.BUSINESS });
  });

  it('un solo negocio no copa una sección entera', async () => {
    // Un comercio con carta grande y varios rivales con carta corta: sin
    // tope, la sección sería íntegramente del primero.
    const grande = await makeBusiness(owner._id, { name: 'Carta Grande', isApproved: true, isActive: true });
    await openAllDay(grande._id);
    for (let i = 0; i < 20; i++) {
      await makeProduct(grande._id, { name: `Pizza grande ${i}`, price: 30000, discountPrice: 9000 });
    }

    for (let b = 0; b < 4; b++) {
      const otro = await makeBusiness(owner._id, { name: `Vecino ${b}`, isApproved: true, isActive: true });
      await openAllDay(otro._id);
      await makeProduct(otro._id, { name: `Pizza vecina ${b}`, price: 30000, discountPrice: 9500 });
    }

    const res = await request(app).get(HOME_API).expect(200);
    const section = res.body.data.find((e: any) => e.key === 'descuentosLocos');

    expect(section).toBeDefined();
    const fromGrande = section.products.filter(
      (p: any) => String(p.businessId) === String(grande._id)
    );
    expect(fromGrande.length).toBeLessThanOrEqual(2);
  });

  it('con catálogo escaso prefiere repetir negocio antes que servir un feed vacío', async () => {
    // Garzón no es Bogotá. Con los topes puestos y un solo comercio, el
    // feed estricto se quedaría en nada; la segunda pasada los relaja.
    const unico = await makeBusiness(owner._id, { isApproved: true, isActive: true });
    await openAllDay(unico._id);
    for (let i = 0; i < 10; i++) {
      await makeProduct(unico._id, { name: `Pizza ${i}`, price: 20000, discountPrice: 8000 });
    }

    const res = await request(app).get(EXPLORE_API).expect(200);
    const collections = res.body.data.entries.filter((e: any) => e.kind === 'collection');

    expect(collections.length).toBeGreaterThan(0);
  });
});
