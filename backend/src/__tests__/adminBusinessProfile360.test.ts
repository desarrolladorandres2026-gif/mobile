import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { Business, BusinessDocument, Pqrs, Review, Coupon, Notification, InternalNote } from '../models';
import { AuditLog, AuditAction } from '../security';
import { Permission } from '../security/rbac';
import { UserRole } from '../types';
import { featureFlagService } from '../services/featureFlag.service';
import { sealForBusiness } from '../services/business.service';
import { cache } from '../cache';
import { BUSINESS_DOCUMENT_TYPES } from '../validators/adminBusiness.validator';
import { makeUser, makeBusiness, makeDriver, makeStaff, authHeader } from './factories';

const API = '/api/v1';
const SECRET_ACCOUNT = 'ENCRYPTED-ACCOUNT-BLOB';

const P = Permission;
const VIEW_ONLY = [P.ADMIN_PANEL, P.BUSINESSES_VIEW];
const EVERYTHING = [
  ...VIEW_ONLY, P.FINANCE_VIEW, P.COMMISSIONS_VIEW, P.ADS_VIEW, P.COUPONS_VIEW, P.REVIEWS_VIEW,
  P.SUPPORT_VIEW, P.USERS_VIEW, P.ADMIN_AUDIT_LOGS, P.BUSINESSES_UPDATE_ALL, P.BUSINESSES_APPROVE,
];

const waitForAudit = async (filter: Record<string, unknown>) => {
  for (let i = 0; i < 40; i++) {
    const found = await AuditLog.findOne(filter).lean();
    if (found) return found;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
};

async function staffWith(slug: 'operaciones' | 'soporte' | 'finanzas' | 'comercios_contenido', permissions: Permission[]) {
  return authHeader(await makeStaff({ roleSlug: slug, permissions }));
}

describe('Ficha 360 del comercio y sus acciones (B5)', () => {
  let owner: any;
  let business: any;

  beforeEach(async () => {
    await featureFlagService.upsert('rbac_enforce', { audience: 'staff' });
    await cache.flush();
    owner = await makeUser({ role: UserRole.BUSINESS, name: 'Dueña Uno' });
    business = await makeBusiness(owner._id);
    await Business.updateOne(
      { _id: business._id },
      {
        $set: {
          legal: {
            documentType: 'NIT',
            documentNumber: sealForBusiness('900123456', business._id),
            dv: '8',
            legalName: 'Razón Social SAS',
            taxRegime: 'simple',
          },
          payoutAccount: {
            method: 'bank',
            bankName: 'Bancolombia',
            accountType: 'ahorros',
            accountNumberEnc: SECRET_ACCOUNT,
            accountLast4: '4321',
            accountNumberHash: 'HASHSECRET',
            holderName: 'Titular',
            holderDocument: 'HOLDERDOC',
            verificationStatus: 'verified',
            version: 1,
          },
        },
      }
    );
    await BusinessDocument.create({
      businessId: business._id, type: 'rut', reference: 'REF-9', status: 'rejected', rejectionReason: 'Borroso',
      fileKey: 'PRIVATE-FILE-KEY', fileFormat: 'pdf',
    });
    await Pqrs.create({ userId: owner._id, type: 'claim', subject: 'Queja del comercio', detail: 'x', businessId: business._id });
    await Coupon.collection.insertOne({ code: 'PROMO1', businessId: business._id, isActive: true, validUntil: new Date(Date.now() + 86_400_000), createdAt: new Date() });
    await InternalNote.create({ entityType: 'business', entityId: business._id, authorId: owner._id, authorName: 'X', body: 'nota' });
  });

  const get = (headers: Record<string, string>) =>
    request(app).get(`${API}/admin/businesses/${business._id}/profile-360`).set(headers);

  it('con todos los permisos entrega las secciones, audita y nunca filtra la cuenta ni URLs', async () => {
    const res = await get(await staffWith('operaciones', EVERYTHING)).expect(200);
    const d = res.body.data;
    expect(d.business).toMatchObject({ name: business.name, isSuspended: false });
    expect(d.business).toHaveProperty('commissionRateBps');
    expect(d.owner).toEqual({ _id: String(owner._id), name: 'Dueña Uno' });
    expect(d.legal).toMatchObject({ legalName: 'Razón Social SAS', nitMasked: '***3456', taxRegime: 'simple', complete: true });
    expect(d.payoutAccount).toMatchObject({ status: 'verified', bankName: 'Bancolombia', last4: '4321' });
    expect(d.documents[0]).toMatchObject({ type: 'rut', status: 'rejected', rejectionReason: 'Borroso' });
    expect(d.menu).toEqual({ products: 0, available: 0 });
    expect(d.ads).toMatchObject({ advertisements: [], invoices: [], outstanding: 0 });
    expect(d.promotions.coupons[0].code).toBe('PROMO1');
    expect(d.promotions.cost30d).toBe(0);
    expect(d.support[0].subject).toBe('Queja del comercio');
    expect(d.notes).toHaveLength(1);
    expect(d.masked).toEqual({ commissions: false, finance: false, sensitive: false });

    const raw = JSON.stringify(res.body);
    for (const leak of [SECRET_ACCOUNT, 'HASHSECRET', 'HOLDERDOC', 'PRIVATE-FILE-KEY', '900123456', 'fileUrl', 'fileKey', 'accountNumber']) {
      expect(raw, leak).not.toContain(leak);
    }
    expect(await waitForAudit({ action: AuditAction.PROFILE_VIEWED, entity: 'business', entityId: String(business._id) })).not.toBeNull();
  });

  it('cada sección se enmascara según el permiso', async () => {
    const res = await get(await staffWith('soporte', VIEW_ONLY)).expect(200);
    const d = res.body.data;
    expect(d.business).not.toHaveProperty('commissionRateBps');
    expect(d.payoutAccount).toBeNull();
    expect(d.ads).toBeNull();
    expect(d.promotions).toBeNull();
    expect(d.reputation).toBeNull();
    expect(d.support).toBeNull();
    expect(d.masked).toEqual({ commissions: true, finance: true, sensitive: true });
    expect(JSON.stringify(d)).not.toContain('4321');
  });

  it('sin finance:view no hay cuenta ni coste de promociones; sin users:view no hay teléfono del equipo', async () => {
    const staffUser = await makeUser({ role: UserRole.CLIENT, phone: '3005550101' });
    await (await import('../models')).BusinessStaff.create({ businessId: business._id, userId: staffUser._id, role: 'staff' });

    const res = await get(await staffWith('comercios_contenido', [...VIEW_ONLY, P.COUPONS_VIEW])).expect(200);
    expect(res.body.data.payoutAccount).toBeNull();
    expect(res.body.data.promotions.cost30d).toBeNull();
    expect(res.body.data.team[0]).not.toHaveProperty('phone');

    const res2 = await get(await staffWith('finanzas', [...VIEW_ONLY, P.USERS_VIEW, P.REVIEWS_VIEW, P.SUPPORT_VIEW])).expect(200);
    expect(res2.body.data.team[0].phone).toBeTruthy();
    expect(res2.body.data.reputation).not.toBeNull();
    expect(res2.body.data.support).toHaveLength(1);
    await Review.deleteMany({});
  });

  it('403 sin businesses:view y con tokens de cliente, comercio y domiciliario; 404 y 400', async () => {
    const url = `${API}/admin/businesses/${business._id}/profile-360`;
    await request(app).get(url).set(await staffWith('soporte', [P.ADMIN_PANEL])).expect(403);
    const client = await makeUser({ role: UserRole.CLIENT });
    const driverUser = await makeUser({ role: UserRole.DRIVER });
    await makeDriver(driverUser._id);
    for (const u of [client, owner, driverUser]) await request(app).get(url).set(await authHeader(u)).expect(403);
    const ok = await staffWith('operaciones', EVERYTHING);
    await request(app).get(`${API}/admin/businesses/64b7f0f0f0f0f0f0f0f0f0f0/profile-360`).set(ok).expect(404);
    await request(app).get(`${API}/admin/businesses/xyz/profile-360`).set(ok).expect(400);
  });

  describe('PATCH /suspension', () => {
    const patch = (headers: Record<string, string>, body: object) =>
      request(app).patch(`${API}/admin/businesses/${business._id}/suspension`).set(headers).send(body);

    it('suspende con motivo, exige motivo, es idempotente y audita una sola vez', async () => {
      const h = await staffWith('operaciones', EVERYTHING);
      await patch(h, { suspended: true }).expect(400);
      await patch(h, { suspended: true, reason: 'abc' }).expect(400);
      const r1 = await patch(h, { suspended: true, reason: 'Incumplimiento grave' }).expect(200);
      expect(r1.body.data).toMatchObject({ isSuspended: true, changed: true });
      const r2 = await patch(h, { suspended: true, reason: 'Incumplimiento grave' }).expect(200);
      expect(r2.body.data.changed).toBe(false);
      expect(await AuditLog.countDocuments({ action: AuditAction.BUSINESS_SUSPENSION_SET, entityId: String(business._id) })).toBe(1);

      const r3 = await patch(h, { suspended: false }).expect(200);
      expect(r3.body.data).toMatchObject({ isSuspended: false, changed: true });
      const fresh = await Business.findById(business._id).lean();
      expect(fresh!.suspensionReason).toBeNull();
      expect(await AuditLog.countDocuments({ action: AuditAction.BUSINESS_SUSPENSION_SET })).toBe(2);
    });

    it('dos peticiones simultáneas producen un solo cambio y una auditoría', async () => {
      const h = await staffWith('operaciones', EVERYTHING);
      const rs = await Promise.all([
        patch(h, { suspended: true, reason: 'Fraude confirmado' }),
        patch(h, { suspended: true, reason: 'Fraude confirmado' }),
      ]);
      expect(rs.map((r) => r.status)).toEqual([200, 200]);
      expect(rs.filter((r) => r.body.data.changed).length).toBe(1);
      expect(await AuditLog.countDocuments({ action: AuditAction.BUSINESS_SUSPENSION_SET, entityId: String(business._id) })).toBe(1);
    });

    it('403 sin businesses:update_all y con otros roles; 404', async () => {
      await patch(await staffWith('soporte', VIEW_ONLY), { suspended: false }).expect(403);
      for (const u of [await makeUser({ role: UserRole.CLIENT }), owner]) {
        await patch(await authHeader(u), { suspended: false }).expect(403);
      }
      await request(app).patch(`${API}/admin/businesses/64b7f0f0f0f0f0f0f0f0f0f0/suspension`)
        .set(await staffWith('operaciones', EVERYTHING)).send({ suspended: false }).expect(404);
    });
  });

  describe('POST /request-documents', () => {
    const post = (headers: Record<string, string>, body: object) =>
      request(app).post(`${API}/admin/businesses/${business._id}/request-documents`).set(headers).send(body);

    it('valida tipos, notifica al dueño, audita, no toca documentos y limita a una por hora', async () => {
      const h = await staffWith('operaciones', EVERYTHING);
      await post(h, { types: [] }).expect(400);
      await post(h, { types: ['pasaporte'] }).expect(400);

      await post(h, { types: ['rut', 'bank_certificate'], message: 'Por favor, hoy' }).expect(200);
      const note = await Notification.findOne({ userId: owner._id }).lean();
      expect(note?.body).toContain('RUT');
      expect(note?.body).toContain('Por favor, hoy');
      expect(await waitForAudit({ action: AuditAction.BUSINESS_DOCUMENTS_REQUESTED, entityId: String(business._id) })).not.toBeNull();
      expect((await BusinessDocument.findOne({ businessId: business._id }).lean())!.status).toBe('rejected');

      await post(h, { types: ['rut'] }).expect(429);
      expect(await Notification.countDocuments({ userId: owner._id })).toBe(1);
    });

    it('403 sin businesses:approve y con otros roles', async () => {
      await post(await staffWith('soporte', VIEW_ONLY), { types: ['rut'] }).expect(403);
      for (const u of [await makeUser({ role: UserRole.CLIENT }), owner]) {
        await post(await authHeader(u), { types: ['rut'] }).expect(403);
      }
    });

    it('los tipos del validador coinciden con el enum del modelo', () => {
      const modelEnum = (BusinessDocument.schema.path('type') as any).options.enum as string[];
      expect([...BUSINESS_DOCUMENT_TYPES].sort()).toEqual([...modelEnum].sort());
    });
  });

  describe('H7: GET /businesses/:id/documents', () => {
    const url = () => `${API}/businesses/${business._id}/documents`;

    it('admin sin businesses:approve 403; con él, 200', async () => {
      await request(app).get(url()).set(await staffWith('soporte', VIEW_ONLY)).expect(403);
      await request(app).get(url()).set(await staffWith('operaciones', EVERYTHING)).expect(200);
    });

    it('el dueño y su staff siguen viendo sus documentos', async () => {
      await request(app).get(url()).set(await authHeader(owner)).expect(200);
    });
  });
});
