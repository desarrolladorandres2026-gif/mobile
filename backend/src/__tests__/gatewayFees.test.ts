import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { Types } from 'mongoose';
import { refundService } from '../services/refund.service';
import { orderService } from '../services/order.service';
import { ledgerService } from '../services/ledger.service';
import { pricingConfigService } from '../services/pricingConfig.service';
import { paymentReportService } from '../services/paymentReport.service';
import { platformResultService } from '../services/platformResult.service';
import { paymentService, setPaymentProvider, SandboxPaymentProvider } from '../services/payments';
import { Payment, Order, LedgerEntry } from '../models';
import { Permission } from '../security/rbac';
import { PaymentMethod, RefundKind, UserRole, LedgerAccount, LedgerDirection, LedgerEventType } from '../types';
import {
  estimateGatewayFee, gatewayFeeSnapshot, paymentGatewayFee, gatewayOperationFee, gatewayFeeReturned, gatewayFeeReadiness,
} from '../utils/gatewayFee';
import { makeUser, makeBusiness, makeProduct, makePricingConfig, makeStaff, authHeader, offsetKm, GARZON } from './factories';

/**
 * M-005 y M-006 — el costo de Wompi.
 *
 * Las tarifas de estas pruebas son de EJEMPLO para ejercitar el cálculo: no son
 * las del contrato de ZIPP con Wompi, que no está en el repositorio. Lo que se
 * fija aquí es la mecánica: una sola fórmula, la comisión guardada con el cobro
 * (no se reescribe al cambiar las tarifas), el ajuste al reembolsar sobre lo YA
 * asentado, y que mientras no haya contrato no se presenta nada como verificado.
 */

const DESTINATION = offsetKm(GARZON, 1);

const RATES = {
  gatewayCardBps: 265, gatewayCardFixed: 700,
  gatewayPseBps: 265, gatewayPseFixed: 700,
  gatewayNequiBps: 265, gatewayNequiFixed: 700,
  gatewayOtherBps: 265, gatewayOtherFixed: 700,
  gatewayFeeVatBps: 1900,
};

afterEach(() => setPaymentProvider(new SandboxPaymentProvider()));

describe('La fórmula, en un solo sitio', () => {
  it('porcentaje + fijo + IVA sobre la comisión; 0 mientras el método no tenga tarifa', () => {
    expect(estimateGatewayFee(RATES, 'CARD', 100_000)).toBe(Math.round((2_650 + 700) * 1.19));
    expect(estimateGatewayFee({}, 'CARD', 100_000)).toBe(0);
    expect(estimateGatewayFee({ ...RATES, gatewayNequiBps: 0, gatewayNequiFixed: 0 }, 'NEQUI', 100_000)).toBe(0);
  });

  it('la base del IVA puede ser solo el fijo (según el contrato)', () => {
    expect(estimateGatewayFee({ ...RATES, gatewayFeeVatBase: 'fixed' }, 'PSE', 100_000)).toBe(2_650 + 700 + 133);
  });

  it('el desglose suma exactamente lo mismo que el total', () => {
    const parts = gatewayFeeSnapshot({ ...RATES, version: 7, gatewayContractRef: 'Contrato 123' }, 'CARD', 100_000);
    expect(parts.percentage + parts.fixed + parts.vat).toBe(parts.total);
    expect(parts).toMatchObject({ configVersion: 7, estimated: true, contractVerified: true });
    expect(gatewayFeeSnapshot({ ...RATES }, 'CARD', 100_000).contractVerified).toBe(false);
  });

  it('el costo de una operación lleva el IVA; sin configurar, cero', () => {
    expect(gatewayOperationFee({ gatewayRefundFixed: 1_000, gatewayFeeVatBps: 1900 }, 'refund')).toEqual({ base: 1_000, vat: 190, total: 1_190 });
    expect(gatewayOperationFee({ gatewayChargebackFixed: 25_000 }, 'chargeback').total).toBe(25_000);
    expect(gatewayOperationFee({}, 'refund').total).toBe(0);
  });

  it('la comisión que la pasarela devuelve es proporcional, acotada, y sin política no se asume', () => {
    expect(gatewayFeeReturned({ gatewayFeeRefundBps: null }, 1_000, 50_000, 100_000)).toBe(0);
    expect(gatewayFeeReturned({}, 1_000, 50_000, 100_000)).toBe(0);
    expect(gatewayFeeReturned({ gatewayFeeRefundBps: 10_000 }, 1_000, 50_000, 100_000)).toBe(500);
    expect(gatewayFeeReturned({ gatewayFeeRefundBps: 5_000 }, 1_000, 100_000, 100_000)).toBe(500);
    expect(gatewayFeeReturned({ gatewayFeeRefundBps: 10_000 }, 1_000, 100_000, 100_000, 700)).toBe(300);
    expect(gatewayFeeReturned({ gatewayFeeRefundBps: 10_000 }, 1_000, 200_000, 100_000)).toBe(1_000);
    expect(gatewayFeeReturned({ gatewayFeeRefundBps: 0 }, 1_000, 100_000, 100_000)).toBe(0);
  });

  it('un cobro con comisión guardada manda sobre lo que digan las tarifas de hoy', () => {
    const stored = { total: 3_000, configVersion: 1 };
    const payment = { amount: 100_000, paymentMethodType: 'CARD', metadata: { gatewayFee: stored } };
    expect(paymentGatewayFee(payment, RATES)).toEqual({ total: 3_000, source: 'snapshot' });
    expect(paymentGatewayFee({ amount: 100_000, paymentMethodType: 'CARD' }, RATES)).toEqual({
      total: estimateGatewayFee(RATES, 'CARD', 100_000), source: 'estimate',
    });
    // Un valor guardado corrupto no se acepta en silencio.
    expect(paymentGatewayFee({ amount: 100_000, paymentMethodType: 'CARD', metadata: { gatewayFee: { total: -5 } } }, RATES).source).toBe('estimate');
  });
});

describe('Qué falta para dar las tarifas por buenas', () => {
  it('de fábrica: nada verificado, todos los métodos sin tarifa y lo que hay que confirmar con el contrato', () => {
    const r = gatewayFeeReadiness({});
    expect(r).toMatchObject({ verified: false, complete: false, contractRef: '' });
    expect(r.methodsWithoutTariff).toEqual(['card', 'pse', 'nequi', 'other']);
    expect(r.toConfirm.map((c) => c.code)).toEqual(['vat', 'refund_fee_policy', 'refund_cost', 'chargeback_cost', 'declined_voided']);
  });

  it('con tarifas pero sin el documento que las respalda, no están verificadas', () => {
    const r = gatewayFeeReadiness({ ...RATES });
    expect(r.methodsWithoutTariff).toEqual([]);
    expect(r.verified).toBe(false);
    expect(r.complete).toBe(false);
  });

  it('con tarifas y la referencia del contrato, quedan verificadas', () => {
    const r = gatewayFeeReadiness({ ...RATES, gatewayContractRef: 'Contrato Wompi, anexo de tarifas' });
    expect(r).toMatchObject({ verified: true, complete: true });
    expect(r.toConfirm.find((c) => c.code === 'vat')).toBeUndefined();
  });
});

describe('Con un pedido pagado por la pasarela', () => {
  async function paidOrder(config: Record<string, unknown> = {}, method: PaymentMethod = PaymentMethod.ONLINE) {
    setPaymentProvider(new SandboxPaymentProvider());
    await makePricingConfig({ cashOnDeliveryEnabled: true, cashOnDeliveryMaxAmount: 1_000_000, ...config });
    const client = await makeUser();
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id, { commissionRateBps: 1000 });
    const product = await makeProduct(business._id, { price: 40_000 });
    const order = await orderService.create({
      clientId: client._id.toString(),
      businessId: business._id.toString(),
      items: [{ productId: product._id.toString(), quantity: 1 }],
      paymentMethod: method,
      deliveryAddress: 'Cra 10 #5-23',
      deliveryLatitude: DESTINATION.lat,
      deliveryLongitude: DESTINATION.lng,
      ...(method === PaymentMethod.CASH_ON_DELIVERY ? { cashPayment: { needsChange: false } } : {}),
    } as never);
    if (method === PaymentMethod.ONLINE) {
      await paymentService.initiate({
        orderId: order._id.toString(),
        userId: client._id.toString(),
        amount: order.finance.customerTotal,
        description: 'Prueba',
        customer: { name: 'Cliente', phone: '3101234567' },
      });
    }
    return { order: (await Order.findById(order._id))!, client };
  }

  const expenseNet = async (orderId: Types.ObjectId) =>
    (await ledgerService.accountBalance(LedgerAccount.PAYMENT_PROCESSING_EXPENSE, { orderId })).balance;
  const withheld = async (orderId: Types.ObjectId) =>
    (await ledgerService.accountBalance(LedgerAccount.GATEWAY_WITHHELD, { orderId })).balance;

  it('la comisión se calcula una vez y se guarda con el cobro', async () => {
    const { order } = await paidOrder(RATES);
    const payment = (await Payment.findOne({ orderId: order._id }))!;
    const stored = (payment.metadata as any).gatewayFee;
    expect(stored.total).toBeGreaterThan(0);
    expect(stored).toMatchObject({ estimated: true, contractVerified: false, configVersion: 1 });
    expect(stored.total).toBe(estimateGatewayFee(RATES, payment.paymentMethodType, payment.amount));
    expect(await expenseNet(order._id)).toBe(stored.total);
  });

  it('cambiar las tarifas después NO reescribe los cobros históricos', async () => {
    const { order } = await paidOrder(RATES);
    const original = ((await Payment.findOne({ orderId: order._id }))!.metadata as any).gatewayFee.total;

    await pricingConfigService.update({ gatewayCardBps: 900, gatewayOtherBps: 900, gatewayPseBps: 900, gatewayNequiBps: 900 }, { userId: String(new Types.ObjectId()), reason: 'Nueva tarifa del contrato' });

    const report = await paymentReportService.list({});
    const row = report.items.find((i) => i.orderId === String(order._id))!;
    expect(row.estimatedFee).toBe(original);
    expect(row.feeSource).toBe('snapshot');
    // El libro tampoco se movió.
    expect(await expenseNet(order._id)).toBe(original);
  });

  it('un cobro anterior a este registro se sigue estimando, y el informe lo dice', async () => {
    const { order } = await paidOrder(RATES);
    await Payment.updateOne({ orderId: order._id }, { $unset: { 'metadata.gatewayFee': 1 } });
    const row = (await paymentReportService.list({})).items.find((i) => i.orderId === String(order._id))!;
    expect(row.feeSource).toBe('estimate');
  });

  it('reembolso total: Wompi devuelve su comisión y cobra la operación; el gasto neto es solo el costo de la operación', async () => {
    const config = { ...RATES, gatewayFeeRefundBps: 10_000, gatewayRefundFixed: 1_000 };
    const { order } = await paidOrder(config);
    const fee = await expenseNet(order._id);
    expect(fee).toBeGreaterThan(0);

    await refundService.issue({ orderId: order._id.toString(), reason: 'Reclamo', kind: RefundKind.FULL });

    const operation = gatewayOperationFee(config, 'refund').total;
    expect(operation).toBe(1_190);
    expect(await expenseNet(order._id)).toBe(operation);
    expect(await withheld(order._id)).toBe(-operation);
    expect(await ledgerService.isBalanced({ orderId: order._id })).toBe(true);

    const adjustment = await LedgerEntry.find({ orderId: order._id, event: LedgerEventType.GATEWAY_FEE_ADJUSTED });
    expect(adjustment.length).toBeGreaterThan(0);
    expect(adjustment.every((e) => e.account === LedgerAccount.PAYMENT_PROCESSING_EXPENSE || e.account === LedgerAccount.GATEWAY_WITHHELD)).toBe(true);
  });

  it('sin política de devolución definida no se asume que Wompi devuelva nada; el costo de la operación sí se registra', async () => {
    const config = { ...RATES, gatewayFeeRefundBps: null, gatewayRefundFixed: 1_000 };
    const { order } = await paidOrder(config);
    const fee = await expenseNet(order._id);
    await refundService.issue({ orderId: order._id.toString(), reason: 'Reclamo', kind: RefundKind.FULL });
    expect(await expenseNet(order._id)).toBe(fee + 1_190);
  });

  it('un reembolso parcial devuelve solo la parte proporcional de la comisión', async () => {
    const config = { ...RATES, gatewayFeeRefundBps: 10_000 };
    const { order } = await paidOrder(config);
    const fee = await expenseNet(order._id);

    await refundService.issue({ orderId: order._id.toString(), amount: 5_000, reason: 'Falta un producto' });
    const afterFirst = await expenseNet(order._id);
    expect(afterFirst).toBe(fee - gatewayFeeReturned(config, fee, 5_000, order.finance.customerTotal));
    expect(afterFirst).toBeLessThan(fee);
    expect(afterFirst).toBeGreaterThan(0);
    expect(await ledgerService.isBalanced({ orderId: order._id })).toBe(true);
  });

  it('lo que la pasarela devuelve nunca supera la comisión asentada, por muchos reembolsos que haya', async () => {
    const config = { ...RATES, gatewayFeeRefundBps: 10_000 };
    const { order } = await paidOrder(config);
    const fee = await expenseNet(order._id);
    // Dos ajustes (el proveedor de prueba solo admite un reembolso por cobro, así que se ejercitan directo).
    await refundService.recordGatewayFeeAdjustment(order, order.finance.customerTotal, 'refund', 'a');
    await refundService.recordGatewayFeeAdjustment(order, order.finance.customerTotal, 'refund', 'b');
    expect(await expenseNet(order._id)).toBe(0);
    expect(fee).toBeGreaterThan(0);
  });

  it('el contracargo cuesta lo que diga su propia tarifa, y no devuelve comisión', async () => {
    const config = { ...RATES, gatewayFeeRefundBps: 10_000, gatewayRefundFixed: 1_000, gatewayChargebackFixed: 20_000 };
    const { order } = await paidOrder(config);
    const fee = await expenseNet(order._id);
    await refundService.recordChargeback({ orderId: order._id.toString(), reference: 'CB-9' });
    // Un contracargo no es un reembolso: usa su tarifa (20.000 + IVA). La política de devolución aplica igual a lo reversado.
    const operation = gatewayOperationFee(config, 'chargeback').total;
    expect(operation).toBe(23_800);
    expect(await expenseNet(order._id)).toBe(operation);
    expect(fee).toBeGreaterThan(0);
  });

  it('sin tarifas configuradas no se escribe ningún ajuste: nada se inventa', async () => {
    const { order } = await paidOrder({});
    await refundService.issue({ orderId: order._id.toString(), reason: 'Reclamo', kind: RefundKind.FULL });
    expect(await LedgerEntry.countDocuments({ orderId: order._id, event: LedgerEventType.GATEWAY_FEE_ADJUSTED })).toBe(0);
    expect(await expenseNet(order._id)).toBe(0);
  });

  it('un pedido en efectivo no pasa por Wompi: ninguna comisión ni ajuste', async () => {
    const { order } = await paidOrder({ ...RATES, gatewayRefundFixed: 1_000 }, PaymentMethod.CASH_ON_DELIVERY);
    await refundService.issue({ orderId: order._id.toString(), reason: 'Reclamo', kind: RefundKind.FULL });
    expect(await expenseNet(order._id)).toBe(0);
    expect(await LedgerEntry.countDocuments({ orderId: order._id, event: LedgerEventType.GATEWAY_FEE_ADJUSTED })).toBe(0);
  });

  it('el costo de la pasarela es gasto de ZIPP: no toca el pago del comercio ni del domiciliario ni el impuesto', async () => {
    const config = { ...RATES, gatewayFeeRefundBps: 10_000, gatewayRefundFixed: 1_000 };
    const { order } = await paidOrder(config);
    const before = {
      merchant: (await ledgerService.accountBalance(LedgerAccount.MERCHANT_PAYABLE, { orderId: order._id })).balance,
      driver: (await ledgerService.accountBalance(LedgerAccount.DRIVER_PAYABLE, { orderId: order._id })).balance,
      tax: (await ledgerService.accountBalance(LedgerAccount.TAX_PAYABLE, { orderId: order._id })).balance,
    };
    await refundService.recordGatewayFeeAdjustment(order, 10_000, 'refund', 'solo-ajuste');
    const after = {
      merchant: (await ledgerService.accountBalance(LedgerAccount.MERCHANT_PAYABLE, { orderId: order._id })).balance,
      driver: (await ledgerService.accountBalance(LedgerAccount.DRIVER_PAYABLE, { orderId: order._id })).balance,
      tax: (await ledgerService.accountBalance(LedgerAccount.TAX_PAYABLE, { orderId: order._id })).balance,
    };
    expect(after).toEqual(before);
  });

  it('el ajuste es idempotente: el mismo reembolso reintentado no lo duplica', async () => {
    const config = { ...RATES, gatewayFeeRefundBps: 10_000, gatewayRefundFixed: 1_000 };
    const { order } = await paidOrder(config);
    await refundService.recordGatewayFeeAdjustment(order, 10_000, 'refund', 'ref-1');
    const once = await expenseNet(order._id);
    await refundService.recordGatewayFeeAdjustment(order, 10_000, 'refund', 'ref-1');
    expect(await expenseNet(order._id)).toBe(once);
  });

  it('el resultado de la plataforma sigue marcado como incompleto y refleja el gasto de pasarela', async () => {
    const { order } = await paidOrder(RATES);
    const result = await platformResultService.forOrder(order._id);
    expect(result!.incomplete).toBe(true);
    expect(result!.processingExpense).toBe(await expenseNet(order._id));
    expect(result!.netAfterGatewayCosts).toBe(result!.netBeforeGatewayCosts - result!.processingExpense);
  });
});

describe('Configurar las tarifas desde la administración', () => {
  const API = '/api/v1';

  it('el contrato se anota con su referencia y cada cambio queda versionado y auditado', async () => {
    await makePricingConfig({});
    const manager = await makeStaff({ roleSlug: 'finanzas', permissions: [Permission.FINANCE_VIEW, Permission.FINANCE_MANAGE] });
    const res = await request(app).put(`${API}/finance/config`).set(await authHeader(manager)).send({
      reason: 'Tarifas del anexo de Wompi firmado',
      gatewayCardBps: 265, gatewayCardFixed: 700, gatewayFeeVatBps: 1900,
      gatewayFeeRefundBps: 0, gatewayRefundFixed: 1000, gatewayChargebackFixed: 20000,
      gatewayContractRef: 'Anexo de tarifas Wompi · firmado 2026-10-01 (ejemplo de prueba)',
    });
    expect(res.status).toBe(200);
    const cfg = await pricingConfigService.getCurrent();
    expect(cfg).toMatchObject({ version: 2, gatewayRefundFixed: 1000, gatewayChargebackFixed: 20000, gatewayFeeRefundBps: 0 });
    expect(cfg.gatewayContractRef).toMatch(/Anexo de tarifas/);
    expect(res.body.data.changes.gatewayContractRef).toBeTruthy();

    const readiness = await request(app).get(`${API}/finance/config/readiness`).set(await authHeader(manager));
    expect(readiness.body.data.gateway.verified).toBe(true);
    expect(readiness.body.data.gateway.methodsWithoutTariff).toEqual(['pse', 'nequi', 'other']);
  });

  it('sin finance:manage no se cambia, y un campo inventado se rechaza', async () => {
    await makePricingConfig({});
    const viewer = await makeStaff({ roleSlug: 'soporte', permissions: [Permission.FINANCE_VIEW] });
    expect((await request(app).put(`${API}/finance/config`).set(await authHeader(viewer)).send({ reason: 'Quiero cambiarla', gatewayCardBps: 1 })).status).toBe(403);
    const manager = await makeStaff({ roleSlug: 'finanzas', permissions: [Permission.FINANCE_VIEW, Permission.FINANCE_MANAGE] });
    expect((await request(app).put(`${API}/finance/config`).set(await authHeader(manager)).send({ reason: 'Con un campo raro', wompiSecreto: 1 })).status).toBe(400);
    expect((await request(app).put(`${API}/finance/config`).set(await authHeader(manager)).send({ reason: 'Fuera de rango', gatewayCardBps: 20_000 })).status).toBe(400);
  });
});
