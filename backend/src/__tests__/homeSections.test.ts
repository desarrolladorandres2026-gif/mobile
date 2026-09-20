import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { Business, Order, Product } from '../models';
import { UserRole, OrderStatus, PaymentMethod } from '../types';
import { orderService } from '../services/order.service';
import { applyTeste, ImageUploader } from '../scripts/teste/applyTeste';
import { GARZON, makeUser, makeBusiness, makeProduct, makePricingConfig, makeDiscoveryCollections, offsetKm } from './factories';

const API = '/api/v1/home-sections';
const EXPLORE_API = '/api/v1/explore';

/**
 * Las colecciones del producto, vengan del feed que vengan.
 *
 * Desde que el descubrimiento se repartió en dos pantallas, una colección
 * concreta vive en `/home-sections` o en `/explore`, pero no en las dos. Lo
 * que estas pruebas comprueban —que una sección mezcla comercios, respeta el
 * stock y el horario, y que ningún producto acapara el feed— no depende de
 * en cuál de las dos cayó, así que se miran juntas. El reparto en sí tiene
 * su propia prueba, más abajo.
 */
async function feed(params: Record<string, string | number> = {}) {
  const [home, explore] = await Promise.all([
    request(app).get(API).query(params).expect(200),
    request(app).get(EXPLORE_API).query(params).expect(200),
  ]);
  return [...home.body.data, ...explore.body.data.entries];
}

/** Abre el negocio las 24 horas, para que la hora a la que corra la prueba no importe. */
async function openAllDay(businessId: any) {
  const day = { open: '00:00', close: '23:59', isOpen: true };
  await Business.updateOne(
    { _id: businessId },
    { schedule: { monday: day, tuesday: day, wednesday: day, thursday: day, friday: day, saturday: day, sunday: day } }
  );
}

async function closeAllDay(businessId: any) {
  const day = { open: '00:00', close: '00:00', isOpen: false };
  await Business.updateOne(
    { _id: businessId },
    { schedule: { monday: day, tuesday: day, wednesday: day, thursday: day, friday: day, saturday: day, sunday: day } }
  );
}

async function deliver(businessId: string, clientId: string, productId: string, quantity: number, deliveredAt: Date) {
  const order = await orderService.create({
    clientId,
    businessId,
    items: [{ productId, quantity }],
    paymentMethod: PaymentMethod.ONLINE,
    deliveryAddress: 'Cra 1 #2-3',
    deliveryLongitude: GARZON.lng,
    deliveryLatitude: GARZON.lat,
  });
  await Order.updateOne({ _id: order._id }, { status: OrderStatus.DELIVERED, deliveredAt });
  return order;
}

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

/**
 * Las colecciones dinámicas del inicio.
 *
 * Lo que fija cada prueba no es "el algoritmo hace tal cosa" sino las
 * garantías que le prometimos al usuario: mezclar comercios, respetar stock
 * y horario, esconder una sección sin material, y no dejar que un mismo
 * producto acapare el inicio.
 */
describe('GET /api/home-sections', () => {
  let owner: any;

  beforeEach(async () => {
    await makePricingConfig();
    await makeDiscoveryCollections();
    owner = await makeUser({ role: UserRole.BUSINESS });
  });

  it('mezcla productos de varios comercios en una misma sección', async () => {
    const a = await makeBusiness(owner._id);
    const b = await makeBusiness(owner._id);
    await openAllDay(a._id);
    await openAllDay(b._id);

    await makeProduct(a._id, { name: 'Hamburguesa Rebajada', price: 20000, discountPrice: 14000 });
    await makeProduct(b._id, { name: 'Pizza Rebajada', price: 30000, discountPrice: 21000 });
    // Relleno para que la sección alcance el mínimo de 4 productos.
    await makeProduct(a._id, { name: 'Perro Rebajado', price: 10000, discountPrice: 7000 });
    await makeProduct(b._id, { name: 'Postre Rebajado', price: 12000, discountPrice: 8000 });

    const res = { body: { data: await feed() } };
    const section = res.body.data.find((s: any) => s.key === 'descuentosLocos');

    expect(section).toBeTruthy();
    const businessIds = new Set(section.products.map((p: any) => p.businessId));
    expect(businessIds.size).toBeGreaterThanOrEqual(2);
  });

  it('esconde una sección que no junta suficientes productos', async () => {
    const a = await makeBusiness(owner._id);
    await openAllDay(a._id);
    // Solo dos rebajados: por debajo del mínimo de 4 para mostrar la sección.
    await makeProduct(a._id, { name: 'Único Rebajado 1', price: 20000, discountPrice: 14000 });
    await makeProduct(a._id, { name: 'Único Rebajado 2', price: 20000, discountPrice: 14000 });

    const res = { body: { data: await feed() } };
    expect(res.body.data.find((s: any) => s.key === 'descuentosLocos')).toBeUndefined();
  });

  it('no muestra un producto sin stock aunque cumpla todo lo demás', async () => {
    const a = await makeBusiness(owner._id);
    await openAllDay(a._id);
    const agotado = await makeProduct(a._id, {
      name: 'Combo Agotado', price: 20000, discountPrice: 14000, stock: 0, isAvailable: true,
    });
    await makeProduct(a._id, { name: 'Relleno 1', price: 20000, discountPrice: 14000 });
    await makeProduct(a._id, { name: 'Relleno 2', price: 20000, discountPrice: 14000 });
    await makeProduct(a._id, { name: 'Relleno 3', price: 20000, discountPrice: 14000 });
    await makeProduct(a._id, { name: 'Relleno 4', price: 20000, discountPrice: 14000 });

    const res = { body: { data: await feed() } };
    const section = res.body.data.find((s: any) => s.key === 'descuentosLocos');
    expect(section.products.some((p: any) => p._id === agotado._id.toString())).toBe(false);
  });

  it('excluye un negocio no aprobado', async () => {
    const rejected = await makeBusiness(owner._id, { isApproved: false });
    await openAllDay(rejected._id);
    await makeProduct(rejected._id, { name: 'Fantasma', price: 20000, discountPrice: 14000, isAvailable: true });

    const approved = await makeBusiness(owner._id);
    await openAllDay(approved._id);
    for (let i = 0; i < 4; i++) {
      await makeProduct(approved._id, { name: `Relleno ${i}`, price: 20000, discountPrice: 14000 });
    }

    const res = { body: { data: await feed() } };
    const section = res.body.data.find((s: any) => s.key === 'descuentosLocos');
    expect(section.products.every((p: any) => p.businessId !== rejected._id.toString())).toBe(true);
  });

  it('excluye un negocio cerrado en este momento', async () => {
    // `pharmacy` a propósito: `fast_food` (la categoría por defecto de
    // `makeBusiness`) también encaja en "Para la noche", y ese cruce
    // consumiría el cupo de repetición del producto antes de que le tocara
    // el turno a "Favoritos de ZIPP".
    const closed = await makeBusiness(owner._id, { category: 'pharmacy' });
    await closeAllDay(closed._id);
    await makeProduct(closed._id, { name: 'Solo de Noche Imposible', isAvailable: true });

    const open = await makeBusiness(owner._id, { category: 'pharmacy' });
    await openAllDay(open._id);
    for (let i = 0; i < 4; i++) {
      await makeProduct(open._id, { name: `Destacado abierto ${i}` });
      await Product.updateOne({ businessId: open._id, name: `Destacado abierto ${i}` }, { isFeatured: true });
    }
    await Product.updateOne({ businessId: closed._id }, { isFeatured: true });

    const res = { body: { data: await feed() } };
    const section = res.body.data.find((s: any) => s.key === 'favoritosZipp');
    expect(section).toBeTruthy();
    expect(section.products.every((p: any) => p.businessId !== closed._id.toString())).toBe(true);
  });

  it('"Los más pedidos" mezcla ventas de negocios distintos, ordenadas por unidades', async () => {
    const client = await makeUser({ role: UserRole.CLIENT });
    const a = await makeBusiness(owner._id);
    const b = await makeBusiness(owner._id);
    await openAllDay(a._id);
    await openAllDay(b._id);
    const popular = await makeProduct(a._id, { name: 'El Más Vendido' });
    const segundo = await makeProduct(b._id, { name: 'El Segundo Más Vendido' });
    // Relleno: "Los más pedidos" se esconde con menos de cuatro candidatos.
    const tercero = await makeProduct(a._id, { name: 'Tercer Lugar' });
    const cuarto = await makeProduct(b._id, { name: 'Cuarto Lugar' });

    await deliver(a._id.toString(), client._id.toString(), popular._id.toString(), 6, daysAgo(2));
    await deliver(b._id.toString(), client._id.toString(), segundo._id.toString(), 3, daysAgo(2));
    await deliver(a._id.toString(), client._id.toString(), tercero._id.toString(), 1, daysAgo(2));
    await deliver(b._id.toString(), client._id.toString(), cuarto._id.toString(), 1, daysAgo(2));

    const res = { body: { data: await feed() } };
    const section = res.body.data.find((s: any) => s.key === 'losMasPedidos');

    expect(section).toBeTruthy();
    const names = section.products.map((p: any) => p.name);
    expect(names.indexOf('El Más Vendido')).toBeLessThan(names.indexOf('El Segundo Más Vendido'));
  });

  it('"Está en tendencia" solo entra si vendió más esta semana que la anterior', async () => {
    // Dos clientes distintos —uno por semana— para que la venta creciente
    // no se lea también como "Pide y repite" (que exige el mismo cliente
    // dos veces): son señales distintas y esta prueba solo quiere la de
    // tendencia.
    const clientA = await makeUser({ role: UserRole.CLIENT });
    const clientB = await makeUser({ role: UserRole.CLIENT });
    // `pharmacy` para no chocar con "Para la noche" antes de que le toque
    // el turno a "Está en tendencia" — ver la nota de la prueba de horario.
    const a = await makeBusiness(owner._id, { category: 'pharmacy' });
    await openAllDay(a._id);
    const estable = await makeProduct(a._id, { name: 'Producto Estable' });

    // Cuatro productos que de verdad crecen (el mínimo para que la sección
    // se muestre) y uno estable, como control negativo.
    const crecientes = await Promise.all(
      ['Producto en Alza 1', 'Producto en Alza 2', 'Producto en Alza 3', 'Producto en Alza 4'].map((name) =>
        makeProduct(a._id, { name })
      )
    );
    // "Recién llegados" los tomaría a todos por ser nuevos, agotando de paso
    // su cupo de repetición antes de que le tocara el turno a esta sección:
    // se adelanta la fecha de alta para aislar la señal que sí se examina.
    // `createdAt` es inmutable para Mongoose una vez creado el documento
    // (lo marca `{timestamps:true}`): un `updateOne` normal lo ignora en
    // silencio. Hay que ir por debajo, contra el driver nativo.
    const old = daysAgo(40);
    await Product.collection.updateMany({ businessId: a._id }, { $set: { createdAt: old } });
    await Business.collection.updateOne({ _id: a._id }, { $set: { createdAt: old } });

    for (const producto of crecientes) {
      await deliver(a._id.toString(), clientA._id.toString(), producto._id.toString(), 1, daysAgo(10));
      await deliver(a._id.toString(), clientB._id.toString(), producto._id.toString(), 5, daysAgo(2));
    }

    // "Producto Estable": la misma venta repartida sin crecer.
    await deliver(a._id.toString(), clientA._id.toString(), estable._id.toString(), 4, daysAgo(10));
    await deliver(a._id.toString(), clientB._id.toString(), estable._id.toString(), 1, daysAgo(2));

    const res = { body: { data: await feed() } };
    const section = res.body.data.find((s: any) => s.key === 'estaEnTendencia');
    const names = section?.products.map((p: any) => p.name) ?? [];

    expect(names).toEqual(
      expect.arrayContaining(['Producto en Alza 1', 'Producto en Alza 2', 'Producto en Alza 3', 'Producto en Alza 4'])
    );
    expect(names).not.toContain('Producto Estable');
  });

  it('un mismo producto no acapara el inicio: aparece a lo sumo dos veces', async () => {
    const a = await makeBusiness(owner._id);
    await openAllDay(a._id);

    // Un producto que encaja en varios criterios a la vez: destacado, barato,
    // rebajado y con nombre de antojo.
    const estrella = await makeProduct(a._id, {
      name: 'Hamburguesa Combo Especial', price: 9000, discountPrice: 6000,
    });
    await Product.updateOne({ _id: estrella._id }, { isFeatured: true });

    // Relleno de sobra para que cada sección que también matchea el
    // producto estrella tenga con qué completarse sin depender de él.
    for (let i = 0; i < 6; i++) {
      await makeProduct(a._id, { name: `Hamburguesa Relleno ${i}`, price: 9000, discountPrice: 6000 });
    }

    const res = { body: { data: await feed() } };
    const appearances = res.body.data.reduce(
      (count: number, section: any) =>
        count + section.products.filter((p: any) => p._id === estrella._id.toString()).length,
      0
    );

    expect(appearances).toBeLessThanOrEqual(2);
  });

  it('sin coordenadas, no incluye "Cerca de ti" pero responde con las demás', async () => {
    const a = await makeBusiness(owner._id);
    await openAllDay(a._id);
    for (let i = 0; i < 4; i++) await makeProduct(a._id, { name: `Genérico ${i}` });

    const res = { body: { data: await feed() } };
    expect(res.body.data.find((s: any) => s.key === 'cercaDeTi')).toBeUndefined();
  });

  it('con coordenadas, "Cerca de ti" descarta un negocio fuera del radio', async () => {
    // `pharmacy`: mismo motivo que en las pruebas de horario y tendencia —
    // evita que "Para la noche" consuma el cupo de repetición antes de
    // tiempo, ya que "Cerca de ti" es de las últimas secciones en armarse.
    const near = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng, category: 'pharmacy' });
    await openAllDay(near._id);
    for (let i = 0; i < 4; i++) await makeProduct(near._id, { name: `Cercano ${i}` });

    const far = offsetKm(GARZON, 20);
    const lejos = await makeBusiness(owner._id, { lat: far.lat, lng: far.lng });
    await openAllDay(lejos._id);
    await makeProduct(lejos._id, { name: 'Lejano' });

    const res = { body: { data: await feed({ lat: GARZON.lat, lng: GARZON.lng, maxDistance: 5000 }) } };

    const section = res.body.data.find((s: any) => s.key === 'cercaDeTi');
    expect(section).toBeTruthy();
    expect(section.products.every((p: any) => p.businessId !== lejos._id.toString())).toBe(true);
  });
});

// ── Contra el catálogo real de TESTE ──────────────────────────────────

const fakeUploader: ImageUploader = {
  async product(product, buffer) {
    product.imageAsset = {
      publicId: `teste/${product._id}`, width: 1600, height: 1200, bytes: buffer.length, format: 'jpg',
      checksum: buffer.toString('utf8'), enhanced: true, backgroundRemoved: false, uploadedAt: new Date(),
    } as any;
    product.image = `https://res.cloudinary.test/${product._id}.jpg`;
    await product.save();
  },
  async business(business, _buffer, kind) {
    return `https://res.cloudinary.test/${business._id}-${kind}.jpg`;
  },
};

const fakeFetch = async (url: string) => Buffer.from(url);

describe('GET /api/home-sections — con el catálogo de TESTE', () => {
  beforeEach(async () => {
    await makePricingConfig();
    await makeDiscoveryCollections();
    const admin = await makeUser({ role: UserRole.ADMIN, name: 'Admin' });
    await applyTeste({ adminId: admin._id.toString(), fetchImage: fakeFetch, uploader: fakeUploader });
  });

  it('arma secciones reales, mezclando los cinco comercios sembrados', async () => {
    const res = { body: { data: await feed() } };
    const sections: any[] = res.body.data;

    expect(sections.length).toBeGreaterThan(0);

    // Cada producto devuelto pertenece a uno de los comercios del TESTE —
    // ninguna sección inventa nada fuera del catálogo sembrado.
    const businessNames = new Set(await Business.find({}).distinct('name'));
    for (const section of sections) {
      for (const product of section.products) {
        expect(businessNames.has(product.businessName)).toBe(true);
      }
    }

    // Al menos una sección de verdad mezcla comercios distintos: es la
    // promesa central de la funcionalidad, no un detalle de una sola fila.
    const mixed = sections.some((s) => new Set(s.products.map((p: any) => p.businessId)).size >= 2);
    expect(mixed).toBe(true);
  });

  it('"El antojo del día" encuentra los perros y salchipapas de Callejón 21', async () => {
    const res = { body: { data: await feed() } };
    const section = res.body.data.find((s: any) => s.key === 'antojoDelDia');

    expect(section).toBeTruthy();
    const names = section.products.map((p: any) => p.name);
    expect(names.some((n: string) => /perro|salchipapa/i.test(n))).toBe(true);
  });

  it('"Por menos de $10.000" solo trae precios efectivos por debajo del umbral', async () => {
    const res = { body: { data: await feed() } };
    const section = res.body.data.find((s: any) => s.key === 'porMenosDe10000');

    expect(section).toBeTruthy();
    for (const product of section.products) {
      const effective = product.discountPrice ?? product.price;
      expect(effective).toBeLessThan(10000);
    }
  });
});
