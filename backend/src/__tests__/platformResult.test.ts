import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { Types } from 'mongoose';
import app from '../app';
import { LedgerEntry, Order } from '../models';
import { LedgerAccount, LedgerDirection, LedgerEventType, UserRole, OrderStatus, PaymentMethod } from '../types';
import { platformResultService } from '../services/platformResult.service';
import { dailySummaryService } from '../services/dailySummary.service';
import {
  periodRange,
  bogotaDateString,
  bogotaDayRange,
  customRange,
} from '../utils/period';
import { makeUser, authHeader } from './factories';

/**
 * D11 (docs/PANEL-ADMIN.md): una sola definición de "ingreso", del libro
 * mayor, con periodos reales en hora de Colombia.
 */

const { DEBIT, CREDIT } = LedgerDirection;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let seq = 0;
/** Inserta asientos por el driver: el modelo no deja fijar `createdAt`. */
async function seed(
  at: Date,
  lines: Array<[LedgerAccount, LedgerDirection, number]>
) {
  const orderId = new Types.ObjectId();
  const groupId = `g-${seq++}`;
  await LedgerEntry.collection.insertMany(
    lines.map(([account, direction, amount], i) => ({
      groupId,
      orderId,
      event: LedgerEventType.ORDER_DELIVERED,
      account,
      direction,
      amount,
      currency: 'COP',
      pricingConfigVersion: 1,
      reference: `r${seq}-${i}`,
      memo: '',
      createdAt: at,
    }))
  );
}

/** Un asiento balanceado con la cuenta de ingreso/gasto contra caja. */
const revenue = (at: Date, account: LedgerAccount, amount: number) =>
  seed(at, [
    [LedgerAccount.CUSTOMER_PAYMENT, DEBIT, amount],
    [account, CREDIT, amount],
  ]);
const expense = (at: Date, account: LedgerAccount, amount: number) =>
  seed(at, [
    [account, DEBIT, amount],
    [LedgerAccount.CUSTOMER_PAYMENT, CREDIT, amount],
  ]);

describe('periodos en hora de Colombia', () => {
  it('23:30 en Bogotá (04:30 UTC del día siguiente) sigue siendo el mismo día', () => {
    const at = new Date('2026-09-24T04:30:00.000Z'); // 23:30 del 23 en Bogotá
    expect(bogotaDateString(at)).toBe('2026-09-23');

    const { from, to } = periodRange('today', at);
    expect(from.toISOString()).toBe('2026-09-23T05:00:00.000Z');
    expect(to.toISOString()).toBe('2026-09-24T04:59:59.999Z');
  });

  it('00:30 UTC todavía es el día anterior en Bogotá; 05:00 UTC ya es el nuevo', () => {
    expect(bogotaDateString(new Date('2026-09-24T00:30:00.000Z'))).toBe('2026-09-23');
    expect(bogotaDateString(new Date('2026-09-24T05:00:00.000Z'))).toBe('2026-09-24');
  });

  it('semana = 7 días de Bogotá incluido hoy; mes = 30', () => {
    const now = new Date('2026-09-24T04:30:00.000Z'); // 23 de septiembre en Bogotá
    expect(periodRange('week', now).from.toISOString()).toBe('2026-09-17T05:00:00.000Z');
    expect(periodRange('month', now).from.toISOString()).toBe('2026-08-25T05:00:00.000Z');
    expect(periodRange('month', now).to.toISOString()).toBe('2026-09-24T04:59:59.999Z');
  });

  it('customRange rechaza fechas imposibles, mal formadas o invertidas', () => {
    expect(customRange('2026-02-31', '2026-03-01')).toBeNull();
    expect(customRange('2026-9-1', '2026-09-02')).toBeNull();
    expect(customRange('2026-09-05', '2026-09-01')).toBeNull();
    expect(customRange('2026-09-01', '2026-09-01')).not.toBeNull();
  });
});

describe('platformResultService.forRange', () => {
  it('ingreso = -(comisión + tarifa + margen); un margen subsidiado RESTA', async () => {
    const now = new Date();
    await revenue(now, LedgerAccount.COMMISSION_REVENUE, 1000);
    await revenue(now, LedgerAccount.SERVICE_FEE_REVENUE, 500);
    // Domicilio subsidiado: el margen queda como débito.
    await expense(now, LedgerAccount.DELIVERY_MARGIN_REVENUE, 300);
    await expense(now, LedgerAccount.PROMOTION_EXPENSE, 200);
    await expense(now, LedgerAccount.CASH_SHORTAGE_EXPENSE, 50);
    await expense(now, LedgerAccount.DRIVER_FEE_ABSORBED_EXPENSE, 30);
    await expense(now, LedgerAccount.BAD_DEBT_EXPENSE, 20);

    const r = await platformResultService.forRange();

    expect(r.grossRevenue).toBe(1000 + 500 - 300);
    expect(r.promotionExpense).toBe(200);
    expect(r.cashShortageExpense).toBe(50);
    expect(r.driverFeeAbsorbed).toBe(30);
    expect(r.badDebt).toBe(20);
    expect(r.netBeforeGatewayCosts).toBe(1200 - 200 - 50 - 30 - 20);
    expect(r.incomplete).toBe(true);
    expect(r.incompleteReason).toContain('Wompi');
  });

  it('filtra por fecha del asiento; un reembolso de hoy resta a hoy', async () => {
    const now = new Date();
    await revenue(new Date(now.getTime() - 3 * DAY), LedgerAccount.COMMISSION_REVENUE, 1000);
    await revenue(now, LedgerAccount.COMMISSION_REVENUE, 400);
    // Reverso de hoy sobre un cobro anterior: débito a la cuenta de ingreso.
    await expense(now, LedgerAccount.COMMISSION_REVENUE, 100);

    expect((await platformResultService.forRange(periodRange('today'))).grossRevenue).toBe(300);
    expect((await platformResultService.forRange(periodRange('week'))).grossRevenue).toBe(1300);
    expect((await platformResultService.forRange()).grossRevenue).toBe(1300);
  });

  it('sin asientos devuelve ceros, no -0', async () => {
    const r = await platformResultService.forRange(periodRange('today'));
    expect(Object.is(r.grossRevenue, 0)).toBe(true);
    expect(Object.is(r.netBeforeGatewayCosts, 0)).toBe(true);
  });

  it('respeta el corte de día de Bogotá', async () => {
    // 23:30 del 23 en Bogotá = 04:30 UTC del 24; 00:30 del 24 en Bogotá = 05:30 UTC.
    await revenue(new Date('2026-09-24T04:30:00.000Z'), LedgerAccount.COMMISSION_REVENUE, 700);
    await revenue(new Date('2026-09-24T05:30:00.000Z'), LedgerAccount.COMMISSION_REVENUE, 90);

    const d23 = await platformResultService.forRange(bogotaDayRange('2026-09-23'));
    const d24 = await platformResultService.forRange(bogotaDayRange('2026-09-24'));
    expect(d23.grossRevenue).toBe(700);
    expect(d24.grossRevenue).toBe(90);

    const daily = await dailySummaryService.generate('2026-09-23');
    expect(daily.today.platformGrossRevenue).toBe(700);
    expect(daily.today.netRevenue).toBe(700);
    expect(daily.today.platformResult.incomplete).toBe(true);
  });
});

describe('endpoints del panel', () => {
  it('GET /finance/ledger/summary: periodo real, histórico sin parámetro y 400 si es inválido', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    const headers = await authHeader(admin);
    const now = new Date();
    await revenue(new Date(now.getTime() - 3 * DAY), LedgerAccount.COMMISSION_REVENUE, 1000);
    await revenue(now, LedgerAccount.COMMISSION_REVENUE, 400);

    const commission = (body: any) =>
      body.data.balances.find((b: any) => b.account === LedgerAccount.COMMISSION_REVENUE).credit;

    const all = await request(app).get('/api/v1/finance/ledger/summary').set(headers).expect(200);
    expect(commission(all.body)).toBe(1400);
    expect(all.body.data.period).toBe('all');
    expect(all.body.data.platformResult.grossRevenue).toBe(1400);

    const today = await request(app).get('/api/v1/finance/ledger/summary?period=today').set(headers).expect(200);
    expect(commission(today.body)).toBe(400);
    expect(today.body.data.platformResult.grossRevenue).toBe(400);
    // `balanced` es global aunque el periodo sea corto.
    expect(today.body.data.balanced).toBe(true);

    await request(app).get('/api/v1/finance/ledger/summary?period=year').set(headers).expect(400);
    await request(app).get('/api/v1/finance/ledger/summary?from=2026-13-01&to=2026-13-02').set(headers).expect(400);
  });

  it('Dashboard, Finanzas y Resumen diario dan el mismo ingreso para el mismo día', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    const headers = await authHeader(admin);
    const now = new Date();
    await revenue(now, LedgerAccount.COMMISSION_REVENUE, 1000);
    await expense(now, LedgerAccount.PROMOTION_EXPENSE, 250);

    const dash = await request(app).get('/api/v1/admin/dashboard').set(headers).expect(200);
    const fin = await request(app).get('/api/v1/admin/financials?period=today').set(headers).expect(200);
    const led = await request(app).get('/api/v1/finance/ledger/summary?period=today').set(headers).expect(200);
    const daily = await request(app).get('/api/v1/admin/daily-summary').set(headers).expect(200);

    expect(dash.body.data.platformResult.grossRevenue).toBe(1000);
    expect(fin.body.data.platformResult.grossRevenue).toBe(1000);
    expect(led.body.data.platformResult.grossRevenue).toBe(1000);
    expect(daily.body.data.today.platformGrossRevenue).toBe(1000);
    expect(daily.body.data.today.promotionExpense).toBe(250);
    expect(daily.body.data.today.netRevenue).toBe(750);
    expect(fin.body.data.platformResult.incomplete).toBe(true);
    // El 0 permanente se retiró.
    expect(fin.body.data.settledCommissions).toBeUndefined();
  });

  it('agregados del día sobre TODOS los pedidos, no sobre una muestra', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    const headers = await authHeader(admin);
    const now = new Date();
    const base = { createdAt: now, platformCommission: 0 };

    const docs: Record<string, unknown>[] = [];
    // 8 entregados online (100 c/u), 4 entregados en efectivo (50 c/u), 2 cancelados, 1 en preparación.
    for (let i = 0; i < 8; i++)
      docs.push({ ...base, status: OrderStatus.DELIVERED, paymentMethod: PaymentMethod.ONLINE, total: 100, deliveredAt: now });
    for (let i = 0; i < 4; i++)
      docs.push({ ...base, status: OrderStatus.DELIVERED, paymentMethod: PaymentMethod.CASH_ON_DELIVERY, total: 50, deliveredAt: now });
    for (let i = 0; i < 2; i++)
      docs.push({ ...base, status: OrderStatus.CANCELLED, paymentMethod: PaymentMethod.ONLINE, total: 70, cancelledAt: now });
    docs.push({ ...base, status: OrderStatus.PREPARING, paymentMethod: PaymentMethod.ONLINE, total: 10 });
    // Entregado hace 3 días: no cuenta hoy.
    docs.push({
      status: OrderStatus.DELIVERED,
      paymentMethod: PaymentMethod.ONLINE,
      total: 999,
      platformCommission: 0,
      createdAt: new Date(now.getTime() - 3 * DAY),
      deliveredAt: new Date(now.getTime() - 3 * DAY),
    });
    // Inserción cruda: `orderNumber` tiene índice único y aquí no pasa por el servicio.
    await Order.collection.insertMany(docs.map((d, i) => ({ ...d, orderNumber: `T-${i}` })));

    const dash = await request(app).get('/api/v1/admin/dashboard').set(headers).expect(200);
    const d = dash.body.data;
    expect(d.paymentBreakdown).toEqual({
      online: { count: 8, amount: 800 },
      cash: { count: 4, amount: 200 },
    });
    expect(d.deliveredCount).toBe(12);
    expect(d.cancelledCount).toBe(2);
    expect(d.deliveryRate).toBe(85.7); // 12 / 14
    expect(d.ordersByStatus[OrderStatus.DELIVERED]).toBe(12);
    expect(d.ordersByStatus[OrderStatus.CANCELLED]).toBe(2);
    expect(d.ordersByStatus[OrderStatus.PREPARING]).toBe(1);
    expect(d.ordersByStatus[OrderStatus.PENDING]).toBe(0);

    const week = await request(app).get('/api/v1/admin/financials?period=week').set(headers).expect(200);
    expect(week.body.data.paymentBreakdown.online.count).toBe(9);
  });

  it('deliveryRate es null si no se cerró ningún pedido', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    const dash = await request(app).get('/api/v1/admin/dashboard').set(await authHeader(admin)).expect(200);
    expect(dash.body.data.deliveryRate).toBeNull();
  });
});
