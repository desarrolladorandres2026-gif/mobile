import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { Types } from 'mongoose';
import app from '../app';
import { payoutService } from '../services/payout.service';
import { ledgerService } from '../services/ledger.service';
import { migratePayoutLateRefundSplit } from '../migrations/029-payout-late-refund-split';
import { Payout, Settlement, Order, LedgerEntry } from '../models';
import {
  PayoutBeneficiary,
  PayoutStatus,
  UserRole,
  SettlementPaymentMethod,
  LedgerAccount,
  LedgerDirection,
  LedgerEventType,
} from '../types';
import { makeUser, makeBusiness, makeDriver, makeSettleableBusinessId, authHeader } from './factories';

/**
 * Corrección 1.2: un reembolso tardío (con el payout ya liquidado o reclamado)
 * se restaba dos veces en el extracto del comercio: una en `reversedAmount` de
 * la fila original y otra en la fila de arrastre. Regla vigente:
 *
 *   neto = liquidado + pendiente
 *
 * La fila original conserva lo que se pagó (`reversedAmount` es solo lo
 * revertido antes de comprometerse); lo tardío va a `reversedAfterCommit` y lo
 * representa el arrastre, que conserva su `amount` original y suma lo cobrado
 * en `consumedAmount`.
 */

const RECEIPT = 'https://example.com/comprobante.jpg';
const D = LedgerDirection.DEBIT;
const C = LedgerDirection.CREDIT;

const S: any = Settlement;
const originalCreate = S.create.bind(S);
afterEach(() => {
  S.create = originalCreate;
});

let seq = 0;

/** Un pedido entregado y su payout del comercio (con el ledger del pedido si se pide). */
async function mkSale(
  businessId: Types.ObjectId,
  amount: number,
  opts: { status?: PayoutStatus; ledger?: boolean } = {}
) {
  const orderId = new Types.ObjectId();
  seq += 1;
  await Order.collection.insertOne({
    _id: orderId,
    businessId,
    orderNumber: `LR-${seq}`,
    status: 'delivered',
    paymentMethod: 'online',
    createdAt: new Date(Date.now() + seq),
    finance: { productSubtotal: amount, merchantCommission: 0, merchantFundedDiscount: 0 },
  } as any);
  if (opts.ledger) {
    await ledgerService.post(
      { orderId, event: LedgerEventType.ORDER_PLACED, pricingConfigVersion: 1, businessId, reference: '' },
      [
        { account: LedgerAccount.RECEIVABLE, direction: D, amount },
        { account: LedgerAccount.MERCHANT_PAYABLE, direction: C, amount },
      ]
    );
  }
  return Payout.create({
    orderId,
    beneficiary: PayoutBeneficiary.BUSINESS,
    businessId,
    amount,
    status: opts.status ?? PayoutStatus.PAYABLE,
    currency: 'COP',
    pricingConfigVersion: 1,
    becamePayableAt: new Date(),
  });
}

/** El reembolso real postea este asiento (`ledgerService.recordReversal`); aquí se simula solo el ledger. */
async function postRefund(orderId: Types.ObjectId, businessId: Types.ObjectId, amount: number, reference: string) {
  await ledgerService.post(
    { orderId, event: LedgerEventType.REFUND_ISSUED, pricingConfigVersion: 1, businessId, reference },
    [
      { account: LedgerAccount.MERCHANT_PAYABLE, direction: D, amount },
      { account: LedgerAccount.REFUND, direction: C, amount },
    ]
  );
}

const settle = (businessId: Types.ObjectId, adminId: string) =>
  payoutService.settle({ beneficiary: PayoutBeneficiary.BUSINESS, businessId: String(businessId), createdBy: adminId });

const pay = (settlementId: string, adminId: string) =>
  payoutService.registerPayment({
    settlementId,
    method: SettlementPaymentMethod.BANK_TRANSFER,
    reference: `T-${settlementId}`,
    receiptUrl: RECEIPT,
    paidBy: adminId,
  });

const statement = (businessId: Types.ObjectId) =>
  payoutService.merchantStatementLines({ businessId: String(businessId) });
const summary = (businessId: Types.ObjectId) =>
  payoutService.summaryFor({ beneficiary: PayoutBeneficiary.BUSINESS, businessId: String(businessId) });

async function setup() {
  const businessId = await makeSettleableBusinessId();
  const admin = await makeUser({ role: UserRole.ADMIN, isFinanceAdmin: true });
  return { businessId, adminId: String(admin._id) };
}

describe('1 · reembolso tardío total tras liquidar', () => {
  it('Σ de las líneas = 0 y lo liquidado sigue siendo lo que se consignó', async () => {
    const { businessId, adminId } = await setup();
    const sale = await mkSale(businessId, 100_000);
    const s1 = await settle(businessId, adminId);

    await payoutService.reverse(sale.orderId, { business: 100_000 });

    const original = await Payout.findById(sale._id);
    expect(original!.status).toBe(PayoutStatus.SETTLED);
    expect(original!.reversedAmount).toBe(0);
    expect(original!.reversedAfterCommit).toBe(100_000);

    const { lines, totals } = await statement(businessId);
    const sale1 = lines.find((l) => !l.isClawback)!;
    const claw = lines.find((l) => l.isClawback)!;
    expect(sale1.netAmount).toBe(100_000);
    expect(sale1.lateReversedAmount).toBe(100_000);
    expect(claw.netAmount).toBe(-100_000);
    expect(lines.reduce((sum, l) => sum + l.netAmount, 0)).toBe(0);
    expect(totals.netAmount).toBe(0);

    const sum = await summary(businessId);
    expect(sum.settled).toBe(s1.settlement!.netAmount);
    expect(sum.outstanding).toBe(-100_000);
  });
});

describe('2 · reembolso tardío parcial', () => {
  it('la original muestra lo pagado, el arrastre −delta y Σ = lo ganado de verdad', async () => {
    const { businessId, adminId } = await setup();
    const sale = await mkSale(businessId, 100_000);
    await settle(businessId, adminId);
    await payoutService.reverse(sale.orderId, { business: 30_000 });

    const { lines, totals } = await statement(businessId);
    const original = lines.find((l) => !l.isClawback)!;
    const claw = lines.find((l) => l.isClawback)!;
    expect(original.reversedAmount).toBe(0);
    expect(original.lateReversedAmount).toBe(30_000);
    expect(original.netAmount).toBe(100_000);
    expect(original.pendingAmount).toBe(0);
    expect(claw.netAmount).toBe(-30_000);
    expect(claw.pendingAmount).toBe(-30_000);
    expect(claw.lateReversedAmount).toBe(0);
    expect(totals.netAmount).toBe(70_000);

    const st = await payoutService.merchantStatement({ businessId: String(businessId) });
    expect(st.settled).toBe(100_000);
    expect(st.outstanding).toBe(-30_000);
    expect(st.nextSettlement.netAmount).toBe(-30_000);
    expect(st.weeks.reduce((sum, w) => sum + w.netAmount, 0)).toBe(70_000);
  });
});

describe('3 · arrastre consumido parcialmente', () => {
  it('lo cobrado no desaparece: settled = Σ(net+ad), pendiente = resto y próxima liquidación = Σ pendiente', async () => {
    const { businessId, adminId } = await setup();
    const sale = await mkSale(businessId, 100_000);
    await settle(businessId, adminId);
    await payoutService.reverse(sale.orderId, { business: 30_000 });

    await mkSale(businessId, 20_000);
    const s2 = await settle(businessId, adminId);
    expect(s2.settlement!.clawbackAmount).toBe(20_000);
    expect(s2.netAmount).toBe(0);

    const claw = (await Payout.findOne({ businessId, isClawback: true }))!;
    expect(claw.amount).toBe(30_000); // original, inmutable
    expect(claw.consumedAmount).toBe(20_000);
    expect(claw.status).toBe(PayoutStatus.PAYABLE);
    expect(claw.settlementId).toBeNull();

    const settlements = await Settlement.find({ businessId }).lean();
    const sumSettlements = settlements.reduce((sum, s) => sum + s.netAmount + s.adSpendAmount, 0);

    const { lines, totals } = await statement(businessId);
    const clawLine = lines.find((l) => l.isClawback)!;
    expect(clawLine.netAmount).toBe(-30_000);
    expect(clawLine.pendingAmount).toBe(-10_000);
    expect(totals.netAmount).toBe(90_000);

    const st = await payoutService.merchantStatement({ businessId: String(businessId) });
    expect(st.settled).toBe(sumSettlements);
    expect(st.settled).toBe(100_000);
    expect(st.outstanding).toBe(-10_000);
    expect(st.nextSettlement.netAmount).toBe(-10_000);
    expect(st.nextSettlement.clawbackPendingAmount).toBe(-10_000);
    // Neto = liquidado + pendiente.
    expect(totals.netAmount).toBe(st.settled + st.outstanding);

    // La siguiente liquidación cobra solo el resto, no el original otra vez.
    await mkSale(businessId, 50_000);
    const s3 = await settle(businessId, adminId);
    expect(s3.settlement!.clawbackAmount).toBe(10_000);
    expect(s3.netAmount).toBe(40_000);
    const done = (await Payout.findById(claw._id))!;
    expect(done.status).toBe(PayoutStatus.SETTLED);
    expect(done.consumedAmount).toBe(30_000);
  });
});

describe('4 · arrastre castigado', () => {
  it('el neto de la fila es lo consumido y lo abierto vuelve a 0', async () => {
    const { businessId, adminId } = await setup();
    const sale = await mkSale(businessId, 100_000);
    await settle(businessId, adminId);
    await payoutService.reverse(sale.orderId, { business: 30_000 });
    await mkSale(businessId, 20_000);
    await settle(businessId, adminId); // consume 20.000 de 30.000

    const claw = (await Payout.findOne({ businessId, isClawback: true }))!;
    await payoutService.writeOffClawback({ payoutId: String(claw._id), reason: 'Comercio sin actividad' });

    // El asiento del castigo es solo por lo que seguía abierto.
    const writeOff = await LedgerEntry.find({ reference: `clawback-writeoff:${claw._id}`, account: LedgerAccount.BAD_DEBT_EXPENSE });
    expect(writeOff.reduce((sum, e) => sum + e.amount, 0)).toBe(10_000);

    const { lines, totals } = await statement(businessId);
    const clawLine = lines.find((l) => l.isClawback)!;
    expect(clawLine.payoutStatus).toBe(PayoutStatus.WRITTEN_OFF);
    expect(clawLine.netAmount).toBe(-20_000);
    expect(clawLine.pendingAmount).toBe(0);
    expect(totals.netAmount).toBe(100_000 + 20_000 - 20_000);

    const st = await payoutService.merchantStatement({ businessId: String(businessId) });
    expect(st.outstanding).toBe(0);
    expect(st.settled).toBe(100_000);
    expect(totals.netAmount).toBe(st.settled + st.outstanding);
  });
});

describe('5 · carrera P0: reversión durante el reclamo y liquidación fallida', () => {
  it('la siguiente liquidación paga amount − delta (70.000), no 40.000', async () => {
    const { businessId, adminId } = await setup();
    const sale = await mkSale(businessId, 100_000);

    S.create = async () => {
      await payoutService.reverse(sale.orderId, { business: 30_000 });
      throw new Error('boom');
    };
    await expect(settle(businessId, adminId)).rejects.toThrow('boom');
    S.create = originalCreate;

    // Se soltó el reclamo; la reversión quedó como tardía + arrastre, no en reversedAmount.
    const payout = (await Payout.findById(sale._id))!;
    expect(payout.settlementId).toBeNull();
    expect(payout.reversedAmount).toBe(0);
    expect(payout.reversedAfterCommit).toBe(30_000);
    expect(await Payout.countDocuments({ businessId, isClawback: true })).toBe(1);

    const retry = await settle(businessId, adminId);
    expect(retry.settlement!.grossAmount).toBe(100_000);
    expect(retry.settlement!.reversedAmount).toBe(0);
    expect(retry.settlement!.clawbackAmount).toBe(30_000);
    expect(retry.netAmount).toBe(70_000);
  });
});

describe('6 · dos reversiones tardías', () => {
  it('en secuencia y en paralelo no superan el payout', async () => {
    const { businessId } = await setup();
    const a = await mkSale(businessId, 100_000, { status: PayoutStatus.SETTLED });
    await payoutService.reverse(a.orderId, { business: 70_000 });
    await payoutService.reverse(a.orderId, { business: 70_000 });
    const afterA = (await Payout.findById(a._id))!;
    expect(afterA.reversedAfterCommit).toBe(100_000);
    expect(afterA.reversedAmount).toBe(0);
    const clawsA = await Payout.find({ orderId: a.orderId, isClawback: true });
    expect(clawsA.reduce((sum, c) => sum + c.amount, 0)).toBe(100_000);

    const b = await mkSale(businessId, 100_000, { status: PayoutStatus.SETTLED });
    await Promise.all([
      payoutService.reverse(b.orderId, { business: 70_000 }),
      payoutService.reverse(b.orderId, { business: 70_000 }),
    ]);
    const afterB = (await Payout.findById(b._id))!;
    expect(afterB.reversedAfterCommit).toBe(100_000);
    const clawsB = await Payout.find({ orderId: b.orderId, isClawback: true });
    expect(clawsB.reduce((sum, c) => sum + c.amount, 0)).toBe(100_000);
  });

  it('antes de comprometerse sigue yendo a reversedAmount y revierte el payout al cubrirlo', async () => {
    const { businessId } = await setup();
    const p = await mkSale(businessId, 50_000);
    await payoutService.reverse(p.orderId, { business: 20_000 });
    let doc = (await Payout.findById(p._id))!;
    expect(doc.reversedAmount).toBe(20_000);
    expect(doc.reversedAfterCommit).toBe(0);
    expect(doc.status).toBe(PayoutStatus.PAYABLE);
    await payoutService.reverse(p.orderId, { business: 99_000 });
    doc = (await Payout.findById(p._id))!;
    expect(doc.reversedAmount).toBe(50_000);
    expect(doc.status).toBe(PayoutStatus.REVERSED);
    expect(await Payout.countDocuments({ businessId, isClawback: true })).toBe(0);
  });
});

describe('7 · pedido en efectivo descargado en la puerta + reembolso tardío', () => {
  it('paidAtDoor es lo cobrado en la puerta y el arrastre resta el delta', async () => {
    const { businessId } = await setup();
    const sale = await mkSale(businessId, 100_000);
    await payoutService.dischargeInCash(sale.orderId);
    await payoutService.reverse(sale.orderId, { business: 30_000 });

    const sum = await summary(businessId);
    expect(sum.paidAtDoor).toBe(100_000);
    expect(sum.settledBySettlement).toBe(0);
    expect(sum.settled).toBe(100_000);
    expect(sum.outstanding).toBe(-30_000);
    expect(sum.transferred).toBe(0);

    const { lines, totals } = await statement(businessId);
    expect(lines.find((l) => l.isClawback)!.netAmount).toBe(-30_000);
    expect(lines.find((l) => !l.isClawback)!.netAmount).toBe(100_000);
    expect(totals.netAmount).toBe(70_000);
  });
});

describe('8 · repartidor con tarifa absorbida', () => {
  it('lo liquidado del repartidor no baja y la reversión previa a pagarse sí cuenta', async () => {
    const user = await makeUser({ role: UserRole.DRIVER });
    const driver = await makeDriver(user._id);
    const admin = await makeUser({ role: UserRole.ADMIN, isFinanceAdmin: true });

    const orderId = new Types.ObjectId();
    await Payout.create({
      orderId,
      beneficiary: PayoutBeneficiary.DRIVER,
      driverId: driver._id,
      amount: 5_000,
      status: PayoutStatus.PAYABLE,
      currency: 'COP',
      pricingConfigVersion: 1,
      becamePayableAt: new Date(),
    });
    await payoutService.settle({
      beneficiary: PayoutBeneficiary.DRIVER,
      driverId: String(driver._id),
      createdBy: String(admin._id),
    });
    const before = await payoutService.summaryFor({ beneficiary: PayoutBeneficiary.DRIVER, driverId: String(driver._id) });
    expect(before.settled).toBe(5_000);

    await payoutService.reverse(orderId, { driver: 2_000 }, 'refund-1');

    const after = await payoutService.summaryFor({ beneficiary: PayoutBeneficiary.DRIVER, driverId: String(driver._id) });
    expect(after.settled).toBe(5_000);
    expect(after.outstanding).toBe(0);
    const payout = (await Payout.findOne({ orderId, beneficiary: PayoutBeneficiary.DRIVER }))!;
    expect(payout.reversedAmount).toBe(0);
    expect(payout.reversedAfterCommit).toBe(2_000);
    expect(await Payout.countDocuments({ driverId: driver._id, isClawback: true })).toBe(0);
    const absorbed = await LedgerEntry.find({ orderId, account: LedgerAccount.DRIVER_FEE_ABSORBED_EXPENSE });
    expect(absorbed.reduce((sum, e) => sum + e.amount, 0)).toBe(2_000);
  });
});

describe('9 · CSV de ventas', () => {
  it('trae las columnas nuevas y Σ Neto = totals.netAmount, con el arrastre como número', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id, {});
    const sale = await mkSale(business._id as Types.ObjectId, 100_000, { status: PayoutStatus.SETTLED });
    await payoutService.reverse(sale.orderId, { business: 30_000 });

    const header = await authHeader(owner);
    const res = await request(app).get(`/api/v1/businesses/${business._id}/statement/export`).set(header);
    expect(res.status).toBe(200);

    const rows = res.text.replace(/^﻿/, '').split('\r\n').map((line) => line.split(';').map((c) => c.replace(/^"|"$/g, '')));
    const head = rows[0];
    for (const col of ['Tipo', 'Reversado', 'Reembolso tardío', 'Neto', 'Pendiente', 'Estado', 'Liquidación']) {
      expect(head).toContain(col);
    }
    expect(head).not.toContain('Neto a recibir');

    const body = rows.slice(1).filter((r) => r.length > 1);
    expect(body).toHaveLength(2);
    const col = (name: string) => head.indexOf(name);
    expect(body.map((r) => r[col('Tipo')]).sort()).toEqual(['Arrastre por reembolso tardío', 'Venta']);
    const clawRow = body.find((r) => r[col('Tipo')] !== 'Venta')!;
    expect(clawRow[col('Neto')]).toBe('-30000'); // sin apóstrofo: es un número
    expect(clawRow[col('Pendiente')]).toBe('-30000');
    const saleRow = body.find((r) => r[col('Tipo')] === 'Venta')!;
    expect(saleRow[col('Reembolso tardío')]).toBe('30000');
    expect(saleRow[col('Reversado')]).toBe('0');

    const sumNeto = body.reduce((sum, r) => sum + Number(r[col('Neto')]), 0);
    const { totals } = await statement(business._id as Types.ObjectId);
    expect(sumNeto).toBe(totals.netAmount);
    expect(sumNeto).toBe(70_000);
  });
});

describe('10 · cuadre con el libro', () => {
  it('tras registerPayment, −balance(MERCHANT_PAYABLE) = summary.outstanding, también con arrastre parcial', async () => {
    const { businessId, adminId } = await setup();
    // `0 -` y no un `-` unario: evita el -0 de JavaScript cuando el saldo es cero.
    const ledgerOwed = async () =>
      0 - (await ledgerService.accountBalance(LedgerAccount.MERCHANT_PAYABLE, { businessId })).balance;

    const sale = await mkSale(businessId, 100_000, { ledger: true });
    const s1 = await settle(businessId, adminId);
    await pay(String(s1.settlement!._id), adminId);
    expect(await ledgerOwed()).toBe(0);

    await payoutService.reverse(sale.orderId, { business: 30_000 });
    await postRefund(sale.orderId, businessId, 30_000, 'rf-1');
    expect(await ledgerOwed()).toBe(-30_000);
    expect((await summary(businessId)).outstanding).toBe(-30_000);

    const fresh = await mkSale(businessId, 20_000, { ledger: true });
    const s2 = await settle(businessId, adminId);
    await pay(String(s2.settlement!._id), adminId);
    expect(fresh.orderId).toBeDefined();
    expect(await ledgerOwed()).toBe(-10_000);
    const sum = await summary(businessId);
    expect(sum.outstanding).toBe(-10_000);
    expect(sum.transferred).toBe(100_000 + 0);

    // El resto abierto se cobra directo: el libro y el resumen vuelven a 0.
    const claw = (await Payout.findOne({ businessId, isClawback: true }))!;
    await payoutService.collectClawback({ payoutId: String(claw._id), reference: 'C-1', receiptUrl: RECEIPT });
    expect(await ledgerOwed()).toBe(0);
    expect((await summary(businessId)).outstanding).toBe(0);
  });
});

describe('11 · migración 029', () => {
  async function legacy() {
    const businessId = await makeSettleableBusinessId();
    const other = await makeSettleableBusinessId();
    const admin = await makeUser({ role: UserRole.ADMIN, isFinanceAdmin: true });
    const now = new Date();
    const base = { currency: 'COP', pricingConfigVersion: 1, isClawback: false, createdAt: now, updatedAt: now };
    const raw = Payout.collection;

    // A · venta liquidada con reembolso tardío (la reversión estaba sumada a reversedAmount) + arrastre intacto.
    const settlementA = new Types.ObjectId();
    const orderA = new Types.ObjectId();
    const saleA = new Types.ObjectId();
    const clawA = new Types.ObjectId();
    await raw.insertMany([
      { ...base, _id: saleA, orderId: orderA, beneficiary: 'business', businessId, amount: 100_000, reversedAmount: 30_000, reversedAtClaim: 0, status: 'settled', settlementId: settlementA },
      { ...base, _id: clawA, orderId: orderA, beneficiary: 'business', businessId, amount: 30_000, reversedAmount: 0, reversedAtClaim: 0, status: 'payable', settlementId: null, isClawback: true },
    ] as any);

    // B · arrastre de 30.000 ya consumido en 20.000 (su amount quedó en 10.000).
    const orderB = new Types.ObjectId();
    const saleB = new Types.ObjectId();
    const clawB = new Types.ObjectId();
    const settlementB = new Types.ObjectId();
    await raw.insertMany([
      { ...base, _id: saleB, orderId: orderB, beneficiary: 'business', businessId, amount: 80_000, reversedAmount: 30_000, reversedAtClaim: 0, status: 'settled', settlementId: new Types.ObjectId() },
      { ...base, _id: clawB, orderId: orderB, beneficiary: 'business', businessId, amount: 10_000, reversedAmount: 0, reversedAtClaim: 0, status: 'payable', settlementId: null, isClawback: true },
    ] as any);
    await Settlement.collection.insertOne({
      _id: settlementB, beneficiary: 'business', businessId, payoutCount: 1, grossAmount: 20_000, netAmount: 0, adSpendAmount: 0, clawbackAmount: 20_000,
      clawbacks: [{ payoutId: clawB, orderId: orderB, amount: 20_000, pricingConfigVersion: 1 }], paymentStatus: 'paid', createdAt: now,
    } as any);

    // C · arrastre cobrado entero en dos liquidaciones (30.000 + 20.000): hoy amount = 20.000, SETTLED con liquidación.
    const orderC = new Types.ObjectId();
    const saleC = new Types.ObjectId();
    const clawC = new Types.ObjectId();
    const settlementC1 = new Types.ObjectId();
    const settlementC2 = new Types.ObjectId();
    await raw.insertMany([
      { ...base, _id: saleC, orderId: orderC, beneficiary: 'business', businessId, amount: 90_000, reversedAmount: 50_000, reversedAtClaim: 0, status: 'settled', settlementId: new Types.ObjectId() },
      { ...base, _id: clawC, orderId: orderC, beneficiary: 'business', businessId, amount: 20_000, reversedAmount: 0, reversedAtClaim: 0, status: 'settled', settlementId: settlementC2, isClawback: true },
    ] as any);
    await Settlement.collection.insertMany([
      { _id: settlementC1, beneficiary: 'business', businessId, clawbacks: [{ payoutId: clawC, orderId: orderC, amount: 30_000, pricingConfigVersion: 1 }], createdAt: now },
      { _id: settlementC2, beneficiary: 'business', businessId, clawbacks: [{ payoutId: clawC, orderId: orderC, amount: 20_000, pricingConfigVersion: 1 }], createdAt: now },
    ] as any);

    // D · repartidor con tarifa absorbida de 1.000 sumada a reversedAmount.
    const driverUser = await makeUser({ role: UserRole.DRIVER });
    const driver = await makeDriver(driverUser._id);
    const orderD = new Types.ObjectId();
    const driverPayout = new Types.ObjectId();
    await raw.insertOne({
      ...base, _id: driverPayout, orderId: orderD, beneficiary: 'driver', driverId: driver._id, businessId: null,
      amount: 5_000, reversedAmount: 1_000, reversedAtClaim: 0, status: 'settled', settlementId: new Types.ObjectId(),
    } as any);
    await ledgerService.post(
      { orderId: orderD, event: LedgerEventType.DRIVER_FEE_ABSORBED, pricingConfigVersion: 1, driverId: driver._id as Types.ObjectId, reference: `driver-fee-absorbed:rf:${driverPayout}` },
      [
        { account: LedgerAccount.DRIVER_FEE_ABSORBED_EXPENSE, direction: D, amount: 1_000 },
        { account: LedgerAccount.DRIVER_PAYABLE, direction: C, amount: 1_000 },
      ]
    );

    // E · reclamado cuya foto no cuadra con su reversedAmount y sin arrastre: debe salir en el control.
    const orderE = new Types.ObjectId();
    const saleE = new Types.ObjectId();
    await raw.insertOne({
      ...base, _id: saleE, orderId: orderE, beneficiary: 'business', businessId: other, amount: 10_000, reversedAmount: 7_000, reversedAtClaim: 0, status: 'payable', settlementId: new Types.ObjectId(),
    } as any);

    return { raw, saleA, clawA, clawB, clawC, saleB, saleC, driverPayout, saleE, admin };
  }

  it('dry-run no escribe; aplicar reconstruye amount/consumedAmount/reversedAfterCommit; es idempotente', async () => {
    const { raw, saleA, clawA, clawB, clawC, saleB, saleC, driverPayout, saleE } = await legacy();
    const snapshot = JSON.stringify(await raw.find({}).sort({ _id: 1 }).toArray());

    const dry = await migratePayoutLateRefundSplit();
    expect(dry.dryRun).toBe(true);
    expect(dry.clawbacksMigrated).toBe(3);
    expect(dry.businessPayoutsMigrated).toBe(3);
    expect(dry.driverPayoutsMigrated).toBe(1);
    expect(JSON.stringify(await raw.find({}).sort({ _id: 1 }).toArray())).toBe(snapshot);

    const real = await migratePayoutLateRefundSplit({ dryRun: false });
    expect(real.clawbacksMigrated).toBe(3);
    expect(real.movedToLate).toBe(30_000 + 30_000 + 50_000 + 1_000);

    const get = async (id: Types.ObjectId) => (await raw.findOne({ _id: id })) as any;
    // A · el arrastre no se había cobrado: queda igual, con consumedAmount 0.
    expect(await get(clawA)).toMatchObject({ amount: 30_000, consumedAmount: 0 });
    expect(await get(saleA)).toMatchObject({ reversedAmount: 0, reversedAfterCommit: 30_000 });
    // B · amount vuelve al original y consumedAmount recoge lo cobrado.
    expect(await get(clawB)).toMatchObject({ amount: 30_000, consumedAmount: 20_000, status: 'payable' });
    expect(await get(saleB)).toMatchObject({ reversedAmount: 0, reversedAfterCommit: 30_000 });
    // C · cobrado entero en dos liquidaciones: original = 30.000 + 20.000.
    expect(await get(clawC)).toMatchObject({ amount: 50_000, consumedAmount: 50_000, status: 'settled' });
    expect(await get(saleC)).toMatchObject({ reversedAmount: 0, reversedAfterCommit: 50_000 });
    // D · repartidor.
    expect(await get(driverPayout)).toMatchObject({ reversedAmount: 0, reversedAfterCommit: 1_000 });

    // Control: solo E no cuadra con su foto.
    expect(real.claimMismatches.map((m) => m.payoutId)).toEqual([String(saleE)]);
    expect(await get(saleE)).toMatchObject({ reversedAmount: 7_000 }); // no se toca

    // Idempotente.
    const after = JSON.stringify(await raw.find({}).sort({ _id: 1 }).toArray());
    const again = await migratePayoutLateRefundSplit({ dryRun: false });
    expect(again.clawbacksMigrated).toBe(0);
    expect(again.businessPayoutsMigrated).toBe(0);
    expect(again.driverPayoutsMigrated).toBe(0);
    expect(again.movedToLate).toBe(0);
    expect(JSON.stringify(await raw.find({}).sort({ _id: 1 }).toArray())).toBe(after);
  });
});
