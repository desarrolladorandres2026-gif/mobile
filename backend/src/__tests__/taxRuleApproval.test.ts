import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { TaxRule, TaxConcept, TaxTreatment } from '../models';
import { AuditLog, AuditAction } from '../security';
import { Permission } from '../security/rbac';
import { UserRole } from '../types';
import { taxRuleService } from '../services/taxRule.service';
import { pricingConfigService } from '../services/pricingConfig.service';
import { featureFlagService } from '../services/featureFlag.service';
import { cache } from '../cache';
import { makeUser, makePricingConfig, makeStaff, authHeader } from './factories';

/**
 * Auditoría 2026-10-19 · doble aprobación de reglas tributarias.
 *
 * Una persona propone (crea o edita el borrador) y OTRA aprueba, con un permiso
 * propio (`tax:approve`) distinto del de configurar (`finance:manage`). Las cifras
 * de estas pruebas son de ejemplo para ejercitar el flujo; no son tarifas de ZIPP.
 */

const API = '/api/v1';
const DAY = 86_400_000;
const REF = 'Concepto contable 2026-10-20 (ejemplo de prueba)';
const draft = (over: Record<string, unknown> = {}) =>
  ({ concept: TaxConcept.DELIVERY, treatment: TaxTreatment.TAXED, rateBps: 1900, validFrom: new Date(), ...over }) as never;

let a: any; let b: any; let c: any;
beforeEach(async () => {
  await featureFlagService.upsert('rbac_enforce', { audience: 'staff' });
  await cache.flush();
  a = await makeUser({ role: UserRole.ADMIN });
  b = await makeUser({ role: UserRole.ADMIN });
  c = await makeUser({ role: UserRole.ADMIN });
});

describe('Nadie aprueba lo suyo', () => {
  it('quien propuso no puede aprobar: ni con permiso ni por servicio', async () => {
    const rule = await taxRuleService.createDraft(draft(), String(a._id));
    await expect(taxRuleService.validate(String(rule._id), String(a._id), { validationRef: REF }))
      .rejects.toMatchObject({ statusCode: 403, code: 'TAX_RULE_SELF_APPROVAL' });
    expect((await TaxRule.findById(rule._id))!.status).toBe('draft');
    // Otra persona sí.
    const ok = await taxRuleService.validate(String(rule._id), String(b._id), { validationRef: REF });
    expect(ok.status).toBe('validated');
    expect(String(ok.createdBy)).toBe(String(a._id));
    expect(String(ok.validatedBy)).toBe(String(b._id));
    expect(ok.validatedAt).toBeInstanceOf(Date);
  });

  it('quien editó el borrador tampoco: la regla que se aprueba no la escribió quien la aprueba', async () => {
    const rule = await taxRuleService.createDraft(draft({ rateBps: 1900 }), String(a._id));
    await taxRuleService.updateDraft(String(rule._id), { rateBps: 500 }, String(b._id));

    await expect(taxRuleService.validate(String(rule._id), String(a._id), { validationRef: REF })).rejects.toMatchObject({ code: 'TAX_RULE_SELF_APPROVAL' });
    await expect(taxRuleService.validate(String(rule._id), String(b._id), { validationRef: REF })).rejects.toMatchObject({ code: 'TAX_RULE_SELF_APPROVAL' });
    const ok = await taxRuleService.validate(String(rule._id), String(c._id), { validationRef: REF });
    expect(ok.rateBps).toBe(500);
  });

  it('configurar no es aprobar: finance:manage no basta, hace falta tax:approve', async () => {
    const manager = await makeStaff({ roleSlug: 'finanzas' });
    const superAdmin = await makeStaff({ roleSlug: 'super_admin' });
    const body = { concept: 'delivery', treatment: 'taxed', rateBps: 1900, validFrom: new Date().toISOString() };

    const created = await request(app).post(`${API}/finance/tax-rules`).set(await authHeader(manager)).send(body);
    expect(created.status).toBe(201);
    const id = created.body.data._id;

    expect((await request(app).post(`${API}/finance/tax-rules/${id}/validate`).set(await authHeader(manager)).send({ validationRef: REF })).status).toBe(403);
    // El super administrador tiene el permiso, y es otra persona.
    const ok = await request(app).post(`${API}/finance/tax-rules/${id}/validate`).set(await authHeader(superAdmin)).send({ validationRef: REF });
    expect(ok.status).toBe(200);
  });

  it('el super administrador tampoco aprueba lo que él mismo propuso', async () => {
    const superAdmin = await makeStaff({ roleSlug: 'super_admin' });
    const created = await request(app).post(`${API}/finance/tax-rules`).set(await authHeader(superAdmin))
      .send({ concept: 'delivery', treatment: 'taxed', rateBps: 1900, validFrom: new Date().toISOString() });
    const res = await request(app).post(`${API}/finance/tax-rules/${created.body.data._id}/validate`).set(await authHeader(superAdmin)).send({ validationRef: REF });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TAX_RULE_SELF_APPROVAL');
  });
});

describe('Trazabilidad y vigencia', () => {
  it('queda quién propuso, quién aprobó, cuándo, los valores anteriores, los nuevos y desde cuándo rige', async () => {
    const first = await taxRuleService.createDraft(draft({ rateBps: 1900 }), String(a._id));
    const firstOk = await taxRuleService.validate(String(first._id), String(b._id), { validationRef: REF });

    const tomorrow = new Date(Date.now() + DAY);
    const next = await taxRuleService.createDraft(draft({ rateBps: 500, validFrom: tomorrow }), String(a._id));
    const nextOk = await taxRuleService.validate(String(next._id), String(b._id), { validationRef: `${REF} bis` });

    expect(String(nextOk.supersedes)).toBe(String(firstOk._id));
    expect(nextOk.previousValues).toMatchObject({ treatment: 'taxed', rateBps: 1900, base: 'net_of_discounts', validationRef: REF });
    expect(nextOk.validFrom.getTime()).toBe(tomorrow.getTime());
    expect(nextOk.proposedValidFrom ?? null).toBeNull();
    // La anterior termina justo donde empieza esta.
    expect((await TaxRule.findById(first._id))!.validTo!.getTime()).toBe(tomorrow.getTime());
  });

  it('no retroactivo ni dentro del mismo día: si la fecha pedida ya pasó hoy, rige desde la aprobación y queda lo que se pidió', async () => {
    const COLOMBIA_OFFSET_MS = 5 * 3_600_000;
    const startOfToday = new Date(Math.floor((Date.now() - COLOMBIA_OFFSET_MS) / DAY) * DAY + COLOMBIA_OFFSET_MS);
    const rule = await taxRuleService.createDraft(draft({ validFrom: startOfToday }), String(a._id));

    const before = Date.now();
    const ok = await taxRuleService.validate(String(rule._id), String(b._id), { validationRef: REF });
    expect(ok.validFrom.getTime()).toBeGreaterThanOrEqual(before);
    expect(ok.proposedValidFrom!.getTime()).toBe(startOfToday.getTime());
    // Un cálculo sobre un instante anterior a la aprobación sigue sin regla: lo cobrado antes no se reinterpreta.
    expect(await taxRuleService.resolve(TaxConcept.DELIVERY, new Date(before - 60_000))).toBeNull();
    expect((await taxRuleService.assess(TaxConcept.DELIVERY, 10_000, new Date(before - 60_000))).status).toBe('pending');
    expect((await taxRuleService.assess(TaxConcept.DELIVERY, 10_000, new Date(Date.now() + 1000))).status).toBe('definitive');
  });

  it('la auditoría guarda proponente, aprobador, valores previos y nuevos, y vigencia', async () => {
    const manager = await makeStaff({ roleSlug: 'finanzas' });
    const approver = await makeStaff({ roleSlug: 'super_admin' });
    const body = { concept: 'service_fee', treatment: 'taxed', rateBps: 1900, validFrom: new Date().toISOString() };
    const id = (await request(app).post(`${API}/finance/tax-rules`).set(await authHeader(manager)).send(body)).body.data._id;
    await request(app).post(`${API}/finance/tax-rules/${id}/validate`).set(await authHeader(approver)).send({ validationRef: REF }).expect(200);

    await new Promise((r) => setTimeout(r, 60));
    const audit = await AuditLog.findOne({ action: AuditAction.TAX_RULE_VALIDATED, entityId: id }).lean();
    expect(audit?.metadata).toMatchObject({
      concept: 'service_fee', proposedBy: String(manager._id), approvedBy: String(approver._id),
      previous: null, new: { treatment: 'taxed', rateBps: 1900 }, validationRef: REF,
    });
    expect(audit?.metadata?.effectiveFrom).toBeTruthy();
    expect(audit?.metadata?.approvedAt).toBeTruthy();
  });

  it('sin regla aprobada el concepto sigue pendiente: un borrador, aunque lo haya escrito el contador, no calcula nada', async () => {
    await taxRuleService.createDraft(draft(), String(a._id));
    expect(await taxRuleService.assess(TaxConcept.DELIVERY, 100_000)).toMatchObject({ status: 'pending', taxAmount: 0, ruleId: null });
  });
});

describe('La tasa global y el interruptor de reglas también son de quien aprueba', () => {
  const put = async (user: any, body: Record<string, unknown>) =>
    request(app).put(`${API}/finance/config`).set(await authHeader(user)).send({ reason: 'Prueba de permisos tributarios', ...body });

  it('finance:manage cambia precios pero no la tasa global; tax:approve sí', async () => {
    await makePricingConfig();
    const manager = await makeStaff({ roleSlug: 'finanzas' });
    const approver = await makeStaff({ roleSlug: 'super_admin' });

    const blocked = await put(manager, { taxBps: 500 });
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('TAX_APPROVAL_REQUIRED');
    expect((await pricingConfigService.getCurrent()).taxBps).not.toBe(500);

    // Otro cambio de precios, sin tocar lo tributario, pasa.
    const fee = await put(manager, { serviceFeeFixed: 1234 });
    expect(fee.status).toBe(200);

    // Reenviar el mismo valor de la tasa (el panel manda el borrador completo) no es cambiarla.
    const same = await put(manager, { serviceFeeFixed: 1300, taxBps: (await pricingConfigService.getCurrent()).taxBps });
    expect(same.status).toBe(200);

    expect((await put(approver, { taxBps: 500 })).status).toBe(200);
    expect((await pricingConfigService.getCurrent()).taxBps).toBe(500);
  });

  it('encender las reglas sin los tres conceptos aprobados sigue rechazándose, también para quien aprueba', async () => {
    await makePricingConfig();
    const approver = await makeStaff({ roleSlug: 'super_admin' });
    const res = await put(approver, { taxRulesEnabled: true });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('TAX_RULES_INCOMPLETE');
  });
});
