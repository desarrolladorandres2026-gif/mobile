import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

import app from '../app';
import { Category, Product } from '../models';
import { UserRole } from '../types';
import {
  productImageService,
  readImageHeader,
  fetchInlinePlaceholder,
} from '../services/productImage.service';
import { withProductImages } from '../utils/productImageUrls';
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
    const params = args[0] as { productId: string; businessId: string; publicId: string };
    uploadCount += 1;
    // Como Cloudinary: la carpeta del comercio delante del id que se pidió.
    return {
      publicId: `zipp/products/${params.businessId}/${params.publicId}`,
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
      .set(await authHeader(owner))
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
      .set(await authHeader(owner))
      .field('businessId', business._id.toString())
      .attach('image', jpeg(1600, 1600), { filename: 'burger.jpg', contentType: 'image/jpeg' });

    const images = res.body.data.images;
    expect(images.thumb).toBeTruthy();
    expect(images.catalog).toBeTruthy();
    expect(images.detail).toBeTruthy();
    expect(images.large).toBeTruthy();
    // Sin miniatura incrustada, la URL de respaldo.
    expect(images.placeholder).toContain('e_blur');
    // El `srcSet` lo arma el panel: ya no viaja repetido en cada producto.
    expect(images.srcSet).toBeUndefined();
    // Formato negociado con el navegador, no fijado a mano.
    expect(images.catalog).toContain('f_auto');
  });

  it('sirve la miniatura incrustada y no la repite en imageAsset', async () => {
    const { owner, business, product } = await scenario();
    const dataUri = 'data:image/webp;base64,UklGRkQAAABXRUJQ';
    (productImageService as any).store.mockImplementationOnce(async () => ({
      publicId: `zipp/products/${business._id}/${product._id}`,
      width: 1200,
      height: 1200,
      bytes: 180_000,
      format: 'jpg',
      placeholderDataUri: dataUri,
    }));

    const res = await request(app)
      .post(`/api/v1/products/${product._id}/image`)
      .set(await authHeader(owner))
      .field('businessId', business._id.toString())
      .attach('image', jpeg(1600, 1600), { filename: 'burger.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(201);
    expect(res.body.data.images.placeholder).toBe(dataUri);
    expect(res.body.data.imageAsset.placeholderDataUri).toBeUndefined();
    // Guardada de verdad, no solo pintada en la respuesta.
    const saved = await Product.findById(product._id).lean();
    expect(saved?.imageAsset?.placeholderDataUri).toBe(dataUri);
  });

  it('rechaza una imagen demasiado pequeña explicando por qué', async () => {
    const { owner, business, product } = await scenario();

    const res = await request(app)
      .post(`/api/v1/products/${product._id}/image`)
      .set(await authHeader(owner))
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
      .set(await authHeader(owner))
      .field('businessId', business._id.toString())
      .attach('image', NOT_AN_IMAGE, { filename: 'payload.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(400);
    expect(uploadCount).toBe(0);
  });

  it('rechaza un binario cuyo tipo real no coincide con el declarado', async () => {
    const { owner, business, product } = await scenario();

    const res = await request(app)
      .post(`/api/v1/products/${product._id}/image`)
      .set(await authHeader(owner))
      .field('businessId', business._id.toString())
      // Bytes de PNG, declarado como JPEG.
      .attach('image', png(1000, 1000), { filename: 'foto.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(400);
    expect(uploadCount).toBe(0);
  });

  it('borra la imagen anterior al reemplazarla', async () => {
    const { owner, business, product } = await scenario();
    const upload = async (file: Buffer) =>
      request(app)
        .post(`/api/v1/products/${product._id}/image`)
        .set(await authHeader(owner))
        .field('businessId', business._id.toString())
        .attach('image', file, { filename: 'b.jpg', contentType: 'image/jpeg' });

    await upload(jpeg(1600, 1600));
    const first = (await Product.findById(product._id))!.imageAsset!.publicId;

    // El id sale del contenido: otra foto es otro archivo, y el anterior
    // se borra en vez de acumularse uno por edición.
    await upload(jpeg(1700, 1700));
    const second = (await Product.findById(product._id))!.imageAsset!.publicId;

    expect(second).not.toBe(first);
    expect(destroyed).toEqual([first]);
  });

  it('volver a subir la misma foto no sube nada', async () => {
    const { owner, business, product } = await scenario();
    const upload = async () =>
      request(app)
        .post(`/api/v1/products/${product._id}/image`)
        .set(await authHeader(owner))
        .field('businessId', business._id.toString())
        .attach('image', jpeg(1600, 1600), { filename: 'b.jpg', contentType: 'image/jpeg' });

    await upload();
    const res = await upload();

    expect(res.status).toBe(201);
    expect(uploadCount).toBe(1);
    expect(destroyed).toHaveLength(0);
  });

  it('un archivo por encima del tope sale como 413 y en español', async () => {
    const { owner, business, product } = await scenario();
    const huge = Buffer.concat([jpeg(1600, 1600), Buffer.alloc(8 * 1024 * 1024 + 10, 1)]);

    const res = await request(app)
      .post(`/api/v1/products/${product._id}/image`)
      .set(await authHeader(owner))
      .field('businessId', business._id.toString())
      .attach('image', huge, { filename: 'enorme.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(413);
    expect(res.body.code).toBe('PRODUCT_IMAGE_TOO_LARGE');
    expect(res.body.message).toMatch(/MB/);
    expect(uploadCount).toBe(0);
  });

  it('rechaza un formato que no es JPG, PNG ni WEBP', async () => {
    const { owner, business, product } = await scenario();
    const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(200, 1)]);

    const res = await request(app)
      .post(`/api/v1/products/${product._id}/image`)
      .set(await authHeader(owner))
      .field('businessId', business._id.toString())
      .attach('image', gif, { filename: 'anim.gif', contentType: 'image/gif' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PRODUCT_IMAGE_INVALID_FILE');
    expect(uploadCount).toBe(0);
  });

  it('no deja subir la imagen de un producto ajeno', async () => {
    const { product } = await scenario();
    const stranger = await makeUser({ role: UserRole.BUSINESS });
    const strangerBusiness = await makeBusiness(stranger._id);

    // Manda su propio comercio —que sí posee— con el id de un producto de
    // otro: la comprobación que tiene que frenarlo es la del producto.
    const res = await request(app)
      .post(`/api/v1/products/${product._id}/image`)
      .set(await authHeader(stranger))
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
      .set(await authHeader(s.owner))
      .field('businessId', s.business._id.toString())
      .attach('image', jpeg(1600, 1600), { filename: 'b.jpg', contentType: 'image/jpeg' });
    return s;
  }

  it('rechaza un PATCH sin ningún ajuste', async () => {
    const { owner, business, product } = await withImage();

    const res = await request(app)
      .patch(`/api/v1/products/${product._id}/image`)
      .set(await authHeader(owner))
      .send({ businessId: business._id.toString() });

    expect(res.status).toBe(400);
  });

  it('apaga la mejora sin volver a subir el archivo', async () => {
    const { owner, business, product } = await withImage();
    const before = uploadCount;

    const res = await request(app)
      .patch(`/api/v1/products/${product._id}/image`)
      .set(await authHeader(owner))
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
      .set(await authHeader(owner))
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
      .set(await authHeader(owner))
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
      .set(await authHeader(owner));

    expect(res.status).toBe(200);
    // Sin clave del proveedor (en pruebas nunca la hay) va apagado, y el
    // panel usa esto para no pintar un botón que fallaría siempre.
    expect(res.body.data.backgroundRemoval).toBe(false);
    expect(res.body.data.minDimension).toBeGreaterThan(0);
    expect(res.body.data.aspectRatio).toBe('1:1');
  });
});

/**
 * Galería del producto.
 *
 * La foto principal la leen las listas, las tarjetas y el carrito; estas
 * son las que se deslizan dentro de la ficha y enseñan lo que la portada
 * no puede — el plato por dentro, el tamaño real, la etiqueta.
 *
 * Son un campo aparte y no `images[0]` a propósito: convertir la principal
 * en el primer elemento de un array obligaría a tocar todos esos sitios, y
 * bastaría olvidar uno para que un producto se quedara sin miniatura.
 */
describe('Galería del producto', () => {
  /** Cada subida devuelve un `publicId` distinto, como haría Cloudinary. */
  const distinctUploads = () => {
    let n = 0;
    (productImageService as any).store.mockImplementation(async () => {
      n += 1;
      return {
        publicId: `zipp/products/gallery-${n}`,
        width: 1200,
        height: 1200,
        bytes: 180_000,
        format: 'jpg',
      };
    });
  };

  const withCover = async () => {
    const ctx = await scenario();
    // `replace` escribe de forma atómica y devuelve el producto leído de
    // nuevo: el documento de entrada no cambia.
    ctx.product = (await productImageService.replace({
      product: ctx.product,
      buffer: png(1200, 1200),
      mimetype: 'image/png',
    })) as typeof ctx.product;
    return ctx;
  };

  it('cada foto de galería tiene su propio archivo y no pisa la portada', async () => {
    // Sin `distinctUploads`: el id lo decide el servicio, como en producción.
    const ctx = await withCover();
    const cover = ctx.product.imageAsset!.publicId;

    const updated = await productImageService.addToGallery({
      product: ctx.product,
      buffer: jpeg(1400, 1400),
      mimetype: 'image/jpeg',
    });

    const galleryId = updated.gallery[0].publicId;
    expect(galleryId).not.toBe(cover);
    expect(galleryId).toContain(`${ctx.product._id}-g-`);

    // Y quitarla no toca el archivo de la portada.
    await productImageService.removeFromGallery(updated, galleryId);
    expect(destroyed).toEqual([galleryId]);
  });

  it('quitar una entrada de galería que comparte archivo con la portada no borra la portada', async () => {
    // Los datos que dejó el fallo anterior: galería y portada con el mismo id.
    const ctx = await withCover();
    const cover = ctx.product.imageAsset!;
    ctx.product.gallery.push({ ...(cover as any).toObject(), checksum: 'otro' });
    await ctx.product.save();

    await productImageService.removeFromGallery(ctx.product, cover.publicId);

    expect(destroyed).toHaveLength(0);
    const saved = await Product.findById(ctx.product._id);
    expect(saved!.imageAsset!.publicId).toBe(cover.publicId);
    expect(saved!.gallery).toHaveLength(0);
  });

  it('DELETE de galería por HTTP encuentra la foto', async () => {
    const ctx = await withCover();
    const withPhoto = await productImageService.addToGallery({
      product: ctx.product,
      buffer: jpeg(1400, 1400),
      mimetype: 'image/jpeg',
    });
    const publicId = withPhoto.gallery[0].publicId;

    // Antes el validador tiraba `publicId` del cuerpo y esto daba 404.
    const res = await request(app)
      .delete(`/api/v1/products/${ctx.product._id}/gallery`)
      .set(await authHeader(ctx.owner))
      .send({ businessId: ctx.business._id.toString(), publicId });

    expect(res.status).toBe(200);
    expect(res.body.data.galleryImages).toHaveLength(0);
    expect(destroyed).toContain(publicId);
  });

  it('exige portada antes de la galería', async () => {
    const ctx = await scenario();

    // Un producto con cuatro fotos dentro y ninguna en la carta parecería
    // subido y no se vería en ninguna parte.
    await expect(
      productImageService.addToGallery({
        product: ctx.product,
        buffer: png(1200, 1200),
        mimetype: 'image/png',
      })
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('añade una foto sin tocar la principal', async () => {
    distinctUploads();
    const ctx = await withCover();
    const before = ctx.product.imageAsset!.publicId;

    const updated = await productImageService.addToGallery({
      product: ctx.product,
      buffer: jpeg(1400, 1400),
      mimetype: 'image/jpeg',
    });

    expect(updated.gallery).toHaveLength(1);
    expect(updated.imageAsset!.publicId).toBe(before);
    expect(updated.image).toBeTruthy();
  });

  it('rechaza la misma foto dos veces', async () => {
    distinctUploads();
    const ctx = await withCover();

    await productImageService.addToGallery({
      product: ctx.product,
      buffer: jpeg(1400, 1400),
      mimetype: 'image/jpeg',
    });

    // Un deslizamiento que enseña lo mismo no es una foto más.
    await expect(
      productImageService.addToGallery({
        product: ctx.product,
        buffer: jpeg(1400, 1400),
        mimetype: 'image/jpeg',
      })
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('no deja pasar del tope', async () => {
    distinctUploads();
    const ctx = await withCover();

    for (let i = 0; i < 5; i += 1) {
      await productImageService.addToGallery({
        product: ctx.product,
        buffer: jpeg(1200 + i, 1200 + i),
        mimetype: 'image/jpeg',
      });
    }

    // El tope es de producto, no de almacenamiento: a partir de la quinta
    // nadie sigue deslizando y cada foto es una descarga con datos
    // contados.
    await expect(
      productImageService.addToGallery({
        product: ctx.product,
        buffer: jpeg(1300, 1300),
        mimetype: 'image/jpeg',
      })
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('borrar una foto borra también su archivo', async () => {
    distinctUploads();
    const ctx = await withCover();

    const withPhoto = await productImageService.addToGallery({
      product: ctx.product,
      buffer: jpeg(1400, 1400),
      mimetype: 'image/jpeg',
    });
    const publicId = withPhoto.gallery[0].publicId;

    const updated = await productImageService.removeFromGallery(ctx.product, publicId);

    expect(updated.gallery).toHaveLength(0);
    expect(destroyed).toContain(publicId);
  });

  it('borrar una foto que no está da 404', async () => {
    const ctx = await withCover();

    await expect(
      productImageService.removeFromGallery(ctx.product, 'zipp/products/no-existe')
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('borrar el producto se lleva la galería entera', async () => {
    distinctUploads();
    const ctx = await withCover();

    await productImageService.addToGallery({
      product: ctx.product,
      buffer: jpeg(1400, 1400),
      mimetype: 'image/jpeg',
    });
    await productImageService.addToGallery({
      product: ctx.product,
      buffer: jpeg(1500, 1500),
      mimetype: 'image/jpeg',
    });

    // Sin esto, un producto con cinco fotos deja cinco archivos huérfanos.
    await productImageService.forget(ctx.product);

    expect(destroyed).toHaveLength(3);
  });

  it('la API entrega variantes, no identificadores de almacenamiento', async () => {
    distinctUploads();
    const ctx = await withCover();

    await productImageService.addToGallery({
      product: ctx.product,
      buffer: jpeg(1400, 1400),
      mimetype: 'image/jpeg',
    });

    const json = (await Product.findById(ctx.product._id))!.toJSON() as any;

    // La app no necesita `publicId` para pintar un carrusel, y no mandarlo
    // evita filtrar la estructura del almacenamiento a cualquiera que abra
    // la carta.
    expect(json.galleryImages).toHaveLength(1);
    expect(json.galleryImages[0].detail).toContain('http');
  });
});

describe('Miniatura incrustada', () => {
  const webp = (size: number) => Buffer.alloc(size, 7);
  const respond = (body: Buffer, type = 'image/webp', ok = true) =>
    vi.fn(async () => ({
      ok,
      headers: new Headers({ 'content-type': type }),
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length),
    }));

  it('devuelve un data URI con el tipo que dijo Cloudinary', async () => {
    const fetchMock = respond(webp(90));
    vi.stubGlobal('fetch', fetchMock);
    const uri = await fetchInlinePlaceholder('zipp/products/b/p', 1789479177);
    vi.unstubAllGlobals();

    expect(uri).toMatch(/^data:image\/webp;base64,/);
    // Pedida en WebP fijo y atada a la versión recién subida.
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toContain('f_webp');
    expect(url).toContain('v1789479177');
  });

  it('no incrusta lo que no es una imagen pequeña', async () => {
    vi.stubGlobal('fetch', respond(webp(90), 'text/html'));
    expect(await fetchInlinePlaceholder('p')).toBeNull();
    vi.stubGlobal('fetch', respond(webp(5000)));
    expect(await fetchInlinePlaceholder('p')).toBeNull();
    vi.stubGlobal('fetch', respond(webp(90), 'image/webp', false));
    expect(await fetchInlinePlaceholder('p')).toBeNull();
    vi.unstubAllGlobals();
  });

  it('nunca lanza: sin red, el producto sigue con la URL', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET'); }));
    expect(await fetchInlinePlaceholder('p')).toBeNull();
    vi.unstubAllGlobals();
  });

  it('las filas de un aggregate salen con variantes y sin imageAsset', () => {
    const row = withProductImages({
      name: 'Hamburguesa',
      imageAsset: {
        publicId: 'zipp/products/b/p',
        width: 1200,
        height: 1200,
        enhanced: false,
        backgroundRemoved: false,
        placeholderDataUri: 'data:image/webp;base64,AAAA',
      },
    });
    expect(row).not.toHaveProperty('imageAsset');
    expect(row.images?.thumb).toContain('w_200');
    expect(row.images?.placeholder).toBe('data:image/webp;base64,AAAA');
    expect(withProductImages({ name: 'Sin foto', imageAsset: null }).images).toBeNull();
  });
});
