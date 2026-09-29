import { describe, it, expect } from 'vitest';
import { Types } from 'mongoose';
import { Refund, Payout } from '../models';
import { PayoutBeneficiary, PayoutStatus, RefundKind, RefundStatus } from '../types';
import { dailySummaryService } from '../services/dailySummary.service';
import { dailySummaryFinanceService } from '../services/dailySummaryFinance.service';
import { bogotaDateString } from '../utils/period';

/**
 * Lo que el Resumen diario dice de dinero ajeno: pendientes, pasarela y
 * detalle por pedido. Aquí se fija lo que un contador no perdonaría:
 * un reembolso fallido no es dinero reembolsado, y un día sin cobros no
 * debe fingir que la comisión de la pasarela está "completa".
 */

const today = () => bogotaDateString();

async function refund(status: RefundStatus, amount: number, extra: Record<string, unknown> = {}) {
  return Refund.create({
    orderId: new Types.ObjectId(),
    kind: RefundKind.FULL,
    status,
    amount,
    processedAt: status === RefundStatus.COMPLETED ? new Date() : null,
    ...extra,
  });
}

describe('reembolsos en el resumen diario', () => {
  it('solo cuentan los completados; un fallido no infla refundsAmount', async () => {
    await refund(RefundStatus.COMPLETED, 30_000);
    await refund(RefundStatus.FAILED, 500_000);

    const summary = await dailySummaryService.generate(today());
    expect(summary.today.refundsCount).toBe(1);
    expect(summary.today.refundsAmount).toBe(30_000);
  });

  it('el fallido sí queda como pendiente de atención', async () => {
    await refund(RefundStatus.FAILED, 80_000);
    await refund(RefundStatus.COMPLETED, 10_000);

    const pending = await dailySummaryFinanceService.pending(today());
    expect(pending.refundsPending).toEqual({ count: 1, amount: 80_000 });
  });

  it('un fallido cuyo pedido ya se reembolsó con éxito no es pendiente', async () => {
    const orderId = new Types.ObjectId();
    await refund(RefundStatus.FAILED, 50_000, { orderId });
    await refund(RefundStatus.COMPLETED, 50_000, { orderId });

    const pending = await dailySummaryFinanceService.pending(today());
    expect(pending.refundsPending.count).toBe(0);
  });
});

describe('pendientes y pasarela', () => {
  it('un día sin cobros en línea no finge tener la comisión completa', async () => {
    const gateway = await dailySummaryFinanceService.gateway(today());
    expect(gateway.state).toBe('no_charges');
    expect(gateway.charges).toBe(0);
  });

  it('hoy desglosa devengado y exigible; una fecha pasada solo da el saldo del libro', async () => {
    await Payout.create({
      orderId: new Types.ObjectId(),
      beneficiary: PayoutBeneficiary.BUSINESS,
      businessId: new Types.ObjectId(),
      amount: 40_000,
      status: PayoutStatus.PAYABLE,
      pricingConfigVersion: 1,
    });

    const now = await dailySummaryFinanceService.pending(today());
    expect(now.asOf).toBe('now');
    expect(now.merchants.payable).toBe(40_000);
    expect(now.tipsPending).not.toBeNull();

    const past = await dailySummaryFinanceService.pending('2020-01-15');
    expect(past.asOf).toBe('close_of_day');
    expect(past.merchants.payable).toBeNull();
    expect(past.tipsPending).toBeNull();
  });
});

describe('detalle financiero por pedido', () => {
  it('un día sin pedidos cerrados devuelve una página vacía, no un error', async () => {
    const detail = await dailySummaryFinanceService.detail('2020-01-15', 1, 50);
    expect(detail).toMatchObject({ total: 0, rows: [], page: 1 });
  });

  it('acota el tamaño de página', async () => {
    const detail = await dailySummaryFinanceService.detail('2020-01-15', 1, 100_000);
    expect(detail.limit).toBe(200);
  });
});
