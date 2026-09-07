import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { orderService } from '../services/order.service';
import { ledgerService } from '../services/ledger.service';
import { cashReconciliationService } from '../services/cashReconciliation.service';
import {
  paymentService,
  setPaymentProvider,
  SandboxPaymentProvider,
} from '../services/payments';
import type {
  PaymentProvider,
  PaymentIntent,
  CreatePaymentInput,
  WebhookEvent,
} from '../services/payments/provider';
import { Order, Payment, Payout, CashReconciliation, Driver } from '../models';
import { AuditLog, AuditAction } from '../security';
import {
  PaymentMethod,
  PaymentStatus,
  OrderStatus,
  UserRole,
  PayoutStatus,
  LedgerAccount,
  CashReconciliationStatus,
  PaymentType,
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
 * Los dos métodos de pago, de extremo a extremo.
 *
 * El flujo en línea ya tenía cobertura propia (payments, wompi,
 * payment-hardening); lo que se prueba aquí es el que no la tenía: el
 * dinero que ZIPP nunca toca. Un pedido en efectivo pasa por las manos de
 * una persona en la calle, y la única barrera entre eso y un cobro
 * inventado son las comprobaciones del servidor. Cada caso de este
 * archivo es una de esas barreras.
 */

/**
 * Proveedor que deja todo intento en "pendiente".
 *
 * El sandbox por defecto aprueba en el acto, que es cómodo pero no es la
 * forma de un checkout de Wompi: ahí el pago se queda esperando a que el
 * cliente vuelva. Los casos de cambio de método necesitan justamente ese
 * estado intermedio —un enlace vivo y pagadero— porque es el único en el
 * que el doble cobro es posible.
 */
class PendingProvider implements PaymentProvider {
  readonly name = 'pending-test';
  createdCount = 0;

  isConfigured() { return true; }

  async createPayment(input: CreatePaymentInput): Promise<PaymentIntent> {
    this.createdCount += 1;
    return {
      id: input.reference ?? `pend_${this.createdCount}`,
      status: 'pending',
      amount: input.amount,
      currency: input.currency,
      orderId: input.orderId,
      checkoutUrl: `https://checkout.test/${input.reference}`,
    };
  }

  async getPayment(paymentId: string): Promise<PaymentIntent> {
    throw new Error(`sin registro para ${paymentId}`);
  }

  async refund(): Promise<PaymentIntent> {
    throw new Error('no soportado');
  }

  verifyWebhookSignature() { return false; }
  parseWebhook(): WebhookEvent | null { return null; }
}

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
  const driver = await makeDriver(driverUser._id, { currentFund: 100000 });

  return { client, owner, business, product, driverUser, driver };
}

function createOrder(
  ctx: Awaited<ReturnType<typeof scenario>>,
  paymentMethod: PaymentMethod
) {
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

/** Lleva un pedido hasta "listo" y le asigna el domiciliario. */
async function readyWithDriver(ctx: Awaited<ReturnType<typeof scenario>>, order: any) {
  const ownerId = ctx.owner._id.toString();
  for (const status of [OrderStatus.ACCEPTED, OrderStatus.PREPARING, OrderStatus.READY]) {
    await orderService.updateStatus(order._id.toString(), status, ownerId, UserRole.BUSINESS);
  }
  await orderService.assignDriver(order._id.toString(), ctx.driver._id.toString());
}

/** Pedido en efectivo entregado de verdad: evidencia y códigos incluidos. */
async function deliveredCashOrder(ctx: Awaited<ReturnType<typeof scenario>>) {
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

describe('Métodos de pago — selección', () => {
  beforeEach(() => setPaymentProvider(new SandboxPaymentProvider()));
  afterEach(() => setPaymentProvider(null));

  it('1 · un pedido en línea nace pendiente de la pasarela', async () => {
    const ctx = await scenario();
    const order = await createOrder(ctx, PaymentMethod.ONLINE);

    expect(order.paymentMethod).toBe(PaymentMethod.ONLINE);
    expect(order.paymentStatus).toBe(PaymentStatus.PENDING);
  });

  it('2 · un pedido en efectivo nace en PENDING_CASH, no en PENDING', async () => {
    const ctx = await scenario();
    const order = await createOrder(ctx, PaymentMethod.CASH_ON_DELIVERY);

    expect(order.paymentMethod).toBe(PaymentMethod.CASH_ON_DELIVERY);
    // La distinción es el punto: "pendiente" y "se cobra en la puerta" no
    // son el mismo hecho, y confundirlos contaba como moroso a todo pedido
    // contra entrega en curso.
    expect(order.paymentStatus).toBe(PaymentStatus.PENDING_CASH);
  });

  it('3 · no se puede crear un pedido sin método de pago', async () => {
    const ctx = await scenario();

    const sinMetodo = await request(app)
      .post('/api/v1/orders')
      .set(authHeader(ctx.client))
      .send({
        businessId: ctx.business._id.toString(),
        items: [{ productId: ctx.product._id.toString(), quantity: 1 }],
        deliveryAddress: 'Cra 10 #5-23',
        deliveryLatitude: DESTINATION.lat,
        deliveryLongitude: DESTINATION.lng,
      });
    expect(sinMetodo.status).toBe(400);

    const invalido = await request(app)
      .post('/api/v1/orders')
      .set(authHeader(ctx.client))
      .send({
        businessId: ctx.business._id.toString(),
        items: [{ productId: ctx.product._id.toString(), quantity: 1 }],
        paymentMethod: 'bitcoin',
        deliveryAddress: 'Cra 10 #5-23',
        deliveryLatitude: DESTINATION.lat,
        deliveryLongitude: DESTINATION.lng,
      });
    expect(invalido.status).toBe(400);

    expect(await Order.countDocuments({})).toBe(0);
  });

  it('4 · el método en línea abre un cobro en la pasarela', async () => {
    const ctx = await scenario();
    const order = await createOrder(ctx, PaymentMethod.ONLINE);

    const { intent } = await paymentService.initiate({
      orderId: order._id.toString(),
      userId: ctx.client._id.toString(),
      amount: order.finance.customerTotal,
      description: 'Prueba',
      customer: { name: 'Cliente' },
    });

    expect(intent.amount).toBe(order.finance.customerTotal);

    const payment = await Payment.findOne({
      orderId: order._id,
      method: { $ne: PaymentMethod.CASH_ON_DELIVERY },
    });
    expect(payment).toBeTruthy();
    expect(payment!.reference).toMatch(/^ZIPP-/);
  });

  it('5 · el método en efectivo no llama a la pasarela en ningún momento', async () => {
    const ctx = await scenario();
    const provider = new PendingProvider();
    setPaymentProvider(provider);

    const order = await deliveredCashOrder(ctx);
    await paymentService.confirmCashCollection({
      orderId: order._id.toString(),
      driverId: ctx.driver._id.toString(),
      actorUserId: ctx.driverUser._id.toString(),
      received: true,
    });

    // Ni al crear, ni al entregar, ni al confirmar: el dinero en efectivo
    // no pasa por Wompi en ninguno de los tres momentos.
    expect(provider.createdCount).toBe(0);
  });

  it('6 · el cobro en efectivo sigue pendiente después de entregar', async () => {
    const ctx = await scenario();
    const order = await deliveredCashOrder(ctx);

    const entregado = await Order.findById(order._id);
    expect(entregado!.status).toBe(OrderStatus.DELIVERED);
    // Entregar no es cobrar: falta que el domiciliario lo declare.
    expect(entregado!.paymentStatus).toBe(PaymentStatus.PENDING_CASH);

    const payment = await Payment.findOne({ orderId: order._id });
    expect(payment!.status).toBe(PaymentStatus.PENDING_CASH);
  });
});

describe('Confirmación de efectivo — antifraude', () => {
  beforeEach(() => setPaymentProvider(new SandboxPaymentProvider()));
  afterEach(() => setPaymentProvider(null));

  it('7 · no puede marcarse recibido antes de finalizar el servicio', async () => {
    const ctx = await scenario();
    const order = await createOrder(ctx, PaymentMethod.CASH_ON_DELIVERY);
    await readyWithDriver(ctx, order);

    // El pedido está "listo": el domiciliario lo tiene asignado pero no ha
    // entregado nada. Este es el ataque que la puerta existe para parar.
    const res = await confirmCash(order._id.toString(), ctx.driverUser, { received: true });

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/entrega esté completada/i);

    const sinCobrar = await Order.findById(order._id);
    expect(sinCobrar!.paymentStatus).toBe(PaymentStatus.PENDING_CASH);

    const payment = await Payment.findOne({ orderId: order._id });
    expect(payment!.status).toBe(PaymentStatus.PENDING_CASH);
    expect(payment!.processedAt).toBeFalsy();
  });

  it('7b · el intento prematuro queda auditado', async () => {
    const ctx = await scenario();
    const order = await createOrder(ctx, PaymentMethod.CASH_ON_DELIVERY);
    await readyWithDriver(ctx, order);

    await confirmCash(order._id.toString(), ctx.driverUser, { received: true });

    const registro = await AuditLog.findOne({
      action: AuditAction.CASH_COLLECTION_BLOCKED,
      entityId: order._id.toString(),
    });
    // Sin este registro, un intento de cobrar sin entregar sería
    // indistinguible de un error de red del cliente.
    expect(registro).toBeTruthy();
    expect(registro!.severity).toBe('high');
  });

  it('8 · después de entregar, el domiciliario sí puede confirmarlo', async () => {
    const ctx = await scenario();
    const order = await deliveredCashOrder(ctx);

    const res = await confirmCash(order._id.toString(), ctx.driverUser, { received: true });

    expect(res.status).toBe(200);
    expect(res.body.data.paymentStatus).toBe(PaymentStatus.PAID);

    const cobrado = await Order.findById(order._id);
    expect(cobrado!.paymentStatus).toBe(PaymentStatus.PAID);
  });

  it('9 · el Payment queda con la historia completa del cobro', async () => {
    const ctx = await scenario();
    const order = await deliveredCashOrder(ctx);

    await confirmCash(order._id.toString(), ctx.driverUser, { received: true });

    const payment = await Payment.findOne({ orderId: order._id });
    expect(payment!.status).toBe(PaymentStatus.PAID);
    expect(payment!.method).toBe(PaymentMethod.CASH_ON_DELIVERY);
    expect(payment!.amount).toBe(order.finance.customerTotal);
    expect(payment!.processedAt).toBeTruthy();

    // La declaración y su consecuencia son hechos distintos y quedan los
    // dos: quien revise un faltante meses después necesita ver que alguien
    // dijo "lo recibí", no solo que el pedido figura pagado.
    const recorrido = payment!.statusHistory.map((e) => e.status);
    expect(recorrido).toEqual([
      PaymentStatus.PENDING_CASH,
      PaymentStatus.CASH_RECEIVED,
      PaymentStatus.PAID,
    ]);
    expect(payment!.statusHistory.at(-1)!.source).toBe('cash');
  });

  it('9b · queda auditado quién confirmó, cuánto y desde qué estado', async () => {
    const ctx = await scenario();
    const order = await deliveredCashOrder(ctx);

    await confirmCash(order._id.toString(), ctx.driverUser, { received: true });

    const registro = await AuditLog.findOne({
      action: AuditAction.CASH_COLLECTION_CONFIRMED,
    });
    expect(registro).toBeTruthy();
    expect(registro!.userId).toBe(ctx.driverUser._id.toString());
    expect(registro!.metadata!.amount).toBe(order.finance.customerTotal);
    expect(registro!.metadata!.previousStatus).toBe(PaymentStatus.PENDING_CASH);
    expect(registro!.metadata!.newStatus).toBe(PaymentStatus.PAID);
    expect(registro!.metadata!.driverId).toBe(ctx.driver._id.toString());
  });

  it('10 · confirmar dos veces no cobra dos veces', async () => {
    const ctx = await scenario();
    const order = await deliveredCashOrder(ctx);

    const primera = await confirmCash(order._id.toString(), ctx.driverUser, { received: true });
    const segunda = await confirmCash(order._id.toString(), ctx.driverUser, { received: true });

    expect(primera.status).toBe(200);
    expect(primera.body.data.changed).toBe(true);
    // Repetir es lo que hace una red móvil mala, no un ataque: se responde
    // lo mismo sin volver a mover nada.
    expect(segunda.status).toBe(200);
    expect(segunda.body.data.changed).toBe(false);

    expect(await Payment.countDocuments({ orderId: order._id })).toBe(1);

    const payment = await Payment.findOne({ orderId: order._id });
    const pagados = payment!.statusHistory.filter((e) => e.status === PaymentStatus.PAID);
    expect(pagados).toHaveLength(1);

    // Y la deuda con ZIPP sigue siendo una, no dos.
    expect(await CashReconciliation.countDocuments({ orderId: order._id })).toBe(1);
  });

  it('16 · un domiciliario no puede confirmar el efectivo de otro pedido', async () => {
    const ctx = await scenario();
    const order = await deliveredCashOrder(ctx);

    const intruso = await makeUser({ role: UserRole.DRIVER });
    await makeDriver(intruso._id, { currentFund: 100000 });

    const res = await confirmCash(order._id.toString(), intruso, { received: true });

    // 404 y no 403: distinguirlos convertiría el endpoint en un oráculo
    // para enumerar pedidos ajenos (ver resolveOrderAccess).
    expect(res.status).toBe(404);

    const intacto = await Order.findById(order._id);
    expect(intacto!.paymentStatus).toBe(PaymentStatus.PENDING_CASH);
  });

  it('16b · ni el cliente ni el comercio pueden confirmar el efectivo', async () => {
    const ctx = await scenario();
    const order = await deliveredCashOrder(ctx);

    const cliente = await confirmCash(order._id.toString(), ctx.client, { received: true });
    const comercio = await confirmCash(order._id.toString(), ctx.owner, { received: true });

    // 403 y no 404: los dos participan en este pedido y pueden verlo, así
    // que negar su existencia sería mentir. Lo que no pueden es declarar un
    // cobro que no presenciaron. El 404 se reserva para quien no tiene
    // nada que ver con el pedido (caso 16), donde distinguir "existe pero
    // no es tuyo" de "no existe" sí filtraría información.
    expect(cliente.status).toBe(403);
    expect(comercio.status).toBe(403);

    const intacto = await Order.findById(order._id);
    expect(intacto!.paymentStatus).toBe(PaymentStatus.PENDING_CASH);
  });

  it('12 · un pedido cancelado no admite cobro por ninguna vía', async () => {
    const ctx = await scenario();
    const order = await createOrder(ctx, PaymentMethod.CASH_ON_DELIVERY);

    await orderService.updateStatus(
      order._id.toString(),
      OrderStatus.CANCELLED,
      ctx.client._id.toString(),
      UserRole.CLIENT,
      'Ya no lo quiero'
    );

    const res = await confirmCash(order._id.toString(), ctx.driverUser, { received: true });
    expect(res.status).toBe(404); // sin domiciliario asignado: ni lo ve

    // Y el intento de cobro que hubiera abierto queda invalidado: un
    // enlace de pago vivo sobre un pedido cuyas cuentas ya se deshicieron
    // es exactamente la forma de cobrar dos veces.
    const payment = await Payment.findOne({ orderId: order._id });
    expect(payment!.status).toBe(PaymentStatus.FAILED);
  });

  it('11 · un pedido ya pagado no admite un segundo cobro en línea', async () => {
    const ctx = await scenario();
    const order = await createOrder(ctx, PaymentMethod.ONLINE);

    // El sandbox aprueba al crear el intento.
    await paymentService.initiate({
      orderId: order._id.toString(),
      userId: ctx.client._id.toString(),
      amount: order.finance.customerTotal,
      description: 'Prueba',
      customer: { name: 'Cliente' },
    });

    const pagado = await Order.findById(order._id);
    expect(pagado!.paymentStatus).toBe(PaymentStatus.PAID);

    await expect(
      paymentService.initiate({
        orderId: order._id.toString(),
        userId: ctx.client._id.toString(),
        amount: order.finance.customerTotal,
        description: 'Segundo intento',
        customer: { name: 'Cliente' },
      })
    ).rejects.toThrow(/ya fue pagado/i);
  });

  it('18 · el monto sale del pedido, nunca de la petición', async () => {
    const ctx = await scenario();
    const order = await deliveredCashOrder(ctx);

    // Un cuerpo con campos de más se rechaza de plano: este endpoint no es
    // sitio para discutir cuánto se cobró.
    const res = await confirmCash(order._id.toString(), ctx.driverUser, {
      received: true,
      amount: 1,
      commission: 0,
    });
    expect(res.status).toBe(400);

    const ok = await confirmCash(order._id.toString(), ctx.driverUser, { received: true });
    expect(ok.body.data.amount).toBe(order.finance.customerTotal);
  });

  it('18b · la máquina de estados no admite saltos ilegales', async () => {
    const ctx = await scenario();
    const order = await deliveredCashOrder(ctx);

    await confirmCash(order._id.toString(), ctx.driverUser, { received: true });

    // Pagado → "no lo recibí" no existe. Sin este cierre, un domiciliario
    // podría cobrar, confirmar y después declarar el faltante.
    const res = await confirmCash(order._id.toString(), ctx.driverUser, { received: false });
    expect(res.status).toBe(409);

    const payment = await Payment.findOne({ orderId: order._id });
    expect(payment!.status).toBe(PaymentStatus.PAID);
  });
});

describe('Faltante de efectivo', () => {
  beforeEach(() => setPaymentProvider(new SandboxPaymentProvider()));
  afterEach(() => setPaymentProvider(null));

  it('registra el faltante sin dar el pedido por pagado', async () => {
    const ctx = await scenario();
    const order = await deliveredCashOrder(ctx);

    const res = await confirmCash(order._id.toString(), ctx.driverUser, {
      received: false,
      note: 'El cliente no tenía el dinero',
    });

    expect(res.status).toBe(200);
    expect(res.body.data.paymentStatus).toBe(PaymentStatus.CASH_NOT_RECEIVED);

    const conFaltante = await Order.findById(order._id);
    expect(conFaltante!.paymentStatus).toBe(PaymentStatus.CASH_NOT_RECEIVED);
  });

  it('declarar un faltante NO cancela la deuda con ZIPP', async () => {
    const ctx = await scenario();
    const order = await deliveredCashOrder(ctx);

    const antes = await CashReconciliation.findOne({ orderId: order._id });
    await confirmCash(order._id.toString(), ctx.driverUser, { received: false });
    const despues = await CashReconciliation.findOne({ orderId: order._id });

    // Si el botón "no recibí" borrara la deuda, sería la forma más barata
    // de no pagarle a ZIPP. La conciliación queda viva y marcada para que
    // finanzas la resuelva con la evidencia del traspaso delante.
    expect(despues!.amount).toBe(antes!.amount);
    expect(despues!.status).toBe(CashReconciliationStatus.PENDING);
    expect(despues!.voidedAt).toBeFalsy();
  });

  it('el faltante se audita como incidencia grave', async () => {
    const ctx = await scenario();
    const order = await deliveredCashOrder(ctx);

    await confirmCash(order._id.toString(), ctx.driverUser, { received: false });

    const registro = await AuditLog.findOne({ action: AuditAction.CASH_COLLECTION_DISPUTED });
    expect(registro).toBeTruthy();
    expect(registro!.severity).toBe('high');
    expect(registro!.metadata!.orderNumber).toBe(order.orderNumber);
  });
});

describe('Contabilidad del efectivo', () => {
  beforeEach(() => setPaymentProvider(new SandboxPaymentProvider()));
  afterEach(() => setPaymentProvider(null));

  it('13 · la comisión de ZIPP es lo que el domiciliario le debe', async () => {
    const ctx = await scenario();
    const order = await deliveredCashOrder(ctx);
    await confirmCash(order._id.toString(), ctx.driverUser, { received: true });

    const f = (await Order.findById(order._id))!.finance;
    const reconciliation = await CashReconciliation.findOne({ orderId: order._id });

    // Comisión + tarifa de servicio + margen de reparto + impuesto, menos
    // lo que ZIPP puso de su bolsillo en promociones. Ni la tarifa del
    // domiciliario ni la propina: ese dinero ya es suyo.
    const esperado =
      f.merchantCommission +
      f.customerServiceFee +
      Math.max(0, f.deliveryMargin) +
      f.taxPayable -
      f.platformPromotionExpense;

    expect(reconciliation!.amount).toBe(esperado);
    expect(reconciliation!.breakdown.merchantCommission).toBe(f.merchantCommission);

    // El cliente entregó el total; ZIPP solo reclama su parte.
    expect(reconciliation!.amount).toBeLessThan(f.customerTotal);
  });

  it('14 · confirmar el efectivo no vuelve a asentar el libro mayor', async () => {
    const ctx = await scenario();
    const order = await deliveredCashOrder(ctx);

    const enTransitoAlEntregar = await ledgerService.accountBalance(
      LedgerAccount.CASH_IN_TRANSIT,
      { orderId: order._id }
    );

    await confirmCash(order._id.toString(), ctx.driverUser, { received: true });

    const enTransitoTrasConfirmar = await ledgerService.accountBalance(
      LedgerAccount.CASH_IN_TRANSIT,
      { orderId: order._id }
    );

    // El asiento se escribió al entregar. Volver a escribirlo aquí
    // duplicaría los ingresos de cada pedido en efectivo del sistema.
    expect(enTransitoTrasConfirmar.balance).toBe(enTransitoAlEntregar.balance);
    expect(await ledgerService.isBalanced({ orderId: order._id })).toBe(true);
  });

  it('14b · el libro cuadra también cuando el efectivo se rinde y liquida', async () => {
    const ctx = await scenario();
    const admin = await makeUser({ role: UserRole.ADMIN, isFinanceAdmin: true });
    const order = await deliveredCashOrder(ctx);

    await confirmCash(order._id.toString(), ctx.driverUser, { received: true });

    const record = await CashReconciliation.findOne({ orderId: order._id });
    await cashReconciliationService.verifyByAdmin(
      [String(record!._id)],
      admin._id.toString(),
      'Consignación 4411'
    );
    await cashReconciliationService.settle([String(record!._id)], admin._id.toString());

    const enTransito = await ledgerService.accountBalance(LedgerAccount.CASH_IN_TRANSIT, {
      orderId: order._id,
    });
    expect(enTransito.balance).toBe(0);
    expect(await ledgerService.isBalanced({ orderId: order._id })).toBe(true);
  });

  it('15 · los pagos al comercio y al domiciliario se saldan en la puerta', async () => {
    const ctx = await scenario();
    const order = await deliveredCashOrder(ctx);
    await confirmCash(order._id.toString(), ctx.driverUser, { received: true });

    const payouts = await Payout.find({ orderId: order._id });
    expect(payouts.length).toBeGreaterThan(0);
    // En efectivo nadie espera una transferencia: el domiciliario le pagó
    // al comercio de su fondo y se quedó con su tarifa.
    expect(payouts.every((p) => p.status === PayoutStatus.SETTLED)).toBe(true);

    // Y el fondo que adelantó vuelve completo.
    const driver = await Driver.findById(ctx.driver._id);
    expect(driver!.currentFund).toBe(100000);
  });
});

describe('Cambio de método de pago', () => {
  afterEach(() => setPaymentProvider(null));

  const changeTo = (orderId: string, user: any, paymentMethod: string) =>
    request(app)
      .patch(`/api/v1/orders/${orderId}/payment-method`)
      .set(authHeader(user))
      .send({ paymentMethod });

  it('17 · cambiar a efectivo invalida el checkout de Wompi abierto', async () => {
    const ctx = await scenario();
    const provider = new PendingProvider();
    setPaymentProvider(provider);

    const order = await createOrder(ctx, PaymentMethod.ONLINE);
    const { intent } = await paymentService.initiate({
      orderId: order._id.toString(),
      userId: ctx.client._id.toString(),
      amount: order.finance.customerTotal,
      description: 'Prueba',
      customer: { name: 'Cliente' },
    });
    expect(intent.checkoutUrl).toBeTruthy();

    const res = await changeTo(
      order._id.toString(),
      ctx.client,
      PaymentMethod.CASH_ON_DELIVERY
    );
    expect(res.status).toBe(200);
    expect(res.body.data.paymentStatus).toBe(PaymentStatus.PENDING_CASH);

    const pagos = await Payment.find({ orderId: order._id }).sort({ createdAt: 1 });
    expect(pagos).toHaveLength(2);

    // Exactamente uno vivo. Si el intento de Wompi sobreviviera, el cliente
    // podría pagar en la puerta y después, desde su historial, otra vez en
    // la pasarela.
    const vivos = pagos.filter(
      (p) => p.status !== PaymentStatus.FAILED && p.status !== PaymentStatus.REFUNDED
    );
    expect(vivos).toHaveLength(1);
    expect(vivos[0].method).toBe(PaymentMethod.CASH_ON_DELIVERY);

    const invalidado = pagos.find((p) => p.method === PaymentMethod.ONLINE);
    expect(invalidado!.status).toBe(PaymentStatus.FAILED);
    expect(invalidado!.metadata!.voidedReason).toMatch(/Cambio de método/i);
  });

  it('17b · cambiar de efectivo a en línea cierra la fila del efectivo', async () => {
    const ctx = await scenario();
    setPaymentProvider(new SandboxPaymentProvider());

    const order = await createOrder(ctx, PaymentMethod.CASH_ON_DELIVERY);
    const res = await changeTo(order._id.toString(), ctx.client, PaymentMethod.ONLINE);

    expect(res.status).toBe(200);
    expect(res.body.data.paymentMethod).toBe(PaymentMethod.ONLINE);
    expect(res.body.data.paymentStatus).toBe(PaymentStatus.PENDING);

    const cash = await Payment.findOne({ orderId: order._id, method: PaymentMethod.CASH_ON_DELIVERY });
    expect(cash!.status).toBe(PaymentStatus.FAILED);
  });

  it('no se puede cambiar el método una vez que el comercio aceptó', async () => {
    const ctx = await scenario();
    setPaymentProvider(new SandboxPaymentProvider());

    const order = await createOrder(ctx, PaymentMethod.CASH_ON_DELIVERY);
    await orderService.updateStatus(
      order._id.toString(),
      OrderStatus.ACCEPTED,
      ctx.owner._id.toString(),
      UserRole.BUSINESS
    );

    const res = await changeTo(order._id.toString(), ctx.client, PaymentMethod.ONLINE);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/ya aceptó/i);
  });

  it('no se puede cambiar el método de un pedido ya pagado', async () => {
    const ctx = await scenario();
    setPaymentProvider(new SandboxPaymentProvider());

    const order = await createOrder(ctx, PaymentMethod.ONLINE);
    await paymentService.initiate({
      orderId: order._id.toString(),
      userId: ctx.client._id.toString(),
      amount: order.finance.customerTotal,
      description: 'Prueba',
      customer: { name: 'Cliente' },
    });

    const res = await changeTo(
      order._id.toString(),
      ctx.client,
      PaymentMethod.CASH_ON_DELIVERY
    );
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/ya fue pagado/i);
  });

  it('un tercero no puede cambiar el método de un pedido ajeno', async () => {
    const ctx = await scenario();
    setPaymentProvider(new SandboxPaymentProvider());

    const order = await createOrder(ctx, PaymentMethod.CASH_ON_DELIVERY);
    const otro = await makeUser({ role: UserRole.CLIENT });

    const res = await changeTo(order._id.toString(), otro, PaymentMethod.ONLINE);
    expect(res.status).toBe(403);

    const intacto = await Order.findById(order._id);
    expect(intacto!.paymentMethod).toBe(PaymentMethod.CASH_ON_DELIVERY);
  });

  it('no se puede cambiar a efectivo un pedido que supera el tope', async () => {
    const ctx = await scenario({ cashOnDeliveryMaxAmount: 5000 });
    setPaymentProvider(new SandboxPaymentProvider());

    const order = await createOrder(ctx, PaymentMethod.ONLINE);
    const res = await changeTo(
      order._id.toString(),
      ctx.client,
      PaymentMethod.CASH_ON_DELIVERY
    );

    expect(res.status).toBe(422);

    const intacto = await Order.findById(order._id);
    expect(intacto!.paymentMethod).toBe(PaymentMethod.ONLINE);
    expect(intacto!.paymentStatus).toBe(PaymentStatus.PENDING);
  });
});

describe('Aislamiento entre pasarela y efectivo', () => {
  beforeEach(() => setPaymentProvider(new SandboxPaymentProvider()));
  afterEach(() => setPaymentProvider(null));

  it('un evento de pasarela no puede cobrar un pedido en efectivo', async () => {
    const ctx = await scenario();
    const order = await createOrder(ctx, PaymentMethod.CASH_ON_DELIVERY);

    const payment = await Payment.findOne({ orderId: order._id });

    // Aunque alguien lograra apuntar un evento firmado a la referencia del
    // cobro en efectivo, la pasarela no tiene autoridad sobre él.
    const resultado = await paymentService.applyGatewayStatus(
      payment!.reference!,
      'approved',
      payment!.amount
    );

    expect(resultado.changed).toBe(false);

    const intacto = await Order.findById(order._id);
    expect(intacto!.paymentStatus).toBe(PaymentStatus.PENDING_CASH);
  });

  it('initiate rechaza un pedido en efectivo', async () => {
    const ctx = await scenario();
    const order = await createOrder(ctx, PaymentMethod.CASH_ON_DELIVERY);

    await expect(
      paymentService.initiate({
        orderId: order._id.toString(),
        userId: ctx.client._id.toString(),
        amount: order.finance.customerTotal,
        description: 'Prueba',
        customer: { name: 'Cliente' },
      })
    ).rejects.toThrow(/no es de pago en línea/i);
  });
});

/**
 * Una transferencia no puede saldar más de lo que vale.
 *
 * `verifyByTransaction` comprobaba que el pago cubriera *este* saldo y
 * nada más, así que aplicar la misma referencia a varias conciliaciones
 * las daba todas por buenas: una transferencia de $20.000 cerraba dos
 * pedidos de $20.000 y ZIPP contaba $40.000 que nunca entraron. Lo que
 * hay que comparar no es el saldo de un registro, sino todo lo que esa
 * transacción ya está respaldando.
 */
describe('CashReconciliationService.verifyByTransaction', () => {
  it('no deja que un mismo pago respalde más saldo del que tiene', async () => {
    const ctx = await scenario();

    const primero = await deliveredCashOrder(ctx);
    const segundo = await deliveredCashOrder(ctx);

    const [uno, dos] = await Promise.all([
      CashReconciliation.findOne({ orderId: primero._id }),
      CashReconciliation.findOne({ orderId: segundo._id }),
    ]);
    expect(uno!.amount).toBeGreaterThan(0);

    // Una transferencia que solo alcanza para el primero.
    const transferencia = await Payment.create({
      orderId: primero._id,
      userId: ctx.driverUser._id,
      type: PaymentType.DRIVER_PAYOUT,
      method: PaymentMethod.ONLINE,
      status: PaymentStatus.PAID,
      amount: uno!.amount,
      currency: 'COP',
      reference: `REMESA-${Date.now()}`,
      transactionId: 'TX-REMESA-UNICA',
    });

    await cashReconciliationService.verifyByTransaction(
      uno!._id.toString(),
      transferencia.transactionId!
    );

    await expect(
      cashReconciliationService.verifyByTransaction(
        dos!._id.toString(),
        transferencia.transactionId!
      )
    ).rejects.toThrow(/ya respalda/i);

    const segundoFresco = await CashReconciliation.findById(dos!._id);
    expect(segundoFresco!.status).toBe(CashReconciliationStatus.PENDING);
  });

  it('una transferencia grande sí puede cubrir dos saldos', async () => {
    const ctx = await scenario();

    const primero = await deliveredCashOrder(ctx);
    const segundo = await deliveredCashOrder(ctx);

    const [uno, dos] = await Promise.all([
      CashReconciliation.findOne({ orderId: primero._id }),
      CashReconciliation.findOne({ orderId: segundo._id }),
    ]);

    const transferencia = await Payment.create({
      orderId: primero._id,
      userId: ctx.driverUser._id,
      type: PaymentType.DRIVER_PAYOUT,
      method: PaymentMethod.ONLINE,
      status: PaymentStatus.PAID,
      amount: uno!.amount + dos!.amount,
      currency: 'COP',
      reference: `REMESA-DOBLE-${Date.now()}`,
      transactionId: 'TX-REMESA-JORNADA',
    });

    await cashReconciliationService.verifyByTransaction(uno!._id.toString(), transferencia.transactionId!);
    await cashReconciliationService.verifyByTransaction(dos!._id.toString(), transferencia.transactionId!);

    const frescos = await CashReconciliation.find({ transactionId: 'TX-REMESA-JORNADA' });
    expect(frescos).toHaveLength(2);
    for (const r of frescos) {
      expect(r.status).toBe(CashReconciliationStatus.VERIFIED);
    }
  });
});
