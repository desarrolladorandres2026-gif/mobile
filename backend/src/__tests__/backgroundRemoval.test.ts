import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';

import app from '../app';
import { config } from '../config';
import { Category, ImageProcessingEvent, Product } from '../models';
import { UserRole } from '../types';
import { productImageService } from '../services/productImage.service';
import {
  backgroundRemovalService,
  CLAIM_LEASE_MS,
  MAX_ATTEMPTS,
  startOfBogotaDay,
} from '../services/backgroundRemoval.service';
import {
  BackgroundRemovalError,
  BackgroundRemovalProvider,
  setBackgroundRemovalProviderForTests,
} from '../services/imageProcessing';
import { makeUser, makeBusiness, authHeader } from './factories';

/**
 * Quitar el fondo de la foto principal, de punta a punta.
 *
 * Nada sale a la red: el proveedor es uno falso inyectado, Cloudinary se
 * sustituye en los métodos que suben, bajan y borran, y el trabajo en
 * segundo plano no se dispara solo — cada caso llama a `run` cuando le
 * toca, para que no compita con la aserción. Lo que sí corre de verdad es
 * lo que importa: las rutas, la propiedad, las reservas atómicas en Mongo,
 * el estado del producto y las URLs que reciben las apps.
 */

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

const CUTOUT_PNG = Buffer.alloc(10, 9);

/** Un proveedor que hace lo que cada caso le diga. */
const fake = {
  name: 'fake',
  configured: true,
  isConfigured() {
    return this.configured;
  },
  removeBackground: vi.fn(),
};

let uploads = 0;
let destroyed: string[] = [];

beforeEach(() => {
  uploads = 0;
  destroyed = [];
  fake.configured = true;
  fake.removeBackground.mockReset();
  fake.removeBackground.mockResolvedValue({ buffer: CUTOUT_PNG, format: 'png', width: 900, height: 1000 });
  setBackgroundRemovalProviderForTests(fake as unknown as BackgroundRemovalProvider);

  vi.spyOn(productImageService, 'isConfigured', 'get').mockReturnValue(true);
  vi.spyOn(productImageService as any, 'store').mockImplementation(async (...args: unknown[]) => {
    const params = args[0] as { businessId: string; publicId: string };
    uploads += 1;
    return {
      publicId: `zipp/products/${params.businessId}/${params.publicId}`,
      width: 1200,
      height: 1200,
      bytes: 180_000,
      format: 'jpg',
      placeholderDataUri: null,
    };
  });
  vi.spyOn(productImageService, 'storeCutout').mockImplementation(async (params) => ({
    publicId: `zipp/products/${params.businessId}/${params.productId}-${params.checksum.slice(0, 12)}-cutout`,
    width: 900,
    height: 1000,
    bytes: 90_000,
    format: 'png',
    provider: params.provider,
    placeholderDataUri: null,
    createdAt: new Date(),
  }));
  vi.spyOn(productImageService as any, 'destroy').mockImplementation(async (...args: unknown[]) => {
    destroyed.push(args[0] as string);
  });
  vi.spyOn(backgroundRemovalService, 'downloadOriginal').mockResolvedValue({
    buffer: jpeg(1200, 1200),
    mimetype: 'image/jpeg',
  });
});

afterEach(() => {
  setBackgroundRemovalProviderForTests(null);
  vi.restoreAllMocks();
});

async function scenario() {
  const owner = await makeUser({ role: UserRole.BUSINESS });
  const business = await makeBusiness(owner._id);
  const category = await Category.create({ businessId: business._id, name: 'Bebidas', sortOrder: 1 });
  const product = await Product.create({
    businessId: business._id,
    categoryId: category._id,
    name: 'Botella de agua',
    price: 3000,
  });
  return { owner, business, product };
}

async function upload(
  ctx: { owner: any; business: any; product: any },
  options: { file?: Buffer; removeBackground?: boolean } = {}
) {
  const req = request(app)
    .post(`/api/v1/products/${ctx.product._id}/image`)
    .set(await authHeader(ctx.owner))
    .field('businessId', ctx.business._id.toString());
  if (options.removeBackground !== false) req.field('removeBackground', 'true');
  return req.attach('image', options.file ?? jpeg(1600, 1600), {
    filename: 'foto.jpg',
    contentType: 'image/jpeg',
  });
}

const load = async (id: unknown) => (await Product.findById(id))!;
const toJson = async (id: unknown) => (await load(id)).toJSON() as any;

/** El barrido encuentra esta foto vencida. */
async function makeDue(id: unknown) {
  await Product.updateOne(
    { _id: id },
    { $set: { 'imageAsset.backgroundRemoval.nextAttemptAt': new Date(Date.now() - 1_000) } }
  );
}

describe('Subida con "Quitar el fondo"', () => {
  it('guarda la original al instante y deja el recorte en cola', async () => {
    const ctx = await scenario();

    const res = await upload(ctx);

    expect(res.status).toBe(201);
    expect(res.body.data.images.backgroundRemoval).toBe('pending');
    expect(res.body.data.images.usingOriginal).toBe(true);
    // La respuesta no espera al proveedor.
    expect(fake.removeBackground).not.toHaveBeenCalled();
    // La reserva no sale en la API.
    expect(res.body.data.imageAsset.backgroundRemoval.claimId).toBeUndefined();
  });

  it('sin la casilla no se encola nada', async () => {
    const ctx = await scenario();

    const res = await upload(ctx, { removeBackground: false });

    expect(res.status).toBe(201);
    expect(res.body.data.images.backgroundRemoval).toBe('none');
  });

  it('un formato inválido no llega ni a Cloudinary ni al proveedor', async () => {
    const ctx = await scenario();

    const res = await upload(ctx, { file: Buffer.concat([Buffer.from('MZ'), Buffer.alloc(100, 1)]) });

    expect(res.status).toBe(400);
    expect(uploads).toBe(0);
    expect(await ImageProcessingEvent.countDocuments()).toBe(0);
  });
});

describe('Procesamiento', () => {
  it('termina: todas las variantes pasan al recorte compuesto y la original se conserva', async () => {
    const ctx = await scenario();
    await upload(ctx);
    const originalId = (await load(ctx.product._id)).imageAsset!.publicId;

    await backgroundRemovalService.run(ctx.product._id.toString());

    const json = await toJson(ctx.product._id);
    const { images } = json;
    expect(images.backgroundRemoval).toBe('completed');
    expect(images.usingOriginal).toBe(false);
    expect(images.backgroundRemoved).toBe(true);
    for (const size of ['thumb', 'catalog', 'detail', 'large']) {
      expect(images[size]).toContain('-cutout');
      // Centrado y sin deformar, sobre el fondo de ZIPP.
      expect(images[size]).toContain('c_pad');
      expect(images[size]).toContain('b_rgb:f6f8fa');
    }
    // La versión transparente va aparte y sin fondo.
    expect(images.cutout).toContain('-cutout');
    expect(images.cutout).not.toContain('b_rgb');
    // Las apps viejas leen `image`: también apunta al recorte.
    expect(json.image).toContain('-cutout');

    // El original sigue ahí, intacto y sin borrar.
    const saved = await load(ctx.product._id);
    expect(saved.imageAsset!.publicId).toBe(originalId);
    expect(destroyed).not.toContain(originalId);

    const events = await ImageProcessingEvent.find().lean();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: 'completed', provider: 'fake', billable: true });
    expect(events[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('error del proveedor: reintenta y, agotados los intentos, se queda con la original', async () => {
    const ctx = await scenario();
    fake.removeBackground.mockRejectedValue(
      new BackgroundRemovalError('PROVIDER_ERROR', { retryable: true })
    );
    await upload(ctx);

    await backgroundRemovalService.run(ctx.product._id.toString());
    let state = (await load(ctx.product._id)).imageAsset!.backgroundRemoval!;
    expect(state.status).toBe('pending');
    expect(state.errorCode).toBe('PROVIDER_ERROR');
    expect(state.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());

    for (let i = 1; i < MAX_ATTEMPTS; i += 1) {
      await makeDue(ctx.product._id);
      await backgroundRemovalService.run(ctx.product._id.toString());
    }

    state = (await load(ctx.product._id)).imageAsset!.backgroundRemoval!;
    expect(state.status).toBe('failed');
    expect(fake.removeBackground).toHaveBeenCalledTimes(MAX_ATTEMPTS);

    const json = await toJson(ctx.product._id);
    expect(json.images.usingOriginal).toBe(true);
    expect(json.images.catalog).not.toContain('-cutout');
    expect(await ImageProcessingEvent.countDocuments({ outcome: 'retry_scheduled' })).toBe(MAX_ATTEMPTS - 1);
    expect(await ImageProcessingEvent.countDocuments({ outcome: 'failed' })).toBe(1);
  });

  it('timeout: se reprograma en vez de fallar', async () => {
    const ctx = await scenario();
    fake.removeBackground.mockRejectedValueOnce(new BackgroundRemovalError('TIMEOUT', { retryable: true }));
    await upload(ctx);

    const before = Date.now();
    await backgroundRemovalService.run(ctx.product._id.toString());

    const state = (await load(ctx.product._id)).imageAsset!.backgroundRemoval!;
    expect(state.status).toBe('pending');
    expect(state.errorCode).toBe('TIMEOUT');
    expect(state.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(before + 29_000);

    // Y el siguiente intento sale bien.
    await makeDue(ctx.product._id);
    await backgroundRemovalService.run(ctx.product._id.toString());
    expect((await load(ctx.product._id)).imageAsset!.backgroundRemoval!.status).toBe('completed');
  });

  it('rate limit: espera lo que pidió el proveedor', async () => {
    const ctx = await scenario();
    fake.removeBackground.mockRejectedValueOnce(
      new BackgroundRemovalError('RATE_LIMITED', { retryable: true, retryAfterMs: 45_000 })
    );
    await upload(ctx);

    const before = Date.now();
    await backgroundRemovalService.run(ctx.product._id.toString());

    const state = (await load(ctx.product._id)).imageAsset!.backgroundRemoval!;
    expect(state.status).toBe('pending');
    expect(state.errorCode).toBe('RATE_LIMITED');
    const wait = state.nextAttemptAt!.getTime() - before;
    expect(wait).toBeGreaterThanOrEqual(44_000);
    expect(wait).toBeLessThan(60_000);
  });

  it('respuesta inválida: falla sin reintentar, porque ya se cobró', async () => {
    const ctx = await scenario();
    fake.removeBackground.mockRejectedValueOnce(
      new BackgroundRemovalError('INVALID_RESPONSE', { billable: true })
    );
    await upload(ctx);

    await backgroundRemovalService.run(ctx.product._id.toString());

    const state = (await load(ctx.product._id)).imageAsset!.backgroundRemoval!;
    expect(state.status).toBe('failed');
    expect(state.errorCode).toBe('INVALID_RESPONSE');
    expect(fake.removeBackground).toHaveBeenCalledTimes(1);
    expect(await ImageProcessingEvent.countDocuments({ outcome: 'failed', billable: true })).toBe(1);
  });

  it('dos ejecuciones a la vez llaman al proveedor una sola vez', async () => {
    const ctx = await scenario();
    await upload(ctx);

    const id = ctx.product._id.toString();
    await Promise.all([backgroundRemovalService.run(id), backgroundRemovalService.run(id)]);

    expect(fake.removeBackground).toHaveBeenCalledTimes(1);
    expect((await load(id)).imageAsset!.backgroundRemoval!.status).toBe('completed');
  });

  it('una foto nueva a mitad del recorte descarta el recorte viejo', async () => {
    const ctx = await scenario();
    await upload(ctx);

    // Mientras el proveedor trabaja, el comercio sube otra foto.
    fake.removeBackground.mockImplementationOnce(async () => {
      await upload(ctx, { file: jpeg(1700, 1700), removeBackground: false });
      return { buffer: CUTOUT_PNG, format: 'png', width: 900, height: 1000 };
    });

    await backgroundRemovalService.run(ctx.product._id.toString());

    const saved = await load(ctx.product._id);
    // La foto nueva manda, sin recorte encima.
    expect(saved.imageAsset!.cutout).toBeNull();
    expect(saved.imageAsset!.backgroundRemoval).toBeNull();
    // Y el recorte que ya no es de nadie se borró.
    expect(destroyed.some((id) => id.endsWith('-cutout'))).toBe(true);
    expect(await ImageProcessingEvent.countDocuments({ outcome: 'superseded' })).toBe(1);
  });
});

describe('Restaurar la original y reintentar', () => {
  async function completed() {
    const ctx = await scenario();
    await upload(ctx);
    await backgroundRemovalService.run(ctx.product._id.toString());
    return ctx;
  }

  it('"Usar imagen original" va y vuelve sin llamar al proveedor', async () => {
    const ctx = await completed();
    const patch = async (useOriginal: boolean) =>
      request(app)
        .patch(`/api/v1/products/${ctx.product._id}/image`)
        .set(await authHeader(ctx.owner))
        .send({ businessId: ctx.business._id.toString(), useOriginal });

    const toOriginal = await patch(true);
    expect(toOriginal.status).toBe(200);
    expect(toOriginal.body.data.images.usingOriginal).toBe(true);
    expect(toOriginal.body.data.images.catalog).not.toContain('-cutout');
    expect(toOriginal.body.data.image).not.toContain('-cutout');
    // El recorte sigue guardado: volver es un interruptor.
    expect(toOriginal.body.data.images.cutout).toContain('-cutout');

    const back = await patch(false);
    expect(back.body.data.images.usingOriginal).toBe(false);
    expect(back.body.data.images.catalog).toContain('-cutout');

    expect(fake.removeBackground).toHaveBeenCalledTimes(1);
    expect(destroyed).toHaveLength(0);
  });

  it('"Reintentar" tras un fallo vuelve a encolar y termina', async () => {
    const ctx = await scenario();
    fake.removeBackground.mockRejectedValueOnce(new BackgroundRemovalError('REJECTED'));
    await upload(ctx);
    await backgroundRemovalService.run(ctx.product._id.toString());
    expect((await load(ctx.product._id)).imageAsset!.backgroundRemoval!.status).toBe('failed');

    const res = await request(app)
      .post(`/api/v1/products/${ctx.product._id}/image/background-removal`)
      .set(await authHeader(ctx.owner))
      .send({ businessId: ctx.business._id.toString() });

    expect(res.status).toBe(202);
    expect(res.body.data.images.backgroundRemoval).toBe('pending');
    // Un reintento explícito empieza la cuenta de intentos de cero.
    expect((await load(ctx.product._id)).imageAsset!.backgroundRemoval!.attempts).toBe(0);

    await backgroundRemovalService.run(ctx.product._id.toString());
    expect((await load(ctx.product._id)).imageAsset!.backgroundRemoval!.status).toBe('completed');
  });

  it('pedir el recorte mientras ya hay uno en curso no encola otro', async () => {
    const ctx = await scenario();
    await upload(ctx);

    const res = await request(app)
      .post(`/api/v1/products/${ctx.product._id}/image/background-removal`)
      .set(await authHeader(ctx.owner))
      .send({ businessId: ctx.business._id.toString() });

    expect(res.status).toBe(202);
    await backgroundRemovalService.run(ctx.product._id.toString());
    expect(fake.removeBackground).toHaveBeenCalledTimes(1);
  });
});

describe('No se paga dos veces', () => {
  it('editar el producto no reprocesa la foto', async () => {
    const ctx = await scenario();
    await upload(ctx);
    await backgroundRemovalService.run(ctx.product._id.toString());

    const res = await request(app)
      .put(`/api/v1/products/${ctx.product._id}`)
      .set(await authHeader(ctx.owner))
      .send({ businessId: ctx.business._id.toString(), name: 'Agua con gas', price: 3500 });

    expect(res.status).toBe(200);
    await backgroundRemovalService.sweep();
    expect(fake.removeBackground).toHaveBeenCalledTimes(1);
    expect((await load(ctx.product._id)).imageAsset!.backgroundRemoval!.status).toBe('completed');
  });

  it('volver a subir la misma foto no sube ni recorta de nuevo', async () => {
    const ctx = await scenario();
    await upload(ctx);
    await backgroundRemovalService.run(ctx.product._id.toString());

    const res = await upload(ctx);

    expect(res.status).toBe(201);
    expect(res.body.data.images.backgroundRemoval).toBe('completed');
    expect(uploads).toBe(1);
    await backgroundRemovalService.sweep();
    expect(fake.removeBackground).toHaveBeenCalledTimes(1);
  });

  it('pasado el tope diario, la foto se guarda con su fondo y no se llama al proveedor', async () => {
    const ctx = await scenario();
    const limit = config.backgroundRemoval.dailyLimitPerBusiness;
    config.backgroundRemoval.dailyLimitPerBusiness = 1;
    try {
      await ImageProcessingEvent.create({
        businessId: ctx.business._id,
        productId: ctx.product._id,
        provider: 'fake',
        outcome: 'completed',
        billable: true,
        createdAt: new Date(),
      });

      const res = await upload(ctx);

      expect(res.status).toBe(201);
      expect(res.body.data.images.backgroundRemoval).toBe('failed');
      expect(res.body.data.imageAsset.backgroundRemoval.errorCode).toBe('DAILY_LIMIT');
      await backgroundRemovalService.sweep();
      expect(fake.removeBackground).not.toHaveBeenCalled();
      expect(await ImageProcessingEvent.countDocuments({ outcome: 'limited' })).toBe(1);
    } finally {
      config.backgroundRemoval.dailyLimitPerBusiness = limit;
    }
  });

  it('el día del tope empieza a medianoche de Bogotá', () => {
    // 04:59 UTC del 22 son las 23:59 del 21 en Bogotá.
    expect(startOfBogotaDay(new Date('2026-09-22T04:59:00Z')).toISOString()).toBe('2026-09-21T05:00:00.000Z');
    expect(startOfBogotaDay(new Date('2026-09-22T05:00:00Z')).toISOString()).toBe('2026-09-22T05:00:00.000Z');
  });
});

describe('Barrido', () => {
  it('retoma una reserva de un proceso que murió', async () => {
    const ctx = await scenario();
    await upload(ctx);
    // Un proceso reservó la foto y se cayó: la reserva venció.
    await Product.updateOne(
      { _id: ctx.product._id },
      {
        $set: {
          'imageAsset.backgroundRemoval.status': 'processing',
          'imageAsset.backgroundRemoval.claimId': 'proceso-muerto',
          'imageAsset.backgroundRemoval.attempts': 1,
          'imageAsset.backgroundRemoval.nextAttemptAt': new Date(Date.now() - CLAIM_LEASE_MS),
        },
      }
    );

    expect(await backgroundRemovalService.sweep()).toBe(1);
    expect((await load(ctx.product._id)).imageAsset!.backgroundRemoval!.status).toBe('completed');
  });

  it('deja de insistir con una foto que se interrumpe una y otra vez', async () => {
    const ctx = await scenario();
    await upload(ctx);
    await Product.updateOne(
      { _id: ctx.product._id },
      {
        $set: {
          'imageAsset.backgroundRemoval.status': 'processing',
          'imageAsset.backgroundRemoval.attempts': MAX_ATTEMPTS,
          'imageAsset.backgroundRemoval.nextAttemptAt': new Date(Date.now() - 1_000),
        },
      }
    );

    await backgroundRemovalService.sweep();

    const state = (await load(ctx.product._id)).imageAsset!.backgroundRemoval!;
    expect(state.status).toBe('failed');
    expect(state.errorCode).toBe('INTERRUPTED');
    expect(fake.removeBackground).not.toHaveBeenCalled();
  });
});

describe('Autorización entre comercios', () => {
  it('otro comercio no puede subir, recortar ni restaurar la foto de este', async () => {
    const ctx = await scenario();
    await upload(ctx);
    const stranger = await makeUser({ role: UserRole.BUSINESS });
    const strangerBusiness = await makeBusiness(stranger._id);
    const headers = await authHeader(stranger);
    const businessId = strangerBusiness._id.toString();

    const retry = await request(app)
      .post(`/api/v1/products/${ctx.product._id}/image/background-removal`)
      .set(headers)
      .send({ businessId });
    const restore = await request(app)
      .patch(`/api/v1/products/${ctx.product._id}/image`)
      .set(headers)
      .send({ businessId, useOriginal: true });
    const replace = await request(app)
      .post(`/api/v1/products/${ctx.product._id}/image`)
      .set(headers)
      .field('businessId', businessId)
      .field('removeBackground', 'true')
      .attach('image', jpeg(1800, 1800), { filename: 'x.jpg', contentType: 'image/jpeg' });
    // Ni haciéndose pasar por el dueño del comercio.
    const impersonate = await request(app)
      .post(`/api/v1/products/${ctx.product._id}/image/background-removal`)
      .set(headers)
      .send({ businessId: ctx.business._id.toString() });

    expect(retry.status).toBe(403);
    expect(restore.status).toBe(403);
    expect(replace.status).toBe(403);
    expect(impersonate.status).toBe(403);
    expect(uploads).toBe(1);
  });
});

describe('Sin proveedor configurado', () => {
  it('el panel no ve la opción, la subida funciona y el reintento responde 503', async () => {
    fake.configured = false;
    const ctx = await scenario();

    const capabilities = await request(app)
      .get('/api/v1/products/image-capabilities')
      .set(await authHeader(ctx.owner));
    expect(capabilities.body.data.backgroundRemoval).toBe(false);

    const res = await upload(ctx);
    expect(res.status).toBe(201);
    expect(res.body.data.images.backgroundRemoval).toBe('none');

    const retry = await request(app)
      .post(`/api/v1/products/${ctx.product._id}/image/background-removal`)
      .set(await authHeader(ctx.owner))
      .send({ businessId: ctx.business._id.toString() });
    expect(retry.status).toBe(503);
    expect(retry.body.code).toBe('BACKGROUND_REMOVAL_NOT_CONFIGURED');
  });

  it('con el proveedor real y sin clave, igual: apagado', async () => {
    setBackgroundRemovalProviderForTests(null);
    const owner = await makeUser({ role: UserRole.BUSINESS });

    const res = await request(app)
      .get('/api/v1/products/image-capabilities')
      .set(await authHeader(owner));

    expect(res.body.data.backgroundRemoval).toBe(false);
  });

  it('la clave nunca aparece en una respuesta', async () => {
    setBackgroundRemovalProviderForTests(null);
    const key = config.backgroundRemoval.photoroom.apiKey;
    config.backgroundRemoval.photoroom.apiKey = 'sk_test_SECRETO_DE_PRUEBA';
    try {
      const ctx = await scenario();
      const capabilities = await request(app)
        .get('/api/v1/products/image-capabilities')
        .set(await authHeader(ctx.owner));
      const uploaded = await upload(ctx);

      expect(capabilities.body.data.backgroundRemoval).toBe(true);
      expect(JSON.stringify(capabilities.body)).not.toContain('SECRETO');
      expect(JSON.stringify(uploaded.body)).not.toContain('SECRETO');
    } finally {
      config.backgroundRemoval.photoroom.apiKey = key;
    }
  });
});

describe('Métricas', () => {
  it('suma resultados, créditos y tiempos; solo para quien puede ver informes', async () => {
    const ctx = await scenario();
    const base = { businessId: ctx.business._id, productId: ctx.product._id, provider: 'photoroom' };
    await ImageProcessingEvent.create([
      { ...base, outcome: 'completed', billable: true, durationMs: 1000 },
      { ...base, outcome: 'completed', billable: true, durationMs: 3000 },
      { ...base, outcome: 'failed', billable: false, errorCode: 'TIMEOUT' },
      { ...base, outcome: 'limited', billable: false, errorCode: 'DAILY_LIMIT' },
    ]);
    const admin = await makeUser({ role: UserRole.ADMIN });

    const res = await request(app)
      .get('/api/v1/admin/image-processing/stats')
      .set(await authHeader(admin));

    expect(res.status).toBe(200);
    expect(res.body.data.totals).toMatchObject({ completed: 2, failed: 1, limited: 1, billable: 2 });
    expect(res.body.data.durationMs.average).toBe(2000);
    expect(res.body.data.byProvider[0]).toMatchObject({ provider: 'photoroom', billable: 2 });
    expect(res.body.data.topBusinesses[0]).toMatchObject({
      businessId: ctx.business._id.toString(),
      billable: 2,
    });

    const forbidden = await request(app)
      .get('/api/v1/admin/image-processing/stats')
      .set(await authHeader(ctx.owner));
    expect(forbidden.status).toBe(403);
  });

  it('rechaza un rango absurdo', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    const res = await request(app)
      .get('/api/v1/admin/image-processing/stats')
      .query({ from: '2025-01-01', to: '2026-09-01' })
      .set(await authHeader(admin));
    expect(res.status).toBe(400);
  });
});

describe('Migración 008', () => {
  it('informa y repara las galerías que apuntan al archivo de la portada, sin borrar nada', async () => {
    const { migrateProductImageCutout } = await import('../migrations/008-product-image-cutout');
    const ctx = await scenario();
    await upload(ctx, { removeBackground: false });
    const product = await load(ctx.product._id);
    const cover = product.imageAsset!;
    product.gallery.push({ ...(cover as any).toObject(), checksum: 'galeria-vieja' });
    await product.save();

    const report = await migrateProductImageCutout({ apply: false });
    expect(report.affected).toEqual([
      expect.objectContaining({ productId: ctx.product._id.toString(), entries: 1 }),
    ]);
    // Solo informe: nada cambió todavía.
    expect((await load(ctx.product._id)).gallery).toHaveLength(1);

    await migrateProductImageCutout({ apply: true });
    const repaired = await load(ctx.product._id);
    expect(repaired.gallery).toHaveLength(0);
    expect(repaired.imageAsset!.publicId).toBe(cover.publicId);
    expect(destroyed).toHaveLength(0);
  });
});

describe('Endurecimiento', () => {
  it('el tope diario cuenta también las fotos que están en cola', async () => {
    const ctx = await scenario();
    const other = await Product.create({
      businessId: ctx.business._id,
      categoryId: ctx.product.categoryId,
      name: 'Gaseosa',
      price: 2500,
    });
    const limit = config.backgroundRemoval.dailyLimitPerBusiness;
    config.backgroundRemoval.dailyLimitPerBusiness = 1;
    try {
      // Una en cola, sin cobrar todavía: ya ocupa el único hueco del día.
      const first = await upload(ctx);
      expect(first.body.data.images.backgroundRemoval).toBe('pending');

      const second = await upload({ ...ctx, product: other });
      expect(second.body.data.images.backgroundRemoval).toBe('failed');
      expect(second.body.data.imageAsset.backgroundRemoval.errorCode).toBe('DAILY_LIMIT');
    } finally {
      config.backgroundRemoval.dailyLimitPerBusiness = limit;
    }
  });

  it('la carta pública no expone el proveedor ni la maquinaria del recorte', async () => {
    const ctx = await scenario();
    await upload(ctx);
    await backgroundRemovalService.run(ctx.product._id.toString());

    const res = await request(app).get(`/api/v1/products/${ctx.product._id}`);

    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('"provider"');
    expect(body).not.toContain('claimId');
    expect(body).not.toContain('attempts');
    expect(res.body.data.imageAsset.cutout).toBeUndefined();
    // Lo que sí necesita el panel sigue ahí.
    expect(res.body.data.images.backgroundRemoval).toBe('completed');
    expect(res.body.data.images.cutout).toContain('-cutout');
    expect(res.body.data.imageAsset.backgroundRemoval).toHaveProperty('requestedAt');
  });
});
