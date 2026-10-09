import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import {
  BusinessStaff, BusinessRole, BusinessPermission, BUSINESS_ROLE_PERMISSIONS, Order, Product,
} from '../models';
import { OrderStatus, UserRole } from '../types';
import { OrderEvent } from '../security/orderSecurity';
import { orderService } from '../services/order.service';
import { businessStaffService } from '../services/businessStaff.service';
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
const ROLES = [BusinessRole.OWNER, BusinessRole.MANAGER, BusinessRole.EMPLOYEE] as const;
type Role = (typeof ROLES)[number];

const has = (role: Role, permission: BusinessPermission) => BUSINESS_ROLE_PERMISSIONS[role].includes(permission);

describe('Matriz de permisos por rol', () => {
  // [permiso, dueño, administrador, empleado]
  const matrix: Array<[BusinessPermission, boolean, boolean, boolean]> = [
    [P.ORDERS_MANAGE, true, true, true],
    [P.ORDERS_CANCEL, true, true, true],
    [P.ORDERS_CANCEL_PAID, true, false, false],
    [P.CATALOG_AVAILABILITY, true, true, true],
    [P.CATALOG_EDIT, true, true, false],
    [P.CATALOG_CREATE, true, true, false],
    [P.CATALOG_DELETE, true, true, false],
    [P.CATALOG_CHANGE_PRICE, true, true, false],
    [P.TEAM_INVITE, true, true, false],
    [P.TEAM_EDIT, true, true, false],
    [P.TEAM_REMOVE, true, true, false],
    [P.TEAM_CHANGE_ROLE, true, false, false],
    [P.SECURITY_MANAGE, true, false, false],
    [P.SETTINGS_MANAGE, true, false, false],
    [P.BUSINESS_EDIT, true, false, false],
    [P.FINANCIAL_VIEW, true, false, false],
    [P.SETTLEMENTS_VIEW, true, false, false],
    [P.SETTLEMENTS_MANAGE, true, false, false],
    [P.DOCUMENTS_MANAGE, true, false, false],
    [P.SHIFT_VIEW, true, true, false],
  ];

  for (const [permission, ...expected] of matrix) {
    it(`${permission}: dueño/admin/empleado = ${expected.join('/')}`, () => {
      ROLES.forEach((role, i) => expect(has(role, permission), `${role} → ${permission}`).toBe(expected[i]));
    });
  }

  it('el dueño tiene todos los permisos que existen', () => {
    expect([...BUSINESS_ROLE_PERMISSIONS[BusinessRole.OWNER]].sort()).toEqual(Object.values(P).sort());
  });

  it('ningún rol operativo recibe un permiso financiero', () => {
    const financial = [P.FINANCIAL_VIEW, P.SETTLEMENTS_VIEW, P.SETTLEMENTS_MANAGE, P.DOCUMENTS_MANAGE];
    for (const role of [BusinessRole.MANAGER, BusinessRole.EMPLOYEE]) {
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
    [BusinessRole.OWNER, true], [BusinessRole.MANAGER, false], [BusinessRole.EMPLOYEE, false],
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

  // ── Hasta dónde cancela el comercio (auditoría 2026-10-09, ALTO 1) ──

  /** Lleva el pedido a un estado sin pasar por el flujo: lo que se prueba es el candado, no el flujo. */
  const moveTo = (id: string, status: OrderStatus) => Order.updateOne({ _id: id }, { $set: { status } });

  const CANCELLABLE = [OrderStatus.PENDING, OrderStatus.ACCEPTED, OrderStatus.PREPARING, OrderStatus.READY] as const;

  for (const role of ROLES) {
    for (const paid of [false, true]) {
      // El pagado solo lo cancela el propietario (cancel_paid); el resto de roles
      // choca con ese candado, no con el de estado, y se prueba aparte.
      if (paid && role !== BusinessRole.OWNER) continue;
      for (const status of CANCELLABLE) {
        it(`${role}: cancela un pedido ${paid ? 'pagado' : 'contra entrega'} en ${status}`, async () => {
          const id = await placeOrder(paid);
          await moveTo(id, status);
          const result = await cancel(id, await staffUser(role));
          expect(result.status).toBe(OrderStatus.CANCELLED);
        });
      }
    }
  }

  for (const role of ROLES) {
    for (const paid of [false, true]) {
      it(`${role}: NO cancela en ON_WAY un pedido ${paid ? 'pagado' : 'contra entrega'}, ni el propietario`, async () => {
        const id = await placeOrder(paid);
        await moveTo(id, OrderStatus.ON_WAY);
        // Un no-propietario con el pedido pagado choca antes con `cancel_paid`;
        // en cualquier otro caso, con el corte por estado. Se bloquea igual.
        const blockedByPayment = paid && role !== BusinessRole.OWNER;
        await expect(cancel(id, await staffUser(role))).rejects.toMatchObject(
          blockedByPayment
            ? { statusCode: 403, code: 'ORDER_CANCEL_PAID_FORBIDDEN' }
            : { statusCode: 409, code: 'BUSINESS_CANCEL_TOO_LATE' }
        );
        const after = (await Order.findById(id))!;
        expect(after.status).toBe(OrderStatus.ON_WAY);
        expect(after.cancelledAt).toBeUndefined();
      });
    }
  }

  it('por la API directa: el empleado no cancela en ON_WAY ni el propietario, y no se toca el pedido', async () => {
    const id = await placeOrder(false);
    await moveTo(id, OrderStatus.ON_WAY);
    for (const role of [BusinessRole.EMPLOYEE, BusinessRole.OWNER] as const) {
      const res = await request(app)
        .patch(`/api/v1/orders/${id}/status`)
        .set(await authHeader(await staffUser(role)))
        .send({ status: OrderStatus.CANCELLED, cancellationReason: 'Ya no lo queremos', cancellationCode: 'other' });
      expect(res.status, role).toBe(409);
      expect(res.body.code ?? res.body.error?.code, role).toBe('BUSINESS_CANCEL_TOO_LATE');
    }
    expect((await Order.findById(id))!.status).toBe(OrderStatus.ON_WAY);
  });

  it('por la API directa: el administrador del negocio no cancela un pedido pagado', async () => {
    const id = await placeOrder(true);
    const res = await request(app)
      .patch(`/api/v1/orders/${id}/status`)
      .set(await authHeader(await staffUser(BusinessRole.MANAGER)))
      .send({ status: OrderStatus.CANCELLED, cancellationReason: 'Ya no lo queremos', cancellationCode: 'other' });
    expect(res.status).toBe(403);
    expect((await Order.findById(id))!.status).toBe(OrderStatus.PENDING);
  });

  it('un pedido pagado en cocina tampoco lo cancela el empleado', async () => {
    const id = await placeOrder(true);
    await orderService.updateStatus(id, OrderStatus.ACCEPTED, owner._id.toString(), UserRole.BUSINESS);
    await orderService.updateStatus(id, OrderStatus.PREPARING, owner._id.toString(), UserRole.BUSINESS);
    await expect(cancel(id, await staffUser(BusinessRole.EMPLOYEE))).rejects.toMatchObject({ statusCode: 403 });
  });

  it('sin el permiso orders:cancel ni un pedido no pagado se cancela', async () => {
    const id = await placeOrder(false);
    const user = await staffUser(BusinessRole.EMPLOYEE);
    const original = BUSINESS_ROLE_PERMISSIONS[BusinessRole.EMPLOYEE];
    BUSINESS_ROLE_PERMISSIONS[BusinessRole.EMPLOYEE] = original.filter((p) => p !== P.ORDERS_CANCEL);
    try {
      await expect(cancel(id, user)).rejects.toMatchObject({ statusCode: 403, code: 'ORDER_CANCEL_FORBIDDEN' });
    } finally {
      BUSINESS_ROLE_PERMISSIONS[BusinessRole.EMPLOYEE] = original;
    }
  });

  it('exige un motivo, también al dueño', async () => {
    for (const reason of [null, '  ', 'ab']) {
      const id = await placeOrder(false);
      await expect(cancel(id, owner, reason)).rejects.toMatchObject({ statusCode: 400, code: 'CANCELLATION_REASON_REQUIRED' });
    }
  });

  it('queda registrado quién, cuándo, por qué, en qué estado y si estaba pagado', async () => {
    // No pagado: desde 2026-10-09 el administrador ya no cancela pedidos pagados.
    const id = await placeOrder(false);
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
      wasPaid: false,
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
    [BusinessRole.OWNER, true], [BusinessRole.MANAGER, true], [BusinessRole.EMPLOYEE, true],
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
    expect((await put(await staffUser(BusinessRole.EMPLOYEE), { stock: 5 })).status).toBe(200);
  });

  it('el operador no cuela otros campos junto a isAvailable', async () => {
    const operator = await staffUser(BusinessRole.EMPLOYEE);
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

  it('discountPrice y extras cuestan dinero: piden catalog:change_price, no solo catalog:edit', async () => {
    const manager = await staffUser(BusinessRole.MANAGER);
    const original = BUSINESS_ROLE_PERMISSIONS[BusinessRole.MANAGER];
    BUSINESS_ROLE_PERMISSIONS[BusinessRole.MANAGER] = original.filter((p) => p !== P.CATALOG_CHANGE_PRICE);
    try {
      expect((await put(manager, { discountPrice: 100 })).status).toBe(403);
      expect((await put(manager, { extras: [{ name: 'Queso', price: 500 }] })).status).toBe(403);
      // Lo que no es dinero sigue pudiéndose editar.
      expect((await put(manager, { name: 'Otro nombre' })).status).toBe(200);
    } finally {
      BUSINESS_ROLE_PERMISSIONS[BusinessRole.MANAGER] = original;
    }
    const saved = (await Product.findById(product._id))!;
    expect(saved.discountPrice ?? null).toBeNull();
    expect(saved.extras ?? []).toHaveLength(0);
  });

  it('reponer y agotar (escritura atómica) conservan sus reglas: stock 0 agota, stock > 0 repone', async () => {
    const operator = await staffUser(BusinessRole.EMPLOYEE);
    expect((await put(operator, { stock: 0 })).status).toBe(200);
    let saved = (await Product.findById(product._id))!;
    expect([saved.stock, saved.isAvailable]).toEqual([0, false]);

    expect((await put(operator, { stock: 6 })).status).toBe(200);
    saved = (await Product.findById(product._id))!;
    expect([saved.stock, saved.isAvailable]).toEqual([6, true]);

    // Dos personas a la vez: ninguna se pierde ni deja el producto a medias.
    const results = await Promise.all([put(operator, { isAvailable: false }), put(operator, { stock: 3 })]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    saved = (await Product.findById(product._id))!;
    expect(saved.stock).toBe(3);
  });

  it('un cuerpo sin ningún campo no es "solo disponibilidad"', async () => {
    expect((await put(await staffUser(BusinessRole.EMPLOYEE), {})).status).toBe(403);
  });

  it('el operador no borra; el administrador sí edita', async () => {
    const operator = await staffUser(BusinessRole.EMPLOYEE);
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
      businessId: business._id, userId: cashier._id, role: BusinessRole.EMPLOYEE, status: 'active', isActive: true,
    });
    const patch = async (user: any) =>
      request(app)
        .patch(`/api/v1/businesses/${business._id}/staff/${row._id}`)
        .set(await authHeader(user))
        .send({ role: BusinessRole.EMPLOYEE });

    expect((await patch(manager)).status).toBe(403);
    expect((await BusinessStaff.findById(row._id))!.role).toBe(BusinessRole.EMPLOYEE);
    expect((await patch(owner)).status).toBe(200);
    expect((await BusinessStaff.findById(row._id))!.role).toBe(BusinessRole.EMPLOYEE);
  });

  // ── Suspensiones y jerarquía (auditoría 2026-10-09, MEDIO 3) ──

  async function cashierRow(status: 'active' | 'suspended' = 'active') {
    const user = await makeUser({ role: UserRole.BUSINESS });
    const row = await BusinessStaff.create({
      businessId: business._id, userId: user._id, role: BusinessRole.EMPLOYEE, status, isActive: status === 'active',
    });
    return { user, row };
  }
  const patchStaff = async (actor: any, rowId: any, body: Record<string, unknown>) =>
    request(app).patch(`/api/v1/businesses/${business._id}/staff/${rowId}`).set(await authHeader(actor)).send(body);

  it('el propietario suspende y queda escrito quién y con qué papel', async () => {
    const { row } = await cashierRow();
    expect((await patchStaff(owner, row._id, { suspended: true })).status).toBe(200);
    const saved = (await BusinessStaff.findById(row._id))!;
    expect(saved.status).toBe('suspended');
    expect(saved.isActive).toBe(false);
    expect(saved.suspendedBy?.toString()).toBe(owner._id.toString());
    expect(saved.suspendedByRole).toBe(BusinessRole.OWNER);
  });

  it('un administrador NO levanta la suspensión del propietario, por ninguna puerta', async () => {
    const manager = await staffUser(BusinessRole.MANAGER);
    const { user, row } = await cashierRow();
    await patchStaff(owner, row._id, { suspended: true });

    // Reactivar.
    const reactivate = await patchStaff(manager, row._id, { suspended: false });
    expect(reactivate.status).toBe(403);
    expect(reactivate.body.code ?? reactivate.body.error?.code).toBe('SUSPENDED_BY_OWNER');

    // Retirar la fila para invitar de nuevo.
    const del = await request(app)
      .delete(`/api/v1/businesses/${business._id}/staff/${row._id}`)
      .set(await authHeader(manager));
    expect(del.status).toBe(403);

    // Reinvitar encima.
    const reinvite = await request(app)
      .post(`/api/v1/businesses/${business._id}/staff`)
      .set(await authHeader(manager))
      .send({ phone: user.phone, role: BusinessRole.EMPLOYEE });
    expect(reinvite.status).toBe(403);

    // Volver a suspender no le cambia el autor a la suspensión.
    expect((await patchStaff(manager, row._id, { suspended: true })).status).toBe(200);

    const saved = (await BusinessStaff.findById(row._id))!;
    expect(saved.status).toBe('suspended');
    expect(saved.isActive).toBe(false);
    expect(saved.suspendedByRole).toBe(BusinessRole.OWNER);
    // Y sigue sin acceso.
    expect(await businessStaffService.permissionsFor(user._id.toString(), business._id.toString())).toEqual([]);
  });

  it('el propietario sí reactiva lo que suspendió, y se limpia el rastro de la suspensión', async () => {
    const { user, row } = await cashierRow();
    await patchStaff(owner, row._id, { suspended: true });
    expect((await patchStaff(owner, row._id, { suspended: false })).status).toBe(200);

    const saved = (await BusinessStaff.findById(row._id))!;
    expect(saved.status).toBe('active');
    expect(saved.isActive).toBe(true);
    expect(saved.suspendedBy).toBeUndefined();
    expect(saved.suspendedByRole).toBeUndefined();
    expect((await businessStaffService.permissionsFor(user._id.toString(), business._id.toString())).length).toBeGreaterThan(0);
  });

  it('lo que suspendió un administrador lo puede levantar otro administrador', async () => {
    const first = await staffUser(BusinessRole.MANAGER);
    const second = await staffUser(BusinessRole.MANAGER);
    const { row } = await cashierRow();

    expect((await patchStaff(first, row._id, { suspended: true })).status).toBe(200);
    expect((await BusinessStaff.findById(row._id))!.suspendedByRole).toBe(BusinessRole.MANAGER);
    expect((await patchStaff(second, row._id, { suspended: false })).status).toBe(200);
    expect((await BusinessStaff.findById(row._id))!.status).toBe('active');
  });

  it('una suspensión anterior al cambio (sin autor registrado) la sigue pudiendo levantar un administrador', async () => {
    const manager = await staffUser(BusinessRole.MANAGER);
    const { row } = await cashierRow('suspended');
    expect((await patchStaff(manager, row._id, { suspended: false })).status).toBe(200);
  });

  it('el administrador sigue sin tocar a otro administrador', async () => {
    const manager = await staffUser(BusinessRole.MANAGER);
    const other = await staffUser(BusinessRole.MANAGER);
    const otherRow = (await BusinessStaff.findOne({ businessId: business._id, userId: other._id }))!;
    expect((await patchStaff(manager, otherRow._id, { suspended: true })).status).toBe(403);
    expect((await BusinessStaff.findById(otherRow._id))!.status).toBe('active');
  });

  it('el operador y el cajero no gestionan usuarios', async () => {
    for (const role of [BusinessRole.EMPLOYEE] as const) {
      const user = await staffUser(role);
      const res = await request(app)
        .post(`/api/v1/businesses/${business._id}/staff`)
        .set(await authHeader(user))
        .send({ phone: '3009998877', role: BusinessRole.EMPLOYEE });
      expect(res.status, role).toBe(403);
    }
  });
});
