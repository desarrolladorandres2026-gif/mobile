import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import {
  Order, TaxConcept, TaxTreatment, ProSubscription, ProSubscriptionStatus, Payment, Advertisement,
  AdPricingModel, AdApprovalStatus, AdInvoice,
} from '../models';
import { UserRole, PaymentMethod, PaymentStatus, PaymentType, RefundKind } from '../types';
import { taxRuleService, CONCEPT_PROFILES } from '../services/taxRule.service';
import { orderService } from '../services/order.service';
import { proService } from '../services/pro.service';
import { advertisementService } from '../services/advertisement.service';
import { refundService } from '../services/refund.service';
import { featureFlagService } from '../services/featureFlag.service';
import { PRO_PLAN } from '../config/pro';
import { cache } from '../cache';
import {
  electronicInvoicingService, setElectronicInvoiceProvider, ZIPP_DOCUMENT_KINDS,
  type ElectronicInvoiceProvider,
} from '../services/electronicInvoicing.service';
import { FISCAL_DOCUMENT_NOTICE } from '../models/FiscalDocument';
import { makeUser, makeBusiness, makeProduct, makePricingConfig, makeStaff, authHeader, GARZON, offsetKm } from './factories';

/**
 * Auditoría 2026-10-19 · cada concepto con su propio tratamiento.
 *
 * Las cifras (19 %, 5 %…) son de EJEMPLO para ejercitar el motor; no son las
 * tarifas ni el criterio tributario de ZIPP. Lo que se prueba es la mecánica:
 * sin regla aprobada todo queda «pendiente» y no se inventa nada; con regla,
 * el impuesto se separa de lo cobrado sin cambiar ningún importe; y el pasado no
 * se reescribe.
 */

const API = '/api/v1';
const DAY = 86_400_000;
const REF = 'Concepto contable de ejemplo (prueba)';
const DEST = offsetKm(GARZON, 1);

let proposer: any;
let approver: any;

beforeEach(async () => {
  await featureFlagService.upsert('rbac_enforce', { audience: 'staff' });
  await cache.flush();
  proposer = await makeUser({ role: UserRole.ADMIN });
  approver = await makeUser({ role: UserRole.ADMIN });
});
afterEach(() => setElectronicInvoiceProvider(null));

const approve = async (concept: TaxConcept, over: Record<string, unknown> = {}) => {
  const rule = await taxRuleService.createDraft(
    { concept, treatment: TaxTreatment.TAXED, rateBps: 1900, validFrom: new Date(), priceIncludesTax: true, ...over } as never,
    String(proposer._id)
  );
  return taxRuleService.validate(String(rule._id), String(approver._id), { validationRef: REF });
};

async function placeOrder() {
  const client = await makeUser();
  const owner = await makeUser({ role: UserRole.BUSINESS });
  const business = await makeBusiness(owner._id, { commissionRateBps: 1000 });
  const product = await makeProduct(business._id, { price: 30_000 });
  return orderService.create({
    clientId: client._id.toString(), businessId: business._id.toString(),
    items: [{ productId: product._id.toString(), quantity: 1 }], paymentMethod: PaymentMethod.ONLINE,
    deliveryAddress: 'Cra 10 #5-23', deliveryLatitude: DEST.lat, deliveryLongitude: DEST.lng,
  } as never);
}

describe('Comisión de ZIPP: la evaluación queda con el pedido y no mueve dinero', () => {
  it('sin regla aprobada: pendiente, 0 de impuesto, nada inventado', async () => {
    await makePricingConfig();
    const order = await placeOrder();
    expect(order.finance.commissionTax).toMatchObject({ status: 'pending', ruleId: null, taxIncluded: 0, baseAmount: order.finance.merchantCommission });
  });

  it('con regla «incluida»: separa cuánto de la comisión es impuesto, y comisión y pago al comercio NO cambian', async () => {
    await makePricingConfig();
    const without = await placeOrder();
    await approve(TaxConcept.COMMISSION);
    const withRule = await placeOrder();

    const c = withRule.finance.merchantCommission;
    const included = c - Math.round((c * 10_000) / 11_900);
    expect(withRule.finance.commissionTax).toMatchObject({ status: 'definitive', rateBps: 1900, baseAmount: c, taxIncluded: included });
    expect(included).toBeGreaterThan(0);

    // Mismo pedido, misma plata: la regla no toca ningún importe.
    for (const k of ['merchantCommission', 'businessPayout', 'driverPayout', 'customerTotal', 'taxPayable', 'platformGrossRevenue'] as const) {
      expect(withRule.finance[k]).toBe(without.finance[k]);
    }
  });

  it('exento, excluido o no aplica: evaluación definitiva con 0 de impuesto (distinto de «pendiente»)', async () => {
    await makePricingConfig();
    await approve(TaxConcept.COMMISSION, { treatment: TaxTreatment.EXEMPT, rateBps: null });
    const order = await placeOrder();
    expect(order.finance.commissionTax).toMatchObject({ status: 'definitive', treatment: 'exempt', taxIncluded: 0 });
  });

  it('redondeo: el impuesto extraído nunca excede lo cobrado y se calcula sobre el importe entero', async () => {
    await approve(TaxConcept.COMMISSION);
    for (const amount of [1, 7, 99, 1_001, 3_333, 19_999, 123_457]) {
      const snap = await taxRuleService.snapshot(TaxConcept.COMMISSION, amount);
      expect(snap.taxIncluded).toBe(amount - Math.round((amount * 10_000) / 11_900));
      expect(snap.taxIncluded).toBeLessThanOrEqual(amount);
      expect(Number.isInteger(snap.taxIncluded)).toBe(true);
    }
  });

  it('cambio de vigencia: el pedido anterior conserva «pendiente» aunque después se apruebe una regla', async () => {
    await makePricingConfig();
    const before = await placeOrder();
    await approve(TaxConcept.COMMISSION);
    const after = await placeOrder();

    expect((await Order.findById(before._id))!.finance.commissionTax!.status).toBe('pending');
    expect((await Order.findById(after._id))!.finance.commissionTax!.status).toBe('definitive');
  });
});

describe('Zipp Pro: la cuota queda con su evaluación y el cobro no cambia', () => {
  const paid = async () => {
    const user = await makeUser();
    await ProSubscription.create({
      userId: user._id, status: ProSubscriptionStatus.PENDING, planId: PRO_PLAN.id, price: PRO_PLAN.price, currency: PRO_PLAN.currency,
    });
    const payment: any = await Payment.create({
      userId: user._id, type: PaymentType.PRO_SUBSCRIPTION, method: PaymentMethod.ONLINE, status: PaymentStatus.PAID,
      amount: PRO_PLAN.price, currency: PRO_PLAN.currency, reference: `pro-${user._id}`,
    } as any);
    await proService.settlePayment(payment, PaymentStatus.PAID);
    return Payment.findById(payment._id).lean() as Promise<any>;
  };

  it('sin regla aprobada: pendiente', async () => {
    const p = await paid();
    expect(p.amount).toBe(PRO_PLAN.price);
    expect(p.metadata.taxAssessment).toMatchObject({ status: 'pending', taxIncluded: 0 });
  });

  it('con regla incluida: informa el impuesto de la cuota sin cambiar lo cobrado', async () => {
    await approve(TaxConcept.PRO_SUBSCRIPTION);
    const p = await paid();
    expect(p.amount).toBe(PRO_PLAN.price);
    expect(p.metadata.taxAssessment).toMatchObject({ status: 'definitive', rateBps: 1900 });
    expect(p.metadata.taxAssessment.taxIncluded).toBe(PRO_PLAN.price - Math.round((PRO_PLAN.price * 10_000) / 11_900));
  });

  it('un webhook repetido no vuelve a evaluar: queda la evaluación del primer cobro', async () => {
    const p = await paid();
    await approve(TaxConcept.PRO_SUBSCRIPTION);
    await proService.settlePayment((await Payment.findById(p._id))!, PaymentStatus.PAID);
    expect((await Payment.findById(p._id).lean() as any).metadata.taxAssessment.status).toBe('pending');
  });
});

describe('No se confunde con la pasarela ni se cuenta dos veces', () => {
  it('el costo de Wompi y el impuesto son cuentas distintas: aprobar una regla no mueve el gasto de pasarela', async () => {
    await makePricingConfig({ gatewayOtherBps: 265, gatewayOtherFixed: 700, gatewayFeeVatBps: 1900 });
    const before = await placeOrder();
    await approve(TaxConcept.COMMISSION);
    const after = await placeOrder();
    // Ni el total cobrado ni el margen de ZIPP dependen de la regla de la comisión.
    expect(after.finance.customerTotal).toBe(before.finance.customerTotal);
    expect(after.finance.platformGrossRevenue).toBe(before.finance.platformGrossRevenue);
  });

  it('publicidad: el impuesto «incluido» se informa una vez y el importe facturado es el mismo con y sin regla', async () => {
    const close = async () => {
      const ad = await Advertisement.create({
        campaignName: 'Promo', advertiserName: 'Tienda', flyerUrl: 'https://res.cloudinary.com/demo/image/upload/v1/ads/x.jpg',
        startDate: new Date(Date.now() - DAY), endDate: new Date(Date.now() + DAY),
        pricingModel: AdPricingModel.CPC, cpcRate: 500, budget: 100_000, clickCount: 20,
        approvalStatus: AdApprovalStatus.APPROVED, isActive: true,
      });
      return advertisementService.closeAndInvoice(String(ad._id));
    };
    const a = await close();
    await approve(TaxConcept.ADVERTISING);
    const b = await close();
    expect(a.amount).toBe(b.amount);
    expect(a.taxAssessment).toMatchObject({ status: 'pending', taxIncluded: 0 });
    expect(b.taxAssessment).toMatchObject({ status: 'definitive', taxIncluded: b.amount - Math.round((b.amount * 10_000) / 11_900) });
  });
});

describe('Conciliación tributaria', () => {
  const range = () => ({ from: new Date(Date.now() - DAY), to: new Date(Date.now() + DAY) });

  it('lo cobrado sin regla aprobada sale como pendiente y el informe NO se presenta como definitivo', async () => {
    await makePricingConfig();
    await placeOrder();
    const rec = await taxRuleService.reconciliation(range());
    const commission = rec.concepts.find((c) => c.concept === TaxConcept.COMMISSION)!;
    expect(commission).toMatchObject({ events: 0, pendingEvents: 1 });
    expect(rec.checkout.unvalidatedGlobalRate.orders).toBe(1); // tasa global sin validar
    expect(rec.definitive).toBe(false);
  });

  it('con regla: el hecho entra como definitivo, el anterior sigue pendiente (no se reescribe) y los totales cuadran', async () => {
    await makePricingConfig();
    const oldOrder = await placeOrder();
    await approve(TaxConcept.COMMISSION);
    const newOrder = await placeOrder();
    const rec = await taxRuleService.reconciliation(range());
    const row = rec.concepts.find((c) => c.concept === TaxConcept.COMMISSION)!;
    expect(row.events).toBe(1);
    expect(row.pendingEvents).toBe(1);
    expect(row.baseTotal).toBe(newOrder.finance.merchantCommission);
    expect(row.taxTotal).toBe(newOrder.finance.commissionTax!.taxIncluded);
    expect(row.pendingBase).toBe(oldOrder.finance.merchantCommission);
  });

  it('lo devuelto en reembolsos se informa aparte, sin mezclarlo con lo cobrado', async () => {
    await makePricingConfig();
    const order = await placeOrder();
    const refund = await refundService.issue({ orderId: order._id.toString(), amount: 3_000, reason: 'Parcial', kind: RefundKind.PARTIAL });
    const rec = await taxRuleService.reconciliation(range());
    expect(rec.refunds.commissionReturned).toBe(refund.allocation.fromCommission);
    expect(rec.refunds.checkoutTaxReturned).toBe(refund.allocation.fromTax);
  });

  it('por HTTP: finance:view y rango validado', async () => {
    await makePricingConfig();
    const viewer = await makeStaff({ roleSlug: 'soporte', permissions: [(await import('../security/rbac')).Permission.FINANCE_VIEW] });
    const nobody = await makeStaff({ roleSlug: 'operaciones', permissions: [(await import('../security/rbac')).Permission.SUPPORT_VIEW] });
    expect((await request(app).get(`${API}/finance/tax-reconciliation`).set(await authHeader(nobody))).status).toBe(403);
    const ok = await request(app).get(`${API}/finance/tax-reconciliation?period=month`).set(await authHeader(viewer));
    expect(ok.status).toBe(200);
    expect(ok.body.data.concepts).toHaveLength(7);
    expect((await request(app).get(`${API}/finance/tax-reconciliation?period=ayer`).set(await authHeader(viewer))).status).toBe(400);
    expect((await request(app).get(`${API}/finance/tax-reconciliation?from=2026-13-40`).set(await authHeader(viewer))).status).toBe(400);
  });

  it('cada concepto declara quién presta el servicio, quién recibe el ingreso, la base y qué sigue abierto', () => {
    for (const concept of Object.values(TaxConcept)) {
      const p = CONCEPT_PROFILES[concept];
      expect(p.provider.length).toBeGreaterThan(0);
      expect(p.recipient.length).toBeGreaterThan(0);
      expect(p.base.length).toBeGreaterThan(0);
      expect(['checkout', 'snapshot', 'none']).toContain(p.integration);
    }
    expect(CONCEPT_PROFILES[TaxConcept.COMMISSION].openQuestions.length).toBeGreaterThan(0);
  });
});

describe('Facturación electrónica: lo interno no es una factura', () => {
  it('cada documento que ZIPP genera hoy está clasificado y ninguno es factura electrónica', () => {
    expect(Object.values(ZIPP_DOCUMENT_KINDS)).not.toContain('electronic_invoice');
    expect(ZIPP_DOCUMENT_KINDS.settlement_statement).toBe('internal_voucher');
    expect(ZIPP_DOCUMENT_KINDS.driver_payment_voucher).toBe('internal_voucher');
    expect(FISCAL_DOCUMENT_NOTICE).toMatch(/No es factura electr[oó]nica/i);
  });

  it('sin proveedor no se simula nada: 501 y la lista de lo que falta', async () => {
    expect((await electronicInvoicingService.status())).toMatchObject({ integrated: false, provider: null });
    expect((await electronicInvoicingService.status()).missing.join(' ')).toMatch(/NIT/);
    await expect(electronicInvoicingService.issue({ source: { kind: 'settlement_statement', id: 'x' }, amount: 1000 }))
      .rejects.toMatchObject({ statusCode: 501, code: 'ELECTRONIC_INVOICING_NOT_CONFIGURED' });
  });

  it('con proveedor, solo cuenta como emitida si el proveedor devuelve número, CUFE y fecha de validación', async () => {
    const fake = (receipt: any): ElectronicInvoiceProvider => ({ name: 'fake', isConfigured: () => true, issue: async () => receipt });
    const req = { source: { kind: 'ad_charge' as const, id: 'x' }, amount: 1000 };

    setElectronicInvoiceProvider(fake({ number: 'SETP-1', cufe: '', dianValidatedAt: new Date(), providerReference: 'r' }));
    await expect(electronicInvoicingService.issue(req)).rejects.toMatchObject({ code: 'ELECTRONIC_INVOICE_NOT_VALIDATED' });
    setElectronicInvoiceProvider(fake({ number: 'SETP-1', cufe: 'abc', providerReference: 'r' }));
    await expect(electronicInvoicingService.issue(req)).rejects.toMatchObject({ code: 'ELECTRONIC_INVOICE_NOT_VALIDATED' });

    const good = { number: 'SETP-1', cufe: 'abc123', dianValidatedAt: new Date(), providerReference: 'r' };
    setElectronicInvoiceProvider(fake(good));
    await expect(electronicInvoicingService.issue(req)).resolves.toMatchObject({ cufe: 'abc123' });
  });

  it('el informe de pendientes lo dice: integrated=false y qué falta', async () => {
    await makePricingConfig();
    const viewer = await makeStaff({ roleSlug: 'soporte', permissions: [(await import('../security/rbac')).Permission.FINANCE_VIEW] });
    const res = await request(app).get(`${API}/finance/config/readiness`).set(await authHeader(viewer));
    expect(res.body.data.tax.electronicInvoicing).toMatchObject({ integrated: false, provider: null });
    expect(res.body.data.tax.electronicInvoicing.missing.length).toBeGreaterThan(3);
  });
});

void AdInvoice;
