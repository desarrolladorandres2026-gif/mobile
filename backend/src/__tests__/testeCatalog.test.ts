import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { User, Business, Product, Category, Order, BusinessDocument } from '../models';
import { UserRole, OrderStatus } from '../types';
import { orderService } from '../services/order.service';
import { applyTeste, ImageUploader } from '../scripts/teste/applyTeste';
import { validateTeste } from '../scripts/teste/validateTeste';
import { TESTE_BUSINESSES, TESTE_CLIENTS, TESTE_PASSWORD } from '../scripts/teste/data/businesses';
import { TESTE_IMAGES } from '../scripts/teste/data/images';
import { makeUser, makeDriver, makePricingConfig, authHeader, pick } from './factories';
import { runDelivery } from './factories';
import { offsetPoint } from '../scripts/teste/common';

/**
 * El TESTE contra la Mongo en memoria.
 *
 * Aquí se comprueba lo que un seed no puede prometer solo con correr: que
 * es idempotente (dos veces = lo mismo, con los mismos ids de opciones),
 * que el validador lo da por bueno, y que sus productos sirven de verdad
 * para crear pedidos por HTTP con las mismas rutas que usa la app.
 *
 * Las fotos no viajan a Cloudinary: se inyecta un subidor falso que guarda
 * `imageAsset` con la forma real, así que el validador puede revisar
 * también esa parte.
 */

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

/** Cada URL devuelve un "archivo" distinto, para que los checksums no choquen. */
const fakeFetch = async (url: string) => Buffer.from(url);

async function seed() {
  const admin = await makeUser({ role: UserRole.ADMIN, name: 'Admin' });
  return applyTeste({ adminId: admin._id.toString(), fetchImage: fakeFetch, uploader: fakeUploader });
}

const findProduct = async (businessName: string, productName: string) => {
  const business = await Business.findOne({ name: businessName });
  const product = await Product.findOne({ businessId: business!._id, name: productName });
  if (!product) throw new Error(`${businessName} / ${productName} no existe`);
  return { business: business!, product };
};

describe('TESTE — siembra', () => {
  beforeEach(async () => {
    await makePricingConfig();
  });

  it('siembra 5 negocios aprobados, 50 productos y 2 clientes con dirección', async () => {
    const report = await seed();
    expect(report.businesses.created).toBe(5);
    expect(report.products.created).toBe(50);
    expect(report.users.created).toBe(7);
    expect(report.addresses.created).toBe(2);
    expect(report.images.uploaded).toBe(60);
    expect(report.images.failed).toEqual([]);

    const businesses = await Business.find({});
    expect(businesses.every((b) => b.isApproved && b.isActive)).toBe(true);
    expect(await BusinessDocument.countDocuments({ status: 'approved' })).toBeGreaterThanOrEqual(5 * 4);
    expect(await Product.countDocuments()).toBe(50);
    for (const spec of TESTE_BUSINESSES) {
      const b = businesses.find((x) => x.name === spec.name)!;
      expect(await Product.countDocuments({ businessId: b._id })).toBe(10);
      expect(await Category.countDocuments({ businessId: b._id })).toBe(spec.categories.length);
    }
  });

  it('las cuentas entran por el login real', async () => {
    await seed();
    const res = await request(app).post('/api/v1/auth/login').send({ phone: TESTE_CLIENTS[0].phone, password: TESTE_PASSWORD });
    expect(res.status).toBe(200);
    const owner = await request(app).post('/api/v1/auth/login').send({ phone: TESTE_BUSINESSES[0].owner.phone, password: TESTE_PASSWORD });
    expect(owner.status).toBe(200);
    expect(owner.body.data.user.role).toBe('business');
  });

  it('es idempotente y conserva los ids de grupos y opciones', async () => {
    const first = await seed();
    const before = await Product.find({}).sort({ name: 1 });
    const ids = before.map((p) => p.modifierGroups.map((g) => [String(g._id), g.options.map((o) => String(o._id))]));

    const second = await applyTeste({ adminId: (await User.findOne({ role: UserRole.ADMIN }))!._id.toString(), fetchImage: fakeFetch, uploader: fakeUploader });
    expect(second.businesses.created).toBe(0);
    expect(second.products.created).toBe(0);
    expect(second.products.updated).toBe(50);
    expect(second.users.created).toBe(0);
    expect(second.images.uploaded).toBe(0);
    expect(second.images.skipped).toBe(60);
    expect(second.businesses.ids).toEqual(first.businesses.ids);

    const after = await Product.find({}).sort({ name: 1 });
    expect(after.map((p) => p.modifierGroups.map((g) => [String(g._id), g.options.map((o) => String(o._id))]))).toEqual(ids);
    expect(await Product.countDocuments()).toBe(50);
    expect(await User.countDocuments()).toBe(8);
  });

  it('el validador lo da por bueno (PASS, sin hallazgos altos)', async () => {
    await seed();
    const report = await validateTeste();
    expect(report.findings.filter((f) => f.severity === 'high')).toEqual([]);
    expect(report.verdict).toBe('PASS');
    expect(report.counts).toMatchObject({ businesses: 5, products: 50, orders: 0 });
    expect(report.counts.groups).toBeGreaterThan(60);
  });

  it('el validador detecta un producto colgado de otro negocio y un id de opción duplicado', async () => {
    await seed();
    const { product: burger } = await findProduct('Carbón & Pan', 'Clásica de la Casa');
    const { business: tul } = await findProduct('Sazón de la Tulia', 'Bandeja Paisa');
    await Product.updateOne({ _id: burger._id }, { businessId: tul._id });
    const { product: smash } = await findProduct('Carbón & Pan', 'Doble Smash');
    await Product.updateOne({ _id: smash._id }, { $set: { 'modifierGroups.0.options.0._id': burger.modifierGroups[0].options[0]._id } });

    const report = await validateTeste();
    expect(report.verdict).toBe('FAIL');
    expect(report.findings.map((f) => f.check)).toEqual(expect.arrayContaining(['producto.categoriaAjena', 'opcion.idRepetida']));
  });

  it('las 60 imágenes tienen procedencia completa y sin repetir', () => {
    expect(TESTE_IMAGES).toHaveLength(60);
    const ids = new Set(TESTE_IMAGES.map((i) => i.photoId));
    expect(ids.size).toBe(60);
    for (const image of TESTE_IMAGES) {
      expect(image.pageUrl).toMatch(/^https:\/\/unsplash\.com\/photos\//);
      expect(image.directUrl).toMatch(/^https:\/\/images\.unsplash\.com\/photo-/);
      expect(image.author.length).toBeGreaterThan(0);
      expect(Math.min(image.width, image.height)).toBeGreaterThanOrEqual(1200);
    }
    const keys = new Set(TESTE_IMAGES.map((i) => i.key));
    for (const b of TESTE_BUSINESSES) {
      expect(keys.has(`${b.key}.logo`)).toBe(true);
      expect(keys.has(`${b.key}.cover`)).toBe(true);
      for (const p of b.products) expect(keys.has(`${b.key}.${p.imageKey}`), `${b.key}.${p.imageKey}`).toBe(true);
    }
  });
});

describe('TESTE — la matriz por HTTP', () => {
  let client: any;
  let deliverTo: { lat: number; lng: number };

  beforeEach(async () => {
    await makePricingConfig({ cashOnDeliveryEnabled: true, cashOnDeliveryMaxAmount: 1_000_000 });
    await seed();
    client = await User.findOne({ phone: TESTE_CLIENTS[0].phone });
    deliverTo = offsetPoint(TESTE_CLIENTS[0].address.offsetKm);
  });

  const order = async (business: any, items: unknown[], extra: Record<string, unknown> = {}) =>
    request(app).post('/api/v1/orders').set(await authHeader(client)).send({
      businessId: business._id.toString(), items, paymentMethod: 'online',
      deliveryAddress: TESTE_CLIENTS[0].address.address, deliveryLatitude: deliverTo.lat, deliveryLongitude: deliverTo.lng,
      ...extra,
    });

  it('M-01: la Clásica con todo, por dos, cuesta exactamente $102.800', async () => {
    const { business, product } = await findProduct('Carbón & Pan', 'Clásica de la Casa');
    const res = await order(business, [{
      productId: product._id.toString(), quantity: 2,
      selectedExtras: [
        pick(product, 'Tipo de carne', 'Angus 150 g'), pick(product, 'Queso', 'Cheddar'), pick(product, 'Tocineta', 'Tocineta doble'),
        pick(product, 'Salsas', 'Chipotle'), pick(product, 'Papas', 'Rústicas'), pick(product, 'Bebida', 'Limonada de hierbabuena'),
      ],
    }]);
    expect(res.status).toBe(201);
    expect(res.body.data.subtotal).toBe(102800);
    expect(res.body.data.items[0].selectedExtras).toHaveLength(6);
  });

  it('M-02: la Clásica sin tipo de carne se rechaza con MODIFIER_REQUIRED', async () => {
    const { business, product } = await findProduct('Carbón & Pan', 'Clásica de la Casa');
    const res = await order(business, [{ productId: product._id.toString(), quantity: 1 }]);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MODIFIER_REQUIRED');
  });

  it('M-03: la Mojarra con un solo acompañante se rechaza', async () => {
    const { business, product } = await findProduct('Sazón de la Tulia', 'Mojarra Frita');
    const res = await order(business, [{ productId: product._id.toString(), quantity: 1,
      selectedExtras: [pick(product, 'Tamaño', 'Mediana (450 g)'), pick(product, 'Acompañantes (elige 2)', 'Patacones')] }]);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MODIFIER_REQUIRED');
  });

  it('M-04: los Nuggets con tres salsas se rechazan con MODIFIER_TOO_MANY', async () => {
    const { business, product } = await findProduct('Carbón & Pan', 'Nuggets de Pollo x8');
    const res = await order(business, [{ productId: product._id.toString(), quantity: 1,
      selectedExtras: [pick(product, 'Salsas (1 o 2)', 'BBQ'), pick(product, 'Salsas (1 o 2)', 'Ranch'), pick(product, 'Salsas (1 o 2)', 'Búfalo')] }]);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MODIFIER_TOO_MANY');
  });

  it('M-05: la Bandeja con chicharrón extra (agotado) se rechaza', async () => {
    const { business, product } = await findProduct('Sazón de la Tulia', 'Bandeja Paisa');
    const res = await order(business, [{ productId: product._id.toString(), quantity: 1,
      selectedExtras: [pick(product, 'Porción', 'Tradicional'), pick(product, 'Adiciones', 'Chicharrón extra')] }]);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MODIFIER_UNAVAILABLE');
  });

  it('M-07: la pizza familiar, delgada, dos sabores y borde de queso', async () => {
    const { business, product } = await findProduct('Callejón 21', 'Pizza Mitad y Mitad');
    const res = await order(business, [{ productId: product._id.toString(), quantity: 1,
      selectedExtras: [
        pick(product, 'Tamaño', 'Familiar (8 porciones)'), pick(product, 'Masa', 'Delgada'),
        pick(product, 'Primera mitad', 'Pepperoni'), pick(product, 'Segunda mitad', 'Carnes frías'), pick(product, 'Borde', 'Borde de queso'),
      ] }]);
    expect(res.status).toBe(201);
    expect(res.body.data.subtotal).toBe(38900 + 12000 + 3000 + 6000);
  });

  it('S-01 / S-02: el croissant se agota con la última unidad y la torta agotada no se vende', async () => {
    const { business, product } = await findProduct('Trigo & Tinto', 'Croissant de Almendras');
    await Product.updateOne({ _id: product._id }, { stock: 1 });
    const other = await User.findOne({ phone: TESTE_CLIENTS[1].phone });
    const body = (who: any) => ({
      clientId: who._id.toString(), businessId: business._id.toString(),
      items: [{ productId: product._id.toString(), quantity: 1 }], paymentMethod: 'online' as any,
      deliveryAddress: 'x', deliveryLatitude: deliverTo.lat, deliveryLongitude: deliverTo.lng,
    });
    const results = await Promise.allSettled([orderService.create(body(client)), orderService.create(body(other))]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await Product.findById(product._id))!.stock).toBe(0);

    const torta = await findProduct('Trigo & Tinto', 'Torta de Zanahoria');
    const res = await order(torta.business, [{ productId: torta.product._id.toString(), quantity: 1 }]);
    expect(res.status).toBe(400);
    const carta = await request(app).get(`/api/v1/products/business/${torta.business._id}`).expect(200);
    expect(carta.body.data.some((p: any) => p.name === 'Torta de Zanahoria')).toBe(false);
  });

  it('P-01: Punto Fresco rechaza un pedido por debajo del mínimo de $15.000', async () => {
    const { business, product } = await findProduct('Autoservicio Punto Fresco', 'Agua sin Gas 600 ml');
    const res = await order(business, [{ productId: product._id.toString(), quantity: 2, selectedExtras: [pick(product, 'Temperatura', 'Fría')] }]);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('A-01: el six pack marca el pedido para pedir cédula', async () => {
    const { business, product } = await findProduct('Autoservicio Punto Fresco', 'Cerveza Nacional six pack');
    const res = await order(business, [{ productId: product._id.toString(), quantity: 1, selectedExtras: [pick(product, 'Temperatura', 'Fría')] }]);
    expect(res.status).toBe(201);
    expect(res.body.data.requiresAgeVerification).toBe(true);
  });

  it('B-01: con el interruptor cerrado el negocio no acepta pedidos ni aparece en la lista', async () => {
    const { business, product } = await findProduct('Trigo & Tinto', 'Tinto Campesino');
    await Business.updateOne({ _id: business._id }, { isActive: false });
    const res = await order(business, [{ productId: product._id.toString(), quantity: 1,
      selectedExtras: [pick(product, 'Tamaño', '8 oz'), pick(product, 'Endulzante', 'Panela')] }]);
    expect(res.status).toBe(404);
    const list = await request(app).get('/api/v1/businesses').query({ lat: deliverTo.lat, lng: deliverTo.lng }).expect(200);
    expect(list.body.data.some((b: any) => b.name === 'Trigo & Tinto')).toBe(false);
  });

  it('O-01 / O-02 / O-03: el flujo completo, la cancelación del cliente y el rechazo del comercio', async () => {
    const { business, product } = await findProduct('Autoservicio Punto Fresco', 'Huevos AA x30');
    const owner = await User.findOne({ phone: TESTE_BUSINESSES[4].owner.phone });
    const driverUser = await makeUser({ role: UserRole.DRIVER });
    await makeDriver(driverUser._id, { currentFund: 200_000 });

    // O-02: cancelar devuelve el inventario.
    const first = await order(business, [{ productId: product._id.toString(), quantity: 2 }]);
    expect(first.status).toBe(201);
    expect((await Product.findById(product._id))!.stock).toBe(10);
    await request(app).patch(`/api/v1/orders/${first.body.data._id}/status`).set(await authHeader(client))
      .send({ status: 'cancelled', cancellationCode: 'client_changed_mind' }).expect(200);
    expect((await Product.findById(product._id))!.stock).toBe(12);

    // O-03: el comercio rechaza con motivo del catálogo.
    const second = await order(business, [{ productId: product._id.toString(), quantity: 1 }]);
    const rejected = await request(app).patch(`/api/v1/orders/${second.body.data._id}/status`).set(await authHeader(owner!))
      .send({ status: 'cancelled', cancellationCode: 'business_out_of_stock', cancellationReason: 'Se acabaron' }).expect(200);
    expect(rejected.body.data.cancellationCode).toBe('business_out_of_stock');

    // O-01: aceptar → preparar → listo → domiciliario → entregado. Contra
    // entrega: un pedido en línea queda bloqueado hasta que Wompi confirme
    // el pago, y aquí no hay pasarela.
    const third = await order(business, [{ productId: product._id.toString(), quantity: 1 }], {
      paymentMethod: 'cash_on_delivery',
      cashPayment: { needsChange: false },
    });
    expect(third.status).toBe(201);
    const orderId = third.body.data._id;
    for (const status of ['accepted', 'preparing', 'ready']) {
      await request(app).patch(`/api/v1/orders/${orderId}/status`).set(await authHeader(owner!)).send({ status }).expect(200);
    }
    await request(app).patch(`/api/v1/orders/${orderId}/assign-driver`).set(await authHeader(driverUser)).expect(200);
    await runDelivery(orderId, driverUser);
    expect((await Order.findById(orderId))!.status).toBe(OrderStatus.DELIVERED);

    const timeline = await request(app).get(`/api/v1/orders/${orderId}/timeline`).set(await authHeader(client)).expect(200);
    expect(timeline.body.data.length).toBeGreaterThanOrEqual(6);

    // Y con pedidos hechos, el validador sigue en PASS.
    const report = await validateTeste();
    expect(report.findings.filter((f) => f.severity === 'high')).toEqual([]);
    expect(report.counts.orders).toBe(3);
  });

  it('R-01: "Lo de siempre" reconstruye la misma selección con los mismos optionId', async () => {
    const { business, product } = await findProduct('Trigo & Tinto', 'Capuchino');
    const selection = [pick(product, 'Tamaño', '12 oz'), pick(product, 'Leche', 'Almendras'), pick(product, 'Endulzante', 'Stevia'), pick(product, 'Extra shot', 'Shot adicional de espresso')];
    const first = await order(business, [{ productId: product._id.toString(), quantity: 1, selectedExtras: selection }]);
    expect(first.status).toBe(201);
    expect(first.body.data.subtotal).toBe(7500 + 1500 + 2000 + 2500);

    // Lo que hace `reorder` en el teléfono: copiar ids y cantidades del pedido anterior.
    const again = first.body.data.items.map((item: any) => ({
      productId: item.productId, quantity: item.quantity,
      selectedExtras: item.selectedExtras.map((e: any) => ({ name: e.name, quantity: e.quantity, groupId: e.groupId, optionId: e.optionId })),
    }));
    const second = await order(business, again);
    expect(second.status).toBe(201);
    expect(second.body.data.subtotal).toBe(first.body.data.subtotal);
    expect(second.body.data.items[0].selectedExtras.map((e: any) => e.optionId)).toEqual(first.body.data.items[0].selectedExtras.map((e: any) => e.optionId));
  });
});
