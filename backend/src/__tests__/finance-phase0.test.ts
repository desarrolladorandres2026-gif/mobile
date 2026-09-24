import { describe, it, expect } from 'vitest';
import { Types } from 'mongoose';
import { payoutService } from '../services/payout.service';
import { refundService, allocateRefund } from '../services/refund.service';
import { driverService } from '../services/driver.service';
import { Payout, Settlement, Driver, User } from '../models';
import {
  PayoutBeneficiary,
  PayoutStatus,
  SettlementPaymentMethod,
  RefundKind,
} from '../types';
import { makeUser, makeDriver, makeSettleableBusinessId } from './factories';

/**
 * Fase 0 (dinero): D1 (settle atómico), D2 (arrastre de reversos tardíos),
 * D3 (contracargo parcial), D5 (pago de liquidación idempotente), D7
 * (fondo rotatorio condicionado).
 */

async function makePayout(overrides: Partial<{
  businessId: Types.ObjectId;
  amount: number;
  status: PayoutStatus;
  reversedAmount: number;
}> = {}) {
  const orderId = new Types.ObjectId();
  const businessId = overrides.businessId ?? new Types.ObjectId();
  return Payout.create({
    orderId,
    beneficiary: PayoutBeneficiary.BUSINESS,
    businessId,
    driverId: null,
    amount: overrides.amount ?? 10_000,
    reversedAmount: overrides.reversedAmount ?? 0,
    status: overrides.status ?? PayoutStatus.PAYABLE,
    currency: 'COP',
    pricingConfigVersion: 1,
    becamePayableAt: new Date(),
  });
}

describe('D1 · settle() reclama atómicamente', () => {
  it('dos settle() simultáneos por el mismo comercio solo liquidan una vez', async () => {
    const businessId = await makeSettleableBusinessId();
    const admin = await makeUser({ role: 'admin' as any, isFinanceAdmin: true });

    await makePayout({ businessId, amount: 15_000 });
    await makePayout({ businessId, amount: 5_000 });

    const [a, b] = await Promise.all([
      payoutService.settle({
        beneficiary: PayoutBeneficiary.BUSINESS,
        businessId: businessId.toString(),
        createdBy: admin._id.toString(),
      }),
      payoutService.settle({
        beneficiary: PayoutBeneficiary.BUSINESS,
        businessId: businessId.toString(),
        createdBy: admin._id.toString(),
      }),
    ]);

    const results = [a, b];
    const withMoney = results.filter((r) => r.settlement !== null);
    const empty = results.filter((r) => r.settlement === null);

    expect(withMoney).toHaveLength(1);
    expect(empty).toHaveLength(1);
    expect(withMoney[0].netAmount).toBe(20_000);
    expect(withMoney[0].count).toBe(2);

    const settlements = await Settlement.find({ businessId });
    expect(settlements).toHaveLength(1);

    const payouts = await Payout.find({ businessId });
    expect(payouts.every((p) => p.status === PayoutStatus.SETTLED)).toBe(true);
  });
});

describe('D2 · reverse() sobre un payout ya SETTLED crea un arrastre', () => {
  it('el arrastre se descuenta —solo lo que cabe— en la próxima liquidación del mismo beneficiario', async () => {
    const businessId = await makeSettleableBusinessId();
    const admin = await makeUser({ role: 'admin' as any, isFinanceAdmin: true });

    const settledPayout = await makePayout({
      businessId,
      amount: 10_000,
      status: PayoutStatus.SETTLED,
    });

    // Reembolso tardío: el payout ya se pagó, pero hay que devolver 4.000.
    await payoutService.reverse(settledPayout.orderId, { business: 4_000 });

    const clawback = await Payout.findOne({
      businessId,
      isClawback: true,
    });
    expect(clawback).not.toBeNull();
    expect(clawback!.amount).toBe(4_000);
    expect(clawback!.status).toBe(PayoutStatus.PAYABLE);

    // El payout original nunca cambia de estado por un arrastre.
    const original = await Payout.findById(settledPayout._id);
    expect(original!.status).toBe(PayoutStatus.SETTLED);
    expect(original!.reversedAmount).toBe(4_000);

    // Un payout nuevo, PAYABLE, de solo 3.000: no alcanza para cubrir el
    // arrastre completo. La liquidación nunca debe quedar negativa.
    await makePayout({ businessId, amount: 3_000 });

    const result = await payoutService.settle({
      beneficiary: PayoutBeneficiary.BUSINESS,
      businessId: businessId.toString(),
      createdBy: admin._id.toString(),
    });

    expect(result.settlement).not.toBeNull();
    expect(result.netAmount).toBe(0); // 3.000 de payout - 3.000 de arrastre consumido
    expect(result.settlement!.clawbackAmount).toBe(3_000);

    const remainingClawback = await Payout.findById(clawback!._id);
    expect(remainingClawback!.amount).toBe(1_000); // 4.000 - 3.000 consumidos
    expect(remainingClawback!.status).toBe(PayoutStatus.PAYABLE);
    expect(remainingClawback!.settlementId).toBeNull();
  });

  it('nunca produce un netAmount negativo', async () => {
    const businessId = await makeSettleableBusinessId();
    const admin = await makeUser({ role: 'admin' as any, isFinanceAdmin: true });

    const settledPayout = await makePayout({
      businessId,
      amount: 10_000,
      status: PayoutStatus.SETTLED,
    });
    await payoutService.reverse(settledPayout.orderId, { business: 9_000 });

    await makePayout({ businessId, amount: 100 });

    const result = await payoutService.settle({
      beneficiary: PayoutBeneficiary.BUSINESS,
      businessId: businessId.toString(),
      createdBy: admin._id.toString(),
    });

    expect(result.netAmount).toBeGreaterThanOrEqual(0);
    expect(result.netAmount).toBe(0);
  });
});

describe('D5 · pago de liquidación', () => {
  it('registra el pago, marca payouts SETTLED y postea un asiento idempotente', async () => {
    const businessId = await makeSettleableBusinessId();
    const admin = await makeUser({ role: 'admin' as any, isFinanceAdmin: true });

    await makePayout({ businessId, amount: 20_000 });
    const { settlement } = await payoutService.settle({
      beneficiary: PayoutBeneficiary.BUSINESS,
      businessId: businessId.toString(),
      createdBy: admin._id.toString(),
    });
    expect(settlement).not.toBeNull();

    const paid = await payoutService.registerPayment({
      settlementId: settlement!._id.toString(),
      method: SettlementPaymentMethod.BANK_TRANSFER,
      reference: 'CONSIGNACION-001',
      receiptUrl: 'https://example.com/comprobante-001.jpg',
      paidBy: admin._id.toString(),
    });
    expect(paid.paymentStatus).toBe('paid');

    // Un segundo intento sobre la misma liquidación no puede pagarla otra vez
    // (el asiento del primer pago ya existe, así que esto no es una
    // recuperación: es un intento genuino de pagar dos veces).
    await expect(
      payoutService.registerPayment({
        settlementId: settlement!._id.toString(),
        method: SettlementPaymentMethod.BANK_TRANSFER,
        reference: 'CONSIGNACION-001-retry',
        receiptUrl: 'https://example.com/comprobante-001.jpg',
        paidBy: admin._id.toString(),
      })
    ).rejects.toThrow();

    const { LedgerEntry } = await import('../models');
    const entries = await LedgerEntry.find({ reference: settlement!._id.toString() });
    expect(entries.length).toBeGreaterThan(0);
    const debits = entries.filter((e) => e.direction === 'debit').reduce((s, e) => s + e.amount, 0);
    const credits = entries.filter((e) => e.direction === 'credit').reduce((s, e) => s + e.amount, 0);
    expect(debits).toBe(credits);
    expect(debits).toBe(20_000);
  });
});

describe('D3 · reembolso/contracargo parcial reparte proporcionalmente', () => {
  it('un contracargo parcial no explota y reparte igual que un reembolso parcial', () => {
    const finance: any = {
      customerTotal: 50_000,
      businessPayout: 20_000,
      driverPayout: 8_000,
      merchantCommission: 5_000,
      customerServiceFee: 2_000,
      deliveryMargin: 3_000,
      taxPayable: 1_000,
      platformPromotionExpense: 0,
    };

    const allocation = allocateRefund(finance, 10_000, RefundKind.CHARGEBACK);
    const sum =
      allocation.fromMerchantPayout +
      allocation.fromCommission +
      allocation.fromServiceFee +
      Math.max(0, allocation.fromDeliveryMargin) +
      allocation.fromTax;
    expect(sum).toBe(10_000);
    expect(allocation.fromDriverPayout).toBe(0); // el contracargo parcial no toca al domiciliario
  });

  it('reembolsos parciales acumulados no superan lo que queda en cada cuenta', () => {
    const finance: any = {
      customerTotal: 50_000,
      businessPayout: 20_000,
      driverPayout: 8_000,
      merchantCommission: 5_000,
      customerServiceFee: 2_000,
      deliveryMargin: 3_000,
      taxPayable: 1_000,
      platformPromotionExpense: 0,
    };

    const first = allocateRefund(finance, 15_000, RefundKind.PARTIAL);
    const second = allocateRefund(finance, 15_000, RefundKind.PARTIAL, first);

    expect(second.fromMerchantPayout).toBeLessThanOrEqual(
      finance.businessPayout - first.fromMerchantPayout
    );
    expect(second.fromCommission).toBeLessThanOrEqual(
      finance.merchantCommission - first.fromCommission
    );
  });
});

describe('D7 · fondo rotatorio condicionado', () => {
  it('reduce el fondo base y aplica solo la diferencia a currentFund', async () => {
    const user = await makeUser();
    const driver = await makeDriver(user._id);
    await Driver.updateOne({ _id: driver._id }, { $set: { baseFund: 50_000, currentFund: 60_000 } });

    const updated = await driverService.updateBaseFund(driver._id.toString(), 40_000);
    expect(updated.baseFund).toBe(40_000);
    expect(updated.currentFund).toBe(50_000); // 60.000 - 10.000 de diferencia
  });

  it('rechaza con 409 si el fondo retenido en pedidos no alcanza para absorber la reducción', async () => {
    const user = await makeUser();
    const driver = await makeDriver(user._id);
    // Solo 5.000 libres: el resto del fondo base está retenido en pedidos
    // en curso. Bajar el fondo base a 10.000 exige liberar 40.000, y no hay.
    await Driver.updateOne({ _id: driver._id }, { $set: { baseFund: 50_000, currentFund: 5_000 } });

    await expect(driverService.updateBaseFund(driver._id.toString(), 10_000)).rejects.toMatchObject({
      statusCode: 409,
    });

    const unchanged = await Driver.findById(driver._id);
    expect(unchanged!.baseFund).toBe(50_000);
    expect(unchanged!.currentFund).toBe(5_000);
  });
});
