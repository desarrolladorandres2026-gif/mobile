import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import {
  BusinessStaff, BusinessRole, BusinessPermission, BUSINESS_ROLE_PERMISSIONS, Order, Product,
} from '../models';
import { OrderStatus, UserRole } from '../types';
import { OrderEvent } from '../security/orderSecurity';
import { orderService } from '../services/order.service';
import {
  GARZON, offsetKm, makeUser, makeBusiness, makeProduct, makePricingConfig, authHeader,
} from './factories';

/**
 * Matriz de la "división": cada rol contra cada acción sensible.
 *
 * La tabla de permisos es la fuente de verdad (primer bloque); los demás
 * prueban que el servidor la respeta de verdad, por la puerta que usaría
 * un empleado malicioso y no solo por el servicio.
 */

const P = BusinessPermission;
const ROLES = [BusinessRole.OWNER, BusinessRole.MANAGER, BusinessRole.OPERATOR, BusinessRole.CASHIER] as const;
type Role = (typeof ROLES)[number];

const has = (role: Role, permission: BusinessPermission) => BUSINESS_ROLE_PERMISSIONS[role].includes(permission);

describe('Matriz de permisos por rol', () => {
  // [permiso, dueño, administrador, operador, cajero]
  const matrix: Array<[BusinessPermission, boolean, boolean, boolean, boolean]> = [
    [P.ORDERS_MANAGE, true, true, true, true],
    [P.ORDERS_CANCEL, true, true, true, true],
    [P.ORDERS_CANCEL_PAID, true, true, false, false],
    [P.CATALOG_AVAILABILITY, true, true, true, false],
    [P.CATALOG_EDIT, true, true, false, false],
    [P.CATALOG_CREATE, true, true, false, false],
    [P.CATALOG_DELETE, true, true, false, false],
    [P.CATALOG_CHANGE_PRICE, true, true, false, false],
    [P.TEAM_INVITE, true, true, false, false],
    [P.TEAM_EDIT, true, true, false, false],
    [P.TEAM_REMOVE, true, true, false, false],
    [P.TEAM_CHANGE_ROLE, true, false, false, false],
    [P.SECURITY_MANAGE, true, false, false, false],
    [P.SETTINGS_MANAGE, true, false, false, false],
    [P.BUSINESS_EDIT, true, false, false, false],
    [P.FINANCIAL_VIEW, true, false, false, false],
    [P.SETTLEMENTS_VIEW, true, false, false, false],
    [P.SETTLEMENTS_MANAGE, true, false, false, false],
    [P.DOCUMENTS_MANAGE, true, false, false, false],
    [P.SHIFT_VIEW, true, true, false, true],
  ];

  for (const [permission, ...expected] of matrix) {
    it(`${permission}: dueño/admin/operador/cajero = ${expected.join('/')}`, () => {
      ROLES.forEach((role, i) => expect(has(role, permission), `${role} → ${permission}`).toBe(expected[i]));
    });
  }

  it('el dueño tiene todos los permisos que existen', () => {
    expect([...BUSINESS_ROLE_PERMISSIONS[BusinessRole.OWNER]].sort()).toEqual(Object.values(P).sort());
  });

  it('ningún rol operativo recibe un permiso financiero', () => {
    const financial = [P.FINANCIAL_VIEW, P.SETTLEMENTS_VIEW, P.SETTLEMENTS_MANAGE, P.DOCUMENTS_MANAGE];
    for (const role of [BusinessRole.MANAGER, BusinessRole.OPERATOR, BusinessRole.CASHIER]) {
      for (const permission of financial) expect(has(role, permission)).toBe(false);
    }
  });
});

// ── Por el servidor ──────────────────────────────────────────────────

const DESTINATION = offsetKm(GARZON, 2);
let owner: any;
let business: any;
let product: any;
let client: any;

async function staffUser(role: Role) {
  if (role === BusinessRole.OWNER) return owner;
  const user = await makeUser({ role: UserRole.BUSINESS });
  await BusinessStaff.create({ businessId: business._id, userId: user._id, role, status: 'active', isActive: true });
  return user;
}

/** Un pedido nuevo, pagado o no, listo para cancelarse. */
async function placeOrder(paid: boolean) {
  const order = await orderService.create({
    clientId: client._id.toString(),
    businessId: business._id.toString(),
    items: [{ productId: product._id.toString(), quantity: 1 }],
    paymentMethod: paid ? 'online' : 'cash_on_delivery',
    deliveryAddress: 'Calle 5 # 3-21',
    deliveryLatitude: DESTINATION.lat,
    deliveryLongitude: DESTINATION.lng,
  });
  if (paid) await Order.updateOne({ _id: order._id }, { $set: { paymentStatus: 'paid' } });
  return order._id.toString();
}

// `null` = sin motivo (un `undefined` activaría el valor por defecto).
const cancel = (id: string, user: any, reason: string | null = 'Se acabó el producto') =>
  orderService.updateStatus(id, OrderStatus.CANCELLED, user._id.toString(), UserRole.BUSINESS, reason ?? undefined, {}, 'other' as any);

beforeEach(async () => {
  await makePricingConfig({ cashOnDeliveryEnabled: true, cashOnDeliveryMaxAmount: 1_000_000 });
  owner = await makeUser({ role: UserRole.BUSINESS });
  business = await makeBusiness(owner._id);
  product = await makeProduct(business._id, { price: 20000 });
  client = await makeUser({ role: UserRole.CLIENT });
});

describe('Cancelar pedidos', () => {
  for (const role of ROLES) {
    it(`${role}: cancela un pedido no pagado`, async () => {
      const id = await placeOrder(false);
      const result = await cancel(id, await staffUser(role));
      expect(result.status).toBe(OrderStatus.CANCELLED);
    });
  }

  for (const [role, allowed] of [
    [BusinessRole.OWNER, true], [BusinessRole.MANAGER, true], [BusinessRole.OPERATOR, false], [BusinessRole.CASHIER, false],
  ] as const) {
    it(`${role}: ${allowed ? 'SÍ' : 'NO'} cancela un pedido pagado`, async () => {
      const id = await placeOrder(true);
      const attempt = cancel(id, await staffUser(role));
      if (allowed) {
        expect((await attempt).status).toBe(OrderStatus.CANCELLED);
      } else {
        await expect(attempt).rejects.toMatchObject({ statusCode: 403, code: 'ORDER_CANCEL_PAID_FORBIDDEN' });
        expect((await Order.findById(id))!.status).not.toBe(OrderStatus.CANCELLED);
      }
    });
  }

  it('un pedido pagado en cocina tampoco lo cancela el operador', async () => {
    const id = await placeOrder(true);
    await orderService.updateStatus(id, OrderStatus.ACCEPTED, owner._id.toString(), UserRole.BUSINESS);
    await orderService.updateStatus(id, OrderStatus.PREPARING, owner._id.toString(), UserRole.BUSINESS);
    await expect(cancel(id, await staffUser(BusinessRole.OPERATOR))).rejects.toMatchObject({ statusCode: 403 });
  });

  it('sin el permiso orders:cancel ni un pedido no pagado se cancela', async () => {
    const id = await placeOrder(false);
    const user = await staffUser(BusinessRole.OPERATOR);
    const original = BUSINESS_ROLE_PERMISSIONS[BusinessRole.OPERATOR];
    BUSINESS_ROLE_PERMISSIONS[BusinessRole.OPERATOR] = original.filter((p) => p !== P.ORDERS_CANCEL);
    try {
      await expect(cancel(id, user)).rejects.toMatchObject({ statusCode: 403, code: 'ORDER_CANCEL_FORBIDDEN' });
    } finally {
      BUSINESS_ROLE_PERMISSIONS[BusinessRole.OPERATOR] = original;
    }
  });

  it('exige un motivo, también al dueño', async () => {
    for (const reason of [null, '  ', 'ab']) {
      const id = await placeOrder(false);
      await expect(cancel(id, owner, reason)).rejects.toMatchObject({ statusCode: 400, code: 'CANCELLATION_REASON_REQUIRED' });
    }
  });

  it('queda registrado quién, cuándo, por qué, en qué estado y si estaba pagado', async () => {
    const id = await placeOrder(true);
    const manager = await staffUser(BusinessRole.MANAGER);
    await orderService.updateStatus(id, OrderStatus.ACCEPTED, manager._id.toString(), UserRole.BUSINESS);
    await cancel(id, manager, 'Cocina cerrada por avería');

    const order = (await Order.findById(id))!;
    expect(order.cancelledByUserId?.toString()).toBe(manager._id.toString());
    expect(order.cancelledAt).toBeInstanceOf(Date);
    expect(order.cancellationReason).toBe('Cocina cerrada por avería');

    // La bitácora se escribe sin esperar: se da un respiro antes de leerla.
    let event: any = null;
    for (let i = 0; i < 20 && !event; i++) {
      event = await OrderEvent.findOne({ orderId: id, 'newValue.status': OrderStatus.CANCELLED }).lean();
      if (!event) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(event.userId).toBe(manager._id.toString());
    expect(event.previousValue.status).toBe(OrderStatus.ACCEPTED);
    expect(event.newValue).toMatchObject({
      cancellationReason: 'Cocina cerrada por avería',
      wasPaid: true,
      actorBusinessRole: BusinessRole.MANAGER,
    });
    expect(event.timestamp).toBeInstanceOf(Date);
  });
});

describe('Disponibilidad del catálogo', () => {
  const put = async (user: any, body: Record<string, unknown>) =>
    request(app)
      .put(`/api/v1/products/${product._id}`)
      .set(await authHeader(user))
      .send({ businessId: business._id.toString(), ...body });

  for (const [role, allowed] of [
    [BusinessRole.OWNER, true], [BusinessRole.MANAGER, true], [BusinessRole.OPERATOR, true], [BusinessRole.CASHIER, false],
  ] as const) {
    it(`${role}: ${allowed ? 'SÍ' : 'NO'} marca agotado y vuelve a habilitar`, async () => {
      const user = await staffUser(role);
      const off = await put(user, { isAvailable: false });
      expect(off.status).toBe(allowed ? 200 : 403);
      expect((await Product.findById(product._id))!.isAvailable).toBe(!allowed);
      if (allowed) {
        expect((await put(user, { isAvailable: true })).status).toBe(200);
        expect((await Product.findById(product._id))!.isAvailable).toBe(true);
      }
    });
  }

  it('el operador puede reponer unidades (stock) pero nada más', async () => {
    expect((await put(await staffUser(BusinessRole.OPERATOR), { stock: 5 })).status).toBe(200);
  });

  it('el operador no cuela otros campos junto a isAvailable', async () => {
    const operator = await staffUser(BusinessRole.OPERATOR);
    const before = (await Product.findById(product._id))!;
    for (const extra of [
      { price: 1 }, { name: 'Otro nombre' }, { description: 'x' }, { discountPrice: 100 }, { extras: [] },
      { modifierGroups: [] }, { isFeatured: true }, { prepTimeMinutes: 1 }, { requiresAgeVerification: true },
      { categoryId: before.categoryId.toString() },
    ]) {
      const res = await put(operator, { isAvailable: false, ...extra });
      expect(res.status, JSON.stringify(extra)).toBe(403);
    }
    const after = (await Product.findById(product._id))!;
    expect(after.price).toBe(before.price);
    expect(after.name).toBe(before.name);
    expect(after.isAvailable).toBe(true);
  });

  it('un cuerpo sin ningún campo no es "solo disponibilidad"', async () => {
    expect((await put(await staffUser(BusinessRole.OPERATOR), {})).status).toBe(403);
  });

  it('el operador no borra; el administrador sí edita', async () => {
    const operator = await staffUser(BusinessRole.OPERATOR);
    const del = await request(app)
      .delete(`/api/v1/products/${product._id}`)
      .set(await authHeader(operator))
      .send({ businessId: business._id.toString() });
    expect(del.status).toBe(403);
    expect((await put(await staffUser(BusinessRole.MANAGER), { name: 'Nombre nuevo' })).status).toBe(200);
  });

  it('un empleado de otro negocio no puede ni agotar', async () => {
    const stranger = await makeUser({ role: UserRole.BUSINESS });
    expect((await put(stranger, { isAvailable: false })).status).toBe(403);
  });
});

describe('Gestión de equipo', () => {
  it('el administrador no cambia roles; el propietario sí', async () => {
    const manager = await staffUser(BusinessRole.MANAGER);
    const cashier = await makeUser({ role: UserRole.BUSINESS });
    const row = await BusinessStaff.create({
      businessId: business._id, userId: cashier._id, role: BusinessRole.CASHIER, status: 'active', isActive: true,
    });
    const patch = async (user: any) =>
      request(app)
        .patch(`/api/v1/businesses/${business._id}/staff/${row._id}`)
        .set(await authHeader(user))
        .send({ role: BusinessRole.OPERATOR });

    expect((await patch(manager)).status).toBe(403);
    expect((await BusinessStaff.findById(row._id))!.role).toBe(BusinessRole.CASHIER);
    expect((await patch(owner)).status).toBe(200);
    expect((await BusinessStaff.findById(row._id))!.role).toBe(BusinessRole.OPERATOR);
  });

  it('el operador y el cajero no gestionan usuarios', async () => {
    for (const role of [BusinessRole.OPERATOR, BusinessRole.CASHIER] as const) {
      const user = await staffUser(role);
      const res = await request(app)
        .post(`/api/v1/businesses/${business._id}/staff`)
        .set(await authHeader(user))
        .send({ phone: '3009998877', role: BusinessRole.CASHIER });
      expect(res.status, role).toBe(403);
    }
  });
});
