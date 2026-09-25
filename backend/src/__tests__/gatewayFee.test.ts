import { describe, it, expect } from 'vitest';
import { Types } from 'mongoose';
import { estimateGatewayFee, gatewayFeeMethod } from '../utils/gatewayFee';
import { ledgerService } from '../services/ledger.service';
import { platformResultService } from '../services/platformResult.service';
import { pricingConfigService } from '../services/pricingConfig.service';
import { LedgerAccount } from '../types';
import { makeUser } from './factories';

describe('comisión estimada de la pasarela', () => {
  it('sin tarifa configurada no inventa un coste', () => {
    expect(estimateGatewayFee({}, 'CARD', 50_000)).toBe(0);
    expect(estimateGatewayFee({ gatewayCardBps: 0, gatewayCardFixed: 0 }, 'CARD', 50_000)).toBe(0);
  });

  it('porcentaje + fijo + IVA de la comisión, todo entero', () => {
    // 2,65 % de 50.000 = 1.325 (+ 700 fijo) = 2.025; IVA 19 % = 385 (redondeado) => 2.410
    const cfg = { gatewayCardBps: 265, gatewayCardFixed: 700, gatewayFeeVatBps: 1900 };
    const fee = estimateGatewayFee(cfg, 'CARD', 50_000);
    expect(fee).toBe(2_410);
    expect(Number.isInteger(fee)).toBe(true);
  });

  it('cada método usa su tarifa; lo desconocido cae en "otro"', () => {
    const cfg = { gatewayPseFixed: 2_900, gatewayNequiBps: 150, gatewayOtherFixed: 1_000 };
    expect(gatewayFeeMethod('pse')).toBe('pse');
    expect(estimateGatewayFee(cfg, 'PSE', 80_000)).toBe(2_900);
    expect(estimateGatewayFee(cfg, 'NEQUI', 80_000)).toBe(1_200);
    expect(estimateGatewayFee(cfg, 'BANCOLOMBIA_TRANSFER', 80_000)).toBe(1_000);
    expect(estimateGatewayFee(cfg, undefined, 80_000)).toBe(1_000);
  });

  it('rechaza montos no enteros', () => {
    expect(() => estimateGatewayFee({ gatewayCardBps: 100 }, 'CARD', 100.5)).toThrow();
  });
});

describe('la comisión entra al libro con el cobro', () => {
  it('asienta gasto contra GATEWAY_WITHHELD, cuadra y resta del resultado; un reintento no la duplica', async () => {
    const orderId = new Types.ObjectId();
    const params = { orderId, amount: 50_000, pricingConfigVersion: 1, transactionId: 'tx-fee-1', processingFee: 2_410 };

    await ledgerService.recordPaymentCaptured(params);
    await ledgerService.recordPaymentCaptured(params);

    const expense = await ledgerService.accountBalance(LedgerAccount.PAYMENT_PROCESSING_EXPENSE, { orderId });
    const withheld = await ledgerService.accountBalance(LedgerAccount.GATEWAY_WITHHELD, { orderId });
    expect(expense.balance).toBe(2_410);
    expect(withheld.balance).toBe(-2_410);
    expect(await ledgerService.isBalanced({ orderId })).toBe(true);

    const result = await platformResultService.forRange();
    expect(result.processingExpense).toBe(2_410);
    expect(result.netAfterGatewayCosts).toBe(result.netBeforeGatewayCosts - 2_410);
  });

  it('sin comisión el asiento del cobro queda como antes', async () => {
    const orderId = new Types.ObjectId();
    await ledgerService.recordPaymentCaptured({ orderId, amount: 10_000, pricingConfigVersion: 1, transactionId: 'tx-nofee' });
    const expense = await ledgerService.accountBalance(LedgerAccount.PAYMENT_PROCESSING_EXPENSE, { orderId });
    expect(expense.balance).toBe(0);
  });

  it('la tarifa se publica como parte de una versión de Tarifas', async () => {
    const admin = await makeUser({ role: 'admin' as any });
    const { config } = await pricingConfigService.update(
      { gatewayCardBps: 265, gatewayCardFixed: 700, gatewayFeeVatBps: 1900 },
      { userId: String(admin._id), reason: 'Contrato Wompi 2026' }
    );
    expect(config.gatewayCardBps).toBe(265);
    expect(config.gatewayFeeVatBps).toBe(1900);
    // Lo que no se tocó viaja intacto a la nueva versión.
    expect(config.gatewayPseBps).toBe(0);
  });
});
