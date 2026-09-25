import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { Types } from 'mongoose';
import app from '../app';
import { payoutService } from '../services/payout.service';
import { featureFlagService } from '../services/featureFlag.service';
import { Payout, Commission, Refund } from '../models';
import { Permission } from '../security/rbac';
import {
  PayoutBeneficiary,
  PayoutStatus,
  SettlementPaymentMethod,
  CommissionStatus,
  RefundKind,
  RefundStatus,
  UserRole,
} from '../types';
import { makeUser, makeSettleableBusinessId, makeStaff, authHeader } from './factories';

/**
 * Fase 3 (dinero operable): lista de trabajo de liquidaciones, historial con
 * nombres, comisiones que por fin se cierran, y la bandeja de reembolsos.
 */

const RECEIPT = 'https://example.com/comprobante.jpg';

async function mkPayout(businessId: Types.ObjectId, amount: number, orderId = new Types.ObjectId(), extra: object = {}) {
  return Payout.create({
    orderId,
    beneficiary: PayoutBeneficiary.BUSINESS,
    businessId,
    driverId: null,
    amount,
    status: PayoutStatus.PAYABLE,
    currency: 'COP',
    pricingConfigVersion: 1,
    becamePayableAt: new Date(Date.now() - 3 * 86_400_000),
    ...extra,
  });
}

const financeStaff = () =>
  makeStaff({
    roleSlug: 'finanzas',
    permissions: [Permission.ADMIN_PANEL, Permission.FINANCE_VIEW, Permission.REFUNDS_VIEW, Permission.COMMISSIONS_VIEW],
  });

describe('Fase 3 · liquidaciones', () => {
  beforeEach(async () => {
    await featureFlagService.remove('rbac_enforce');
  });

  it('listPayables suma por comercio, resta arrastres y ordena por antigüedad', async () => {
    const businessId = await makeSettleableBusinessId();
    await mkPayout(businessId, 20_000);
    await mkPayout(businessId, 5_000);
    await mkPayout(businessId, 3_000, new Types.ObjectId(), { isClawback: true });
    // Todavía no es pagable: no cuenta.
    await mkPayout(businessId, 99_000, new Types.ObjectId(), { status: PayoutStatus.ACCRUED });

    const rows = await payoutService.listPayables({ beneficiary: PayoutBeneficiary.BUSINESS });
    const row = rows.find((r) => r.businessId === String(businessId))!;
    expect(row.net).toBe(22_000);
    expect(row.count).toBe(3);
    expect(row.clawbackCount).toBe(1);
    expect(row.daysWaiting).toBeGreaterThanOrEqual(3);
    expect(row.name).toBeTruthy();
  });

  it('listSettlements pagina, trae el nombre y nunca la cuenta de pago', async () => {
    const businessId = await makeSettleableBusinessId();
    const admin = await makeUser({ role: UserRole.ADMIN });
    await mkPayout(businessId, 20_000);
    await payoutService.settle({
      beneficiary: PayoutBeneficiary.BUSINESS,
      businessId: String(businessId),
      createdBy: String(admin._id),
    });

    const res = await payoutService.listSettlements({ businessId: String(businessId), limit: 10 });
    expect(res.meta.total).toBe(1);
    expect(res.items[0].businessName).toBeTruthy();
    expect(res.items[0].netAmount).toBe(20_000);
    expect(JSON.stringify(res.items[0])).not.toContain('accountNumberEnc');
    expect((res.items[0] as any).payoutAccount).toBeUndefined();

    const paid = await payoutService.listSettlements({ paymentStatus: 'paid' as any });
    expect(paid.items.some((i: any) => String(i.businessId) === String(businessId))).toBe(false);
  });

  it('pagar la liquidación cierra la Commission del pedido; con otro payout abierto no', async () => {
    const businessId = await makeSettleableBusinessId();
    const admin = await makeUser({ role: UserRole.ADMIN });
    const closedOrder = new Types.ObjectId();
    const openOrder = new Types.ObjectId();
    for (const orderId of [closedOrder, openOrder]) {
      await Commission.create({ orderId, businessId, platformAmount: 1000, businessAmount: 9000, driverAmount: 0 });
    }
    await mkPayout(businessId, 9_000, closedOrder);
    await mkPayout(businessId, 9_000, openOrder);
    // El pedido "open" también tiene un payout de domiciliario aún por pagar.
    await Payout.create({
      orderId: openOrder,
      beneficiary: PayoutBeneficiary.DRIVER,
      driverId: new Types.ObjectId(),
      amount: 3_000,
      status: PayoutStatus.PAYABLE,
      currency: 'COP',
      pricingConfigVersion: 1,
      becamePayableAt: new Date(),
    });

    const { settlement } = await payoutService.settle({
      beneficiary: PayoutBeneficiary.BUSINESS,
      businessId: String(businessId),
      createdBy: String(admin._id),
    });
    await payoutService.registerPayment({
      settlementId: String(settlement!._id),
      method: SettlementPaymentMethod.BANK_TRANSFER,
      reference: 'CONSIG-1',
      receiptUrl: RECEIPT,
      paidBy: String(admin._id),
    });

    const closed = await Commission.findOne({ orderId: closedOrder });
    expect(closed!.status).toBe(CommissionStatus.SETTLED);
    expect(closed!.settledAt).toBeTruthy();
    expect((await Commission.findOne({ orderId: openOrder }))!.status).toBe(CommissionStatus.PENDING);
  });

  it('rutas: /payables y /clawbacks responden a finanzas y niegan al cliente', async () => {
    const staff = await financeStaff();
    const client = await makeUser({ role: UserRole.CLIENT });
    expect((await request(app).get('/api/v1/finance/payables').set(await authHeader(client))).status).toBe(403);

    const ok = await request(app).get('/api/v1/finance/payables?beneficiary=business').set(await authHeader(staff));
    expect(ok.status).toBe(200);
    expect(Array.isArray(ok.body.data)).toBe(true);

    const claw = await request(app).get('/api/v1/finance/clawbacks?status=open').set(await authHeader(staff));
    expect(claw.status).toBe(200);

    const bad = await request(app).get('/api/v1/finance/settlements?paymentStatus=nada').set(await authHeader(staff));
    expect(bad.status).toBe(400);

    const list = await request(app).get('/api/v1/finance/settlements').set(await authHeader(staff));
    expect(list.status).toBe(200);
    expect(list.body.meta).toBeDefined();
  });
});

describe('Fase 3 · comisiones', () => {
  it('devuelve items y totales por estado sobre todo el filtro', async () => {
    const staff = await financeStaff();
    const businessId = new Types.ObjectId();
    await Commission.create({ orderId: new Types.ObjectId(), businessId, platformAmount: 500, businessAmount: 4500, driverAmount: 0 });
    await Commission.create({
      orderId: new Types.ObjectId(),
      businessId,
      platformAmount: 700,
      businessAmount: 6300,
      driverAmount: 0,
      status: CommissionStatus.SETTLED,
    });

    const res = await request(app).get('/api/v1/admin/commissions?limit=1').set(await authHeader(staff));
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.totals.pending.platformAmount).toBe(500);
    expect(res.body.data.totals.settled.platformAmount).toBe(700);
    expect(res.body.meta.total).toBe(2);

    const bad = await request(app).get('/api/v1/admin/commissions?businessId=zzz').set(await authHeader(staff));
    expect(bad.status).toBe(400);
  });
});

describe('Fase 3 · bandeja de reembolsos', () => {
  beforeEach(async () => {
    // Sin el bloqueo activo el RBAC solo observa: el 403 no existiría.
    await featureFlagService.remove('rbac_enforce');
    await featureFlagService.upsert('rbac_enforce', { audience: 'staff' });
  });

  it('lista con totales, filtra "atención" y exige refunds:view', async () => {
    const staff = await financeStaff();
    const noPerm = await makeStaff({ roleSlug: 'soporte', permissions: [Permission.ADMIN_PANEL] });
    await Refund.create({ orderId: new Types.ObjectId(), kind: RefundKind.FULL, status: RefundStatus.COMPLETED, amount: 10_000, reason: 'ok' });
    await Refund.create({ orderId: new Types.ObjectId(), kind: RefundKind.CHARGEBACK, status: RefundStatus.COMPLETED, amount: 8_000, reason: 'cb' });
    await Refund.create({ orderId: new Types.ObjectId(), kind: RefundKind.FULL, status: RefundStatus.FAILED, amount: 5_000, reason: 'falló' });

    const all = await request(app).get('/api/v1/payments/refunds').set(await authHeader(staff));
    expect(all.status).toBe(200);
    expect(all.body.data.items).toHaveLength(3);
    expect(all.body.data.totals.chargebacks).toEqual({ count: 1, amount: 8_000 });
    expect(all.body.data.totals.failed.count).toBe(1);

    const attention = await request(app).get('/api/v1/payments/refunds?attention=true').set(await authHeader(staff));
    expect(attention.body.data.items).toHaveLength(1);
    expect(attention.body.data.items[0].status).toBe('failed');

    expect((await request(app).get('/api/v1/payments/refunds').set(await authHeader(noPerm))).status).toBe(403);
    expect((await request(app).get('/api/v1/payments/refunds?status=x').set(await authHeader(staff))).status).toBe(400);
  });
});
