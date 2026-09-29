import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import app from '../app';
import { UserRole } from '../types';
import {
  GARZON, offsetKm, makeUser, makeBusiness, makeProduct, authHeader, makePricingConfig,
} from './factories';

/**
 * El contrato de la API, fotografiado antes de tocarla.
 *
 * Los grupos de modificadores tocan el precio, el pedido y la ficha del
 * producto: justo las rutas que consumen la app, el panel y los
 * domiciliarios instalados en teléfonos que no se actualizan el mismo día.
 * Esta prueba guarda, para cada ruta principal, el código de estado, la
 * **forma** del JSON (claves y tipos, nunca ids ni fechas) y el dinero, y
 * exige que después del cambio todo siga igual o solo haya crecido.
 *
 * "Solo crecer" tiene una lista cerrada: un campo nuevo que no esté en
 * `ALLOWED_NEW_KEYS` también rompe la prueba. Así una ampliación es una
 * decisión escrita y no un accidente que nadie revisó.
 *
 * La línea base se genera con `UPDATE_CONTRACT=1 npx vitest run apiContract`
 * y se guarda junto a la prueba. Regenerarla es aceptar un cambio de
 * contrato: no se hace para que una prueba pase.
 */

const BASELINE = path.join(__dirname, '__contracts__', 'api-contract.baseline.json');
const UPDATE = process.env.UPDATE_CONTRACT === '1';

/** Campos que la función de grupos de modificadores puede añadir. */
const ALLOWED_NEW_KEYS = new Set([
  'modifierGroups',
  'isRequired',
  'selectionType',
  'groupId',
  'groupName',
  'optionId',

  // ── Encabezado de la ficha de negocio (2026-09-17) ──
  // Los tres son aditivos y opcionales: un cliente compilado que no los
  // conozca los ignora y sigue pintando la ficha igual que antes.
  'brandColor',
  'showPromoBanner',
  /** Solo en la ficha individual, nunca en el listado. Puede venir `null`. */
  'deliveryFeeFrom',

  // ── Promociones automáticas por producto (2026-09-28) ──
  // Aditivos: la cotización y el pedido dicen qué promociones sin código
  // aplicaron. Un cliente viejo los ignora; el descuento ya va dentro de
  // `total`. Los campos de vigencia del envío gratis NO están aquí a
  // propósito: el servidor los resuelve y no salen crudos.
  'promotionDiscount',
  'appliedAutoPromotions',
  'appliedPromotionIds',

  // ── Tiempo de preparación por producto ──
  // Opcional y aditivo (`null` hereda el del negocio). Estaba en uso desde
  // antes del 2026-09-15 sin declararse aquí; se autorizó el 2026-09-19.
  'prepTimeMinutes',

  // ── Mi cuenta y productos +18 (2026-09-19) ──
  // Aditivo en la cotización: un cliente viejo lo ignora y el servidor sigue
  // rechazando el pedido si falta la fecha de nacimiento.
  'requiresAgeVerification',

  // ── El mejor cupón para el carrito (2026-09-19) ──
  // Aditivo y siempre `null` cuando el pedido ya trae cupón. Un cliente
  // compilado que no lo conozca sigue pidiendo el código a mano, que es
  // exactamente lo que hacía antes.
  'suggestedCoupon',

  // ── Zipp Pro (2026-09-20) ──
  // Aditivos en la cotización y siempre 0 sin membresía, así que un cliente
  // compilado que no los conozca ve exactamente lo de antes. El ahorro ya
  // está dentro de `total`: estos dos solo explican de dónde viene.
  'proDeliveryDiscount',
  'proServiceFeeDiscount',

  // ── Etiquetas de producto (2026-09-20) ──
  // Aditivo y siempre presente, aunque sea como array vacío mientras el
  // relleno (`scripts/backfillProductTags.ts`) no haya corrido. Un cliente
  // compilado que no lo conozca lo ignora y pinta la carta igual: nada de
  // lo que ya se pintaba depende de este campo. Existe para que las
  // colecciones de descubrimiento consulten un array indexado en vez de una
  // regex sin ancla sobre el nombre del plato.
  'tags',
]);

type Shape = string | Shape[] | { [key: string]: Shape };

/** Claves y tipos, sin valores: lo que un cliente compilado espera encontrar. */
function shapeOf(value: unknown): Shape {
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.length ? [shapeOf(value[0])] : [];
  if (typeof value === 'object') {
    const out: Record<string, Shape> = {};
    for (const key of Object.keys(value as object).sort()) {
      out[key] = shapeOf((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return typeof value;
}

/**
 * Diferencias de `after` respecto a `before` que rompen a un cliente.
 *
 * Una clave que desaparece o cambia de tipo es ruptura. Una clave nueva
 * solo se tolera si está en la lista. Un array vacío en un lado no dice
 * nada de la forma de sus elementos, así que no se compara por dentro.
 */
function breakingChanges(before: Shape, after: Shape, at = '$'): string[] {
  if (typeof before === 'string' || typeof after === 'string') {
    return before === after ? [] : [`${at}: ${JSON.stringify(before)} → ${JSON.stringify(after)}`];
  }
  if (Array.isArray(before) || Array.isArray(after)) {
    if (!Array.isArray(before) || !Array.isArray(after)) return [`${at}: cambió entre array y objeto`];
    if (!before.length || !after.length) return [];
    return breakingChanges(before[0], after[0], `${at}[0]`);
  }
  const problems: string[] = [];
  for (const key of Object.keys(before)) {
    if (!(key in after)) problems.push(`${at}.${key}: desapareció`);
    else problems.push(...breakingChanges(before[key], after[key], `${at}.${key}`));
  }
  for (const key of Object.keys(after)) {
    if (!(key in before) && !ALLOWED_NEW_KEYS.has(key)) problems.push(`${at}.${key}: campo nuevo no autorizado`);
  }
  return problems;
}

interface Capture {
  status: number;
  shape: Shape;
  /** Solo dinero y cantidades: los valores que no pueden moverse. */
  money?: unknown;
}

const moneyOfQuote = (d: any) => ({
  subtotal: d.subtotal,
  productSubtotal: d.productSubtotal,
  deliveryFee: d.deliveryFee,
  total: d.total,
  items: (d.items ?? []).map((i: any) => ({
    quantity: i.quantity,
    unitPrice: i.unitPrice,
    totalPrice: i.totalPrice,
    selectedExtras: (i.selectedExtras ?? []).map((e: any) => ({ name: e.name, price: e.price, quantity: e.quantity })),
  })),
});

const DESTINATION = offsetKm(GARZON, 2);
const PASSWORD = 'Clave.Segura123';

async function captureAll(): Promise<Record<string, Capture>> {
  await makePricingConfig();
  const client = await makeUser({ role: UserRole.CLIENT, phone: '3107770001', password: PASSWORD });
  const otherClient = await makeUser({ role: UserRole.CLIENT, phone: '3107770002' });
  const owner = await makeUser({ role: UserRole.BUSINESS, phone: '3107770003' });
  const otherOwner = await makeUser({ role: UserRole.BUSINESS, phone: '3107770004' });

  const business = await makeBusiness(owner._id, { name: 'Contrato Principal' });
  const otherBusiness = await makeBusiness(otherOwner._id, { name: 'Contrato Ajeno' });
  const legacy = await makeProduct(business._id, {
    name: 'Hamburguesa heredada',
    price: 20000,
    extras: [{ name: 'Queso extra', price: 3000 }, { name: 'Tocineta', price: 3500 }],
  });
  const plain = await makeProduct(business._id, { name: 'Gaseosa sin extras', price: 4500 });
  const foreign = await makeProduct(otherBusiness._id, { name: 'Producto ajeno', price: 9000 });

  const body = (items: unknown[], extra: Record<string, unknown> = {}) => ({
    businessId: business._id.toString(),
    items,
    paymentMethod: 'online',
    deliveryAddress: 'Calle 5 # 3-21',
    deliveryLatitude: DESTINATION.lat,
    deliveryLongitude: DESTINATION.lng,
    ...extra,
  });
  const legacyItems = [
    { productId: legacy._id.toString(), quantity: 2, selectedExtras: [{ name: 'Queso extra', quantity: 2 }, { name: 'Tocineta' }] },
    { productId: plain._id.toString(), quantity: 3 },
  ];

  const out: Record<string, Capture> = {};
  const keep = (name: string, res: request.Response, money?: (body: any) => unknown) => {
    out[name] = {
      status: res.status,
      shape: shapeOf(res.body),
      ...(money && res.status < 300 ? { money: money(res.body.data) } : {}),
    };
  };

  keep('auth.login.ok', await request(app).post('/api/v1/auth/login').send({ phone: '3107770001', password: PASSWORD }));
  keep('auth.login.wrongPassword', await request(app).post('/api/v1/auth/login').send({ phone: '3107770001', password: 'Incorrecta.1' }));

  keep('business.list', await request(app).get('/api/v1/businesses').query({ lat: GARZON.lat, lng: GARZON.lng }));
  keep('business.byId', await request(app).get(`/api/v1/businesses/${business._id}`));
  keep('product.byBusiness', await request(app).get(`/api/v1/products/business/${business._id}`));
  keep('product.byId.legacyExtras', await request(app).get(`/api/v1/products/${legacy._id}`));
  keep('product.byId.plain', await request(app).get(`/api/v1/products/${plain._id}`));

  keep('order.quote.legacy', await request(app).post('/api/v1/orders/quote').set(await authHeader(client)).send(body(legacyItems)), moneyOfQuote);
  keep('order.quote.unknownExtra', await request(app).post('/api/v1/orders/quote').set(await authHeader(client))
    .send(body([{ productId: legacy._id.toString(), quantity: 1, selectedExtras: [{ name: 'Trufa' }] }])));
  keep('order.quote.foreignProduct', await request(app).post('/api/v1/orders/quote').set(await authHeader(client))
    .send(body([{ productId: foreign._id.toString(), quantity: 1 }])));
  keep('order.quote.clientPriceIgnored', await request(app).post('/api/v1/orders/quote').set(await authHeader(client))
    .send(body([{ productId: legacy._id.toString(), quantity: 1, selectedExtras: [{ name: 'Queso extra', price: -999999 }] }])), moneyOfQuote);

  keep('order.create.unauthenticated', await request(app).post('/api/v1/orders').send(body(legacyItems)));
  keep('order.create.asBusiness', await request(app).post('/api/v1/orders').set(await authHeader(owner)).send(body(legacyItems)));
  keep('order.create.emptyItems', await request(app).post('/api/v1/orders').set(await authHeader(client)).send(body([])));

  const created = await request(app).post('/api/v1/orders').set(await authHeader(client))
    .send(body(legacyItems, { idempotencyKey: 'contrato-1' }));
  keep('order.create.legacy', created, moneyOfQuote);
  const orderId = created.body?.data?._id;

  keep('order.my', await request(app).get('/api/v1/orders/my').set(await authHeader(client)));
  keep('order.byId.owner', await request(app).get(`/api/v1/orders/${orderId}`).set(await authHeader(client)));
  keep('order.byId.otherClient', await request(app).get(`/api/v1/orders/${orderId}`).set(await authHeader(otherClient)));
  keep('order.status.clientAccepts', await request(app).patch(`/api/v1/orders/${orderId}/status`).set(await authHeader(client)).send({ status: 'accepted' }));
  keep('order.status.businessAccepts', await request(app).patch(`/api/v1/orders/${orderId}/status`).set(await authHeader(owner)).send({ status: 'accepted' }));

  keep('product.update.owner', await request(app).put(`/api/v1/products/${plain._id}`).set(await authHeader(owner))
    .send({ businessId: business._id.toString(), price: 5000 }));
  keep('product.update.otherOwner', await request(app).put(`/api/v1/products/${plain._id}`).set(await authHeader(otherOwner))
    .send({ businessId: otherBusiness._id.toString(), price: 1 }));
  keep('product.update.otherOwnerSpoofedBusiness', await request(app).put(`/api/v1/products/${plain._id}`).set(await authHeader(otherOwner))
    .send({ businessId: business._id.toString(), price: 1 }));

  return out;
}

describe('Contrato de la API — solo puede crecer', () => {
  it('estados, forma del JSON y dinero siguen como en la línea base', async () => {
    const current = await captureAll();

    if (UPDATE || !fs.existsSync(BASELINE)) {
      fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
      fs.writeFileSync(BASELINE, JSON.stringify(current, null, 2) + '\n');
      if (UPDATE) return;
    }

    const baseline: Record<string, Capture> = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
    const problems: string[] = [];

    for (const [name, before] of Object.entries(baseline)) {
      const after = current[name];
      if (!after) { problems.push(`${name}: la ruta ya no se captura`); continue; }
      if (after.status !== before.status) problems.push(`${name}: estado ${before.status} → ${after.status}`);
      problems.push(...breakingChanges(before.shape, after.shape, name));
      if (JSON.stringify(after.money) !== JSON.stringify(before.money)) {
        problems.push(`${name}: dinero ${JSON.stringify(before.money)} → ${JSON.stringify(after.money)}`);
      }
    }

    expect(problems).toEqual([]);
  });
});
