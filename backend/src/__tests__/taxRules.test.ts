import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { Order, TaxRule, TaxConcept, TaxTreatment, AdInvoice, Advertisement, AdPricingModel, AdApprovalStatus } from '../models';
import { Permission } from '../security/rbac';
import { AuditLog, AuditAction } from '../security';
import { PaymentMethod, UserRole, RefundKind } from '../types';
import { taxRuleService } from '../services/taxRule.service';
import { pricingService, computeCheckoutTax } from '../services/pricing.service';
import { pricingConfigService } from '../services/pricingConfig.service';
import { orderService } from '../services/order.service';
import { refundService } from '../services/refund.service';
import { advertisementService } from '../services/advertisement.service';
import { featureFlagService } from '../services/featureFlag.service';
import { cache } from '../cache';
import { GARZON, makeUser, makeBusiness, makeProduct, makePricingConfig, makeStaff, authHeader } from './factories';

/**
 * M-014 — impuestos por concepto.
 *
 * Las cifras de estas pruebas son de ejemplo para ejercitar el motor; NO son las
 * tarifas de ZIPP ni una opinión tributaria. En producción las decide y las
 * respalda con un documento el responsable contable y tributario.
 */

const API = '/api/v1';
const DAY = 86_400_000;
const NOW = () => new Date();
const TOMORROW = () => new Date(Date.now() + DAY);
const REF = 'Concepto contable 2026-10-20 (ejemplo de prueba)';

const draft = (over: Record<string, unknown> = {}) => ({
  concept: TaxConcept.DELIVERY,
  treatment: TaxTreatment.TAXED,
  rateBps: 1900,
  validFrom: NOW(),
  ...over,
}) as never;

let admin: any;

beforeEach(async () => {
  await featureFlagService.upsert('rbac_enforce', { audience: 'staff' });
  await cache.flush();
  admin = await makeUser({ role: UserRole.ADMIN });
});

const validated = async (over: Record<string, unknown> = {}) => {
  const rule = await taxRuleService.createDraft(draft(over), String(admin._id));
  return taxRuleService.validate(String(rule._id), String(admin._id), { validationRef: REF });
};

describe('Qué puede ser una regla', () => {
  it('un concepto gravado necesita tarifa; uno que no lo es, no la lleva', async () => {
    await expect(taxRuleService.createDraft(draft({ rateBps: null }), String(admin._id))).rejects.toMatchObject({ code: 'TAX_RATE_REQUIRED' });
    await expect(taxRuleService.createDraft(draft({ rateBps: 0 }), String(admin._id))).rejects.toMatchObject({ code: 'TAX_RATE_REQUIRED' });
    await expect(taxRuleService.createDraft(draft({ treatment: TaxTreatment.EXEMPT, rateBps: 1900 }), String(admin._id))).rejects.toMatchObject({ statusCode: 422 });
    const exempt = await taxRuleService.createDraft(draft({ treatment: TaxTreatment.EXEMPT, rateBps: null }), String(admin._id));
    expect(exempt.rateBps).toBeNull();
  });

  it('en el checkout el impuesto va encima; en los demás cobros, incluido: lo contrario no está soportado', async () => {
    await expect(taxRuleService.createDraft(draft({ priceIncludesTax: true }), String(admin._id))).rejects.toMatchObject({ code: 'TAX_INCLUDED_NOT_SUPPORTED' });
    await expect(taxRuleService.createDraft(draft({ concept: TaxConcept.ADVERTISING, priceIncludesTax: false }), String(admin._id)))
      .rejects.toMatchObject({ code: 'TAX_ON_TOP_NOT_SUPPORTED' });
    const ads = await taxRuleService.createDraft(draft({ concept: TaxConcept.ADVERTISING }), String(admin._id));
    expect(ads.priceIncludesTax).toBe(true);
  });

  it('«otro servicio» dice cuál', async () => {
    await expect(taxRuleService.createDraft(draft({ concept: TaxConcept.OTHER }), String(admin._id))).rejects.toMatchObject({ statusCode: 422 });
    expect((await taxRuleService.createDraft(draft({ concept: TaxConcept.OTHER, label: 'Alquiler de neveras', priceIncludesTax: true }), String(admin._id))).label).toBe('Alquiler de neveras');
  });
});

describe('Validar una regla', () => {
  it('sin el documento que la respalda no hay validación', async () => {
    const rule = await taxRuleService.createDraft(draft(), String(admin._id));
    await expect(taxRuleService.validate(String(rule._id), String(admin._id), { validationRef: 'ok' })).rejects.toMatchObject({ code: 'TAX_RULE_NEEDS_REFERENCE' });
    expect((await TaxRule.findById(rule._id))!.status).toBe('draft');
  });

  it('un borrador no se usa para nada: sin validar, el concepto sigue pendiente', async () => {
    await taxRuleService.createDraft(draft(), String(admin._id));
    const assessment = await taxRuleService.assess(TaxConcept.DELIVERY, 10_000);
    expect(assessment).toMatchObject({ status: 'pending', taxAmount: 0, ruleId: null });
  });

  it('no se valida hacia el pasado: los pedidos ya cobrados no se reescriben', async () => {
    const rule = await taxRuleService.createDraft(draft({ validFrom: new Date(Date.now() - 3 * DAY) }), String(admin._id));
    await expect(taxRuleService.validate(String(rule._id), String(admin._id), { validationRef: REF })).rejects.toMatchObject({ code: 'TAX_RULE_RETROACTIVE' });
  });

  it('una regla validada es historia: no se edita ni se borra', async () => {
    const rule = await validated();
    await expect(taxRuleService.updateDraft(String(rule._id), { rateBps: 500 }, String(admin._id))).rejects.toMatchObject({ code: 'TAX_RULE_IMMUTABLE' });
    await expect(taxRuleService.removeDraft(String(rule._id))).rejects.toMatchObject({ code: 'TAX_RULE_IMMUTABLE' });
    await expect(taxRuleService.validate(String(rule._id), String(admin._id), { validationRef: REF })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('la regla nueva cierra la anterior justo cuando empieza, sin hueco ni solape', async () => {
    const first = await validated({ rateBps: 1900 });
    const second = await validated({ rateBps: 500, validFrom: TOMORROW() });

    const closed = (await TaxRule.findById(first._id))!;
    expect(closed.validTo?.getTime()).toBe(second.validFrom.getTime());

    // Hoy rige la primera; mañana, la segunda.
    expect((await taxRuleService.resolve(TaxConcept.DELIVERY, NOW()))!.rateBps).toBe(1900);
    expect((await taxRuleService.resolve(TaxConcept.DELIVERY, new Date(TOMORROW().getTime() + 1000)))!.rateBps).toBe(500);
    // El instante exacto del cambio ya es de la nueva (vigencia semiabierta).
    expect((await taxRuleService.resolve(TaxConcept.DELIVERY, second.validFrom))!.rateBps).toBe(500);
  });

  it('dos validaciones simultáneas del mismo concepto no dejan dos reglas vigentes a la vez', async () => {
    const a = await taxRuleService.createDraft(draft({ rateBps: 1900 }), String(admin._id));
    const b = await taxRuleService.createDraft(draft({ rateBps: 500, validFrom: TOMORROW() }), String(admin._id));
    await Promise.allSettled([
      taxRuleService.validate(String(a._id), String(admin._id), { validationRef: REF }),
      taxRuleService.validate(String(b._id), String(admin._id), { validationRef: REF }),
    ]);
    const at = new Date(TOMORROW().getTime() + 1000);
    const live = await TaxRule.find({ concept: TaxConcept.DELIVERY, status: 'validated', validFrom: { $lte: at }, $or: [{ validTo: null }, { validTo: { $gt: at } }] });
    expect(live.length).toBeLessThanOrEqual(1);
  });
});

describe('El cálculo, igual en todas partes', () => {
  it('pendiente: sin regla no se inventa ninguna tarifa', async () => {
    for (const concept of Object.values(TaxConcept)) {
      expect(await taxRuleService.assess(concept, 100_000)).toMatchObject({ status: 'pending', taxAmount: 0 });
    }
  });

  it('gravado encima: el impuesto se suma al importe', async () => {
    await validated({ rateBps: 1900 });
    expect(await taxRuleService.assess(TaxConcept.DELIVERY, 10_000)).toMatchObject({ status: 'definitive', rateBps: 1900, taxAmount: 1900, priceIncludesTax: false });
  });

  it('gravado incluido: se extrae lo que ya iba dentro del precio', async () => {
    await validated({ concept: TaxConcept.ADVERTISING, rateBps: 1900, priceIncludesTax: true });
    expect((await taxRuleService.assess(TaxConcept.ADVERTISING, 11_900)).taxAmount).toBe(1_900);
    expect((await taxRuleService.assess(TaxConcept.ADVERTISING, 100_000)).taxAmount).toBe(15_966);
  });

  it('exento o excluido: tarifa 0, pero con regla (no es «pendiente»)', async () => {
    await validated({ concept: TaxConcept.PRODUCTS, treatment: TaxTreatment.EXCLUDED, rateBps: null });
    expect(await taxRuleService.assess(TaxConcept.PRODUCTS, 50_000)).toMatchObject({ status: 'definitive', taxAmount: 0, treatment: 'excluded' });
  });

  it('cada concepto tiene la suya: la comisión no hereda la del domicilio', async () => {
    await validated({ concept: TaxConcept.DELIVERY, rateBps: 1900 });
    expect((await taxRuleService.assess(TaxConcept.COMMISSION, 10_000)).status).toBe('pending');
  });

  it('computeCheckoutTax: con reglas, base y tarifa por concepto; sin ellas, la tasa global', () => {
    const rules = computeCheckoutTax({
      plan: {
        mode: 'rules', status: 'definitive', missing: [],
        rates: {
          products: { bps: 0, base: 'net_of_discounts', ruleId: 'a' },
          delivery: { bps: 1900, base: 'gross', ruleId: 'b' },
          service_fee: { bps: 1900, base: 'net_of_discounts', ruleId: 'c' },
        },
      },
      legacyBps: 800,
      net: { products: 30_000, delivery: 0, service_fee: 1_000 },
      gross: { products: 32_000, delivery: 4_000, service_fee: 1_500 },
    });
    // domicilio sobre el bruto (4.000 × 19 %) + tarifa sobre lo que paga (1.000 × 19 %)
    expect(rules.taxPayable).toBe(760 + 190);
    expect(rules.status).toBe('definitive');
    expect(rules.lines).toHaveLength(3);

    const legacy = computeCheckoutTax({ legacyBps: 800, net: { products: 30_000, delivery: 4_000, service_fee: 1_000 }, gross: { products: 30_000, delivery: 4_000, service_fee: 1_000 } });
    expect(legacy).toMatchObject({ taxPayable: 2_800, status: 'legacy', lines: [] });
  });
});

describe('El checkout con reglas por concepto', () => {
  let client: any;
  let business: any;
  let product: any;

  const quote = () => pricingService.quote({
    userId: client._id.toString(),
    businessId: business._id.toString(),
    items: [{ productId: product._id.toString(), quantity: 1 }],
    paymentMethod: PaymentMethod.ONLINE,
    deliveryLatitude: GARZON.lat,
    deliveryLongitude: GARZON.lng,
    suggest: false,
  } as never);

  const placeOrder = () => orderService.create({
    clientId: client._id.toString(),
    businessId: business._id.toString(),
    items: [{ productId: product._id.toString(), quantity: 1 }],
    paymentMethod: PaymentMethod.ONLINE,
    deliveryAddress: 'Calle 5 # 3-21',
    deliveryLatitude: GARZON.lat,
    deliveryLongitude: GARZON.lng,
  } as never);

  const enable = (reason = 'Reglas validadas por contabilidad') =>
    pricingConfigService.update({ taxRulesEnabled: true }, { userId: String(admin._id), reason });

  beforeEach(async () => {
    await makePricingConfig({ taxBps: 800, serviceFeeFixed: 1000, serviceFeeMax: 10_000 });
    client = await makeUser({ role: UserRole.CLIENT });
    const owner = await makeUser({ role: UserRole.BUSINESS });
    business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
    product = await makeProduct(business._id, { price: 30_000 });
  });

  const allThree = async () => {
    await validated({ concept: TaxConcept.PRODUCTS, treatment: TaxTreatment.EXEMPT, rateBps: null });
    await validated({ concept: TaxConcept.DELIVERY, rateBps: 1900 });
    await validated({ concept: TaxConcept.SERVICE_FEE, rateBps: 1900 });
  };

  it('apagadas (de fábrica): la tasa global de siempre, marcada como no validada', async () => {
    const q = await quote();
    expect(q.taxStatus).toBe('legacy');
    expect(q.taxBreakdown).toEqual([]);
    expect(q.taxPayable).toBe(Math.round((30_000 + q.deliveryPayable + q.customerServiceFee) * 0.08));
  });

  it('no se pueden encender sin los tres conceptos validados y vigentes hoy', async () => {
    await expect(enable()).rejects.toMatchObject({ code: 'TAX_RULES_INCOMPLETE' });
    await validated({ concept: TaxConcept.PRODUCTS, treatment: TaxTreatment.EXEMPT, rateBps: null });
    await expect(enable()).rejects.toMatchObject({ code: 'TAX_RULES_INCOMPLETE' });
    expect((await pricingConfigService.getCurrent()).taxRulesEnabled).toBe(false);
  });

  it('encendidas: cada concepto con su tarifa y base; la tasa global ya no manda', async () => {
    await allThree();
    await enable();
    const q = await quote();

    expect(q.taxStatus).toBe('definitive');
    expect(q.taxBreakdown).toHaveLength(3);
    const byConcept = Object.fromEntries(q.taxBreakdown!.map((l) => [l.concept, l]));
    expect(byConcept.products).toMatchObject({ rateBps: 0, amount: 0 });
    expect(byConcept.delivery.amount).toBe(Math.round(q.deliveryPayable * 0.19));
    expect(byConcept.service_fee.amount).toBe(Math.round(q.customerServiceFee * 0.19));
    expect(q.taxPayable).toBe(byConcept.delivery.amount + byConcept.service_fee.amount);
    // La tasa global del 8 % sobre los productos NO se aplicó.
    expect(q.taxPayable).toBeLessThan(Math.round(30_000 * 0.08));
    // El libro cuadra con el impuesto por concepto.
    expect(q.customerTotal + q.platformFundedDiscount).toBe(q.businessPayout + q.driverPayout + q.platformGrossRevenue + q.taxPayable);
  });

  it('el pedido guarda con qué regla se calculó y un cambio posterior no lo toca', async () => {
    await allThree();
    await enable();
    const order = await placeOrder();
    expect(order.finance.taxStatus).toBe('definitive');
    expect(order.finance.taxBreakdown).toHaveLength(3);
    const before = JSON.stringify(order.finance.taxBreakdown);

    // Mañana rige otra tarifa de domicilio.
    await validated({ concept: TaxConcept.DELIVERY, rateBps: 500, validFrom: TOMORROW() });
    expect(JSON.stringify((await Order.findById(order._id))!.finance.taxBreakdown)).toBe(before);
  });

  it('encendidas pero sin regla vigente: el pedido se vende con la tasa global y queda «provisional»', async () => {
    await allThree();
    await enable();
    // La regla del domicilio vence y no hay sucesora.
    await TaxRule.updateOne({ concept: TaxConcept.DELIVERY, status: 'validated' }, { $set: { validTo: new Date(Date.now() - 1000) } });
    const q = await quote();
    expect(q.taxStatus).toBe('provisional');
    expect(q.taxPayable).toBe(Math.round((30_000 + q.deliveryPayable + q.customerServiceFee) * 0.08));
  });

  it('un reembolso total devuelve el impuesto cobrado, concepto por concepto, y el libro cuadra', async () => {
    await allThree();
    await enable();
    const order = await placeOrder();
    const refund = await refundService.issue({ orderId: order._id.toString(), reason: 'Reclamo', kind: RefundKind.FULL });
    expect(refund.allocation.fromTax).toBe(order.finance.taxPayable);
    expect(order.finance.taxPayable).toBe(order.finance.taxBreakdown!.reduce((sum, l) => sum + l.amount, 0));
  });
});

describe('Publicidad: el impuesto se informa, no cambia el cobro', () => {
  const closeCampaign = async () => {
    const ad = await Advertisement.create({
      campaignName: 'Promo', advertiserName: 'Tienda',
      flyerUrl: 'https://res.cloudinary.com/demo/image/upload/v1/ads/x.jpg',
      startDate: new Date(Date.now() - DAY), endDate: new Date(Date.now() + DAY),
      pricingModel: AdPricingModel.CPC, cpcRate: 500, budget: 100_000, clickCount: 20,
      approvalStatus: AdApprovalStatus.APPROVED, isActive: true,
    });
    return advertisementService.closeAndInvoice(String(ad._id));
  };

  it('sin regla validada: pendiente, y el importe es el de siempre', async () => {
    const invoice = await closeCampaign();
    expect(invoice.amount).toBe(10_000);
    expect(invoice.taxAssessment).toMatchObject({ status: 'pending', taxIncluded: 0 });
  });

  it('con regla incluida en el precio: informa cuánto es impuesto y NO cambia lo que se cobra', async () => {
    await validated({ concept: TaxConcept.ADVERTISING, rateBps: 1900, priceIncludesTax: true });
    const invoice = await closeCampaign();
    expect(invoice.amount).toBe(10_000);
    expect(invoice.taxAssessment).toMatchObject({ status: 'definitive', rateBps: 1900, taxIncluded: 1_597 });
    expect((await AdInvoice.findById(invoice._id))!.amount).toBe(10_000);
  });
});

describe('Administración: permisos y auditoría', () => {
  const body = { concept: 'delivery', treatment: 'taxed', rateBps: 1900, validFrom: new Date().toISOString() };

  it('ver es finance:view; escribir y validar, finance:manage', async () => {
    // Cada papel con sus permisos exactos (un papel por usuario: comparten la fila del rol).
    const viewer = await makeStaff({ roleSlug: 'soporte', permissions: [Permission.FINANCE_VIEW] });
    const manager = await makeStaff({ roleSlug: 'finanzas', permissions: [Permission.FINANCE_VIEW, Permission.FINANCE_MANAGE] });
    const outsider = await makeStaff({ roleSlug: 'operaciones', permissions: [Permission.SUPPORT_VIEW] });

    expect((await request(app).get(`${API}/finance/tax-rules`).set(await authHeader(viewer))).status).toBe(200);
    expect((await request(app).get(`${API}/finance/tax-rules`).set(await authHeader(outsider))).status).toBe(403);
    expect((await request(app).post(`${API}/finance/tax-rules`).set(await authHeader(viewer)).send(body)).status).toBe(403);

    const created = await request(app).post(`${API}/finance/tax-rules`).set(await authHeader(manager)).send(body);
    expect(created.status).toBe(201);
    const id = created.body.data._id;

    expect((await request(app).post(`${API}/finance/tax-rules/${id}/validate`).set(await authHeader(viewer)).send({ validationRef: REF })).status).toBe(403);
    expect((await request(app).post(`${API}/finance/tax-rules/${id}/validate`).set(await authHeader(manager)).send({ validationRef: 'ok' })).status).toBe(400);
    const ok = await request(app).post(`${API}/finance/tax-rules/${id}/validate`).set(await authHeader(manager)).send({ validationRef: REF });
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe('validated');

    await new Promise((r) => setTimeout(r, 60));
    const audit = await AuditLog.findOne({ action: AuditAction.TAX_RULE_VALIDATED, entityId: id }).lean();
    expect(audit?.metadata?.validationRef).toBe(REF);
  });

  it('la tarifa no puede salirse del rango ni quedar sin documento', async () => {
    const manager = await makeStaff({ roleSlug: 'finanzas', permissions: [Permission.FINANCE_VIEW, Permission.FINANCE_MANAGE] });
    expect((await request(app).post(`${API}/finance/tax-rules`).set(await authHeader(manager)).send({ ...body, rateBps: 20_000 })).status).toBe(400);
    expect((await request(app).post(`${API}/finance/tax-rules`).set(await authHeader(manager)).send({ ...body, tarifaInventada: 1 })).status).toBe(400);
  });

  it('el informe de pendientes dice qué falta, qué no está integrado y que no hay facturación electrónica', async () => {
    await makePricingConfig({});
    const viewer = await makeStaff({ roleSlug: 'soporte', permissions: [Permission.FINANCE_VIEW] });
    const res = await request(app).get(`${API}/finance/config/readiness`).set(await authHeader(viewer));
    expect(res.status).toBe(200);
    const { tax, gateway } = res.body.data;

    expect(tax.mode).toBe('legacy');
    expect(tax.definitive).toBe(false);
    expect(tax.blockers.sort()).toEqual(['delivery', 'products', 'service_fee']);
    expect(tax.concepts).toHaveLength(7);
    expect(tax.concepts.every((c: any) => c.state === 'missing' && c.pending.length > 0)).toBe(true);
    expect(tax.electronicInvoicing.integrated).toBe(false);

    expect(gateway.verified).toBe(false);
    expect(gateway.methodsWithoutTariff).toEqual(['card', 'pse', 'nequi', 'other']);
    expect(gateway.complete).toBe(false);
  });
});
