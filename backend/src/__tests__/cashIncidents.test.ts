import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { orderService } from '../services/order.service';
import { ledgerService } from '../services/ledger.service';
import { cashIncidentService } from '../services/cashIncident.service';
import { paymentService, setPaymentProvider, SandboxPaymentProvider } from '../services/payments';
import {
  Order,
  Payment,
  CashReconciliation,
  CashPaymentIncident,
  LedgerEntry,
} from '../models';
import { AuditLog, AuditAction } from '../security';
import {
  PaymentMethod,
  PaymentStatus,
  OrderStatus,
  UserRole,
  LedgerAccount,
  CashReconciliationStatus,
  CashIncidentStatus,
  CashIncidentResolution,
} from '../types';
import {
  GARZON,
  offsetKm,
  makeUser,
  makeBusiness,
  makeProduct,
  makeDriver,
  makePricingConfig,
  authHeader,
  runDelivery,
} from './factories';

const DESTINATION = offsetKm(GARZON, 1);

/**
 * Faltantes de efectivo: qué pasa cuando el domiciliario dice que no le
 * pagaron.
 *
 * El caso es incómodo porque las dos respuestas fáciles están mal. Si
 * declarar el faltante borrara la deuda, ese botón sería la forma más
 * barata de no pagarle a ZIPP. Si no hiciera nada, el domiciliario cargaría
 * para siempre con un dinero que quizá nunca vio. Lo que hay en medio —y lo
 * que se prueba aquí— es que la declaración abre un expediente y **no mueve
 * ni un peso** hasta que una persona con permisos de finanzas decide.
 */

async function scenario(configOverrides: Record<string, unknown> = {}) {
  await makePricingConfig({
    cashOnDeliveryEnabled: true,
    cashOnDeliveryMaxAmount: 1_000_000,
    serviceFeeFixed: 1000,
    deliveryMarginFixed: 500,
    ...configOverrides,
  });

  const client = await makeUser({ role: UserRole.CLIENT });
  const owner = await makeUser({ role: UserRole.BUSINESS });
  const business = await makeBusiness(owner._id, { commissionRateBps: 1500 });
  const product = await makeProduct(business._id, { price: 20000 });

  const driverUser = await makeUser({ role: UserRole.DRIVER });
  const driver = await makeDriver(driverUser._id, { currentFund: 200000 });

  const finance = await makeUser({ role: UserRole.ADMIN, isFinanceAdmin: true });
  const plainAdmin = await makeUser({ role: UserRole.ADMIN });

  return { client, owner, business, product, driverUser, driver, finance, plainAdmin };
}

type Ctx = Awaited<ReturnType<typeof scenario>>;

function createOrder(ctx: Ctx, paymentMethod: PaymentMethod) {
  return orderService.create({
    clientId: ctx.client._id.toString(),
    businessId: ctx.business._id.toString(),
    items: [{ productId: ctx.product._id.toString(), quantity: 1 }],
    paymentMethod,
    deliveryAddress: 'Cra 10 #5-23',
    deliveryLatitude: DESTINATION.lat,
    deliveryLongitude: DESTINATION.lng,
  });
}

async function readyWithDriver(ctx: Ctx, order: any) {
  const ownerId = ctx.owner._id.toString();
  for (const status of [OrderStatus.ACCEPTED, OrderStatus.PREPARING, OrderStatus.READY]) {
    await orderService.updateStatus(order._id.toString(), status, ownerId, UserRole.BUSINESS);
  }
  await orderService.assignDriver(order._id.toString(), ctx.driver._id.toString());
}

async function deliveredCashOrder(ctx: Ctx) {
  const order = await createOrder(ctx, PaymentMethod.CASH_ON_DELIVERY);
  await readyWithDriver(ctx, order);
  await runDelivery(order._id.toString(), ctx.driverUser);
  return order;
}

const confirmCash = (orderId: string, user: any, body: Record<string, unknown>) =>
  request(app)
    .post(`/api/v1/orders/${orderId}/cash/confirm`)
    .set(authHeader(user))
    .send(body);

/** Atajo: entrega el pedido y declara el faltante. */
async function reportMissingCash(ctx: Ctx, note = 'El cliente no tenía el dinero') {
  const order = await deliveredCashOrder(ctx);
  await confirmCash(order._id.toString(), ctx.driverUser, { received: false, note });
  const incident = await CashPaymentIncident.findOne({ orderId: order._id });
  return { order, incident: incident! };
}

describe('1-4 · Apertura de la incidencia', () => {
  beforeEach(() => setPaymentProvider(new SandboxPaymentProvider()));
  afterEach(() => setPaymentProvider(null));

  it('1 · declarar el faltante crea la incidencia atada al pedido y al cobro', async () => {
    const ctx = await scenario();
    const { order, incident } = await reportMissingCash(ctx);

    expect(incident).toBeTruthy();
    expect(incident.status).toBe(CashIncidentStatus.OPEN);
    expect(incident.type).toBe('cash_not_received');
    expect(incident.orderId.toString()).toBe(order._id.toString());
    expect(incident.driverId.toString()).toBe(ctx.driver._id.toString());
    expect(incident.driverNote).toBe('El cliente no tenía el dinero');

    // El monto sale del pedido, no de lo que dijo el domiciliario.
    expect(incident.amount).toBe(order.finance.customerTotal);

    const payment = await Payment.findOne({ orderId: order._id });
    expect(incident.paymentId.toString()).toBe(payment!._id.toString());
  });

  it('1b · la incidencia apunta al registro financiero que ya existía', async () => {
    const ctx = await scenario();
    const { order, incident } = await reportMissingCash(ctx);

    const reconciliation = await CashReconciliation.findOne({ orderId: order._id });

    // No hay un segundo sistema de deuda: la incidencia señala la
    // conciliación de siempre en vez de copiar su importe a otro sitio.
    expect(incident.reconciliationId).toBeTruthy();
    expect(incident.reconciliationId!.toString()).toBe(reconciliation!._id.toString());
  });

  it('2 · abrir la incidencia NO elimina la deuda con ZIPP', async () => {
    const ctx = await scenario();
    const order = await deliveredCashOrder(ctx);

    const antes = await CashReconciliation.findOne({ orderId: order._id });
    await confirmCash(order._id.toString(), ctx.driverUser, { received: false });
    const despues = await CashReconciliation.findOne({ orderId: order._id });

    expect(despues!.amount).toBe(antes!.amount);
    expect(despues!.amount).toBeGreaterThan(0);
    expect(despues!.status).toBe(CashReconciliationStatus.PENDING);
    expect(despues!.voidedAt).toBeFalsy();
  });

  it('3 · abrir la incidencia no escribe ni un asiento nuevo en el libro', async () => {
    const ctx = await scenario();
    const order = await deliveredCashOrder(ctx);

    const asientosAntes = await LedgerEntry.countDocuments({ orderId: order._id });
    const transitoAntes = await ledgerService.accountBalance(LedgerAccount.CASH_IN_TRANSIT, {
      orderId: order._id,
    });

    await confirmCash(order._id.toString(), ctx.driverUser, { received: false });

    const asientosDespues = await LedgerEntry.countDocuments({ orderId: order._id });
    const transitoDespues = await ledgerService.accountBalance(LedgerAccount.CASH_IN_TRANSIT, {
      orderId: order._id,
    });

    // Ni duplicar `recordCashCollected` ni revertir el efectivo en tránsito:
    // el libro se escribió al entregar y ahí se queda hasta que finanzas
    // decida algo.
    expect(asientosDespues).toBe(asientosAntes);
    expect(transitoDespues.balance).toBe(transitoAntes.balance);
    expect(await ledgerService.isBalanced({ orderId: order._id })).toBe(true);
  });

  it('4 · declarar el faltante dos veces no crea dos expedientes', async () => {
    const ctx = await scenario();
    const order = await deliveredCashOrder(ctx);

    await confirmCash(order._id.toString(), ctx.driverUser, { received: false });
    const segunda = await confirmCash(order._id.toString(), ctx.driverUser, { received: false });

    expect(segunda.status).toBe(200);
    expect(segunda.body.data.changed).toBe(false);
    expect(await CashPaymentIncident.countDocuments({ orderId: order._id })).toBe(1);
  });

  it('4b · el índice único impide el duplicado aunque se llame al servicio directo', async () => {
    const ctx = await scenario();
    const { order } = await reportMissingCash(ctx);

    const payment = await Payment.findOne({ orderId: order._id });
    const recargado = await Order.findById(order._id);

    const otra = await cashIncidentService.open({
      order: recargado!,
      payment: payment!,
      driverId: ctx.driver._id,
      note: 'segundo intento',
    });

    expect(await CashPaymentIncident.countDocuments({ orderId: order._id })).toBe(1);
    // Devuelve el expediente que ya existía, con su nota original intacta.
    expect(otra.driverNote).toBe('El cliente no tenía el dinero');
  });
});

describe('5-6 · Quién puede declarar un faltante y cuándo', () => {
  beforeEach(() => setPaymentProvider(new SandboxPaymentProvider()));
  afterEach(() => setPaymentProvider(null));

  it('5 · un domiciliario no puede declarar el faltante de un pedido ajeno', async () => {
    const ctx = await scenario();
    const order = await deliveredCashOrder(ctx);

    const intruso = await makeUser({ role: UserRole.DRIVER });
    await makeDriver(intruso._id, { currentFund: 100000 });

    const res = await confirmCash(order._id.toString(), intruso, { received: false });

    expect(res.status).toBe(404);
    expect(await CashPaymentIncident.countDocuments({})).toBe(0);
  });

  it('6 · no puede declararse antes de terminar el servicio', async () => {
    const ctx = await scenario();
    const order = await createOrder(ctx, PaymentMethod.CASH_ON_DELIVERY);
    await readyWithDriver(ctx, order);

    const res = await confirmCash(order._id.toString(), ctx.driverUser, { received: false });

    expect(res.status).toBe(409);
    // Sin entrega no hay faltante posible: no se ha cobrado nada todavía.
    expect(await CashPaymentIncident.countDocuments({})).toBe(0);

    const intacto = await Order.findById(order._id);
    expect(intacto!.paymentStatus).toBe(PaymentStatus.PENDING_CASH);
  });
});

describe('7-9 · Gestión administrativa', () => {
  beforeEach(() => setPaymentProvider(new SandboxPaymentProvider()));
  afterEach(() => setPaymentProvider(null));

  const listIncidents = (user: any) =>
    request(app).get('/api/v1/finance/cash/incidents').set(authHeader(user));

  const review = (id: string, user: any) =>
    request(app).post(`/api/v1/finance/cash/incidents/${id}/review`).set(authHeader(user)).send({});

  const resolve = (id: string, user: any, body: Record<string, unknown>) =>
    request(app)
      .post(`/api/v1/finance/cash/incidents/${id}/resolve`)
      .set(authHeader(user))
      .send(body);

  it('7 · un administrador puede consultar las incidencias abiertas', async () => {
    const ctx = await scenario();
    const { order } = await reportMissingCash(ctx);

    const res = await listIncidents(ctx.plainAdmin);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);

    const fila = res.body.data[0];
    // Todo lo que el panel necesita para decidir, sin una segunda llamada.
    expect(fila.orderId.orderNumber).toBe(order.orderNumber);
    expect(fila.driverId.userId.name).toBeTruthy();
    expect(fila.orderId.clientId.name).toBeTruthy();
    expect(fila.amount).toBe(order.finance.customerTotal);
    expect(fila.status).toBe(CashIncidentStatus.OPEN);
    expect(fila.driverNote).toBeTruthy();
  });

  it('7b · un administrador sin permisos de finanzas no puede decidir', async () => {
    const ctx = await scenario();
    const { incident } = await reportMissingCash(ctx);

    // Ver sí (caso 7); decidir sobre el dinero de alguien, no.
    const res = await resolve(incident._id.toString(), ctx.plainAdmin, {
      resolution: 'driver_favor',
    });
    expect(res.status).toBe(403);

    const intacta = await CashPaymentIncident.findById(incident._id);
    expect(intacta!.status).toBe(CashIncidentStatus.OPEN);
  });

  it('7c · un domiciliario no puede resolver su propia incidencia', async () => {
    const ctx = await scenario();
    const { incident } = await reportMissingCash(ctx);

    const res = await resolve(incident._id.toString(), ctx.driverUser, {
      resolution: 'driver_favor',
    });
    expect(res.status).toBe(403);
  });

  it('8 · "a favor del domiciliario" anula el saldo pendiente', async () => {
    const ctx = await scenario();
    const { order, incident } = await reportMissingCash(ctx);

    await review(incident._id.toString(), ctx.finance);
    const res = await resolve(incident._id.toString(), ctx.finance, {
      resolution: 'driver_favor',
      adminNote: 'La foto de entrega respalda al domiciliario',
    });

    expect(res.status).toBe(200);

    const cerrada = await CashPaymentIncident.findById(incident._id);
    expect(cerrada!.status).toBe(CashIncidentStatus.RESOLVED);
    expect(cerrada!.resolution).toBe(CashIncidentResolution.DRIVER_FAVOR);
    expect(cerrada!.resolvedBy!.toString()).toBe(ctx.finance._id.toString());
    expect(cerrada!.resolvedAt).toBeTruthy();

    // Esta es la única salida que borra la deuda, y solo la firma finanzas.
    const reconciliation = await CashReconciliation.findOne({ orderId: order._id });
    expect(reconciliation!.amount).toBe(0);
    expect(reconciliation!.voidedAt).toBeTruthy();

    const cobrado = await Order.findById(order._id);
    expect(cobrado!.paymentStatus).toBe(PaymentStatus.FAILED);

    // ── El pedido queda cerrado también en el libro ──
    // Perdonar la deuda sin dar de baja el efectivo dejaba un balance que
    // afirmaba tener dinero en la calle que nadie iba a traer nunca, y ese
    // saldo solo podía crecer. La cuenta tiene que quedar en cero.
    const transito = await ledgerService.accountBalance(LedgerAccount.CASH_IN_TRANSIT, {
      orderId: order._id,
    });
    expect(transito.balance).toBe(0);

    // Y el dinero no se evapora: aparece como gasto por faltantes, que es
    // lo que de verdad fue.
    const gasto = await ledgerService.accountBalance(LedgerAccount.CASH_SHORTAGE_EXPENSE, {
      orderId: order._id,
    });
    expect(gasto.balance).toBeGreaterThan(0);
    expect(cerrada!.writtenOffAmount).toBe(gasto.balance);

    // La pérdida es la parte de ZIPP, no el total que pagaba el cliente:
    // el comercio ya cobró de la mano del domiciliario y el domiciliario
    // ya se quedó con su tarifa.
    expect(gasto.balance).toBeLessThan(order.finance.customerTotal);

    // El asiento se puede rastrear hasta el expediente que lo motivó.
    const asiento = await LedgerEntry.findOne({
      orderId: order._id,
      account: LedgerAccount.CASH_SHORTAGE_EXPENSE,
    });
    expect(asiento!.reference).toBe(`incident:${incident._id.toString()}`);
    expect(asiento!.driverId!.toString()).toBe(ctx.driver._id.toString());

    // Y el libro sigue cuadrando, que es la única forma de saber que el
    // cierre no rompió nada por otro lado.
    expect(await ledgerService.isBalanced({ orderId: order._id })).toBe(true);
  });

  it('8a · dar de baja el faltante no se cobra dos veces al gasto', async () => {
    const ctx = await scenario();
    const { order, incident } = await reportMissingCash(ctx);

    await resolve(incident._id.toString(), ctx.finance, { resolution: 'driver_favor' });
    const gastoUna = await ledgerService.accountBalance(LedgerAccount.CASH_SHORTAGE_EXPENSE, {
      orderId: order._id,
    });

    // Reenviar el formulario, un reintento de red, dos pestañas abiertas:
    // la referencia sale del expediente, así que el índice único del libro
    // convierte el segundo intento en un no-op.
    await resolve(incident._id.toString(), ctx.finance, { resolution: 'driver_favor' });
    const gastoDos = await ledgerService.accountBalance(LedgerAccount.CASH_SHORTAGE_EXPENSE, {
      orderId: order._id,
    });

    expect(gastoDos.balance).toBe(gastoUna.balance);
    expect(
      await LedgerEntry.countDocuments({
        orderId: order._id,
        account: LedgerAccount.CASH_SHORTAGE_EXPENSE,
      })
    ).toBe(1);

    const transito = await ledgerService.accountBalance(LedgerAccount.CASH_IN_TRANSIT, {
      orderId: order._id,
    });
    expect(transito.balance).toBe(0);
    expect(await ledgerService.isBalanced({ orderId: order._id })).toBe(true);
  });

  it('8a2 · confirmar la deuda no toca la cuenta de faltantes', async () => {
    const ctx = await scenario();
    const { order, incident } = await reportMissingCash(ctx);

    await resolve(incident._id.toString(), ctx.finance, { resolution: 'debt_confirmed' });

    // El domiciliario responde por ese dinero, así que ZIPP no ha perdido
    // nada: el efectivo sigue en tránsito hasta que lo rinda.
    const gasto = await ledgerService.accountBalance(LedgerAccount.CASH_SHORTAGE_EXPENSE, {
      orderId: order._id,
    });
    expect(gasto.balance).toBe(0);

    const transito = await ledgerService.accountBalance(LedgerAccount.CASH_IN_TRANSIT, {
      orderId: order._id,
    });
    expect(transito.balance).toBeGreaterThan(0);

    const cerrada = await CashPaymentIncident.findById(incident._id);
    expect(cerrada!.writtenOffAmount).toBe(0);
  });

  it('8c · una resolución no puede reabrir un cobro ya reembolsado', async () => {
    /**
     * `REFUNDED` es terminal en la tabla de transiciones: un reembolso
     * revertido se registra como un cobro nuevo, nunca reabriendo el
     * anterior. La resolución del expediente no comprobaba la tabla —solo
     * la mencionaba en un comentario— así que confirmar la deuda de un
     * pedido ya reembolsado lo dejaba marcado como pagado, con el dinero
     * devuelto al cliente y el pedido diciendo que se cobró.
     */
    const ctx = await scenario();
    const { order, incident } = await reportMissingCash(ctx);

    await Payment.updateOne(
      { orderId: order._id },
      { $set: { status: PaymentStatus.REFUNDED } }
    );

    const res = await resolve(incident._id.toString(), ctx.finance, {
      resolution: 'debt_confirmed',
      adminNote: 'Intento de confirmar deuda sobre un pedido reembolsado',
    });

    expect(res.status).toBe(409);

    const payment = await Payment.findOne({ orderId: order._id });
    expect(payment!.status).toBe(PaymentStatus.REFUNDED);

    const pedido = await Order.findById(order._id);
    expect(pedido!.paymentStatus).not.toBe(PaymentStatus.PAID);
  });

  it('8b · "confirmar deuda" mantiene el saldo y da el pedido por pagado', async () => {
    const ctx = await scenario();
    const { order, incident } = await reportMissingCash(ctx);

    const antes = await CashReconciliation.findOne({ orderId: order._id });

    const res = await resolve(incident._id.toString(), ctx.finance, {
      resolution: 'debt_confirmed',
      adminNote: 'El cliente confirma que pagó',
    });
    expect(res.status).toBe(200);

    const despues = await CashReconciliation.findOne({ orderId: order._id });
    expect(despues!.amount).toBe(antes!.amount);
    expect(despues!.status).toBe(CashReconciliationStatus.PENDING);
    expect(despues!.voidedAt).toBeFalsy();

    // Frente al cliente el pedido se pagó; lo que queda es una deuda del
    // domiciliario con ZIPP, que es justo lo que la conciliación representa.
    const cobrado = await Order.findById(order._id);
    expect(cobrado!.paymentStatus).toBe(PaymentStatus.PAID);

    const payment = await Payment.findOne({ orderId: order._id });
    const recorrido = payment!.statusHistory.map((e) => e.status);
    expect(recorrido).toEqual([
      PaymentStatus.PENDING_CASH,
      PaymentStatus.CASH_NOT_RECEIVED,
      PaymentStatus.CASH_RECEIVED,
      PaymentStatus.PAID,
    ]);
  });

  it('8c · "marcar como resuelta" cierra el caso sin tocar el saldo', async () => {
    const ctx = await scenario();
    const { order, incident } = await reportMissingCash(ctx);

    const antes = await CashReconciliation.findOne({ orderId: order._id });
    await resolve(incident._id.toString(), ctx.finance, { resolution: 'closed' });

    const despues = await CashReconciliation.findOne({ orderId: order._id });
    expect(despues!.amount).toBe(antes!.amount);

    const pedido = await Order.findById(order._id);
    expect(pedido!.paymentStatus).toBe(PaymentStatus.CASH_NOT_RECEIVED);

    const cerrada = await CashPaymentIncident.findById(incident._id);
    expect(cerrada!.resolution).toBe(CashIncidentResolution.CLOSED);
  });

  it('8d · las operaciones administrativas son idempotentes', async () => {
    const ctx = await scenario();
    const { order, incident } = await reportMissingCash(ctx);

    // Repetir "revisar" no rompe ni cambia nada.
    expect((await review(incident._id.toString(), ctx.finance)).status).toBe(200);
    expect((await review(incident._id.toString(), ctx.finance)).status).toBe(200);

    const primera = await resolve(incident._id.toString(), ctx.finance, {
      resolution: 'driver_favor',
    });
    const repetida = await resolve(incident._id.toString(), ctx.finance, {
      resolution: 'driver_favor',
    });

    expect(primera.status).toBe(200);
    expect(repetida.status).toBe(200);

    // Y el saldo se anuló una vez, no dos.
    const reconciliation = await CashReconciliation.findOne({ orderId: order._id });
    expect(reconciliation!.amount).toBe(0);
  });

  it('8e · una incidencia cerrada no admite una resolución distinta', async () => {
    const ctx = await scenario();
    const { incident } = await reportMissingCash(ctx);

    await resolve(incident._id.toString(), ctx.finance, { resolution: 'driver_favor' });
    const cambiar = await resolve(incident._id.toString(), ctx.finance, {
      resolution: 'debt_confirmed',
    });

    // Reabrir una decisión sobre dinero es una decisión nueva; no se hace
    // por accidente reenviando el formulario.
    expect(cambiar.status).toBe(409);

    const sigue = await CashPaymentIncident.findById(incident._id);
    expect(sigue!.resolution).toBe(CashIncidentResolution.DRIVER_FAVOR);
  });

  it('8f · no existe forma de borrar una incidencia', async () => {
    const ctx = await scenario();
    const { incident } = await reportMissingCash(ctx);

    const res = await request(app)
      .delete(`/api/v1/finance/cash/incidents/${incident._id}`)
      .set(authHeader(ctx.finance));

    // 404 porque la ruta no existe, y no existe a propósito: la incidencia
    // es la explicación de por qué un saldo cambió.
    expect(res.status).toBe(404);
    expect(await CashPaymentIncident.countDocuments({})).toBe(1);
  });

  it('9 · cada decisión queda auditada con actor, importe y estados', async () => {
    const ctx = await scenario();
    const { order, incident } = await reportMissingCash(ctx);

    await review(incident._id.toString(), ctx.finance);
    await resolve(incident._id.toString(), ctx.finance, {
      resolution: 'debt_confirmed',
      adminNote: 'Verificado con el cliente',
    });

    const revisada = await AuditLog.findOne({ action: AuditAction.CASH_INCIDENT_REVIEWED });
    expect(revisada).toBeTruthy();
    expect(revisada!.userId).toBe(ctx.finance._id.toString());

    const resuelta = await AuditLog.findOne({ action: AuditAction.CASH_INCIDENT_RESOLVED });
    expect(resuelta).toBeTruthy();
    expect(resuelta!.userId).toBe(ctx.finance._id.toString());
    expect(resuelta!.severity).toBe('high');
    expect(resuelta!.metadata!.resolution).toBe('debt_confirmed');
    expect(resuelta!.metadata!.previousStatus).toBe(CashIncidentStatus.UNDER_REVIEW);
    expect(resuelta!.metadata!.newStatus).toBe(CashIncidentStatus.RESOLVED);
    expect(resuelta!.metadata!.amount).toBe(order.finance.customerTotal);
    expect(resuelta!.metadata!.adminNote).toBe('Verificado con el cliente');
  });
});

describe('10 · Techo de efectivo sin rendir', () => {
  beforeEach(() => setPaymentProvider(new SandboxPaymentProvider()));
  afterEach(() => setPaymentProvider(null));

  it('10 · superado el techo, el domiciliario no puede tomar otro pedido en efectivo', async () => {
    // La conciliación de un pedido de este escenario vale 4.500
    // (comisión 3.000 + fee 1.000 + margen 500), así que un techo de 1.000
    // se supera con la primera entrega.
    const ctx = await scenario({ maxDriverCashDebt: 1000 });

    await deliveredCashOrder(ctx);

    const segundo = await createOrder(ctx, PaymentMethod.CASH_ON_DELIVERY);
    const ownerId = ctx.owner._id.toString();
    for (const status of [OrderStatus.ACCEPTED, OrderStatus.PREPARING, OrderStatus.READY]) {
      await orderService.updateStatus(segundo._id.toString(), status, ownerId, UserRole.BUSINESS);
    }

    await expect(
      orderService.assignDriver(segundo._id.toString(), ctx.driver._id.toString())
    ).rejects.toThrow(/límite de efectivo pendiente/i);

    const sinAsignar = await Order.findById(segundo._id);
    expect(sinAsignar!.driverId).toBeFalsy();
  });

  it('10b · el bloqueo queda auditado', async () => {
    const ctx = await scenario({ maxDriverCashDebt: 1000 });
    await deliveredCashOrder(ctx);

    const segundo = await createOrder(ctx, PaymentMethod.CASH_ON_DELIVERY);
    const ownerId = ctx.owner._id.toString();
    for (const status of [OrderStatus.ACCEPTED, OrderStatus.PREPARING, OrderStatus.READY]) {
      await orderService.updateStatus(segundo._id.toString(), status, ownerId, UserRole.BUSINESS);
    }
    await orderService
      .assignDriver(segundo._id.toString(), ctx.driver._id.toString())
      .catch(() => {});

    const registro = await AuditLog.findOne({ action: AuditAction.CASH_DEBT_LIMIT_BLOCKED });
    expect(registro).toBeTruthy();
    expect(registro!.metadata!.limit).toBe(1000);
    expect(registro!.metadata!.outstanding).toBeGreaterThanOrEqual(1000);
  });

  it('10c · el mismo domiciliario sí puede tomar un pedido en línea', async () => {
    const ctx = await scenario({ maxDriverCashDebt: 1000 });
    await deliveredCashOrder(ctx);

    const enLinea = await createOrder(ctx, PaymentMethod.ONLINE);
    await paymentService.initiate({
      orderId: enLinea._id.toString(),
      userId: ctx.client._id.toString(),
      amount: enLinea.finance.customerTotal,
      description: 'Prueba',
      customer: { name: 'Cliente' },
    });

    const ownerId = ctx.owner._id.toString();
    for (const status of [OrderStatus.ACCEPTED, OrderStatus.PREPARING, OrderStatus.READY]) {
      await orderService.updateStatus(enLinea._id.toString(), status, ownerId, UserRole.BUSINESS);
    }

    // El techo limita el efectivo en la calle, no al domiciliario: con un
    // pedido ya pagado no hay dinero ajeno que pueda perderse.
    const asignado = await orderService.assignDriver(
      enLinea._id.toString(),
      ctx.driver._id.toString()
    );
    expect(asignado.driverId!.toString()).toBe(ctx.driver._id.toString());
  });

  it('10d · liquidar el saldo vuelve a habilitar el efectivo', async () => {
    const ctx = await scenario({ maxDriverCashDebt: 1000 });
    const primero = await deliveredCashOrder(ctx);

    const { cashReconciliationService } = await import('../services/cashReconciliation.service');
    const record = await CashReconciliation.findOne({ orderId: primero._id });
    await cashReconciliationService.verifyByAdmin(
      [String(record!._id)],
      ctx.finance._id.toString(),
      'Consignación 7781'
    );

    const segundo = await createOrder(ctx, PaymentMethod.CASH_ON_DELIVERY);
    const ownerId = ctx.owner._id.toString();
    for (const status of [OrderStatus.ACCEPTED, OrderStatus.PREPARING, OrderStatus.READY]) {
      await orderService.updateStatus(segundo._id.toString(), status, ownerId, UserRole.BUSINESS);
    }

    const asignado = await orderService.assignDriver(
      segundo._id.toString(),
      ctx.driver._id.toString()
    );
    expect(asignado.driverId!.toString()).toBe(ctx.driver._id.toString());
  });

  it('10e · un techo en 0 significa sin límite', async () => {
    const ctx = await scenario({ maxDriverCashDebt: 0 });
    await deliveredCashOrder(ctx);

    const segundo = await createOrder(ctx, PaymentMethod.CASH_ON_DELIVERY);
    const ownerId = ctx.owner._id.toString();
    for (const status of [OrderStatus.ACCEPTED, OrderStatus.PREPARING, OrderStatus.READY]) {
      await orderService.updateStatus(segundo._id.toString(), status, ownerId, UserRole.BUSINESS);
    }

    const asignado = await orderService.assignDriver(
      segundo._id.toString(),
      ctx.driver._id.toString()
    );
    expect(asignado.driverId).toBeTruthy();
  });
});

describe('11-12 · El flujo en línea no se entera de nada de esto', () => {
  beforeEach(() => setPaymentProvider(new SandboxPaymentProvider()));
  afterEach(() => setPaymentProvider(null));

  it('11 · un pedido en línea no puede generar una incidencia de efectivo', async () => {
    const ctx = await scenario();
    const order = await createOrder(ctx, PaymentMethod.ONLINE);
    await paymentService.initiate({
      orderId: order._id.toString(),
      userId: ctx.client._id.toString(),
      amount: order.finance.customerTotal,
      description: 'Prueba',
      customer: { name: 'Cliente' },
    });

    const ownerId = ctx.owner._id.toString();
    for (const status of [OrderStatus.ACCEPTED, OrderStatus.PREPARING, OrderStatus.READY]) {
      await orderService.updateStatus(order._id.toString(), status, ownerId, UserRole.BUSINESS);
    }
    await orderService.assignDriver(order._id.toString(), ctx.driver._id.toString());
    await runDelivery(order._id.toString(), ctx.driverUser);

    const res = await confirmCash(order._id.toString(), ctx.driverUser, { received: false });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/no es de pago en efectivo/i);
    expect(await CashPaymentIncident.countDocuments({})).toBe(0);

    // Y sigue pagado, como lo dejó la pasarela.
    const pagado = await Order.findById(order._id);
    expect(pagado!.paymentStatus).toBe(PaymentStatus.PAID);
  });

  it('12 · la pasarela sigue siendo la autoridad de su propio flujo', async () => {
    const ctx = await scenario();

    // Un faltante en efectivo abierto y sin resolver, en paralelo.
    await reportMissingCash(ctx);

    const enLinea = await createOrder(ctx, PaymentMethod.ONLINE);
    const { intent } = await paymentService.initiate({
      orderId: enLinea._id.toString(),
      userId: ctx.client._id.toString(),
      amount: enLinea.finance.customerTotal,
      description: 'Prueba',
      customer: { name: 'Cliente' },
    });

    expect(intent.status).toBe('approved');

    const pagado = await Order.findById(enLinea._id);
    expect(pagado!.paymentStatus).toBe(PaymentStatus.PAID);
    expect(await ledgerService.isBalanced({ orderId: enLinea._id })).toBe(true);

    // Y la incidencia de efectivo no tocó nada del pedido en línea.
    const incidencias = await CashPaymentIncident.find({ orderId: enLinea._id });
    expect(incidencias).toHaveLength(0);
  });
});
