import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { Product, Order } from '../models';
import { UserRole, PaymentMethod, OrderStatus } from '../types';
import { pricingService } from '../services/pricing.service';
import { orderService } from '../services/order.service';
import { resolveModifierSelection } from '../utils/modifierSelection';
import {
  GARZON, offsetKm, makeUser, makeBusiness, makeProduct, makePricingConfig, authHeader, pick,
} from './factories';

/**
 * Grupos de modificadores: "Tipo de carne" (obligatorio, uno), "Salsas"
 * (hasta tres), "Tamaño" (uno). Antes solo existían `extras` planos, sin
 * mínimo, máximo ni obligatorios: el comercio no tenía forma de decir "sin
 * elegir la carne no hay hamburguesa".
 *
 * Todo lo que se cobra sale de la base de datos. El cliente manda ids; el
 * nombre y el precio los pone el servidor. Y la carta anterior —productos
 * sin grupos, con `extras` de nombre y precio— sigue funcionando igual:
 * buena parte de estas pruebas existe para que eso no cambie sin querer.
 */

const DESTINATION = offsetKm(GARZON, 2);

const BURGER_GROUPS = [
  {
    name: 'Tipo de carne', minSelect: 1, maxSelect: 1, sortOrder: 0,
    options: [{ name: 'Res 120 g', price: 0 }, { name: 'Angus 150 g', price: 7000 }, { name: 'Pollo', price: 0 }],
  },
  {
    name: 'Queso', minSelect: 0, maxSelect: 1, sortOrder: 1,
    options: [{ name: 'Cheddar', price: 2500 }, { name: 'Mozzarella', price: 2500 }],
  },
  {
    name: 'Salsas', minSelect: 0, maxSelect: 3, sortOrder: 2,
    options: [
      { name: 'BBQ', price: 0 }, { name: 'Chipotle', price: 1000 }, { name: 'Ranch', price: 0 },
      { name: 'Ajo', price: 0 }, { name: 'Trufa', price: 3000, isAvailable: false },
    ],
  },
  {
    name: 'Acompañantes', minSelect: 2, maxSelect: 2, sortOrder: 3,
    options: [{ name: 'Papas', price: 0 }, { name: 'Ensalada', price: 0 }, { name: 'Arroz', price: 0 }],
  },
];

describe('Grupos de modificadores', () => {
  let client: any;
  let owner: any;
  let business: any;
  let burger: any;

  const body = (items: unknown[], extra: Record<string, unknown> = {}) => ({
    businessId: business._id.toString(),
    items,
    paymentMethod: 'online',
    deliveryAddress: 'Calle 5 # 3-21',
    deliveryLatitude: DESTINATION.lat,
    deliveryLongitude: DESTINATION.lng,
    ...extra,
  });

  const quote = (items: unknown[]) =>
    request(app).post('/api/v1/orders/quote').set(authHeader(client)).send(body(items));

  const minimal = () => [
    pick(burger, 'Tipo de carne', 'Res 120 g'),
    pick(burger, 'Acompañantes', 'Papas'),
    pick(burger, 'Acompañantes', 'Ensalada'),
  ];

  beforeEach(async () => {
    await makePricingConfig();
    client = await makeUser({ role: UserRole.CLIENT });
    owner = await makeUser({ role: UserRole.BUSINESS });
    business = await makeBusiness(owner._id);
    burger = await makeProduct(business._id, {
      name: 'Clásica de la Casa',
      price: 22900,
      extras: [{ name: 'Huevo frito', price: 2000 }],
      modifierGroups: BURGER_GROUPS,
    });
  });

  // ── Modelo y validación del producto ──────────────────────────────

  describe('modelo', () => {
    it('deriva obligatorio y tipo de selección de mínimo y máximo', async () => {
      const json = (await Product.findById(burger._id))!.toJSON() as any;
      const [carne, queso, salsas, acomp] = json.modifierGroups;
      expect(carne).toMatchObject({ isRequired: true, selectionType: 'single' });
      expect(queso).toMatchObject({ isRequired: false, selectionType: 'single' });
      expect(salsas).toMatchObject({ isRequired: false, selectionType: 'multiple' });
      expect(acomp).toMatchObject({ isRequired: true, selectionType: 'multiple', minSelect: 2, maxSelect: 2 });
      expect(carne._id).toBeDefined();
      expect(carne.options[0]._id).toBeDefined();
      expect(salsas.options[4].isAvailable).toBe(false);
    });

    it('rechaza límites incoherentes en el modelo', async () => {
      await expect(
        makeProduct(business._id, {
          modifierGroups: [{ name: 'Mal', minSelect: 2, maxSelect: 1, options: [{ name: 'a', price: 0 }, { name: 'b', price: 0 }] }],
        })
      ).rejects.toThrow();
      await expect(
        makeProduct(business._id, {
          modifierGroups: [{ name: 'Mal', minSelect: 0, maxSelect: 3, options: [{ name: 'a', price: 0 }] }],
        })
      ).rejects.toThrow();
      await expect(
        makeProduct(business._id, { modifierGroups: [{ name: 'Vacío', minSelect: 0, maxSelect: 1, options: [] }] })
      ).rejects.toThrow();
    });

    it('SEC-09: el validador de la ruta rechaza grupos mal formados con 400', async () => {
      const base = { businessId: business._id.toString() };
      const cases = [
        { name: 'Mín > máx', minSelect: 2, maxSelect: 1, options: [{ name: 'a', price: 0 }, { name: 'b', price: 0 }] },
        { name: 'Máx > opciones', minSelect: 0, maxSelect: 5, options: [{ name: 'a', price: 0 }] },
        { name: 'Precio negativo', minSelect: 0, maxSelect: 1, options: [{ name: 'a', price: -100 }] },
        { name: 'Precio decimal', minSelect: 0, maxSelect: 1, options: [{ name: 'a', price: 2500.5 }] },
        { name: 'Repetidas', minSelect: 0, maxSelect: 1, options: [{ name: 'a', price: 0 }, { name: 'A', price: 0 }] },
      ];
      for (const group of cases) {
        const res = await request(app).put(`/api/v1/products/${burger._id}`).set(authHeader(owner))
          .send({ ...base, modifierGroups: [group] });
        expect(res.status, group.name).toBe(400);
      }
      const untouched = await Product.findById(burger._id);
      expect(untouched!.modifierGroups).toHaveLength(4);
    });

    it('R-11: crear sin inventario deja `stock` en null, no en cero', async () => {
      const res = await request(app).post('/api/v1/products').set(authHeader(owner)).send({
        businessId: business._id.toString(),
        categoryId: burger.categoryId.toString(),
        name: 'Sin inventario',
        price: 5000,
      });
      expect(res.status).toBe(201);
      const saved = await Product.findById(res.body.data._id);
      expect(saved!.stock).toBeNull();
      expect(saved!.isAvailable).toBe(true);
      expect(saved!.requiresAgeVerification).toBe(false);
      expect(saved!.modifierGroups).toEqual([]);
    });

    it('L-6: crear con inventario, umbral y mayoría de edad los guarda (antes se perdían)', async () => {
      const res = await request(app).post('/api/v1/products').set(authHeader(owner)).send({
        businessId: business._id.toString(),
        categoryId: burger.categoryId.toString(),
        name: 'Cerveza',
        price: 22000,
        stock: 12,
        lowStockThreshold: 3,
        requiresAgeVerification: true,
      });
      expect(res.status).toBe(201);
      const saved = await Product.findById(res.body.data._id);
      expect(saved!.stock).toBe(12);
      expect(saved!.lowStockThreshold).toBe(3);
      expect(saved!.requiresAgeVerification).toBe(true);
    });
  });

  // ── Resolución pura ───────────────────────────────────────────────

  describe('resolveModifierSelection', () => {
    const plain = (p: any) => p.toObject();

    it('con la selección mínima válida suma cero y copia grupo y opción', () => {
      const { lines, total } = resolveModifierSelection(plain(burger), minimal());
      expect(total).toBe(0);
      expect(lines).toHaveLength(3);
      expect(lines[0]).toMatchObject({ name: 'Res 120 g', price: 0, quantity: 1, groupName: 'Tipo de carne' });
      expect(lines[0].groupId).toBe(burger.modifierGroups[0]._id.toString());
      expect(lines[0].optionId).toBe(burger.modifierGroups[0].options[0]._id.toString());
    });

    it('con la selección máxima suma todos los precios de la base de datos', () => {
      const { total } = resolveModifierSelection(plain(burger), [
        pick(burger, 'Tipo de carne', 'Angus 150 g'),
        pick(burger, 'Queso', 'Cheddar'),
        pick(burger, 'Salsas', 'BBQ'), pick(burger, 'Salsas', 'Chipotle'), pick(burger, 'Salsas', 'Ranch'),
        pick(burger, 'Acompañantes', 'Papas'), pick(burger, 'Acompañantes', 'Arroz'),
      ]);
      expect(total).toBe(7000 + 2500 + 1000);
    });

    it('M-02: falta un grupo obligatorio', () => {
      expect(() => resolveModifierSelection(plain(burger), [
        pick(burger, 'Acompañantes', 'Papas'), pick(burger, 'Acompañantes', 'Ensalada'),
      ])).toThrow(expect.objectContaining({ code: 'MODIFIER_REQUIRED', statusCode: 400 }));
    });

    it('M-03: un grupo con mínimo 2 y una sola elección', () => {
      expect(() => resolveModifierSelection(plain(burger), [
        pick(burger, 'Tipo de carne', 'Res 120 g'), pick(burger, 'Acompañantes', 'Papas'),
      ])).toThrow(expect.objectContaining({ code: 'MODIFIER_REQUIRED' }));
    });

    it('M-04: más opciones que el máximo', () => {
      expect(() => resolveModifierSelection(plain(burger), [
        ...minimal(),
        pick(burger, 'Salsas', 'BBQ'), pick(burger, 'Salsas', 'Chipotle'),
        pick(burger, 'Salsas', 'Ranch'), pick(burger, 'Salsas', 'Ajo'),
      ])).toThrow(expect.objectContaining({ code: 'MODIFIER_TOO_MANY' }));
    });

    it('M-05: una opción agotada', () => {
      expect(() => resolveModifierSelection(plain(burger), [...minimal(), pick(burger, 'Salsas', 'Trufa')]))
        .toThrow(expect.objectContaining({ code: 'MODIFIER_UNAVAILABLE' }));
    });

    it('SEC-08: la misma opción dos veces', () => {
      expect(() => resolveModifierSelection(plain(burger), [...minimal(), pick(burger, 'Salsas', 'BBQ'), pick(burger, 'Salsas', 'BBQ')]))
        .toThrow(expect.objectContaining({ code: 'MODIFIER_DUPLICATE' }));
    });

    it('SEC-02b: una opción válida bajo el grupo equivocado', () => {
      const wrong = { groupId: pick(burger, 'Queso', 'Cheddar').groupId, optionId: pick(burger, 'Salsas', 'BBQ').optionId };
      expect(() => resolveModifierSelection(plain(burger), [...minimal(), wrong]))
        .toThrow(expect.objectContaining({ code: 'MODIFIER_UNKNOWN' }));
    });

    it('un producto sin grupos rechaza cualquier optionId', () => {
      expect(() => resolveModifierSelection({ name: 'Gaseosa', modifierGroups: [] }, [pick(burger, 'Queso', 'Cheddar')]))
        .toThrow(expect.objectContaining({ code: 'MODIFIER_UNKNOWN' }));
      expect(resolveModifierSelection({ name: 'Gaseosa', modifierGroups: [] }, [])).toEqual({ lines: [], total: 0 });
    });
  });

  // ── Precio y pedido por HTTP ──────────────────────────────────────

  describe('cotización y pedido', () => {
    it('M-01: la combinación máxima por dos cobra exactamente lo esperado', async () => {
      const res = await quote([{
        productId: burger._id.toString(), quantity: 2,
        selectedExtras: [
          pick(burger, 'Tipo de carne', 'Angus 150 g'),
          pick(burger, 'Queso', 'Cheddar'),
          pick(burger, 'Salsas', 'Chipotle'),
          pick(burger, 'Acompañantes', 'Papas'), pick(burger, 'Acompañantes', 'Ensalada'),
          { name: 'Huevo frito', quantity: 2 },
        ],
      }]);
      expect(res.status).toBe(200);
      // (22.900 + 7.000 + 2.500 + 1.000 + 2×2.000) × 2
      expect(res.body.data.items[0].totalPrice).toBe((22900 + 7000 + 2500 + 1000 + 4000) * 2);
      expect(res.body.data.subtotal).toBe(74800);
      expect(res.body.data.items[0].selectedExtras).toHaveLength(6);
    });

    it('R-04: extras planos y grupos no se confunden aunque compartan nombre', async () => {
      const mixed = await makeProduct(business._id, {
        name: 'Mixto', price: 10000,
        extras: [{ name: 'Cheddar', price: 500 }],
        modifierGroups: [{ name: 'Queso', minSelect: 0, maxSelect: 1, options: [{ name: 'Cheddar', price: 2500 }] }],
      });
      const res = await quote([{
        productId: mixed._id.toString(), quantity: 1,
        selectedExtras: [{ name: 'Cheddar' }, pick(mixed, 'Queso', 'Cheddar')],
      }]);
      expect(res.status).toBe(200);
      expect(res.body.data.items[0].totalPrice).toBe(10000 + 500 + 2500);
      const lines = res.body.data.items[0].selectedExtras;
      const flat = lines.find((l: any) => !l.optionId);
      const grouped = lines.find((l: any) => l.optionId);
      expect(flat).toMatchObject({ name: 'Cheddar', price: 500 });
      expect(flat.optionId).toBeUndefined();
      expect(grouped).toMatchObject({ name: 'Cheddar', price: 2500, groupName: 'Queso' });
    });

    it('M-06 / SEC-04: el precio enviado por el cliente se ignora en opciones y en extras', async () => {
      const res = await quote([{
        productId: burger._id.toString(), quantity: 1,
        selectedExtras: [
          { ...pick(burger, 'Tipo de carne', 'Angus 150 g'), price: -999999 },
          { ...pick(burger, 'Acompañantes', 'Papas'), price: 0 },
          { ...pick(burger, 'Acompañantes', 'Ensalada'), price: 999999999 },
          { name: 'Huevo frito', price: 1 },
        ],
        unitPrice: 1, totalPrice: 1,
      }]);
      expect(res.status).toBe(200);
      expect(res.body.data.items[0].unitPrice).toBe(22900);
      expect(res.body.data.items[0].totalPrice).toBe(22900 + 7000 + 2000);
    });

    it('la API devuelve el código del error para que la app reaccione', async () => {
      const res = await quote([{ productId: burger._id.toString(), quantity: 1, selectedExtras: [] }]);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('MODIFIER_REQUIRED');
      expect(res.body.message).toContain('Tipo de carne');
    });

    it('SEC-01 / SEC-02: ids de otro producto', async () => {
      const other = await makeProduct(business._id, {
        name: 'Otra', price: 5000,
        modifierGroups: [{ name: 'Tamaño', minSelect: 1, maxSelect: 1, options: [{ name: 'Grande', price: 2000 }] }],
      });
      const foreign = pick(other, 'Tamaño', 'Grande');

      const byOption = await quote([{ productId: burger._id.toString(), quantity: 1,
        selectedExtras: [...minimal(), { groupId: pick(burger, 'Queso', 'Cheddar').groupId, optionId: foreign.optionId }] }]);
      expect(byOption.status).toBe(400);
      expect(byOption.body.code).toBe('MODIFIER_UNKNOWN');

      const byGroup = await quote([{ productId: burger._id.toString(), quantity: 1, selectedExtras: [...minimal(), foreign] }]);
      expect(byGroup.status).toBe(400);
      expect(byGroup.body.code).toBe('MODIFIER_UNKNOWN');
    });

    it('SEC-07: ids mal formados o con operadores no pasan la validación', async () => {
      for (const optionId of ['abc', { $ne: null }, '000000000000000000000000; drop']) {
        const res = await quote([{ productId: burger._id.toString(), quantity: 1,
          selectedExtras: [...minimal(), { groupId: minimal()[0].groupId, optionId }] }]);
        expect(res.status).toBe(400);
      }
      const orphan = await quote([{ productId: burger._id.toString(), quantity: 1,
        selectedExtras: [...minimal(), { optionId: minimal()[0].optionId }] }]);
      expect(orphan.status).toBe(400);
    });

    it('R-06 / R-07: el pedido copia la selección y no cambia si el producto cambia después', async () => {
      const created = await request(app).post('/api/v1/orders').set(authHeader(client)).send(body([{
        productId: burger._id.toString(), quantity: 1,
        selectedExtras: [pick(burger, 'Tipo de carne', 'Angus 150 g'), pick(burger, 'Acompañantes', 'Papas'), pick(burger, 'Acompañantes', 'Ensalada')],
      }])).expect(201);

      const before = (await Order.findById(created.body.data._id))!.toObject();
      expect(before.items[0].totalPrice).toBe(29900);
      expect(before.items[0].selectedExtras[0]).toMatchObject({ name: 'Angus 150 g', price: 7000, groupName: 'Tipo de carne' });

      // El comercio sube precios y borra la opción.
      await request(app).put(`/api/v1/products/${burger._id}`).set(authHeader(owner)).send({
        businessId: business._id.toString(),
        price: 30000,
        modifierGroups: [{ name: 'Tipo de carne', minSelect: 1, maxSelect: 1, options: [{ name: 'Res 120 g', price: 0 }] }],
      }).expect(200);

      const after = (await Order.findById(created.body.data._id))!.toObject();
      expect(after.items).toEqual(before.items);
      expect(after.subtotal).toBe(before.subtotal);
      expect(after.finance.productSubtotal).toBe(before.finance.productSubtotal);
    });

    it('R-09: cancelar devuelve el stock exacto con dos líneas del mismo producto', async () => {
      await Product.updateOne({ _id: burger._id }, { stock: 10 });
      const order = await orderService.create({
        clientId: client._id.toString(),
        businessId: business._id.toString(),
        items: [
          { productId: burger._id.toString(), quantity: 2, selectedExtras: minimal() },
          { productId: burger._id.toString(), quantity: 3, selectedExtras: [pick(burger, 'Tipo de carne', 'Pollo'), pick(burger, 'Acompañantes', 'Papas'), pick(burger, 'Acompañantes', 'Arroz')] },
        ],
        paymentMethod: PaymentMethod.ONLINE,
        deliveryAddress: 'Cra 1 #2-3',
        deliveryLongitude: GARZON.lng,
        deliveryLatitude: GARZON.lat,
      });
      expect((await Product.findById(burger._id))!.stock).toBe(5);
      await orderService.updateStatus(order._id.toString(), OrderStatus.CANCELLED, client._id.toString(), UserRole.CLIENT, 'Cambio de planes');
      expect((await Product.findById(burger._id))!.stock).toBe(10);
    });

    it('CON-01 / CON-04: dos clientes por la última unidad con la misma selección', async () => {
      await Product.updateOne({ _id: burger._id }, { stock: 1 });
      const other = await makeUser({ role: UserRole.CLIENT });
      const results = await Promise.allSettled([client, other].map((who) => orderService.create({
        clientId: who._id.toString(),
        businessId: business._id.toString(),
        items: [{ productId: burger._id.toString(), quantity: 1, selectedExtras: [pick(burger, 'Tipo de carne', 'Angus 150 g'), pick(burger, 'Acompañantes', 'Papas'), pick(burger, 'Acompañantes', 'Ensalada')] }],
        paymentMethod: PaymentMethod.ONLINE,
        deliveryAddress: 'Cra 1 #2-3',
        deliveryLongitude: GARZON.lng,
        deliveryLatitude: GARZON.lat,
      })));
      const ok = results.filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled');
      expect(ok).toHaveLength(1);
      expect(ok[0].value.items[0].totalPrice).toBe(29900);
      expect((await Product.findById(burger._id))!.stock).toBe(0);
    });
  });

  // ── Panel: editar sin romper ──────────────────────────────────────

  describe('edición desde el panel (R-10)', () => {
    it('un PUT sin `modifierGroups` no toca los grupos', async () => {
      await request(app).put(`/api/v1/products/${burger._id}`).set(authHeader(owner))
        .send({ businessId: business._id.toString(), description: 'Nueva descripción' }).expect(200);
      const saved = await Product.findById(burger._id);
      expect(saved!.modifierGroups).toHaveLength(4);
      expect(saved!.extras).toHaveLength(1);
    });

    it('enviar los grupos con sus ids conserva la identidad de opciones', async () => {
      const json = JSON.parse(JSON.stringify((await Product.findById(burger._id))!.toJSON()));
      const groups = json.modifierGroups.map((g: any) => ({
        _id: g._id, name: g.name, minSelect: g.minSelect, maxSelect: g.maxSelect, sortOrder: g.sortOrder,
        options: g.options.map((o: any) => ({ _id: o._id, name: o.name === 'Angus 150 g' ? 'Angus 180 g' : o.name, price: o.price, isAvailable: o.isAvailable })),
      }));
      await request(app).put(`/api/v1/products/${burger._id}`).set(authHeader(owner))
        .send({ businessId: business._id.toString(), modifierGroups: groups }).expect(200);

      const saved = await Product.findById(burger._id);
      expect(saved!.modifierGroups[0]._id!.toString()).toBe(json.modifierGroups[0]._id);
      expect(saved!.modifierGroups[0].options[1]._id!.toString()).toBe(json.modifierGroups[0].options[1]._id);
      expect(saved!.modifierGroups[0].options[1].name).toBe('Angus 180 g');
    });

    it('quitar todos los grupos deja extras, inventario e imagen como estaban', async () => {
      await Product.updateOne({ _id: burger._id }, { stock: 7, image: 'https://img.test/a.jpg' });
      await request(app).put(`/api/v1/products/${burger._id}`).set(authHeader(owner))
        .send({ businessId: business._id.toString(), modifierGroups: [] }).expect(200);
      const saved = await Product.findById(burger._id);
      expect(saved!.modifierGroups).toEqual([]);
      expect(saved!.extras[0].name).toBe('Huevo frito');
      expect(saved!.stock).toBe(7);
      expect(saved!.image).toBe('https://img.test/a.jpg');
    });

    it('SEC-06: el dueño de otro comercio no puede editar los grupos', async () => {
      const intruder = await makeUser({ role: UserRole.BUSINESS });
      const theirs = await makeBusiness(intruder._id);
      const payload = { modifierGroups: [{ name: 'Robo', minSelect: 0, maxSelect: 1, options: [{ name: 'x', price: 0 }] }] };

      await request(app).put(`/api/v1/products/${burger._id}`).set(authHeader(intruder))
        .send({ businessId: theirs._id.toString(), ...payload }).expect(403);
      await request(app).put(`/api/v1/products/${burger._id}`).set(authHeader(intruder))
        .send({ businessId: business._id.toString(), ...payload }).expect(403);

      expect((await Product.findById(burger._id))!.modifierGroups[0].name).toBe('Tipo de carne');
    });

    it('borrar un producto con grupos funciona como siempre', async () => {
      await request(app).delete(`/api/v1/products/${burger._id}`).set(authHeader(owner))
        .send({ businessId: business._id.toString() }).expect(200);
      expect(await Product.findById(burger._id)).toBeNull();
    });
  });

  // ── Regresión: la carta anterior no cambia ───────────────────────

  describe('compatibilidad (R-01, R-02)', () => {
    it('un producto sin grupos ni extras se cotiza igual que siempre', async () => {
      const plain = await makeProduct(business._id, { name: 'Gaseosa', price: 4500 });
      const res = await quote([{ productId: plain._id.toString(), quantity: 3 }]);
      expect(res.status).toBe(200);
      expect(res.body.data.items[0]).toMatchObject({ unitPrice: 4500, totalPrice: 13500, selectedExtras: [] });
      expect(res.body.data.subtotal).toBe(13500);
    });

    it('un producto solo con extras heredados sigue eligiendo por nombre y cantidad', async () => {
      const legacy = await makeProduct(business._id, {
        name: 'Heredado', price: 20000, extras: [{ name: 'Queso extra', price: 3000 }],
      });
      const res = await quote([{ productId: legacy._id.toString(), quantity: 2, selectedExtras: [{ name: 'Queso extra', quantity: 2 }] }]);
      expect(res.status).toBe(200);
      expect(res.body.data.items[0].totalPrice).toBe((20000 + 6000) * 2);
      const extra = res.body.data.items[0].selectedExtras[0];
      expect(extra).toMatchObject({ name: 'Queso extra', price: 3000, quantity: 2 });
      expect(extra.groupId).toBeUndefined();
      expect(extra.optionId).toBeUndefined();
    });

    it('la ficha de un producto sin grupos devuelve `modifierGroups: []`, no `undefined`', async () => {
      const plain = await makeProduct(business._id, { name: 'Agua', price: 2500 });
      const res = await request(app).get(`/api/v1/products/${plain._id}`).expect(200);
      expect(res.body.data.modifierGroups).toEqual([]);
    });
  });
});
