import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { BusinessStaff, BusinessRole, Order, Pqrs } from '../models';
import { AuditLog, AuditAction } from '../security';
import { OrderStatus, UserRole } from '../types';
import { orderService } from '../services/order.service';
import { merchantOrderView, customerOrderView, driverOrderView } from '../services/profileMasking';
import {
  GARZON, offsetKm, makeUser, makeBusiness, makeProduct, makePricingConfig, authHeader, counterAuthHeader,
} from './factories';

/**
 * Privacidad del historial y contacto intermediado (decisión 2026-10-17).
 *
 * El comercio conserva lo operativo y lo financiero de un pedido cerrado,
 * pero no el teléfono ni las coordenadas del cliente. Para hablar con él por
 * un reclamo, una garantía o una aclaración, pide a ZIPP que haga de puente
 * (PQRS `contact_customer_*`), con permiso, auditoría y sin recibir el número.
 */

const API = '/api/v1';
const DETAIL = 'El cliente dejó un reclamo por el empaque y queremos ofrecerle un cambio.';
const DESTINATION = offsetKm(GARZON, 2);

let owner: any;
let business: any;
let product: any;
let client: any;

async function placeOrder(status?: OrderStatus) {
  const order = await orderService.create({
    clientId: client._id.toString(),
    businessId: business._id.toString(),
    items: [{ productId: product._id.toString(), quantity: 1 }],
    paymentMethod: 'cash_on_delivery',
    deliveryAddress: 'Calle 5 # 3-21',
    deliveryLatitude: DESTINATION.lat,
    deliveryLongitude: DESTINATION.lng,
  });
  if (status) await Order.updateOne({ _id: order._id }, { $set: { status } });
  return order;
}

async function staff(role: BusinessRole, status: 'active' | 'pending' = 'active') {
  const user = await makeUser({ role: UserRole.BUSINESS });
  await BusinessStaff.create({ businessId: business._id, userId: user._id, role, isActive: status === 'active', status });
  return user;
}

const askContact = async (headers: Record<string, string>, orderId: string, reason = 'contact_customer_claim') =>
  request(app).post(`${API}/pqrs`).set(headers).send({
    reason, subject: 'Contactar al cliente', detail: DETAIL, businessId: business._id.toString(), orderId,
  });

beforeEach(async () => {
  await makePricingConfig({ cashOnDeliveryEnabled: true, cashOnDeliveryMaxAmount: 1_000_000 });
  owner = await makeUser({ role: UserRole.BUSINESS });
  business = await makeBusiness(owner._id);
  product = await makeProduct(business._id, { price: 20000 });
  client = await makeUser({ role: UserRole.CLIENT });
});

describe('Contacto intermediado con el cliente de un pedido cerrado', () => {
  it('el propietario lo pide: nace el caso, queda auditado y no recibe el número', async () => {
    const order = await placeOrder(OrderStatus.DELIVERED);
    const res = await askContact(await authHeader(owner), order._id.toString());

    expect(res.status).toBe(201);
    expect(JSON.stringify(res.body)).not.toContain(client.phone);
    const stored = await Pqrs.findById(res.body.data._id).lean();
    expect(stored!.reason).toBe('contact_customer_claim');
    expect(stored!.type).toBe('petition');
    expect(String(stored!.orderId)).toBe(order._id.toString());

    // `logAudit` no se espera en el controlador: se da un margen corto.
    await new Promise((r) => setTimeout(r, 50));
    const audit = await AuditLog.findOne({ action: AuditAction.CUSTOMER_CONTACT_REQUESTED, entityId: order._id.toString() }).lean();
    expect(audit).toBeTruthy();
    expect(audit!.metadata?.pqrsId).toBe(res.body.data._id);
  });

  it('el encargado también; el mostrador y la sesión de mostrador del dueño no', async () => {
    const order = await placeOrder(OrderStatus.CANCELLED);
    const manager = await staff(BusinessRole.MANAGER);
    expect((await askContact(await authHeader(manager), order._id.toString(), 'contact_customer_warranty')).status).toBe(201);

    const second = await placeOrder(OrderStatus.DELIVERED);
    const employee = await staff(BusinessRole.EMPLOYEE);
    expect((await askContact(await authHeader(employee), second._id.toString())).status).toBe(403);
    expect((await askContact(await counterAuthHeader(owner), second._id.toString())).status).toBe(403);
  });

  it('con el pedido en curso se rechaza y explica a qué motivo ir', async () => {
    const order = await placeOrder();
    const res = await askContact(await authHeader(owner), order._id.toString());
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/El cliente no responde/);
  });

  it('un caso abierto por pedido: el segundo responde 409', async () => {
    const order = await placeOrder(OrderStatus.DELIVERED);
    expect((await askContact(await authHeader(owner), order._id.toString())).status).toBe(201);
    const again = await askContact(await authHeader(owner), order._id.toString(), 'contact_customer_clarification');
    expect(again.status).toBe(409);
  });

  it('sin pedido no hay contacto, y con el pedido de otro negocio tampoco', async () => {
    const res = await request(app).post(`${API}/pqrs`).set(await authHeader(owner)).send({
      reason: 'contact_customer_claim', subject: 'Contactar', detail: DETAIL, businessId: business._id.toString(),
    });
    expect(res.status).toBe(422);

    const otherOwner = await makeUser({ role: UserRole.BUSINESS });
    const other = await makeBusiness(otherOwner._id);
    const order = await placeOrder(OrderStatus.DELIVERED);
    const foreign = await request(app).post(`${API}/pqrs`).set(await authHeader(otherOwner)).send({
      reason: 'contact_customer_claim', subject: 'Contactar', detail: DETAIL, businessId: other._id.toString(), orderId: order._id.toString(),
    });
    expect(foreign.status).toBe(403);
  });

  it('el cliente no puede usar estos motivos', async () => {
    const order = await placeOrder(OrderStatus.DELIVERED);
    const res = await request(app).post(`${API}/pqrs`).set(await authHeader(client)).send({
      reason: 'contact_customer_claim', subject: 'Contactar', detail: DETAIL, orderId: order._id.toString(),
    });
    expect(res.status).toBe(422);
  });

  it('una invitación sin aceptar no abre casos a nombre del local (antes bastaba con `isActive`)', async () => {
    const invited = await makeUser({ role: UserRole.BUSINESS });
    await BusinessStaff.create({ businessId: business._id, userId: invited._id, role: BusinessRole.MANAGER, isActive: true, status: 'pending' });
    const res = await request(app).post(`${API}/pqrs`).set(await authHeader(invited)).send({
      reason: 'panel_issue', subject: 'Algo falla', detail: DETAIL, businessId: business._id.toString(),
    });
    expect(res.status).toBe(403);
  });
});

describe('Ningún pedido sale con la economía de ZIPP a quien no le toca', () => {
  const PLATFORM_ONLY = ['deliveryMargin', 'platformGrossRevenue', 'platformPromotionExpense', 'platformNetRevenueBeforeOperatingCosts', 'taxPayable', 'merchantCommission', 'businessPayout'];

  it('el cliente: crear, mis pedidos y el detalle', async () => {
    const created = await request(app).post(`${API}/orders`).set(await authHeader(client)).send({
      businessId: business._id.toString(),
      items: [{ productId: product._id.toString(), quantity: 1 }],
      paymentMethod: 'online',
      deliveryAddress: 'Calle 5 # 3-21',
      deliveryLatitude: DESTINATION.lat,
      deliveryLongitude: DESTINATION.lng,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.data._id;
    const mine = (await request(app).get(`${API}/orders/my`).set(await authHeader(client))).body.data[0];
    const detail = (await request(app).get(`${API}/orders/${id}`).set(await authHeader(client))).body.data;

    for (const view of [created.body.data, mine, detail]) {
      for (const key of PLATFORM_ONLY) expect(view.finance?.[key]).toBeUndefined();
      expect(view.finance.customerTotal).toBeDefined();
      for (const key of ['driverPayout', 'platformCommission', 'businessPayout', 'dispatch']) expect(view[key]).toBeUndefined();
    }
  });

  it('el domiciliario conserva su pago, no la comisión ni el margen ni `dispatch`', async () => {
    const order = await placeOrder();
    const view = driverOrderView(await orderService.getById(order._id.toString())) as any;
    for (const key of PLATFORM_ONLY) expect(view.finance?.[key]).toBeUndefined();
    expect(view.finance.driverDeliveryPayout).toBeDefined();
    expect(view.driverPayout).toBeDefined();
    expect(view.dispatch).toBeUndefined();
  });

  it('`merchantOrderView` no reescribe el documento original al enmascarar', async () => {
    const order = await placeOrder(OrderStatus.DELIVERED);
    const doc = await orderService.getById(order._id.toString());
    const masked = merchantOrderView(doc, { owner: true, terminal: true }) as any;
    expect(masked.clientId.phone).toMatch(/\*/);
    expect((doc.clientId as any).phone).toBe(client.phone);
    expect(customerOrderView(doc) as any).toHaveProperty('deliveryLocation');
  });
});
