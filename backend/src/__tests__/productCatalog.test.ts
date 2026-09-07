import { describe, it, expect } from 'vitest';
import request from 'supertest';

import app from '../app';
import { Category, Product } from '../models';
import { UserRole } from '../types';
import { makeUser, makeBusiness, authHeader } from './factories';

/**
 * Alta y edición de productos desde el panel del comercio.
 *
 * El endpoint no tenía ninguna prueba, y tampoco tenía `validate(...)` en
 * la ruta: lo que llegaba en el cuerpo iba directo a Mongoose. Estas
 * pruebas fijan las dos cosas que un panel real hace todo el rato —crear
 * con datos incompletos y tocar el catálogo del vecino— porque son
 * exactamente las que fallaban.
 */

async function scenario() {
  const owner = await makeUser({ role: UserRole.BUSINESS });
  const business = await makeBusiness(owner._id);
  const category = await Category.create({
    businessId: business._id,
    name: 'Hamburguesas',
    sortOrder: 1,
  });
  return { owner, business, category };
}

const validBody = (businessId: string, categoryId: string) => ({
  businessId,
  categoryId,
  name: 'Hamburguesa doble',
  description: 'Doble carne, queso y tocineta',
  price: 24000,
});

describe('Alta de producto', () => {
  it('crea el producto con los datos mínimos', async () => {
    const { owner, business, category } = await scenario();

    const res = await request(app)
      .post('/api/v1/products')
      .set(authHeader(owner))
      .send(validBody(business._id.toString(), category._id.toString()));

    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe('Hamburguesa doble');
    expect(res.body.data.price).toBe(24000);
  });

  it('explica que falta la categoría en vez de reventar', async () => {
    const { owner, business } = await scenario();

    // Es el caso real del panel: un comercio sin categorías abre "Nuevo
    // producto" y el desplegable manda una cadena vacía. `findById('')`
    // lanza un CastError que el manejador no reconoce, así que respondía
    // 500 "Error interno del servidor" — y el comercio solo veía "no se
    // pudo guardar el producto", sin saber que le falta crear una
    // categoría.
    const res = await request(app)
      .post('/api/v1/products')
      .set(authHeader(owner))
      .send({ ...validBody(business._id.toString(), ''), categoryId: '' });

    expect(res.status).toBe(400);
    // El mensaje accionable viaja en `errors[]`; `message` solo dice de
    // qué clase es el fallo. El panel tiene que leer el primero: mostrar
    // "Error de validación" no le dice al comercio que le falta crear una
    // categoría.
    expect(res.body.errors[0].field).toBe('body.categoryId');
    expect(res.body.errors[0].message).toMatch(/categor/i);
  });

  it('rechaza un identificador de categoría con forma inválida', async () => {
    const { owner, business } = await scenario();

    const res = await request(app)
      .post('/api/v1/products')
      .set(authHeader(owner))
      .send({ ...validBody(business._id.toString(), 'no-es-un-id') });

    expect(res.status).toBe(400);
  });

  it('rechaza un precio que no es un número', async () => {
    const { owner, business, category } = await scenario();

    // `parseFloat('')` es NaN, y el formulario puede mandarlo si el campo
    // llega vacío. Sin validación, Mongoose guardaba... o no, según el
    // camino, y el mensaje nunca decía cuál era el problema.
    const res = await request(app)
      .post('/api/v1/products')
      .set(authHeader(owner))
      .send({
        ...validBody(business._id.toString(), category._id.toString()),
        price: null,
      });

    expect(res.status).toBe(400);
  });

  it('no deja colgar un producto de la categoría de otro comercio', async () => {
    const { owner, business } = await scenario();
    const other = await scenario();

    const res = await request(app)
      .post('/api/v1/products')
      .set(authHeader(owner))
      .send(validBody(business._id.toString(), other.category._id.toString()));

    expect(res.status).toBe(400);
    expect(await Product.countDocuments({ businessId: business._id })).toBe(0);
  });

  it('no deja crear productos en un comercio ajeno', async () => {
    const { category, business } = await scenario();
    const stranger = await makeUser({ role: UserRole.BUSINESS });

    const res = await request(app)
      .post('/api/v1/products')
      .set(authHeader(stranger))
      .send(validBody(business._id.toString(), category._id.toString()));

    expect(res.status).toBe(403);
  });

  it('descarta los campos que no pertenecen al producto', async () => {
    const { owner, business, category } = await scenario();

    // `req.body` iba entero a `Product.create`. `isFeatured` sí es del
    // comercio —solo ordena su propio menú, no promociona nada en la
    // plataforma; eso es `Business.isFeatured`, que ya es de admin— pero
    // cualquier otra clave tenía que quedarse fuera.
    const res = await request(app)
      .post('/api/v1/products')
      .set(authHeader(owner))
      .send({
        ...validBody(business._id.toString(), category._id.toString()),
        isFeatured: true,
        rating: 5,
        businessPayout: 999,
      });

    expect(res.status).toBe(201);
    const created = await Product.findById(res.body.data._id);
    expect(created!.isFeatured).toBe(true);
    expect((created as any).rating).toBeUndefined();
    expect((created as any).businessPayout).toBeUndefined();
  });
});

describe('Edición de producto', () => {
  it('actualiza precio y disponibilidad', async () => {
    const { owner, business, category } = await scenario();

    const created = await request(app)
      .post('/api/v1/products')
      .set(authHeader(owner))
      .send(validBody(business._id.toString(), category._id.toString()));

    const res = await request(app)
      .put(`/api/v1/products/${created.body.data._id}`)
      .set(authHeader(owner))
      .send({ businessId: business._id.toString(), price: 26000, isAvailable: false });

    expect(res.status).toBe(200);
    expect(res.body.data.price).toBe(26000);
    expect(res.body.data.isAvailable).toBe(false);
  });

  it('no deja editar el producto de otro comercio', async () => {
    const { owner, business, category } = await scenario();
    const created = await request(app)
      .post('/api/v1/products')
      .set(authHeader(owner))
      .send(validBody(business._id.toString(), category._id.toString()));

    const stranger = await makeUser({ role: UserRole.BUSINESS });
    const strangerBusiness = await makeBusiness(stranger._id);

    // El atacante manda **su** businessId, que sí posee, pero el id de un
    // producto ajeno: la comprobación de propiedad del comercio pasa y la
    // que tiene que frenarlo es la del producto.
    const res = await request(app)
      .put(`/api/v1/products/${created.body.data._id}`)
      .set(authHeader(stranger))
      .send({ businessId: strangerBusiness._id.toString(), price: 1 });

    expect(res.status).toBe(403);
    const untouched = await Product.findById(created.body.data._id);
    expect(untouched!.price).toBe(24000);
  });
});
