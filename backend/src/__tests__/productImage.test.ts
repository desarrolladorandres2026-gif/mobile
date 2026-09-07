import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

import app from '../app';
import { Category, Product } from '../models';
import { UserRole } from '../types';
import { productImageService, readImageHeader } from '../services/productImage.service';
import { makeUser, makeBusiness, authHeader } from './factories';

/**
 * Imágenes del catálogo.
 *
 * Cloudinary se sustituye solo en el método que habla con la red, no el
 * paquete entero: así sigue ejecutándose de verdad lo que importa —la
 * inspección de los bytes, las dimensiones mínimas, el control de
 * propiedad, la persistencia y el borrado de la imagen anterior.
 */

// ── Constructores de imágenes de prueba ──────────────────────────────

/** PNG mínimo válido con las dimensiones que se le pidan. */
function png(width: number, height: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4);
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;
  ihdr[17] = 6;
  return Buffer.concat([signature, ihdr, Buffer.alloc(64, 3)]);
}

/** JPEG mínimo válido: SOI, un APP0 que hay que saltar, y el SOF0. */
function jpeg(width: number, height: number): Buffer {
  const soi = Buffer.from([0xff, 0xd8]);

  const app0 = Buffer.alloc(20);
  app0[0] = 0xff;
  app0[1] = 0xe0;
  app0.writeUInt16BE(18, 2);
  app0.write('JFIF\0', 4);

  const sof0 = Buffer.alloc(11);
  sof0[0] = 0xff;
  sof0[1] = 0xc0;
  sof0.writeUInt16BE(9, 2);
  sof0[4] = 8;
  sof0.writeUInt16BE(height, 5);
  sof0.writeUInt16BE(width, 7);
  sof0[9] = 1;

  return Buffer.concat([soi, app0, sof0, Buffer.alloc(32, 1)]);
}

/** Un ejecutable con nombre y MIME de imagen. */
const NOT_AN_IMAGE = Buffer.concat([Buffer.from('MZ\x90\x00'), Buffer.alloc(200, 1)]);

async function scenario() {
  const owner = await makeUser({ role: UserRole.BUSINESS });
  const business = await makeBusiness(owner._id);
  const category = await Category.create({
    businessId: business._id,
    name: 'Hamburguesas',
    sortOrder: 1,
  });
  const product = await Product.create({
    businessId: business._id,
    categoryId: category._id,
    name: 'Hamburguesa doble',
    price: 24000,
  });
  return { owner, business, category, product };
}

let uploadCount = 0;
let destroyed: string[] = [];

beforeEach(() => {
  uploadCount = 0;
  destroyed = [];

  vi.spyOn(productImageService as any, 'store').mockImplementation(async (...args: unknown[]) => {
    const params = args[0] as { productId: string; businessId: string };
    uploadCount += 1;
    return {
      publicId: `zipp/products/${params.businessId}/${params.productId}`,
      width: 1200,
      height: 1200,
      bytes: 180_000,
      format: 'jpg',
    };
  });

  vi.spyOn(productImageService as any, 'destroy').mockImplementation(async (...args: unknown[]) => {
    destroyed.push(args[0] as string);
  });

  // Cloudinary no está configurado en pruebas y `isConfigured` lo mira.
  vi.spyOn(productImageService, 'isConfigured', 'get').mockReturnValue(true);
});

describe('Lectura de dimensiones sin descargar librerías', () => {
  it('lee un PNG', () => {
    expect(readImageHeader(png(1024, 768))).toEqual({
      format: 'png',
      width: 1024,
      height: 768,
    });
  });

  it('lee un JPEG saltándose los segmentos que no describen la imagen', () => {
    expect(readImageHeader(jpeg(1600, 1200))).toEqual({
      format: 'jpg',
      width: 1600,
      height: 1200,
    });
  });

  it('devuelve null para algo que no es una imagen', () => {
    expect(readImageHeader(NOT_AN_IMAGE)).toBeNull();
  });

  it('devuelve null para un PNG truncado', () => {
    expect(readImageHeader(png(800, 800).subarray(0, 10))).toBeNull();
  });
});

describe('Subida de la imagen de un producto', () => {
  it('guarda la imagen y deja la URL de catálogo en `image`', async () => {
    const { owner, business, product } = await scenario();

    const res = await request(app)
      .post(`/api/v1/products/${product._id}/image`)
      .set(authHeader(owner))
      .field('businessId', business._id.toString())
      .attach('image', jpeg(1600, 1600), { filename: 'burger.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(201);

    const saved = await Product.findById(product._id);
    expect(saved!.imageAsset).toBeTruthy();
    expect(saved!.imageAsset!.enhanced).toBe(true);

    // La app móvil lee `product.image`; tiene que seguir siendo una URL.
    expect(typeof saved!.image).toBe('string');
    expect(saved!.image).toContain('http');
  });

  it('expone las cuatro variantes y un placeholder', async () => {
    const { owner, business, product } = await scenario();

    const res = await request(app)
      .post(`/api/v1/products/${product._id}/image`)
      .set(authHeader(owner))
      .field('businessId', business._id.toString())
      .attach('image', jpeg(1600, 1600), { filename: 'burger.jpg', contentType: 'image/jpeg' });

    const images = res.body.data.images;
    expect(images.thumb).toBeTruthy();
    expect(images.catalog).toBeTruthy();
    expect(images.detail).toBeTruthy();
    expect(images.large).toBeTruthy();
    expect(images.placeholder).toBeTruthy();
    // El `srcset` lleva los cuatro anchos reales.
    expect(images.srcSet).toContain('200w');
    expect(images.srcSet).toContain('1200w');
    // Formato negociado con el navegador, no fijado a mano.
    expect(images.catalog).toContain('f_auto');
  });

  it('rechaza una imagen demasiado pequeña explicando por qué', async () => {
    const { owner, business, product } = await scenario();

    const res = await request(app)
      .post(`/api/v1/products/${product._id}/image`)
      .set(authHeader(owner))
      .field('businessId', business._id.toString())
      .attach('image', jpeg(300, 300), { filename: 'peque.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PRODUCT_IMAGE_TOO_SMALL');
    expect(res.body.message).toMatch(/300×300/);
    expect(uploadCount).toBe(0);
  });

  it('rechaza un archivo que solo dice ser una imagen', async () => {
    const { owner, business, product } = await scenario();

    const res = await request(app)
      .post(`/api/v1/products/${product._id}/image`)
      .set(authHeader(owner))
      .field('businessId', business._id.toString())
      .attach('image', NOT_AN_IMAGE, { filename: 'payload.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(400);
    expect(uploadCount).toBe(0);
  });

  it('rechaza un binario cuyo tipo real no coincide con el declarado', async () => {
    const { owner, business, product } = await scenario();

    const res = await request(app)
      .post(`/api/v1/products/${product._id}/image`)
      .set(authHeader(owner))
      .field('businessId', business._id.toString())
      // Bytes de PNG, declarado como JPEG.
      .attach('image', png(1000, 1000), { filename: 'foto.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(400);
    expect(uploadCount).toBe(0);
  });

  it('borra la imagen anterior al reemplazarla', async () => {
    const { owner, business, product } = await scenario();
    const upload = () =>
      request(app)
        .post(`/api/v1/products/${product._id}/image`)
        .set(authHeader(owner))
        .field('businessId', business._id.toString())
        .attach('image', jpeg(1600, 1600), { filename: 'b.jpg', contentType: 'image/jpeg' });

    await upload();

    // El `public_id` es estable por producto, así que Cloudinary
    // sobrescribe y no hay nada que borrar: lo que no puede pasar es que
    // se acumule una imagen por edición.
    (productImageService as any).store.mockImplementationOnce(async () => ({
      publicId: 'zipp/products/otro/identificador',
      width: 1200,
      height: 1200,
      bytes: 150_000,
      format: 'jpg',
    }));
    await upload();

    expect(destroyed).toHaveLength(1);
    expect(destroyed[0]).toContain(product._id.toString());
  });

  it('no deja subir la imagen de un producto ajeno', async () => {
    const { product } = await scenario();
    const stranger = await makeUser({ role: UserRole.BUSINESS });
    const strangerBusiness = await makeBusiness(stranger._id);

    // Manda su propio comercio —que sí posee— con el id de un producto de
    // otro: la comprobación que tiene que frenarlo es la del producto.
    const res = await request(app)
      .post(`/api/v1/products/${product._id}/image`)
      .set(authHeader(stranger))
      .field('businessId', strangerBusiness._id.toString())
      .attach('image', jpeg(1600, 1600), { filename: 'b.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(403);
    expect(uploadCount).toBe(0);
  });
});

describe('Ajustes y borrado de la imagen', () => {
  async function withImage() {
    const s = await scenario();
    await request(app)
      .post(`/api/v1/products/${s.product._id}/image`)
      .set(authHeader(s.owner))
      .field('businessId', s.business._id.toString())
      .attach('image', jpeg(1600, 1600), { filename: 'b.jpg', contentType: 'image/jpeg' });
    return s;
  }

  it('apaga la mejora sin volver a subir el archivo', async () => {
    const { owner, business, product } = await withImage();
    const before = uploadCount;

    const res = await request(app)
      .patch(`/api/v1/products/${product._id}/image`)
      .set(authHeader(owner))
      .send({ businessId: business._id.toString(), enhance: false });

    expect(res.status).toBe(200);
    expect(res.body.data.images.enhanced).toBe(false);
    // La mejora vive en la URL: cambiarla no cuesta una subida.
    expect(uploadCount).toBe(before);

    const saved = await Product.findById(product._id);
    expect(saved!.imageAsset!.enhanced).toBe(false);
  });

  it('borra la imagen y su archivo', async () => {
    const { owner, business, product } = await withImage();

    const res = await request(app)
      .delete(`/api/v1/products/${product._id}/image`)
      .set(authHeader(owner))
      .send({ businessId: business._id.toString() });

    expect(res.status).toBe(200);

    const saved = await Product.findById(product._id);
    expect(saved!.imageAsset).toBeNull();
    expect(saved!.image).toBeFalsy();
    expect(destroyed).toHaveLength(1);
  });

  it('borra el archivo cuando se borra el producto entero', async () => {
    const { owner, business, product } = await withImage();

    const res = await request(app)
      .delete(`/api/v1/products/${product._id}`)
      .set(authHeader(owner))
      .send({ businessId: business._id.toString() });

    expect(res.status).toBe(200);
    // Sin esto, cada producto eliminado dejaba su foto huérfana.
    expect(destroyed).toHaveLength(1);
    expect(await Product.findById(product._id)).toBeNull();
  });
});

describe('Capacidades del entorno', () => {
  it('dice si el recorte de fondo está disponible', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });

    const res = await request(app)
      .get('/api/v1/products/image-capabilities')
      .set(authHeader(owner));

    expect(res.status).toBe(200);
    // Es un complemento de pago de Cloudinary: por defecto va apagado, y
    // el panel usa esto para no pintar un botón que fallaría siempre.
    expect(res.body.data.backgroundRemoval).toBe(false);
    expect(res.body.data.minDimension).toBeGreaterThan(0);
    expect(res.body.data.aspectRatio).toBe('1:1');
  });
});
