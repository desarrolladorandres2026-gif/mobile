import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { BusinessStaff, BusinessRole, Order, Pqrs } from '../models';
import { AuditLog, AuditAction } from '../security';
import { Permission } from '../security/rbac';
import { OrderStatus, PaymentMethod, PaymentStatus, UserRole } from '../types';
import { featureFlagService } from '../services/featureFlag.service';
import { merchantOrderView, contactWindowExpired } from '../services/profileMasking';
import { decideContactException } from '../services/pqrs.service';
import { cache } from '../cache';
import { GARZON, makeUser, makeBusiness, makeStaff, makePricingConfig, authHeader } from './factories';

/**
 * Plazo para pedir contacto con el cliente (decisión 2026-10-19).
 *
 * Siete días calendario desde la entrega (o la cancelación): dentro, el comercio
 * pide el puente a ZIPP como siempre; después, el historial deja de mostrar la
 * dirección y el nombre completo, y pedir contacto es una excepción con
 * justificación que soporte o administración autoriza o niega. Nunca se
 * rechaza sin salida: una garantía puede vencer después del plazo.
 */

const API = '/api/v1';
const DAY = 86_400_000;
const DETAIL = 'El cliente dejó un reclamo por el empaque y queremos ofrecerle un cambio.';
const JUSTIFICATION = 'La garantía del producto cubre 6 meses y el cliente reportó una falla tras la entrega.';

let owner: any;
let business: any;
let client: any;

const ago = (days: number) => new Date(Date.now() - days * DAY);

const closedOrder = (over: Record<string, unknown> = {}) => Order.create({
  orderNumber: `ZIPP-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
  clientId: client._id,
  businessId: business._id,
  items: [],
  status: OrderStatus.DELIVERED,
  paymentMethod: PaymentMethod.ONLINE,
  paymentStatus: PaymentStatus.PAID,
  deliveryAddress: 'Carrera 10 # 5-20, apto 301',
  deliveryDetails: 'Torre B, portería',
  recipient: { name: 'Pedro Pérez', phone: '3001234567' },
  deliveryLocation: { type: 'Point', coordinates: [GARZON.lng, GARZON.lat] },
  subtotal: 20000, deliveryFee: 4000, total: 24000,
  platformCommission: 2000, businessPayout: 18000, driverPayout: 4000,
  finance: { productSubtotal: 20000, merchantCommission: 2000, businessPayout: 18000 },
  ...over,
});

const ask = async (user: any, orderId: string, body: Record<string, unknown> = {}) =>
  request(app).post(`${API}/pqrs`).set(await authHeader(user)).send({
    reason: 'contact_customer_claim', subject: 'Contactar al cliente', detail: DETAIL,
    businessId: business._id.toString(), orderId, ...body,
  });

beforeEach(async () => {
  await featureFlagService.upsert('rbac_enforce', { audience: 'staff' });
  await cache.flush();
  await makePricingConfig({});
  owner = await makeUser({ role: UserRole.BUSINESS });
  business = await makeBusiness(owner._id);
  client = await makeUser({ role: UserRole.CLIENT, name: 'María Fernanda Gómez' });
});

describe('El plazo de siete días calendario', () => {
  it('cuenta días calendario desde la entrega: el día 7 sigue vigente, el 8 vence', () => {
    const now = new Date('2026-10-20T15:00:00-05:00');
    const delivered = (iso: string) => ({ deliveredAt: new Date(iso) });
    expect(contactWindowExpired(delivered('2026-10-13T08:00:00-05:00'), { now })).toBe(false); // 7 días
    expect(contactWindowExpired(delivered('2026-10-13T23:59:00-05:00'), { now })).toBe(false);
    expect(contactWindowExpired(delivered('2026-10-12T23:59:00-05:00'), { now })).toBe(true); // 8 días
    expect(contactWindowExpired(delivered('2026-10-12T08:00:00-05:00'), { now })).toBe(true);
  });

  it('un pedido EN CURSO (sin fecha de cierre porque aún no cierra) no vence', () => {
    expect(contactWindowExpired({})).toBe(false);
    expect(contactWindowExpired({ status: OrderStatus.ON_WAY, createdAt: ago(1) })).toBe(false);
    expect(contactWindowExpired({ deliveredAt: 'basura' })).toBe(false);
  });

  it('la cancelación también abre el plazo', () => {
    expect(contactWindowExpired({ cancelledAt: ago(10) })).toBe(true);
    expect(contactWindowExpired({ cancelledAt: ago(2) })).toBe(false);
  });

  it('el plazo es un parámetro, no una constante', () => {
    expect(contactWindowExpired({ deliveredAt: ago(10) }, { windowDays: 30 })).toBe(false);
    expect(contactWindowExpired({ deliveredAt: ago(10) }, { windowDays: 3 })).toBe(true);
  });
});

describe('Dentro del plazo', () => {
  it('el comercio pide el contacto como siempre, sin excepción', async () => {
    const order = await closedOrder({ deliveredAt: ago(6) });
    const res = await ask(owner, order._id.toString());
    expect(res.status).toBe(201);
    const stored = await Pqrs.findById(res.body.data._id).lean();
    expect(stored!.contactException ?? null).toBeNull();
  });
});

describe('Fuera del plazo', () => {
  it('sin justificación se rechaza con el motivo y la salida', async () => {
    const order = await closedOrder({ deliveredAt: ago(9) });
    const res = await ask(owner, order._id.toString());
    expect(res.status).toBe(422);
    expect(res.body.code ?? res.body.errorCode).toBe('CONTACT_WINDOW_EXPIRED');
    expect(res.body.message).toMatch(/garantía, reclamo, obligación legal/);
    expect(await Pqrs.countDocuments({ orderId: order._id })).toBe(0);
  });

  it('una justificación de una línea no basta', async () => {
    const order = await closedOrder({ deliveredAt: ago(9) });
    const res = await ask(owner, order._id.toString(), { exceptionJustification: 'lo necesito' });
    expect(res.status).toBe(400);
  });

  it('con justificación nace detenido, auditado, y el comercio no recibe el número', async () => {
    const order = await closedOrder({ deliveredAt: ago(40) });
    const res = await ask(owner, order._id.toString(), {
      reason: 'contact_customer_warranty', exceptionJustification: JUSTIFICATION,
    });
    expect(res.status).toBe(201);
    expect(JSON.stringify(res.body)).not.toContain(client.phone);
    expect(res.body.data.contactException).toMatchObject({ status: 'pending', justification: JUSTIFICATION });
    // El solicitante ve que está pendiente, no quién lo decidirá.
    expect(res.body.data.contactException.decidedBy).toBeUndefined();

    await new Promise((r) => setTimeout(r, 50));
    const audit = await AuditLog.findOne({ action: AuditAction.CUSTOMER_CONTACT_EXCEPTION_REQUESTED, entityId: order._id.toString() }).lean();
    expect(audit?.metadata?.daysSinceClosed).toBeGreaterThanOrEqual(40);
  });

  it('el mostrador y el empleado no pueden ni con justificación', async () => {
    const order = await closedOrder({ deliveredAt: ago(40) });
    const employee = await makeUser({ role: UserRole.BUSINESS });
    await BusinessStaff.create({ businessId: business._id, userId: employee._id, role: BusinessRole.EMPLOYEE, isActive: true, status: 'active' });
    const res = await ask(employee, order._id.toString(), { exceptionJustification: JUSTIFICATION });
    expect(res.status).toBe(403);
  });
});

describe('La autorización de soporte o administración', () => {
  let order: any;
  let pqrsId: string;
  let support: any;

  beforeEach(async () => {
    order = await closedOrder({ deliveredAt: ago(30) });
    const res = await ask(owner, order._id.toString(), { exceptionJustification: JUSTIFICATION });
    pqrsId = res.body.data._id;
    support = await makeStaff({ roleSlug: 'super_admin' });
  });

  const decide = async (user: any, body: Record<string, unknown>) =>
    request(app).patch(`${API}/pqrs/${pqrsId}/contact-exception`).set(await authHeader(user)).send(body);

  it('mientras está pendiente, el personal no puede responder el caso como si nada', async () => {
    const res = await request(app).patch(`${API}/pqrs/${pqrsId}/respond`).set(await authHeader(support)).send({ message: 'Lo llamamos hoy mismo.' });
    expect(res.status).toBe(409);
    expect(res.body.code ?? res.body.errorCode).toBe('CONTACT_EXCEPTION_PENDING');
  });

  it('autorizar deja constancia de quién, cuándo y por qué, y habilita la respuesta', async () => {
    const res = await decide(support, { decision: 'authorize', note: 'Garantía vigente por 6 meses según la factura.' });
    expect(res.status).toBe(200);
    const stored = await Pqrs.findById(pqrsId).lean();
    expect(stored!.contactException).toMatchObject({ status: 'authorized', decisionNote: 'Garantía vigente por 6 meses según la factura.' });
    expect(String(stored!.contactException!.decidedBy)).toBe(String(support._id));
    expect(stored!.contactException!.decidedAt).toBeTruthy();

    const reply = await request(app).patch(`${API}/pqrs/${pqrsId}/respond`).set(await authHeader(support)).send({ message: 'Contactamos al cliente.' });
    expect(reply.status).toBe(200);

    await new Promise((r) => setTimeout(r, 50));
    expect(await AuditLog.countDocuments({ action: AuditAction.CUSTOMER_CONTACT_EXCEPTION_DECIDED, entityId: pqrsId })).toBe(1);
  });

  it('negar cierra el caso y le explica al comercio por qué', async () => {
    const res = await decide(support, { decision: 'deny', note: 'La garantía ya había vencido según la política.' });
    expect(res.status).toBe(200);
    const stored = await Pqrs.findById(pqrsId).lean();
    expect(stored!.status).toBe('closed');
    expect(stored!.contactException!.status).toBe('denied');
    expect(stored!.responses.at(-1)!.message).toMatch(/No se autorizó el contacto/);
  });

  it('exige un motivo escrito', async () => {
    expect((await decide(support, { decision: 'authorize', note: 'ok' })).status).toBe(400);
  });

  it('solo quien gestiona soporte decide; el propietario del comercio no se autoriza a sí mismo', async () => {
    expect((await decide(owner, { decision: 'authorize', note: 'Me autorizo a mí mismo, gracias.' })).status).toBe(403);
    const viewer = await makeStaff({ roleSlug: null, permissions: [Permission.SUPPORT_VIEW] });
    expect((await decide(viewer, { decision: 'authorize', note: 'Solo puedo ver, no decidir.' })).status).toBe(403);
    expect((await Pqrs.findById(pqrsId).lean())!.contactException!.status).toBe('pending');
  });

  it('una decisión es definitiva; dos agentes a la vez: gana uno y el otro recibe 409', async () => {
    const other = await makeStaff({ roleSlug: 'super_admin' });
    const results = await Promise.allSettled([
      decideContactException(pqrsId, String(support._id), 'authorize', 'Garantía vigente, se autoriza.'),
      decideContactException(pqrsId, String(other._id), 'deny', 'Fuera de garantía, se niega.'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    await expect(decideContactException(pqrsId, String(support._id), 'deny', 'Intento tardío de cambiar.'))
      .rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('Lo que ve el comercio en el historial', () => {
  it('dentro del plazo: nombre completo y dirección (teléfono ya enmascarado)', async () => {
    const order = await Order.findById((await closedOrder({ deliveredAt: ago(3) }))._id).populate('clientId', 'name phone email');
    const view: any = merchantOrderView(order!, { owner: true, terminal: true });
    expect(view.clientId.name).toBe('María Fernanda Gómez');
    expect(view.deliveryAddress).toBe('Carrera 10 # 5-20, apto 301');
    expect(view.personalDataProtected).toBeUndefined();
  });

  it('vencido el plazo: dirección, detalle, receptor y correo desaparecen; el nombre se reduce', async () => {
    const order = await Order.findById((await closedOrder({ deliveredAt: ago(12) }))._id).populate('clientId', 'name phone email');
    const view: any = merchantOrderView(order!, { owner: true, terminal: true });
    expect(view.clientId.name).toBe('María G.');
    expect(view.clientId.email).toBeUndefined();
    expect(view.clientId.phone).not.toBe(client.phone);
    expect(view.deliveryAddress).toBe('');
    expect(view.deliveryDetails).toBeUndefined();
    expect(view.recipient).toBeUndefined();
    expect(view.deliveryLocation).toBeUndefined();
    expect(view.personalDataProtected).toBe(true);
    // Lo operativo y lo financiero siguen.
    expect(view.total).toBe(24000);
    expect(view.finance.businessPayout).toBe(18000);
  });

  it('el recorte no toca la base: el pedido conserva todo para contabilidad y auditoría', async () => {
    const order = await closedOrder({ deliveredAt: ago(12) });
    merchantOrderView((await Order.findById(order._id).populate('clientId', 'name phone'))!, { owner: true, terminal: true });
    const stored = await Order.findById(order._id).lean();
    expect(stored!.deliveryAddress).toBe('Carrera 10 # 5-20, apto 301');
    expect(stored!.recipient?.name).toBe('Pedro Pérez');
  });

  it('por HTTP: el propietario recibe la vista recortada de un pedido vencido', async () => {
    const order = await closedOrder({ deliveredAt: ago(12) });
    const res = await request(app).get(`${API}/orders/${order._id}`).set(await authHeader(owner));
    expect(res.status).toBe(200);
    expect(res.body.data.deliveryAddress).toBe('');
    expect(res.body.data.personalDataProtected).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('Pedro');
  });

  it('el cliente y el administrador siguen viendo su pedido completo', async () => {
    const order = await closedOrder({ deliveredAt: ago(12) });
    const mine = await request(app).get(`${API}/orders/${order._id}`).set(await authHeader(client));
    expect(mine.body.data.deliveryAddress).toBe('Carrera 10 # 5-20, apto 301');
    const admin = await makeStaff({ roleSlug: 'super_admin' });
    const staff = await request(app).get(`${API}/orders/${order._id}`).set(await authHeader(admin));
    expect(staff.body.data.deliveryAddress).toBe('Carrera 10 # 5-20, apto 301');
  });
});

describe('Pedidos cerrados sin fecha de entrega (Auditoría 2026-10-19)', () => {
  // `closedOrder` crea con createdAt = ahora; aquí se retrocede por el driver nativo, como una migración.
  const backdated = async (over: Record<string, unknown>, createdDaysAgo: number) => {
    const order = await closedOrder(over);
    await Order.collection.updateOne({ _id: order._id }, { $set: { createdAt: ago(createdDaysAgo) } });
    return order;
  };

  it('la falta de dato nunca da acceso indefinido: sin fecha de cierre cuenta desde la creación', () => {
    const delivered = (createdAt: Date) => ({ status: OrderStatus.DELIVERED, createdAt });
    expect(contactWindowExpired(delivered(ago(30)))).toBe(true);   // antiguo y sin fecha: vencido
    expect(contactWindowExpired(delivered(ago(2)))).toBe(false);   // reciente: sigue dentro del plazo
    expect(contactWindowExpired({ status: OrderStatus.CANCELLED, createdAt: ago(30) })).toBe(true);
  });

  it('sin NINGUNA fecha utilizable se restringe', () => {
    expect(contactWindowExpired({ status: OrderStatus.DELIVERED })).toBe(true);
    expect(contactWindowExpired({ status: OrderStatus.DELIVERED, createdAt: 'basura', deliveredAt: 'basura' })).toBe(true);
    // El historial del comercio solo muestra pedidos cerrados: ahí `terminal` basta aunque falte el estado.
    expect(contactWindowExpired({}, { terminal: true })).toBe(true);
  });

  it('una fecha de entrega en el futuro es un dato corrupto: no alarga el acceso', () => {
    const future = new Date(Date.now() + 90 * DAY);
    expect(contactWindowExpired({ status: OrderStatus.DELIVERED, deliveredAt: future, createdAt: ago(30) })).toBe(true);
  });

  it('un pedido «en curso» atascado desde hace semanas tampoco queda abierto para siempre', () => {
    expect(contactWindowExpired({ status: OrderStatus.PENDING, createdAt: ago(3) })).toBe(false);
    expect(contactWindowExpired({ status: OrderStatus.PENDING, createdAt: ago(40) })).toBe(true);
  });

  it('la fecha real manda siempre sobre la de creación', () => {
    expect(contactWindowExpired({ status: OrderStatus.DELIVERED, deliveredAt: ago(1), createdAt: ago(60) })).toBe(false);
    expect(contactWindowExpired({ status: OrderStatus.DELIVERED, deliveredAt: ago(60), createdAt: ago(1) })).toBe(true);
  });

  it('el historial del comercio oculta dirección y nombre completo de un pedido antiguo sin fecha de entrega', async () => {
    const order = await backdated({ deliveredAt: undefined }, 45);
    const plain = (await Order.findById(order._id).populate('clientId', 'name phone email').lean())!;
    const view: any = merchantOrderView(plain as never, { owner: true, terminal: true });
    expect(view.personalDataProtected).toBe(true);
    expect(view.deliveryAddress).toBe('');
    expect(view.clientId.name).toBe('María G.');
  });

  it('pedir contacto: vencido por creación exige justificación; con ella nace detenido y dice de dónde salió la fecha', async () => {
    const order = await backdated({ deliveredAt: undefined }, 45);

    const bare = await ask(owner, order._id.toString());
    expect(bare.status).toBe(422);
    expect(bare.body.code ?? bare.body.errorCode).toBe('CONTACT_WINDOW_EXPIRED');

    const res = await ask(owner, order._id.toString(), { reason: 'contact_customer_warranty', exceptionJustification: JUSTIFICATION });
    expect(res.status).toBe(201);
    const stored: any = await Pqrs.findById(res.body.data._id).lean();
    expect(stored.contactException).toMatchObject({ status: 'pending', closedAtSource: 'created_at_fallback' });
    expect(stored.contactException.daysSinceClosed).toBeGreaterThanOrEqual(44);

    // No se inventó una entrega ni se tocó el registro histórico.
    const untouched: any = await Order.findById(order._id).lean();
    expect(untouched.deliveredAt ?? null).toBeNull();
  });

  it('un pedido cancelado sin fecha de cancelación recibe el mismo tratamiento', async () => {
    const order = await backdated({ status: OrderStatus.CANCELLED, deliveredAt: undefined, cancelledAt: undefined }, 20);
    const res = await ask(owner, order._id.toString());
    expect(res.status).toBe(422);
  });

  it('un pedido reciente sin fecha de entrega sigue dentro del plazo: sin excepción', async () => {
    const order = await backdated({ deliveredAt: undefined }, 2);
    const res = await ask(owner, order._id.toString());
    expect(res.status).toBe(201);
    expect(((await Pqrs.findById(res.body.data._id).lean()) as any).contactException ?? null).toBeNull();
  });

  it('una excepción autorizada por soporte sobre un pedido sin fecha queda auditada como cualquier otra', async () => {
    const order = await backdated({ deliveredAt: undefined }, 45);
    const res = await ask(owner, order._id.toString(), { reason: 'contact_customer_warranty', exceptionJustification: JUSTIFICATION });
    const staff = await makeStaff({ roleSlug: 'soporte' });
    const decided = await decideContactException(res.body.data._id, String(staff._id), 'authorize', 'Garantía vigente verificada con el comercio.');
    expect(decided.contactException).toMatchObject({ status: 'authorized' });
    expect(String(decided.contactException!.decidedBy)).toBe(String(staff._id));
  });
});
