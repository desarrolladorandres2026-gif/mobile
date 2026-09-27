/**
 * Pruebas visibles de la bandeja de alertas, los pedidos y las cancelaciones
 * del panel admin.
 *
 * No es una suite automática: provoca casos para que una persona los vea
 * llegar al panel en vivo, tal como los vería el equipo en producción. Todo
 * lo que tiene flujo real se provoca por la API del backend que está
 * corriendo (pedidos, cancelaciones, SOS, reclamo, entrega completa con
 * códigos y fotos, faltante de efectivo, fraude por salto de GPS): así pasa
 * por los mismos validadores y emite los mismos avisos por socket.
 *
 * Solo `detenida` escribe directo en la base, porque sus alertas dependen del
 * reloj (un pedido quieto 45 minutos, un documento vencido). En producción
 * esas tampoco llegan por socket: las trae el sondeo de 60 s de la bandeja.
 *
 * Todo queda marcado con `[PRUEBA]` (o `PRUEBA-ALERTAS` en referencias) y
 * `--limpiar` borra exactamente eso, fotos de evidencia incluidas, y le
 * devuelve a Luis las cifras que la entrega le cambió.
 *
 * Uso (backend corriendo en local):
 *   npx tsx src/scripts/teste/alertas.ts --db=zipp --bloque=pedidos
 *   npx tsx src/scripts/teste/alertas.ts --db=zipp --bloque=detenida
 *   npx tsx src/scripts/teste/alertas.ts --db=zipp --bloque=vivo
 *   npx tsx src/scripts/teste/alertas.ts --db=zipp --limpiar
 *   --pausa=15   segundos entre pasos (por defecto 15)
 *
 * El login tiene un tope de 10 intentos cada 15 minutos por IP, compartido
 * con los paneles: las sesiones se guardan en un archivo temporal y se
 * renuevan con el refresh token en vez de volver a iniciar sesión.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import mongoose, { Types } from 'mongoose';
import { cloudinary } from '../../config';
import {
  User, Driver, Business, Product, Order, SosAlert, Pqrs, BusinessDocument, DriverDocument,
  CashPaymentIncident, AlertReceipt,
} from '../../models';
import { FraudAlert, FraudAlertType } from '../../security';
import { connectGuarded, parseArgs, TESTE_BASE } from './common';

const BASE = 'http://localhost:3000/api/v1';
const MARK = '[PRUEBA]';
const DOC_REF = 'PRUEBA-ALERTAS';
const MARK_RE = /^\[PRUEBA\]/;
const SESSIONS_FILE = path.join(os.tmpdir(), 'zipp-alertas-sesiones.json');
/** Lo que la limpieza necesita y no se puede marcar con `[PRUEBA]`. */
const MANIFEST_FILE = path.join(os.tmpdir(), 'zipp-alertas-manifiesto.json');
const PHOTO_PATH = path.resolve(__dirname, '../../../../mobile/assets/images/auth-bg.jpg');
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const ACCOUNTS = {
  camila: { phone: '3009990011', password: 'Teste.2026' },
  andres: { phone: '3009990012', password: 'Teste.2026' },
  gloria: { phone: '3009990002', password: 'Teste.2026' },
  pedro: { phone: '3111234567', password: 'Zipp.2026' },
  luis: { phone: '3121234567', password: 'Zipp.2026' },
} as const;
type AccountKey = keyof typeof ACCOUNTS;

const BUSINESS_NAME = 'Sazón de la Tulia';
const LUIS_PHONE = '3121234567';
const DELIVERY = { ...TESTE_BASE, address: 'Carrera 5 # 12-34, barrio Centro' };
/** ~95 km de Garzón: un salto que ninguna moto hace en segundos. */
const NEIVA = { lat: 2.9273, lng: -75.2819 };

const args = parseArgs(process.argv.slice(2));
const PAUSE_MS = Number(args.pausa ?? 15) * 1000;

// ─── Salida ──────────────────────────────────────────────────────────────

let step = 0;
function paso(titulo: string, dondeMirar: string) {
  step += 1;
  const hora = new Date().toLocaleTimeString('es-CO', { timeZone: 'America/Bogota' });
  console.log(`\n[${hora}] ${String(step).padStart(2, '0')} · ${titulo}`);
  console.log(`         → ${dondeMirar}`);
}
const nota = (msg: string) => console.log(`         ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pausa = () => sleep(PAUSE_MS);

// ─── HTTP y sesiones ─────────────────────────────────────────────────────

async function api<T = any>(method: string, route: string, opts: { token?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${method} ${route} → ${res.status}: ${json.message ?? res.statusText} ${json.errors ? JSON.stringify(json.errors) : ''}`);
  }
  return json as T;
}

/**
 * Foto de evidencia: el mismo multipart (`photo`) que manda la app. Lleva
 * bytes al azar tras el final del JPEG: el servidor rechaza una foto ya usada
 * en el pedido (por checksum), y la de recogida y la de entrega son la misma.
 */
async function apiPhoto(route: string, token: string, at: { latitude: number; longitude: number; accuracy: number }) {
  const form = new FormData();
  const photo = Buffer.concat([fs.readFileSync(PHOTO_PATH), crypto.randomBytes(16)]);
  form.append('photo', new Blob([photo], { type: 'image/jpeg' }), 'evidencia.jpg');
  for (const [k, v] of Object.entries(at)) form.append(k, String(v));
  const res = await fetch(`${BASE}${route}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`POST ${route} → ${res.status}: ${json.message ?? res.statusText}`);
  return json;
}

interface Manifest {
  luisSnapshot?: { status?: string; currentFund?: number; totalDeliveries?: number; totalEarnings?: number };
  fraudAlertIds?: string[];
}

function readManifest(): Manifest {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
  } catch {
    return {};
  }
}

const writeManifest = (m: Manifest) => fs.writeFileSync(MANIFEST_FILE, JSON.stringify(m));

interface Session { accessToken: string; refreshToken: string; userId: string; exp: number }

function readSessions(): Partial<Record<AccountKey, Session>> {
  try {
    return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function tokenExp(token: string): number {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).exp * 1000;
  } catch {
    return 0;
  }
}

const sessions = readSessions();

async function tokenFor(key: AccountKey): Promise<string> {
  const current = sessions[key];
  if (current && current.exp - Date.now() > 60_000) return current.accessToken;

  let data: any = null;
  if (current?.refreshToken) {
    try {
      data = (await api('POST', '/auth/refresh-token', { body: { refreshToken: current.refreshToken } })).data;
    } catch {
      data = null;
    }
  }
  if (!data) data = (await api('POST', '/auth/login', { body: ACCOUNTS[key] })).data;

  sessions[key] = {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken ?? current?.refreshToken,
    userId: data.user?._id ?? current?.userId,
    exp: tokenExp(data.accessToken),
  };
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions));
  return data.accessToken;
}

// ─── Contexto de la base ─────────────────────────────────────────────────

interface Ctx {
  clientIds: Types.ObjectId[];
  camilaId: Types.ObjectId;
  andresId: Types.ObjectId;
  business: { _id: Types.ObjectId; name: string };
  pedroDriverId: Types.ObjectId;
  luisDriverId: Types.ObjectId;
  items: Array<{ productId: string; quantity: number }>;
}

async function loadCtx(): Promise<Ctx> {
  const [camila, andres, gloria, pedro, luis] = await Promise.all(
    [ACCOUNTS.camila.phone, ACCOUNTS.andres.phone, ACCOUNTS.gloria.phone, ACCOUNTS.pedro.phone, LUIS_PHONE].map((phone) =>
      User.findOne({ phone }).select('_id').lean()
    )
  );
  if (!camila || !andres || !gloria || !pedro || !luis) {
    throw new Error('Faltan cuentas TESTE o de demostración. Corre `npm run teste:seed` y `npm run seed:demo-drivers`.');
  }
  const business = await Business.findOne({ ownerId: gloria._id, name: BUSINESS_NAME }).select('_id name').lean();
  if (!business) throw new Error(`No existe "${BUSINESS_NAME}".`);
  const [pedroDriver, luisDriver] = await Promise.all([
    Driver.findOne({ userId: pedro._id }).select('_id').lean(),
    Driver.findOne({ userId: luis._id }).select('_id').lean(),
  ]);
  if (!pedroDriver || !luisDriver) throw new Error('Faltan los perfiles de domiciliario de Pedro o Luis.');

  // Un plato sin inventario (no mueve stock) y sin grupos obligatorios.
  const products = await Product.find({ businessId: business._id, isAvailable: true }).lean();
  const simple = products.find(
    (p: any) => p.stock == null && (p.modifierGroups ?? []).every((g: any) => (g.minSelect ?? 0) === 0) && p.price >= 15000
  );
  if (!simple) throw new Error(`"${BUSINESS_NAME}" no tiene un plato simple de $15.000 o más.`);

  return {
    clientIds: [camila._id, andres._id],
    camilaId: camila._id,
    andresId: andres._id,
    business: { _id: business._id, name: business.name },
    pedroDriverId: pedroDriver._id,
    luisDriverId: luisDriver._id,
    items: [{ productId: String(simple._id), quantity: 1 }],
  };
}

// ─── Pedidos ─────────────────────────────────────────────────────────────

const orderNote = (n: number) => `${MARK} pedido ${n} de la prueba de alertas`;

async function findTestOrder(ctx: Ctx, n: number) {
  return Order.findOne({ clientId: { $in: ctx.clientIds }, notes: orderNote(n) });
}

async function createOrder(ctx: Ctx, n: number, who: 'camila' | 'andres') {
  const existing = await findTestOrder(ctx, n);
  if (existing) {
    nota(`(ya existía: ${existing.orderNumber}, ${existing.status})`);
    return existing;
  }
  const res = await api('POST', '/orders', {
    token: await tokenFor(who),
    body: {
      businessId: String(ctx.business._id),
      items: ctx.items,
      paymentMethod: 'cash_on_delivery',
      cashPayment: { needsChange: false },
      deliveryAddress: DELIVERY.address,
      deliveryDetails: 'Casa de prueba',
      deliveryLatitude: DELIVERY.lat,
      deliveryLongitude: DELIVERY.lng,
      notes: orderNote(n),
    },
  });
  nota(`${res.data.orderNumber} · $${Number(res.data.total).toLocaleString('es-CO')} · ${res.data.status}`);
  return (await Order.findById(res.data._id))!;
}

async function setStatus(orderId: unknown, status: string, who: AccountKey, extra: Record<string, unknown> = {}) {
  const res = await api('PATCH', `/orders/${String(orderId)}/status`, { token: await tokenFor(who), body: { status, ...extra } });
  nota(`→ ${res.data.status}`);
}

/** Lleva el pedido hasta `ready` por la API, respetando el estado en que ya esté. */
async function toReady(orderId: unknown, stepMs = 0) {
  const flow = ['pending', 'accepted', 'preparing', 'ready'];
  const current = (await Order.findById(orderId).select('status').lean())!.status as string;
  if (!flow.includes(current)) return;
  for (const status of flow.slice(flow.indexOf(current) + 1)) {
    await setStatus(orderId, status, 'gloria');
    if (stepMs) await sleep(stepMs);
  }
}

/**
 * Escribe directo en la colección (sin Mongoose) para poder fijar
 * `updatedAt`: con el modelo, `timestamps` lo pisaría con la hora actual.
 */
async function rawOrderPatch(orderId: unknown, set: Record<string, unknown>) {
  await Order.collection.updateOne({ _id: new Types.ObjectId(String(orderId)) }, { $set: set });
}

// ─── Bloques ─────────────────────────────────────────────────────────────

async function bloquePedidos(ctx: Ctx) {
  paso('Pedido nuevo (API real): Camila pide en Sazón de la Tulia', 'Dashboard: se refresca solo (Pedidos solo al recargar)');
  const o1 = await createOrder(ctx, 1, 'camila');
  await pausa();

  paso('El comercio acepta → prepara → marca listo el pedido 1', 'Dashboard: pedidos recientes cambian de estado cada 5 s');
  await toReady(o1._id, 5000);
  await pausa();

  paso('Cancelación por el cliente (API real): pedido 2, cancelado en pendiente', 'Dashboard y Pedidos (recargar): Cancelado por el cliente');
  const o2 = await createOrder(ctx, 2, 'camila');
  await sleep(5000);
  if (o2.status !== 'cancelled') {
    await setStatus(o2._id, 'cancelled', 'camila', {
      cancellationCode: 'client_ordered_by_mistake',
      cancellationReason: `${MARK} Me equivoqué de dirección`,
    });
  }
  await pausa();

  paso('Cancelación por el comercio (API real): pedido 3, aceptado y luego cancelado', 'Dashboard y Pedidos (recargar): Aceptado y luego Cancelado por el comercio');
  const o3 = await createOrder(ctx, 3, 'andres');
  if (o3.status === 'pending') {
    await setStatus(o3._id, 'accepted', 'gloria');
    await sleep(5000);
  }
  if ((await Order.findById(o3._id).select('status').lean())!.status !== 'cancelled') {
    await setStatus(o3._id, 'cancelled', 'gloria', {
      cancellationCode: 'business_out_of_stock',
      cancellationReason: `${MARK} Se nos acabó el plato`,
    });
  }
}

async function bloqueDetenida(ctx: Ctx) {
  const o1 = await findTestOrder(ctx, 1);
  paso('Pedido listo sin domiciliario (base: el pedido 1 lleva 11 min quieto)', 'Campana e Incidentes · Alto · “Pedido listo sin domiciliario”');
  if (!o1) throw new Error('Falta el pedido 1: corre antes --bloque=pedidos.');
  if (o1.status !== 'ready') await toReady(o1._id);
  await rawOrderPatch(o1._id, { updatedAt: new Date(Date.now() - 11 * MIN) });
  nota(`${o1.orderNumber} · listo, sin domiciliario, updatedAt hace 11 min`);
  await pausa();

  paso('Pedido detenido (API hasta “listo”, luego base: Pedro en camino hace 50 min)', 'Campana e Incidentes · Alto · “Pedido detenido”');
  const o4 = await createOrder(ctx, 4, 'camila');
  await toReady(o4._id);
  await rawOrderPatch(o4._id, {
    status: 'on_way',
    driverId: ctx.pedroDriverId,
    pickedUpAt: new Date(Date.now() - 55 * MIN),
    updatedAt: new Date(Date.now() - 50 * MIN),
  });
  nota(`${o4.orderNumber} · en camino con Pedro, sin moverse hace 50 min`);
  await pausa();

  paso('Documentos (base): permiso sanitario del comercio vence en 5 días; revisión técnico-mecánica de Luis venció ayer', 'Campana e Incidentes · Medio (comercio) y Alto (domiciliario)');
  const bizTypes = ['health_permit', 'bank_certificate', 'chamber_of_commerce', 'rut', 'legal_rep_id'];
  const taken = new Set((await BusinessDocument.find({ businessId: ctx.business._id }).select('type').lean()).map((d) => d.type));
  const alreadyBiz = await BusinessDocument.findOne({ businessId: ctx.business._id, reference: new RegExp(`^${DOC_REF}`) });
  const freeType = bizTypes.find((t) => !taken.has(t as any));
  if (alreadyBiz) nota('(el documento del comercio ya existía)');
  else if (!freeType) nota('El comercio ya tiene los 5 tipos de documento: no se siembra el suyo.');
  else {
    await BusinessDocument.create({
      businessId: ctx.business._id,
      type: freeType,
      reference: `${DOC_REF} ${freeType}`,
      status: 'approved',
      expiresAt: new Date(Date.now() + 5 * DAY),
      reviewedAt: new Date(),
    });
    nota(`${ctx.business.name}: ${freeType}, vence en 5 días`);
  }
  // Tipo no obligatorio a propósito: un SOAT o una licencia vencidos
  // desconectarían a Luis (`assertDocumentsCurrent`). Un documento vencido
  // del comercio, igual, le cortaría los pedidos: por eso el suyo solo "vence".
  const alreadyDriver = await DriverDocument.findOne({ driverId: ctx.luisDriverId, type: 'technical_review' });
  if (alreadyDriver && !String(alreadyDriver.reference).startsWith(DOC_REF)) {
    nota('Luis ya tiene una revisión técnico-mecánica real: no se toca.');
  } else if (!alreadyDriver) {
    await DriverDocument.create({
      driverId: ctx.luisDriverId,
      type: 'technical_review',
      reference: `${DOC_REF} technical_review`,
      status: 'approved',
      expiresAt: new Date(Date.now() - 1 * DAY),
      reviewedAt: new Date(),
    });
    nota('Luis: revisión técnico-mecánica, venció ayer');
  }
}

/**
 * Todo por el flujo real y en el orden en que pasaría en la calle: cada
 * paso lo provoca el backend que está corriendo, así que el panel recibe los
 * mismos avisos por socket que recibiría en producción (sin recargar).
 */
async function bloqueVivo(ctx: Ctx) {
  const luisToken = () => tokenFor('luis');
  const manifest = readManifest();

  paso('Botón de pánico: Luis pide ayuda', 'Incidentes: suena el tono y sale “Nueva emergencia”; campana · Crítico');
  // Uno abierto ya no suena: el servicio lo reutiliza (`sos:updated`).
  const openSos = await SosAlert.findOne({ driverId: ctx.luisDriverId, note: MARK_RE, status: { $in: ['active', 'acknowledged'] } }).select('_id').lean();
  if (openSos) nota(`(ya estaba abierto: ${openSos._id})`);
  else {
  const sos = await api('POST', '/sos', {
    token: await luisToken(),
    body: { lat: DELIVERY.lat + 0.004, lng: DELIVERY.lng - 0.002, note: `${MARK} Me caí de la moto, estoy bien pero necesito ayuda` },
  });
  nota(`alerta ${sos.data._id}`);
  }
  await pausa();

  const o3 = await findTestOrder(ctx, 3);
  paso('Reclamo: Andrés reclama por el pedido que le cancelaron', 'Campana · Medio · “Reclamo sin resolver”');
  if (await Pqrs.exists({ userId: ctx.andresId, subject: new RegExp('^\\[PRUEBA\\] Me cancelaron') })) nota('(ya existía)');
  else {
    await api('POST', '/pqrs', {
      token: await tokenFor('andres'),
      body: {
        type: 'claim',
        subject: `${MARK} Me cancelaron el pedido después de aceptarlo`,
        detail: 'El comercio aceptó mi pedido y a los pocos minutos lo canceló sin explicación. Quiero saber qué pasó.',
        ...(o3 ? { orderId: String(o3._id), businessId: String(ctx.business._id) } : {}),
      },
    });
  }
  await pausa();

  // ── Entrega completa en efectivo, con Luis ──
  paso('Entrega completa: pedido nuevo de Camila, el comercio lo prepara', 'Dashboard: entra y avanza a Listo');
  const o5 = await createOrder(ctx, 5, 'camila');
  await toReady(o5._id, 4000);
  const store = (await Business.findById(ctx.business._id).select('location').lean())!.location!.coordinates;
  const storeAt = { latitude: store[1], longitude: store[0], accuracy: 10 };
  const homeAt = { latitude: DELIVERY.lat, longitude: DELIVERY.lng, accuracy: 10 };
  await pausa();

  // Lo que la entrega le cambia a Luis (entregas, ganancias, fondo, estado)
  // se guarda para devolverlo tal cual en la limpieza.
  if (!manifest.luisSnapshot) {
    const luis = await Driver.findById(ctx.luisDriverId).select('status currentFund totalDeliveries totalEarnings').lean();
    manifest.luisSnapshot = {
      status: luis?.status,
      currentFund: luis?.currentFund,
      totalDeliveries: luis?.totalDeliveries,
      totalEarnings: luis?.totalEarnings,
    };
    writeManifest(manifest);
  }

  paso('Luis toma el pedido y llega al local', 'Pedidos/ficha del pedido: domiciliario asignado y “llegó al local”');
  const current5 = await Order.findById(o5._id).select('status driverId').lean();
  if (!current5!.driverId) {
    await api('PATCH', `/orders/${o5._id}/assign-driver`, { token: await luisToken(), body: {} });
    nota('asignado a Luis');
  }
  await api('POST', '/tracking/ping', { token: await luisToken(), body: { lat: storeAt.latitude, lng: storeAt.longitude, accuracy: 10 } }).catch(() => undefined);
  if ((await Order.findById(o5._id).select('status').lean())!.status === 'ready') {
    await api('POST', `/orders/${o5._id}/pickup/arrive`, { token: await luisToken(), body: storeAt });
    nota('llegó al local');
    await sleep(4000);
    await apiPhoto(`/orders/${o5._id}/pickup/evidence`, await luisToken(), storeAt);
    nota('foto de recogida subida');
    await sleep(4000);
    const flow = await api('GET', `/orders/${o5._id}/flow`, { token: await tokenFor('gloria') });
    await api('POST', `/orders/${o5._id}/pickup/verify`, { token: await luisToken(), body: { code: flow.data.pickup.code, ...storeAt } });
    nota(`código de recogida ${flow.data.pickup.code} validado → recogido`);
  }
  await pausa();

  paso('Luis sale hacia la casa de Camila y llega', 'Dashboard: En camino; ficha del pedido: “llegó donde el cliente”');
  if ((await Order.findById(o5._id).select('status').lean())!.status === 'picked_up') {
    await setStatus(o5._id, 'on_way', 'luis');
  }
  await api('POST', '/tracking/ping', { token: await luisToken(), body: { lat: homeAt.latitude, lng: homeAt.longitude, accuracy: 10 } }).catch(() => undefined);
  if ((await Order.findById(o5._id).select('status').lean())!.status === 'on_way') {
    await api('POST', `/orders/${o5._id}/delivery/arrive`, { token: await luisToken(), body: homeAt });
    nota('llegó donde el cliente');
    await sleep(4000);
    await apiPhoto(`/orders/${o5._id}/delivery/evidence`, await luisToken(), homeAt);
    nota('foto de entrega subida');
    await sleep(4000);
    const flow = await api('GET', `/orders/${o5._id}/flow`, { token: await tokenFor('camila') });
    await api('POST', `/orders/${o5._id}/delivery/verify`, { token: await luisToken(), body: { code: flow.data.delivery.code, ...homeAt } });
    nota(`código de entrega ${flow.data.delivery.code} validado → entregado`);
  }
  await pausa();

  paso('Faltante de efectivo: Luis declara que Camila no le pagó', 'Campana · Alto · “Faltante de efectivo”');
  if (await CashPaymentIncident.exists({ orderId: o5._id })) nota('(ya existía)');
  else {
    await api('POST', `/orders/${o5._id}/cash/confirm`, {
      token: await luisToken(),
      body: { received: false, note: `${MARK} La clienta dijo que ya había pagado en la app` },
    });
  }
  await pausa();

  paso('Fraude: el GPS de Luis salta de Garzón a Neiva en segundos', 'Campana · Alto · “Alerta de fraude · Cambio de ubicación sospechoso”');
  const since = new Date();
  await sleep(6000); // el seguimiento descarta pings a menos de 5 s del anterior
  await api('POST', '/tracking/ping', { token: await luisToken(), body: { lat: NEIVA.lat, lng: NEIVA.lng, accuracy: 10 } });
  const jump = await FraudAlert.findOne({
    userId: sessions.luis!.userId,
    type: FraudAlertType.SUSPICIOUS_LOCATION_CHANGE,
    createdAt: { $gte: since },
  }).select('_id description').lean();
  if (jump) {
    manifest.fraudAlertIds = [...new Set([...(manifest.fraudAlertIds ?? []), String(jump._id)])];
    writeManifest(manifest);
    nota(jump.description);
  } else {
    nota('No se abrió alerta nueva (Luis ya tenía una del mismo tipo abierta: se sumó una repetición).');
  }

  // Terminado el turno de prueba, Luis vuelve a desconectado.
  await api('PATCH', '/drivers/status', { token: await luisToken(), body: { status: 'offline' } }).catch((e) => nota(`No se pudo desconectar a Luis: ${e.message}`));
}

// ─── Limpieza ────────────────────────────────────────────────────────────

async function limpiar(ctx: Ctx) {
  const orders = await Order.find({ clientId: { $in: ctx.clientIds }, notes: MARK_RE }).select('_id orderNumber').lean();
  const orderIds = orders.map((o) => o._id);
  const removedIds: string[] = orderIds.map(String);
  const counts: Record<string, number> = {};
  const manifest = readManifest();

  // Las fotos de evidencia viven en Cloudinary: se borran antes que su fila.
  if (orderIds.length && mongoose.modelNames().includes('OrderEvidence')) {
    const evidences = await mongoose.model('OrderEvidence').find({ orderId: { $in: orderIds } }).select('storageKey').lean();
    for (const e of evidences as Array<{ storageKey?: string }>) {
      if (!e.storageKey) continue;
      await cloudinary.uploader.destroy(e.storageKey, { type: 'authenticated', invalidate: true }).catch(() => undefined);
    }
    if (evidences.length) counts.CloudinaryEvidence = evidences.length;
  }

  // Todo lo que cuelga de un pedido de prueba, en cualquier colección con
  // `orderId` (códigos, bitácora, pagos, payouts, efectivo, reembolsos,
  // chat, SOS, PQRS...). La auditoría se deja: es registro de lo que pasó.
  // Los `_id` se guardan antes de borrar: las claves de alerta vista
  // (`kind:<id>:stage`) apuntan a ellos, no al pedido.
  if (orderIds.length) {
    for (const name of mongoose.modelNames()) {
      if (name === 'Order' || /audit/i.test(name)) continue;
      const model = mongoose.model(name);
      if (!model.schema.path('orderId')) continue;
      const linked = await model.find({ orderId: { $in: orderIds } }).select('_id').lean();
      if (!linked.length) continue;
      removedIds.push(...linked.map((d: any) => String(d._id)));
      const res = await model.deleteMany({ orderId: { $in: orderIds } });
      if (res.deletedCount) counts[name] = res.deletedCount;
    }
  }

  const byMark: Array<[string, mongoose.Model<any>, Record<string, unknown>]> = [
    ['SosAlert', SosAlert, { note: MARK_RE }],
    ['Pqrs', Pqrs, { subject: MARK_RE }],
    ['FraudAlert', FraudAlert as unknown as mongoose.Model<any>, {
      $or: [{ description: MARK_RE }, { _id: { $in: (manifest.fraudAlertIds ?? []).map((id) => new Types.ObjectId(id)) } }],
    }],
    ['BusinessDocument', BusinessDocument, { reference: new RegExp(`^${DOC_REF}`) }],
    ['DriverDocument', DriverDocument, { reference: new RegExp(`^${DOC_REF}`) }],
  ];
  for (const [name, model, filter] of byMark) {
    const docs = await model.find(filter).select('_id').lean();
    if (!docs.length) continue;
    removedIds.push(...docs.map((d: any) => String(d._id)));
    const res = await model.deleteMany({ _id: { $in: docs.map((d: any) => d._id) } });
    counts[name] = (counts[name] ?? 0) + res.deletedCount;
  }

  // Luis vuelve a las cifras que tenía antes de la entrega de prueba.
  if (manifest.luisSnapshot) {
    await Driver.updateOne({ _id: ctx.luisDriverId }, { $set: manifest.luisSnapshot });
    console.log(`  Luis restaurado: ${JSON.stringify(manifest.luisSnapshot)}`);
  }

  if (removedIds.length) {
    const keyRe = new RegExp(`:(${removedIds.join('|')}):`);
    counts.AlertReceipt = (await AlertReceipt.deleteMany({ key: keyRe })).deletedCount;
  }

  if (orderIds.length) counts.Order = (await Order.deleteMany({ _id: { $in: orderIds } })).deletedCount;

  for (const file of [SESSIONS_FILE, MANIFEST_FILE]) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* no existía */
    }
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`\nLimpieza: ${total} documentos borrados${orders.length ? ` (pedidos ${orders.map((o) => o.orderNumber).join(', ')})` : ''}`);
  for (const [name, n] of Object.entries(counts)) if (n) console.log(`  ${name}: ${n}`);
  console.log('Las alertas desaparecen de la campana en menos de un minuto (caché de 15 s + sondeo de 60 s).');
}

// ─── Entrada ─────────────────────────────────────────────────────────────

const BLOQUES: Record<string, (ctx: Ctx) => Promise<void>> = {
  pedidos: bloquePedidos,
  detenida: bloqueDetenida,
  vivo: bloqueVivo,
};

async function main() {
  const health: any = await fetch('http://localhost:3000/health').then((r) => r.json()).catch(() => null);
  if (!health) throw new Error('El backend no responde en localhost:3000.');
  if (health.environment === 'production') throw new Error('El backend local dice ser producción. No se toca nada.');

  await connectGuarded(typeof args.db === 'string' ? args.db : undefined);
  try {
    const ctx = await loadCtx();
    if (args.limpiar) return await limpiar(ctx);

    const names = [String(args.bloque ?? '')];
    for (const [i, name] of names.entries()) {
      const run = BLOQUES[name];
      if (!run) throw new Error(`Bloque desconocido "${name}". Usa: ${Object.keys(BLOQUES).join(', ')} o --limpiar.`);
      console.log(`\n══ Bloque: ${name} ══`);
      await run(ctx);
      if (i < names.length - 1) await pausa();
    }
    console.log('\nListo. Lo sembrado directo en base aparece al refrescar (o en ≤60 s); lo de la API llega en vivo.');
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}`);
  process.exit(1);
});
