import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { SearchLog, Business, Product } from '../models';
import { UserRole } from '../types';
import { normalize, tokenize, editDistance } from '../utils/text';
import { searchDictionaryService } from '../services/searchDictionary.service';
import { searchService } from '../services/search.service';
import {
  GARZON, offsetKm, makeUser, makeBusiness, makeProduct, authHeader,
} from './factories';

const API = '/api/v1/search';

/** Un catálogo mínimo, pero con los casos que la búsqueda tiene que acertar. */
async function seedCatalog() {
  const owner = await makeUser({ role: UserRole.BUSINESS });

  const pizzeria = await makeBusiness(owner._id, { name: 'Pizzería del Centro' });
  const cafeteria = await makeBusiness(owner._id, { name: 'Café Bogotá' });

  await makeProduct(pizzeria._id, { name: 'Hamburguesa doble' });
  await makeProduct(pizzeria._id, { name: 'Pizza hawaiana' });

  // El diccionario de corrección se cachea diez minutos; sin invalidarlo,
  // una prueba que siembra y consulta al vuelo leería el de la anterior.
  searchDictionaryService.invalidate();

  return { owner, pizzeria, cafeteria };
}

describe('utilidades de texto', () => {
  it('normaliza tildes y mayúsculas, que es como la gente escribe en el móvil', () => {
    expect(normalize('Café Bogotá')).toBe('cafe bogota');
    expect(normalize('  PIZZERÍA   del  Centro ')).toBe('pizzeria del centro');
  });

  it('descarta las palabras de una y dos letras al partir un texto', () => {
    expect(tokenize('Arroz con pollo y papa')).toEqual(['arroz', 'con', 'pollo', 'papa']);
  });

  it('corta en cuanto se pasa del margen, sin calcular la distancia real', () => {
    // Devuelve `max + 1` para decir "no cabe", no la distancia exacta: al
    // que pregunta solo le interesa si entra en el umbral.
    expect(editDistance('hamburgesa', 'hamburguesa', 2)).toBe(1);
    expect(editDistance('pan', 'zanahoria', 2)).toBe(3);
  });
});

describe('GET /api/v1/search', () => {
  beforeEach(seedCatalog);

  it('encuentra un negocio por texto sin caer al respaldo por prefijo', async () => {
    const res = await request(app).get(API).query({ q: 'pizza' }).expect(200);

    expect(res.body.data.strategy).toBe('text');
    const names = res.body.data.businesses.map((b: any) => b.name);
    expect(names).toContain('Pizzería del Centro');
  });

  it('encuentra un negocio por su descripción cuando ni el nombre ni la carta dicen el término', async () => {
    // El caso real: "Carbón & Pan" no se llama "Hamburguesas" y su carta usa
    // nombres de autor ("Doble Smash") que nunca dicen la palabra. Solo la
    // descripción la tiene, y por eso tiene que estar en el índice de texto.
    const owner = await makeUser({ role: UserRole.BUSINESS });
    await makeBusiness(owner._id, {
      name: 'Carbón & Pan',
      description: 'Hamburguesas de carne madurada a la parrilla de carbón, en pan brioche.',
    });
    searchDictionaryService.invalidate();

    const res = await request(app).get(API).query({ q: 'hamburguesa' }).expect(200);

    expect(res.body.data.strategy).toBe('text');
    expect(res.body.data.businesses.map((b: any) => b.name)).toContain('Carbón & Pan');
  });

  it('encuentra un plato aunque ningún negocio se llame así', async () => {
    const res = await request(app).get(API).query({ q: 'hamburguesa' }).expect(200);

    const names = res.body.data.products.map((p: any) => p.name);
    expect(names).toContain('Hamburguesa doble');
  });

  it('encuentra "Café" escrito sin tilde', async () => {
    const res = await request(app).get(API).query({ q: 'cafe' }).expect(200);

    const names = res.body.data.businesses.map((b: any) => b.name);
    expect(names).toContain('Café Bogotá');
  });

  it('el índice en español ya casa por raíz, sin llegar al respaldo', async () => {
    // "pizzería" y "pizzer" comparten raíz para el stemmer español, así que
    // el índice de texto resuelve solo un término escrito a medias.
    const res = await request(app).get(API).query({ q: 'pizzer' }).expect(200);

    expect(res.body.data.strategy).toBe('text');
    expect(res.body.data.businesses.map((b: any) => b.name)).toContain('Pizzería del Centro');
  });

  it('responde a medio escribir cuando el corte cae dentro de la raíz', async () => {
    // Aquí el stemmer no ayuda: "hambur" no es la raíz de nada. Es el caso
    // que justifica el respaldo por prefijo, y el normal al ir escribiendo.
    const res = await request(app).get(API).query({ q: 'hambur' }).expect(200);

    expect(res.body.data.strategy).toBe('prefix');
    expect(res.body.data.products.map((p: any) => p.name)).toContain('Hamburguesa doble');
  });

  it('rescata un error de tipeo y dice que lo corrigió', async () => {
    const res = await request(app).get(API).query({ q: 'hamburgesa' }).expect(200);

    expect(res.body.data.strategy).toBe('corrected');
    expect(res.body.data.suggestedTerm).toBe('hamburguesa');
    expect(res.body.data.products.map((p: any) => p.name)).toContain('Hamburguesa doble');
  });

  it('no inventa correcciones para palabras cortas', async () => {
    // "pan" está a una edición de varias cosas, y ninguna es lo que pidieron.
    const corrected = await searchDictionaryService.correct('pan');
    expect(corrected).toBeNull();
  });

  it('nunca enseña un negocio sin aprobar, por ninguna de las tres vías', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    await makeBusiness(owner._id, { name: 'Sushi Oculto', isApproved: false });
    searchDictionaryService.invalidate();

    for (const q of ['sushi', 'sush', 'sushii']) {
      const res = await request(app).get(API).query({ q }).expect(200);
      const names = res.body.data.businesses.map((b: any) => b.name);
      expect(names).not.toContain('Sushi Oculto');
    }
  });
});

describe('búsqueda con ubicación', () => {
  it('adjunta la distancia y descarta lo que queda fuera del radio', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const lejos = offsetKm(GARZON, 40);

    await makeBusiness(owner._id, { name: 'Pizza Cerca' });
    await makeBusiness(owner._id, { name: 'Pizza Lejos', lat: lejos.lat, lng: lejos.lng });
    searchDictionaryService.invalidate();

    const res = await request(app)
      .get(API)
      .query({ q: 'pizza', lat: GARZON.lat, lng: GARZON.lng })
      .expect(200);

    const names = res.body.data.businesses.map((b: any) => b.name);
    expect(names).toContain('Pizza Cerca');
    expect(names).not.toContain('Pizza Lejos');

    const cerca = res.body.data.businesses.find((b: any) => b.name === 'Pizza Cerca');
    expect(cerca.distanceMeters).toBeGreaterThanOrEqual(0);
    expect(cerca.distanceMeters).toBeLessThan(1000);
  });

  it('sin coordenadas se comporta igual que antes, sin campo de distancia', async () => {
    await seedCatalog();

    const res = await request(app).get(API).query({ q: 'pizza' }).expect(200);
    expect(res.body.data.businesses[0].distanceMeters).toBeUndefined();
  });

  it('ordena por cercanía cuando se le pide', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const medio = offsetKm(GARZON, 3);

    await makeBusiness(owner._id, { name: 'Pizza Media', lat: medio.lat, lng: medio.lng });
    await makeBusiness(owner._id, { name: 'Pizza Pegada' });
    searchDictionaryService.invalidate();

    const res = await request(app)
      .get(API)
      .query({ q: 'pizza', lat: GARZON.lat, lng: GARZON.lng, sort: 'distance' })
      .expect(200);

    expect(res.body.data.businesses[0].name).toBe('Pizza Pegada');
  });
});

describe('paginación', () => {
  it('parte los resultados y avisa de si queda más', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    for (let i = 0; i < 5; i++) {
      await makeBusiness(owner._id, { name: `Pizza Número ${i}` });
    }
    searchDictionaryService.invalidate();

    const first = await request(app).get(API).query({ q: 'pizza', limit: 2 }).expect(200);
    expect(first.body.data.businesses).toHaveLength(2);
    expect(first.body.data.hasMore).toBe(true);

    const last = await request(app)
      .get(API)
      .query({ q: 'pizza', limit: 2, page: 3 })
      .expect(200);
    expect(last.body.data.hasMore).toBe(false);
    // Los platos son la cabecera de los resultados, no la lista infinita.
    expect(last.body.data.products).toHaveLength(0);
  });
});

describe('GET /api/v1/search/suggest', () => {
  beforeEach(seedCatalog);

  it('sugiere mientras se escribe, con negocios y platos', async () => {
    const res = await request(app).get(`${API}/suggest`).query({ q: 'piz' }).expect(200);

    const labels = res.body.data.map((s: any) => s.label);
    expect(labels).toContain('Pizzería del Centro');
    expect(labels).toContain('Pizza hawaiana');
  });

  it('un plato apunta a su negocio, porque el carrito necesita saber de dónde sale', async () => {
    const res = await request(app).get(`${API}/suggest`).query({ q: 'hambur' }).expect(200);

    const plato = res.body.data.find((s: any) => s.type === 'product');
    expect(plato.id).toBeTruthy();
    expect(plato.sublabel).toBe('Pizzería del Centro');
  });

  it('calla con una sola letra, que no distingue nada', async () => {
    const res = await request(app).get(`${API}/suggest`).query({ q: 'p' }).expect(200);
    expect(res.body.data).toEqual([]);
  });
});

describe('registro de búsquedas', () => {
  beforeEach(seedCatalog);

  it('registra sin exigir sesión, porque buscar es público', async () => {
    await request(app)
      .post(`${API}/log`)
      .send({ term: 'Pizza', resultCount: 3 })
      .expect(200);

    const logged = await SearchLog.findOne({ term: 'pizza' });
    expect(logged).toBeTruthy();
    expect(logged!.termRaw).toBe('Pizza');
    expect(logged!.userId).toBeNull();
  });

  it('rechaza lo que no es una búsqueda', async () => {
    await request(app).post(`${API}/log`).send({ term: 'pizza' }).expect(400);
  });
});

describe('lo más buscado', () => {
  it('cae a las categorías del catálogo mientras no haya volumen, con su nombre y sin conteo', async () => {
    await seedCatalog();

    const terms = await searchService.popularTerms();
    expect(terms.length).toBeGreaterThan(0);
    // Sin registro suficiente devuelve categorías, no términos escritos — y
    // las devuelve como se llaman, no con la clave cruda que guarda el
    // negocio, que es lo que la pantalla acababa anunciando.
    expect(terms.map((t) => t.term)).toContain('Comidas rápidas');
    expect(terms.map((t) => t.term)).not.toContain('fast_food');
    // Cero: ese conteo mediría negocios por categoría, no búsquedas.
    expect(terms.every((t) => t.count === 0)).toBe(true);
  });

  it('usa las búsquedas reales en cuanto las hay, con cuántas fueron', async () => {
    await seedCatalog();

    // Dos términos distintos repetidos, y un límite que ya se llena con ellos.
    for (let i = 0; i < 3; i++) {
      await searchService.logSearch({ term: 'hamburguesa', resultCount: 4 });
      await searchService.logSearch({ term: 'pizza', resultCount: 2 });
    }

    const terms = await searchService.popularTerms(2);
    expect(terms.map((t) => t.term)).toEqual(expect.arrayContaining(['hamburguesa', 'pizza']));
    expect(terms.every((t) => t.count === 3)).toBe(true);
  });

  it('no parte el mismo término por cómo se escribió, y devuelve una escritura real', async () => {
    await seedCatalog();

    // El mismo término con y sin tilde: es una sola búsqueda para la gente.
    await searchService.logSearch({ term: 'Café', resultCount: 3 });
    await searchService.logSearch({ term: 'cafe', resultCount: 3 });

    const terms = await searchService.popularTerms(1);
    expect(terms).toHaveLength(1);
    expect(terms[0].count).toBe(2);
    // Lo que se pinta es lo que alguien escribió, no el normalizado interno.
    expect(['Café', 'cafe']).toContain(terms[0].term);
  });
});

describe('GET /api/v1/search/insights', () => {
  it('separa lo que se encuentra de lo que no, y cierra a quien no es admin', async () => {
    await seedCatalog();

    await searchService.logSearch({ term: 'pizza', resultCount: 5 });
    await searchService.logSearch({ term: 'sushi', resultCount: 0 });
    await searchService.logSearch({ term: 'sushi', resultCount: 0 });

    const client = await makeUser({ role: UserRole.CLIENT });
    await request(app)
      .get(`${API}/insights`)
      .set(await authHeader(client))
      .expect(403);

    const admin = await makeUser({ role: UserRole.ADMIN });
    const res = await request(app)
      .get(`${API}/insights`)
      .set(await authHeader(admin))
      .expect(200);

    expect(res.body.data.top.map((r: any) => r.term)).toContain('pizza');

    // La lista que de verdad importa: qué se buscó y no había.
    const falta = res.body.data.empty.find((r: any) => r.term === 'sushi');
    expect(falta.count).toBe(2);
  });
});

describe('mantenimiento de searchName', () => {
  it('un documento anterior al cambio no se encuentra hasta que se rellena', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id, { name: 'Café Bogotá' });

    // Simula el catálogo sembrado antes de que el campo existiera.
    await Business.collection.updateOne({ _id: business._id }, { $unset: { searchName: '' } });
    expect(await Business.findOne({ searchName: { $regex: '^cafe' } })).toBeNull();

    // Lo que hace `npm run backfill:search-names`, en una fila.
    await Business.collection.updateOne(
      { _id: business._id },
      { $set: { searchName: normalize('Café Bogotá') } }
    );
    expect(await Business.findOne({ searchName: { $regex: '^cafe' } })).toBeTruthy();
  });

  it('renombrar desde el panel actualiza el índice de búsqueda', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id, { name: 'Pizza Vieja' });

    // `findOneAndUpdate` no carga el documento, así que no dispara el hook
    // de `save`. Sin su propio hook este negocio seguiría encontrándose por
    // "pizza" y nunca por su nombre nuevo, sin que nada pareciera roto.
    await Business.findOneAndUpdate({ _id: business._id }, { name: 'Sushi Nuevo' });

    expect(await Business.findOne({ searchName: { $regex: '^sushi' } })).toBeTruthy();
    expect(await Business.findOne({ searchName: { $regex: '^pizza' } })).toBeNull();
  });

  it('lo mismo al renombrar un producto', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id);
    const product = await makeProduct(business._id, { name: 'Empanada de Pollo' });

    await Product.findOneAndUpdate({ _id: product._id }, { $set: { name: 'Arepa de Queso' } });

    expect(await Product.findOne({ searchName: { $regex: '^arepa' } })).toBeTruthy();
  });
});
