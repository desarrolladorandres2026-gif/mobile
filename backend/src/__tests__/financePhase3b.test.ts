import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import request from 'supertest';
import { Types } from 'mongoose';
import app from '../app';
import * as mfa from '../services/mfa.service';
import { featureFlagService } from '../services/featureFlag.service';
import { pricingConfigService } from '../services/pricingConfig.service';
import { Payment, LedgerEntry, AdInvoice, Payout, FiscalDocument, CashReconciliation } from '../models';
import { AuditLog, AuditAction } from '../security/audit';
import { Permission } from '../security/rbac';
import { PaymentMethod, PaymentStatus, PaymentType, LedgerAccount, LedgerDirection, LedgerEventType, UserRole } from '../types';
import { payoutService } from '../services/payout.service';
import { makeUser, makeStaff, authHeader, makeSettleableBusinessId } from './factories';

/**
 * Fase 3 (bloque 2): listado de pagos y conciliación diaria contra Wompi,
 * y los exportes contables con motivo + TOTP.
 */

const staffWith = (perms: Permission[]) => makeStaff({ roleSlug: 'finanzas', permissions: [Permission.ADMIN_PANEL, ...perms] });

async function mkPayment(over: Record<string, unknown> = {}) {
  return Payment.create({
    orderId: new Types.ObjectId(),
    userId: new Types.ObjectId(),
    type: PaymentType.ORDER_PAYMENT,
    method: PaymentMethod.ONLINE,
    paymentMethodType: 'CARD',
    status: PaymentStatus.PAID,
    amount: 50_000,
    reference: `ref-${new Types.ObjectId()}`,
    transactionId: `tx-${new Types.ObjectId()}`,
    processedAt: new Date(),
    ...over,
  } as any);
}

describe('pagos y conciliación diaria', () => {
  beforeEach(async () => {
    await featureFlagService.remove('rbac_enforce');
    await featureFlagService.upsert('rbac_enforce', { audience: 'staff' });
  });

  it('lista por estado y método con totales y comisión estimada', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    await pricingConfigService.update(
      { gatewayCardBps: 265, gatewayCardFixed: 700, gatewayFeeVatBps: 1900 },
      { userId: String(admin._id), reason: 'Contrato Wompi' }
    );
    await mkPayment();
    await mkPayment({ paymentMethodType: 'PSE', amount: 20_000 });
    await mkPayment({ status: PaymentStatus.FAILED, amount: 9_000 });
    const staff = await staffWith([Permission.FINANCE_VIEW]);

    const res = await request(app).get('/api/v1/finance/payments').set(await authHeader(staff));
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(3);
    expect(res.body.data.totals.paid).toEqual({ count: 2, amount: 70_000 });
    const card = res.body.data.items.find((i: any) => i.methodType === 'CARD' && i.status === 'paid');
    expect(card.estimatedFee).toBe(2_410);
    const failed = res.body.data.items.find((i: any) => i.status === 'failed');
    expect(failed.estimatedFee).toBe(0);

    const onlyPse = await request(app).get('/api/v1/finance/payments?methodType=pse').set(await authHeader(staff));
    expect(onlyPse.body.data.items).toHaveLength(1);

    expect((await request(app).get('/api/v1/finance/payments?status=nada').set(await authHeader(staff))).status).toBe(400);
  });

  it('la conciliación diaria separa lo cobrado, lo asentado y lo que debería llegar', async () => {
    await mkPayment({ amount: 100_000 });
    await LedgerEntry.create({
      groupId: 'g-fee',
      orderId: new Types.ObjectId(),
      event: LedgerEventType.PAYMENT_CAPTURED,
      account: LedgerAccount.PAYMENT_PROCESSING_EXPENSE,
      direction: LedgerDirection.DEBIT,
      amount: 3_000,
      pricingConfigVersion: 1,
    } as any);
    const staff = await staffWith([Permission.FINANCE_VIEW]);

    const res = await request(app).get('/api/v1/finance/payments/daily').set(await authHeader(staff));
    expect(res.status).toBe(200);
    expect(res.body.data.totals.gross).toBe(100_000);
    expect(res.body.data.totals.bookedFee).toBe(3_000);
    expect(res.body.data.totals.expectedDeposit).toBe(97_000);
    expect(res.body.data.items[0].byMethod.card).toEqual({ count: 1, amount: 100_000 });

    expect((await request(app).get('/api/v1/finance/payments/daily?from=2026-02-31&to=2026-03-01').set(await authHeader(staff))).status).toBe(400);
  });

  it('sin finance:view no se ve nada', async () => {
    const soporte = await staffWith([]);
    expect((await request(app).get('/api/v1/finance/payments').set(await authHeader(soporte))).status).toBe(403);
    expect((await request(app).get('/api/v1/finance/payments/daily').set(await authHeader(soporte))).status).toBe(403);
  });
});

describe('exportes contables', () => {
  let spy: { mockRestore: () => void };
  beforeEach(async () => {
    await featureFlagService.remove('rbac_enforce');
    await featureFlagService.upsert('rbac_enforce', { audience: 'staff' });
    spy = vi.spyOn(mfa, 'verifySecondFactor').mockImplementation(async (_id: any, token: string) => token === '123456');
  });
  afterEach(() => spy.mockRestore());

  const post = async (user: any, kind: string, body: object) =>
    request(app).post(`/api/v1/finance/exports/${kind}`).set(await authHeader(user)).send(body);

  it('exige permiso, motivo y un TOTP válido', async () => {
    const withoutExport = await staffWith([Permission.FINANCE_VIEW]);
    expect((await post(withoutExport, 'ledger', { reason: 'cierre de mes', totpToken: '123456' })).status).toBe(403);

    const staff = await staffWith([Permission.FINANCE_VIEW, Permission.REPORTS_EXPORT]);
    expect((await post(staff, 'ledger', { reason: 'x', totpToken: '123456' })).status).toBe(400);
    expect((await post(staff, 'ledger', { reason: 'cierre de mes' })).status).toBe(400);
    const bad = await post(staff, 'ledger', { reason: 'cierre de mes', totpToken: '000000' });
    expect(bad.status).toBe(401);
    expect(bad.body.code ?? bad.body.error?.code).toBeDefined();
    expect((await post(staff, 'inventado', { reason: 'cierre de mes', totpToken: '123456' })).status).toBe(400);
  });

  it('entrega el CSV con BOM, sin cachear, y lo deja auditado', async () => {
    await mkPayment({ amount: 42_000 });
    await LedgerEntry.create({
      groupId: 'g-x',
      orderId: new Types.ObjectId(),
      event: LedgerEventType.PAYMENT_CAPTURED,
      account: LedgerAccount.CUSTOMER_PAYMENT,
      direction: LedgerDirection.DEBIT,
      amount: 42_000,
      pricingConfigVersion: 1,
      memo: '=HYPERLINK("http://malo")',
    } as any);
    const staff = await staffWith([Permission.FINANCE_VIEW, Permission.REPORTS_EXPORT]);

    const ledger = await post(staff, 'ledger', { reason: 'cierre de septiembre', totpToken: '123456' });
    expect(ledger.status).toBe(200);
    expect(ledger.headers['content-type']).toContain('text/csv');
    expect(ledger.headers['cache-control']).toBe('no-store');
    expect(ledger.text.startsWith('﻿"Fecha"')).toBe(true);
    expect(ledger.text).toContain('customer_payment');
    // Inyección de fórmulas neutralizada.
    expect(ledger.text).toContain(`"'=HYPERLINK`);

    const payments = await post(staff, 'payments', { reason: 'cierre de septiembre', totpToken: '123456' });
    expect(payments.status).toBe(200);
    expect(payments.text).toContain('42000');

    for (let i = 0; i < 40; i++) {
      if ((await AuditLog.countDocuments({ action: AuditAction.DATA_EXPORTED })) >= 2) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const audits = await AuditLog.find({ action: AuditAction.DATA_EXPORTED }).lean();
    expect(audits.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(audits)).toContain('cierre de septiembre');
  });

  it('los otros exportes responden aunque no haya filas', async () => {
    const staff = await staffWith([Permission.FINANCE_VIEW, Permission.REPORTS_EXPORT]);
    for (const kind of ['settlements', 'refunds', 'cash']) {
      const res = await post(staff, kind, { reason: 'revisión trimestral', totpToken: '123456', from: '2026-01-01', to: '2026-12-31' });
      expect(res.status).toBe(200);
      expect(res.text.startsWith('﻿')).toBe(true);
    }
    const inverted = await post(staff, 'refunds', { reason: 'revisión trimestral', totpToken: '123456', from: '2026-12-01', to: '2026-01-01' });
    expect(inverted.status).toBe(400);
  });
});

describe('facturas de publicidad', () => {
  beforeEach(async () => {
    await featureFlagService.remove('rbac_enforce');
    await featureFlagService.upsert('rbac_enforce', { audience: 'staff' });
  });

  const mk = (over: object = {}) =>
    AdInvoice.create({
      campaignId: new Types.ObjectId(),
      campaignName: 'Campaña',
      advertiserName: 'Anunciante',
      pricingModel: 'cpm',
      amount: 30_000,
      periodStart: new Date(),
      periodEnd: new Date(),
      settledAgainstPayout: false,
      ...over,
    } as any);

  it('lista por estado con totales y cobra por fuera una sola vez', async () => {
    // Un rol distinto: dos usuarios con el mismo slug comparten (y se pisan) los permisos.
    const viewer = await makeStaff({ roleSlug: 'soporte', permissions: [Permission.ADMIN_PANEL, Permission.FINANCE_VIEW] });
    const manager = await staffWith([Permission.FINANCE_VIEW, Permission.FINANCE_MANAGE]);
    const external = await mk();
    await mk({ settledAgainstPayout: true, amount: 12_000 });

    const list = await request(app).get('/api/v1/finance/ad-invoices').set(await authHeader(viewer));
    expect(list.status).toBe(200);
    expect(list.body.data.totals.to_collect).toEqual({ count: 1, amount: 30_000 });
    expect(list.body.data.totals.to_deduct).toEqual({ count: 1, amount: 12_000 });
    const onlyCollect = await request(app).get('/api/v1/finance/ad-invoices?view=to_collect').set(await authHeader(viewer));
    expect(onlyCollect.body.data.items).toHaveLength(1);

    const url = `/api/v1/finance/ad-invoices/${external._id}/collect`;
    const body = { reference: 'CONSIG-77', receiptUrl: 'https://example.com/c.jpg' };
    expect((await request(app).post(url).set(await authHeader(viewer)).send(body)).status).toBe(403);
    expect((await request(app).post(url).set(await authHeader(manager)).send(body)).status).toBe(200);
    expect((await request(app).post(url).set(await authHeader(manager)).send({ ...body, reference: 'OTRA-99' })).status).toBe(409);
    expect((await AdInvoice.findById(external._id))!.collectionReference).toBe('CONSIG-77');
  });

  it('una factura que se descuenta de la liquidación no se cobra por fuera', async () => {
    const manager = await staffWith([Permission.FINANCE_VIEW, Permission.FINANCE_MANAGE]);
    const deductible = await mk({ settledAgainstPayout: true });
    const res = await request(app)
      .post(`/api/v1/finance/ad-invoices/${deductible._id}/collect`)
      .set(await authHeader(manager))
      .send({ reference: 'CONSIG-78', receiptUrl: 'https://example.com/c.jpg' });
    expect(res.status).toBe(409);
    expect((await AdInvoice.findById(deductible._id))!.settledAt).toBeNull();
  });
});

describe('comprobantes internos', () => {
  beforeEach(async () => {
    await featureFlagService.remove('rbac_enforce');
    await featureFlagService.upsert('rbac_enforce', { audience: 'staff' });
  });

  async function paidSettlement(amount = 20_000) {
    const businessId = await makeSettleableBusinessId();
    const admin = await makeUser({ role: UserRole.ADMIN });
    await Payout.create({
      orderId: new Types.ObjectId(), beneficiary: 'business', businessId, driverId: null, amount,
      status: 'payable', currency: 'COP', pricingConfigVersion: 1, becamePayableAt: new Date(),
    } as any);
    const { settlement } = await payoutService.settle({ beneficiary: 'business' as any, businessId: String(businessId), createdBy: String(admin._id) });
    return { settlement: settlement!, admin };
  }

  it('solo se emite con la liquidación pagada, una vez, con consecutivo INT- y foto inmutable', async () => {
    const { settlement, admin } = await paidSettlement();
    const manager = await staffWith([Permission.FINANCE_VIEW, Permission.FINANCE_MANAGE]);
    const url = `/api/v1/finance/settlements/${settlement._id}/document`;

    // Pendiente de pago: no hay comprobante.
    expect((await request(app).post(url).set(await authHeader(manager))).status).toBe(409);

    await payoutService.registerPayment({
      settlementId: String(settlement._id), method: 'bank_transfer' as any, reference: 'CONSIG-9',
      receiptUrl: 'https://example.com/c.jpg', paidBy: String(admin._id),
    });

    const first = await request(app).post(url).set(await authHeader(manager));
    expect(first.status).toBe(201);
    expect(first.body.data.number).toMatch(/^INT-\d{6}$/);
    expect(first.body.data.netAmount).toBe(20_000);
    expect(first.body.data.notice).toContain('No es factura');

    const again = await request(app).post(url).set(await authHeader(manager));
    expect(again.status).toBe(200);
    expect(again.body.data.number).toBe(first.body.data.number);
    expect(await FiscalDocument.countDocuments({ settlementId: settlement._id })).toBe(1);

    // Inmutable.
    await expect(FiscalDocument.updateOne({ _id: first.body.data._id }, { $set: { netAmount: 1 } })).rejects.toThrow();

    const list = await request(app).get('/api/v1/finance/documents').set(await authHeader(manager));
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect((await request(app).get('/api/v1/finance/documents?month=2026-13').set(await authHeader(manager))).status).toBe(400);
    expect((await request(app).get(`/api/v1/finance/documents/${first.body.data._id}`).set(await authHeader(manager))).status).toBe(200);
  });

  it('quien solo ve finanzas no puede emitir; el paquete mensual sale por el exporte', async () => {
    const { settlement, admin } = await paidSettlement(15_000);
    await payoutService.registerPayment({
      settlementId: String(settlement._id), method: 'nequi' as any, reference: 'NEQ-1',
      receiptUrl: 'https://example.com/c.jpg', paidBy: String(admin._id),
    });
    const viewer = await makeStaff({ roleSlug: 'soporte', permissions: [Permission.ADMIN_PANEL, Permission.FINANCE_VIEW] });
    expect((await request(app).post(`/api/v1/finance/settlements/${settlement._id}/document`).set(await authHeader(viewer))).status).toBe(403);

    const manager = await staffWith([Permission.FINANCE_VIEW, Permission.FINANCE_MANAGE, Permission.REPORTS_EXPORT]);
    await request(app).post(`/api/v1/finance/settlements/${settlement._id}/document`).set(await authHeader(manager));
    const spy = vi.spyOn(mfa, 'verifySecondFactor').mockImplementation((async () => true) as any);
    const csv = await request(app)
      .post('/api/v1/finance/exports/documents')
      .set(await authHeader(manager))
      .send({ reason: 'paquete del mes', totpToken: '123456' });
    spy.mockRestore();
    expect(csv.status).toBe(200);
    expect(csv.text).toContain('INT-');
    expect(csv.text).toContain('15000');
  });
});

describe('efectivo por domiciliario', () => {
  it('agrupa lo sin rendir, marca lo vencido y lo reportado, y deja fuera lo liquidado', async () => {
    await featureFlagService.remove('rbac_enforce');
    const driverA = await makeDriverForCash();
    const mk = (driverId: any, amount: number, status: string, dueAt: Date) =>
      CashReconciliation.create({
        driverId, orderId: new Types.ObjectId(), amount, status, dueAt,
        breakdown: { merchantCommission: amount, customerServiceFee: 0, deliveryMargin: 0, taxPayable: 0 },
      } as any);
    const past = new Date(Date.now() - 86_400_000);
    const future = new Date(Date.now() + 86_400_000);
    await mk(driverA, 5_000, 'pending', future);
    await mk(driverA, 7_000, 'reported', future);
    await mk(driverA, 3_000, 'overdue', past);
    await mk(driverA, 99_000, 'settled', past);

    const staff = await staffWith([Permission.FINANCE_VIEW]);
    await featureFlagService.upsert('rbac_enforce', { audience: 'staff' });
    const res = await request(app).get('/api/v1/finance/cash/by-driver').set(await authHeader(staff));
    expect(res.status).toBe(200);
    const row = res.body.data.find((r: any) => r.driverId === String(driverA));
    expect(row).toMatchObject({ count: 3, amount: 15_000, reportedAmount: 7_000, overdueCount: 1, overdueAmount: 3_000 });
  });
});

async function makeDriverForCash() {
  const { makeDriver } = await import('./factories');
  const user = await makeUser({ role: UserRole.DRIVER });
  const driver: any = await makeDriver(user._id);
  return driver._id as Types.ObjectId;
}
