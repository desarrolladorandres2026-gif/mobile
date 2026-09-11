import { describe, it, expect, beforeEach } from 'vitest';
import { Types } from 'mongoose';
import { migratePaymentUniqueness } from '../migrations/003-payment-uniqueness';
import { Payment, Refund } from '../models';
import {
  PaymentStatus,
  PaymentMethod,
  PaymentType,
  RefundStatus,
  RefundKind,
} from '../types';

/**
 * La migración existe porque Mongo no construye un índice único cuyos datos
 * ya lo violen: falla en silencio y la aplicación arranca creyendo que tiene
 * una garantía que no tiene. Si una base ya acumuló dos cobros abiertos para
 * el mismo pedido —que es exactamente el fallo que el índice viene a cerrar—
 * hay que dejarla en un estado donde el índice pueda existir.
 */

const orderId = () => new Types.ObjectId();
const userId = new Types.ObjectId();

/**
 * Deja la base como la de un despliegue anterior a este cambio: con los
 * índices únicos todavía sin construir. Sin esto no se puede ni preparar el
 * escenario que la migración viene a resolver — el índice, ya presente en
 * el entorno de pruebas, rechaza los duplicados que hay que sembrar.
 *
 * Que la migración vuelva a crearlos al final es, además, la mitad de lo
 * que se está comprobando.
 */
async function dropUniquenessIndexes() {
  const drops: Array<[typeof Payment | typeof Refund, string]> = [
    [Payment, 'one_open_online_payment_per_order'],
    [Refund, 'one_refund_in_flight_per_order'],
  ];

  for (const [model, name] of drops) {
    await model.collection.dropIndex(name).catch(() => {
      // Ya no está: la limpieza entre pruebas pudo llevárselo.
    });
  }
}

async function indexNames(model: typeof Payment | typeof Refund): Promise<string[]> {
  const indexes = await model.collection.indexes();
  return indexes.map((i) => i.name as string);
}

beforeEach(async () => {
  await dropUniquenessIndexes();
});

async function openPayment(order: Types.ObjectId, reference: string, amount = 10000) {
  return Payment.create({
    orderId: order,
    userId,
    type: PaymentType.ORDER_PAYMENT,
    method: PaymentMethod.ONLINE,
    status: PaymentStatus.PENDING,
    amount,
    currency: 'COP',
    reference,
    transactionId: reference,
  });
}

describe('Migración 003 · unicidad de cobros', () => {
  it('retira los intentos viejos y conserva el más reciente', async () => {
    const order = orderId();

    // Se insertan saltándose el índice (que es justo lo que no puede
    // existir todavía en una base así) usando la colección directamente.
    const now = Date.now();
    await Payment.collection.insertMany([
      {
        orderId: order, userId, type: PaymentType.ORDER_PAYMENT, method: PaymentMethod.ONLINE,
        status: PaymentStatus.PENDING, amount: 10000, currency: 'COP',
        reference: 'REF-VIEJA', transactionId: 'REF-VIEJA', statusHistory: [], metadata: {},
        createdAt: new Date(now - 60_000), updatedAt: new Date(now - 60_000),
      },
      {
        orderId: order, userId, type: PaymentType.ORDER_PAYMENT, method: PaymentMethod.ONLINE,
        status: PaymentStatus.PENDING, amount: 12000, currency: 'COP',
        reference: 'REF-NUEVA', transactionId: 'REF-NUEVA', statusHistory: [], metadata: {},
        createdAt: new Date(now), updatedAt: new Date(now),
      },
    ]);

    const report = await migratePaymentUniqueness();

    expect(report.ordersWithDuplicatePayments).toBe(1);
    expect(report.paymentsRetired).toBe(1);

    const vieja = await Payment.findOne({ reference: 'REF-VIEJA' });
    const nueva = await Payment.findOne({ reference: 'REF-NUEVA' });

    expect(vieja!.status).toBe(PaymentStatus.FAILED);
    expect(nueva!.status).toBe(PaymentStatus.PENDING);

    // No se borra: la fila retirada sigue localizable por su referencia,
    // que es lo que permite reconocer un pago tardío del enlace viejo.
    expect(vieja!.metadata?.voidedReason).toBeTruthy();

    // Y el índice queda construido: es la mitad del trabajo. Sin él, la
    // aplicación arranca creyendo que tiene una garantía que no tiene.
    expect(await indexNames(Payment)).toContain('one_open_online_payment_per_order');
    expect(await indexNames(Refund)).toContain('one_refund_in_flight_per_order');
  });

  it('deja el índice impidiendo que el duplicado vuelva a aparecer', async () => {
    const order = orderId();
    await openPayment(order, 'REF-UNICA');

    await migratePaymentUniqueness();

    await expect(openPayment(order, 'REF-SEGUNDA')).rejects.toThrow(/duplicate key/i);
  });

  it('no toca cobros aprobados, en efectivo ni de otros pedidos', async () => {
    const orderA = orderId();
    const orderB = orderId();

    const aprobado = await Payment.create({
      orderId: orderA, userId, type: PaymentType.ORDER_PAYMENT,
      method: PaymentMethod.ONLINE, status: PaymentStatus.PAID,
      amount: 10000, currency: 'COP', reference: 'REF-PAGADA',
    });
    const efectivo = await Payment.create({
      orderId: orderA, userId, type: PaymentType.ORDER_PAYMENT,
      method: PaymentMethod.CASH_ON_DELIVERY, status: PaymentStatus.PENDING_CASH,
      amount: 10000, currency: 'COP', reference: 'REF-EFECTIVO',
    });
    const otro = await openPayment(orderB, 'REF-OTRO-PEDIDO');

    const report = await migratePaymentUniqueness();
    expect(report.paymentsRetired).toBe(0);

    expect((await Payment.findById(aprobado._id))!.status).toBe(PaymentStatus.PAID);
    expect((await Payment.findById(efectivo._id))!.status).toBe(PaymentStatus.PENDING_CASH);
    expect((await Payment.findById(otro._id))!.status).toBe(PaymentStatus.PENDING);
  });

  it('cierra reembolsos pendientes duplicados para poder reintentarlos', async () => {
    const order = orderId();
    const now = Date.now();

    await Refund.collection.insertMany([
      {
        orderId: order, kind: RefundKind.FULL, status: RefundStatus.PENDING,
        amount: 5000, currency: 'COP', reason: 'primero', allocation: {},
        createdAt: new Date(now - 60_000), updatedAt: new Date(now - 60_000),
      },
      {
        orderId: order, kind: RefundKind.FULL, status: RefundStatus.PENDING,
        amount: 5000, currency: 'COP', reason: 'segundo', allocation: {},
        createdAt: new Date(now), updatedAt: new Date(now),
      },
    ]);

    const report = await migratePaymentUniqueness();

    expect(report.ordersWithDuplicateRefunds).toBe(1);
    expect(report.refundsFailed).toBe(1);
    expect(await Refund.countDocuments({ orderId: order, status: RefundStatus.PENDING })).toBe(1);
  });

  it('en seco no cambia nada', async () => {
    const order = orderId();
    const now = Date.now();

    await Payment.collection.insertMany([
      {
        orderId: order, userId, type: PaymentType.ORDER_PAYMENT, method: PaymentMethod.ONLINE,
        status: PaymentStatus.PENDING, amount: 10000, currency: 'COP',
        reference: 'SECO-1', transactionId: 'SECO-1', statusHistory: [], metadata: {},
        createdAt: new Date(now - 60_000), updatedAt: new Date(now - 60_000),
      },
      {
        orderId: order, userId, type: PaymentType.ORDER_PAYMENT, method: PaymentMethod.ONLINE,
        status: PaymentStatus.PENDING, amount: 10000, currency: 'COP',
        reference: 'SECO-2', transactionId: 'SECO-2', statusHistory: [], metadata: {},
        createdAt: new Date(now), updatedAt: new Date(now),
      },
    ]);

    const report = await migratePaymentUniqueness({ dryRun: true });

    expect(report.paymentsRetired).toBe(1);
    expect(await Payment.countDocuments({ orderId: order, status: PaymentStatus.PENDING })).toBe(2);
  });

  it('es segura de ejecutar dos veces', async () => {
    const order = orderId();
    const now = Date.now();

    await Payment.collection.insertMany([
      {
        orderId: order, userId, type: PaymentType.ORDER_PAYMENT, method: PaymentMethod.ONLINE,
        status: PaymentStatus.PENDING, amount: 10000, currency: 'COP',
        reference: 'IDEM-1', transactionId: 'IDEM-1', statusHistory: [], metadata: {},
        createdAt: new Date(now - 60_000), updatedAt: new Date(now - 60_000),
      },
      {
        orderId: order, userId, type: PaymentType.ORDER_PAYMENT, method: PaymentMethod.ONLINE,
        status: PaymentStatus.PENDING, amount: 10000, currency: 'COP',
        reference: 'IDEM-2', transactionId: 'IDEM-2', statusHistory: [], metadata: {},
        createdAt: new Date(now), updatedAt: new Date(now),
      },
    ]);

    await migratePaymentUniqueness();
    const second = await migratePaymentUniqueness();

    expect(second.paymentsRetired).toBe(0);
    expect(await Payment.countDocuments({ orderId: order, status: PaymentStatus.PENDING })).toBe(1);
  });
});
