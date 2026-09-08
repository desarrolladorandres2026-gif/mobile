import { describe, it, expect, beforeEach } from 'vitest';
import { Business, Product } from '../models';
import { UserRole } from '../types';
import { searchService } from '../services/search.service';
import { makeUser, makeBusiness, makeProduct, GARZON } from './factories';

/**
 * Búsqueda del catálogo.
 *
 * Antes solo se buscaban negocios, con `$regex` sin índice. Lo caro no era
 * el recorrido de la colección: era que buscar "hamburguesa" no devolvía
 * nada si ningún negocio se llamaba así, aunque tres la tuvieran en la
 * carta. Eso hace que ZIPP se sienta un listado de sitios y no un sitio
 * donde comprar.
 */
describe('Búsqueda de catálogo', () => {
  let business: any;

  beforeEach(async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    business = await makeBusiness(owner._id, {
      name: 'Burger House',
      category: 'fast_food',
      lat: GARZON.lat,
      lng: GARZON.lng,
    });

    await makeProduct(business._id, { name: 'Hamburguesa doble' });
    await makeProduct(business._id, { name: 'Perro caliente' });
    await makeProduct(business._id, { name: 'Malteada de fresa' });
  });

  it('encuentra un producto aunque ningún negocio se llame así', async () => {
    // Este es el caso que antes no existía: el nombre del plato no está en
    // el nombre del local.
    const results = await searchService.search('hamburguesa');

    expect(results.products.length).toBeGreaterThan(0);
    expect((results.products[0] as any).name).toContain('Hamburguesa');
  });

  it('el producto viene con su negocio, para poder pintarlo y navegar', async () => {
    const results = await searchService.search('hamburguesa');
    const product = results.products[0] as any;

    expect(product.businessName).toBe('Burger House');
    expect(product.businessId.toString()).toBe(business._id.toString());
  });

  it('encuentra el negocio por su nombre', async () => {
    const results = await searchService.search('Burger');
    expect(results.businesses.length).toBeGreaterThan(0);
    expect((results.businesses[0] as any).name).toBe('Burger House');
  });

  it('entiende el plural y el singular, porque el índice sabe español', async () => {
    // "hamburguesas" y "hamburguesa" comparten raíz: sin el idioma en el
    // índice, la segunda no encontraría al primero.
    const results = await searchService.search('hamburguesas');
    expect(results.products.length).toBeGreaterThan(0);
  });

  it('encuentra por prefijo mientras el usuario todavía escribe', async () => {
    // El índice de texto solo casa palabras completas, y la caja consulta
    // en cada tecla. "hambur" es el caso normal, no el raro.
    const results = await searchService.search('hambur');

    expect(results.strategy).toBe('prefix');
    expect(results.products.length).toBeGreaterThan(0);
  });

  it('no devuelve productos de un negocio sin aprobar', async () => {
    await Business.updateOne({ _id: business._id }, { isApproved: false });

    const results = await searchService.search('hamburguesa');
    // Enseñarlos lleva a una carta que no se puede pedir, y el usuario
    // culpa a la aplicación y no al estado del comercio.
    expect(results.products).toHaveLength(0);
    expect(results.businesses).toHaveLength(0);
  });

  it('no devuelve productos agotados', async () => {
    await Product.updateMany({ businessId: business._id }, { isAvailable: false });

    const results = await searchService.search('hamburguesa');
    expect(results.products).toHaveLength(0);
  });

  it('ignora búsquedas de una sola letra', async () => {
    const results = await searchService.search('h');
    expect(results.products).toHaveLength(0);
    expect(results.businesses).toHaveLength(0);
  });

  it('un término sin resultados devuelve listas vacías, no un error', async () => {
    const results = await searchService.search('sushi vegano molecular');
    expect(results.products).toHaveLength(0);
    expect(results.businesses).toHaveLength(0);
  });

  it('no se rompe con caracteres especiales en la búsqueda', async () => {
    // Sin escapar, un paréntesis suelto revienta la expresión regular del
    // camino por prefijo.
    await expect(searchService.search('pizza (grande)')).resolves.toBeDefined();
    await expect(searchService.search('a+b*c')).resolves.toBeDefined();
  });

  it('lo más buscado sale del catálogo real, no de una lista escrita a mano', async () => {
    const terms = await searchService.popularTerms();
    expect(terms).toContain('fast_food');
  });
});
