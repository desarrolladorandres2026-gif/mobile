import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { Types } from 'mongoose';
import { Writable } from 'stream';
import { featureFlagService } from '../services/featureFlag.service';
import { cache } from '../cache';
import app from '../app';
import { cloudinary } from '../config';
import {
  Business,
  BusinessDocument,
  BusinessStaff,
  Notification,
  Payout,
  Settlement,
  Zone,
} from '../models';
import { AuditLog, encrypt, decrypt } from '../security';
import { PayoutBeneficiary, PayoutStatus, UserRole } from '../types';
import { businessService, openForBusiness, businessAad } from '../services/business.service';
import { payoutService } from '../services/payout.service';
import { migratePayoutAccountHardening } from '../migrations/018-payout-account-hardening';
import { pdfHasActiveContent } from '../services/privateStorage.service';
import {
  makeUser,
  makeBusiness,
  authHeader,
  GARZON,
  approveBusinessDocument,
  provisionVerifiedAccount,
  attachTestFile,
  reviewDoc,
} from './factories';

/**
 * Revisión de seguridad del flujo fiscal (2026-09-24): un grupo por hallazgo,
 * con el orden de la revisión (1 crítico → 12 bajo).
 */

const PWD = 'Clave.Segura123';
const RECEIPT = 'https://example.com/comprobante.jpg';
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0, 0, 0, 13]),
  Buffer.from('IHDR'),
  Buffer.from([0, 0, 0, 10, 0, 0, 0, 10, 8, 6, 0, 0, 0]),
  Buffer.alloc(12),
]);

beforeAll(() => {
  cloudinary.config({ cloud_name: 'demo', api_key: 'key', api_secret: 'secret' });
  vi.spyOn(cloudinary.uploader, 'upload_stream').mockImplementation(((options: any, cb: any) => {
    const id = `${options.public_id ?? `${options.folder}/file`}-${Math.random().toString(36).slice(2)}`;
    return new Writable({
      write(_chunk, _enc, next) { next(); },
      final(done) { cb(null, { public_id: id }); done(); },
    });
  }) as any);
});
afterAll(() => vi.restoreAllMocks());

const bankBody = (overrides: Record<string, unknown> = {}): any => ({
  method: 'bank',
  bankName: 'Bancolombia',
  accountType: 'ahorros',
  accountNumber: '12345678901',
  holderName: 'Negocio SAS',
  holderDocument: '900123456',
  currentPassword: PWD,
  ...overrides,
});

/** Un comercio aprobado con cuenta verificada y una liquidación pagable. */
async function merchantWithPayable(amount = 10_000) {
  const owner = await makeUser({ role: UserRole.BUSINESS });
  const finance = await makeUser({ role: UserRole.ADMIN, isFinanceAdmin: true });
  const admin = await makeUser({ role: UserRole.ADMIN });
  const business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng, withPayoutAccount: false });
  await provisionVerifiedAccount(business, String(owner._id), String(admin._id));
  await Payout.create({
    orderId: new Types.ObjectId(),
    beneficiary: PayoutBeneficiary.BUSINESS,
    businessId: business._id,
    amount,
    status: PayoutStatus.PAYABLE,
    currency: 'COP',
    pricingConfigVersion: 1,
    becamePayableAt: new Date(),
  });
  return { owner, finance, admin, business, id: String(business._id) };
}

const settleReq = (finance: any, businessId: string) =>
  (async () =>
    request(app).post('/api/v1/finance/settlements').set(await authHeader(finance)).send({ beneficiary: 'business', businessId }))();

const payReq = (finance: any, settlementId: string) =>
  (async () =>
    request(app)
      .post(`/api/v1/finance/settlements/${settlementId}/payment`)
      .set(await authHeader(finance))
      .send({ method: 'bank_transfer', reference: 'TRX-0001', receiptUrl: RECEIPT }))();

/** Cambia la cuenta como lo haría el dueño y deja la nueva verificada. */
async function changeAndVerify(ctx: Awaited<ReturnType<typeof merchantWithPayable>>, accountNumber: string) {
  const res = await request(app)
    .put(`/api/v1/businesses/${ctx.id}/payout-account`)
    .set(await authHeader(ctx.owner))
    .send(bankBody({ accountNumber }))
    .expect(200);
  await approveBusinessDocument(ctx.id, 'bank_certificate', String(ctx.admin._id));
  await businessService.verifyPayoutAccount(ctx.id, String(ctx.finance._id), res.body.data.version);
  return res.body.data.version as number;
}

describe('1 · liquidar y pagar solo a la cuenta verificada (CRÍTICO)', () => {
  it('sin cuenta o con cuenta pendiente, settle responde 422 y no toca los payouts', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const finance = await makeUser({ role: UserRole.ADMIN, isFinanceAdmin: true });
    const business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng, withPayoutAccount: false });
    await Payout.create({
      orderId: new Types.ObjectId(), beneficiary: PayoutBeneficiary.BUSINESS, businessId: business._id,
      amount: 5_000, status: PayoutStatus.PAYABLE, currency: 'COP', pricingConfigVersion: 1, becamePayableAt: new Date(),
    });

    const none = await settleReq(finance, String(business._id));
    expect(none.status).toBe(422);
    expect(none.body.code ?? none.body.error?.code).toBe('PAYOUT_ACCOUNT_NOT_VERIFIED');

    await businessService.setPayoutAccount(String(business._id), bankBody(), String(owner._id), { asOwner: true });
    const pending = await settleReq(finance, String(business._id));
    expect(pending.status).toBe(422);

    const payout = await Payout.findOne({ businessId: business._id });
    expect(payout!.status).toBe(PayoutStatus.PAYABLE);
    expect(payout!.settlementId).toBeNull();
    expect(await Settlement.countDocuments({ businessId: business._id })).toBe(0);
  });

  it('guarda la foto de la cuenta con su versión y no la filtra en el listado', async () => {
    const ctx = await merchantWithPayable();
    const res = await settleReq(ctx.finance, ctx.id);
    expect(res.status).toBe(201);
    const settlementId = res.body.data.settlement._id;
    expect(JSON.stringify(res.body)).not.toContain('12345678901');

    const stored = await Settlement.findById(settlementId).select('+payoutAccount').lean();
    expect(stored!.payoutAccount).toMatchObject({ version: 1, method: 'bank', accountLast4: '8901' });
    expect(stored!.payoutAccount!.accountNumberEnc).toMatch(/^v3:/);
    expect(JSON.stringify(stored)).not.toContain('12345678901');

    const list = await request(app).get('/api/v1/finance/settlements').set(await authHeader(ctx.finance)).expect(200);
    expect(JSON.stringify(list.body)).not.toMatch(/payoutAccount|accountNumber/);
  });

  it('si la cuenta cambia mientras se liquida, 409 y se suelta el reclamo', async () => {
    const ctx = await merchantWithPayable();
    const original = businessService.snapshotVerifiedPayoutAccount.bind(businessService);
    const spy = vi.spyOn(businessService, 'snapshotVerifiedPayoutAccount').mockImplementation(async (id: string) => {
      const snapshot = await original(id);
      // El atacante (con la sesión del dueño) cambia la cuenta justo después de la foto.
      await Business.updateOne(
        { _id: id },
        { $set: { 'payoutAccount.verificationStatus': 'pendingVerification' }, $inc: { 'payoutAccount.version': 1 } }
      );
      return snapshot;
    });

    try {
      const res = await settleReq(ctx.finance, ctx.id);
      expect(res.status).toBe(409);
      expect(res.body.code ?? res.body.error?.code).toBe('PAYOUT_ACCOUNT_CHANGED');
    } finally {
      spy.mockRestore();
    }

    const payout = await Payout.findOne({ businessId: ctx.business._id });
    expect(payout!.status).toBe(PayoutStatus.PAYABLE);
    expect(payout!.settlementId).toBeNull();
    expect(await Settlement.countDocuments({ businessId: ctx.business._id })).toBe(0);
  });

  it('dos liquidaciones simultáneas del mismo comercio crean una sola', async () => {
    const ctx = await merchantWithPayable();
    const results = await Promise.allSettled([
      payoutService.settle({ beneficiary: PayoutBeneficiary.BUSINESS, businessId: ctx.id, createdBy: String(ctx.finance._id) }),
      payoutService.settle({ beneficiary: PayoutBeneficiary.BUSINESS, businessId: ctx.id, createdBy: String(ctx.finance._id) }),
    ]);
    const created = results.filter((r) => r.status === 'fulfilled' && r.value.settlement).length;
    expect(created).toBe(1);
    expect(await Settlement.countDocuments({ businessId: ctx.business._id })).toBe(1);
  });

  it('registrar el pago tras un cambio de cuenta da 409; se paga tras verificar y refrescar', async () => {
    const ctx = await merchantWithPayable();
    const settled = await settleReq(ctx.finance, ctx.id);
    const settlementId = settled.body.data.settlement._id;

    // El viernes el atacante cambia la cuenta; finanzas ya había liquidado.
    await request(app).put(`/api/v1/businesses/${ctx.id}/payout-account`).set(await authHeader(ctx.owner))
      .send(bankBody({ accountNumber: '99999999999' })).expect(200);

    const blocked = await payReq(ctx.finance, settlementId);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code ?? blocked.body.error?.code).toBe('PAYOUT_ACCOUNT_CHANGED');
    expect((await Settlement.findById(settlementId))!.paymentStatus).toBe('pending');

    // La pantalla de pago sigue mostrando la cuenta ORIGINAL y avisa del cambio.
    const reveal = await request(app).get(`/api/v1/finance/settlements/${settlementId}/payout-account`)
      .set(await authHeader(ctx.finance)).expect(200);
    expect(reveal.body.data).toMatchObject({ accountNumber: '12345678901', holderDocument: '900123456', changedSinceSettlement: true });
    expect(JSON.stringify(reveal.body)).not.toContain('99999999999');

    // La cuenta nueva se verifica (con certificado) y finanzas refresca la foto.
    await approveBusinessDocument(ctx.id, 'bank_certificate', String(ctx.admin._id));
    const current = await Business.findById(ctx.id).select('+payoutAccount');
    await businessService.verifyPayoutAccount(ctx.id, String(ctx.finance._id), current!.payoutAccount!.version);
    await request(app).post(`/api/v1/finance/settlements/${settlementId}/payout-account/refresh`)
      .set(await authHeader(ctx.finance)).expect(200);

    const refreshed = await request(app).get(`/api/v1/finance/settlements/${settlementId}/payout-account`)
      .set(await authHeader(ctx.finance)).expect(200);
    expect(refreshed.body.data).toMatchObject({ accountNumber: '99999999999', changedSinceSettlement: false });

    const paid = await payReq(ctx.finance, settlementId);
    expect(paid.status).toBe(200);
    expect((await Settlement.findById(settlementId))!.paymentStatus).toBe('paid');
  });

  it('una liquidación pendiente anterior al control (sin foto) exige refrescar antes de pagar', async () => {
    const ctx = await merchantWithPayable();
    const settled = await settleReq(ctx.finance, ctx.id);
    const settlementId = settled.body.data.settlement._id;
    await Settlement.collection.updateOne({ _id: new Types.ObjectId(settlementId) }, { $unset: { payoutAccount: 1 } });

    const blocked = await payReq(ctx.finance, settlementId);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code ?? blocked.body.error?.code).toBe('PAYOUT_ACCOUNT_SNAPSHOT_MISSING');
    await request(app).get(`/api/v1/finance/settlements/${settlementId}/payout-account`)
      .set(await authHeader(ctx.finance)).expect(404);

    await request(app).post(`/api/v1/finance/settlements/${settlementId}/payout-account/refresh`)
      .set(await authHeader(ctx.finance)).expect(200);
    expect((await payReq(ctx.finance, settlementId)).status).toBe(200);
  });

  it('revelar desde el settlement: solo finanzas, no-store y auditoría HIGH sin el número', async () => {
    const ctx = await merchantWithPayable();
    const settled = await settleReq(ctx.finance, ctx.id);
    const settlementId = settled.body.data.settlement._id;
    const url = `/api/v1/finance/settlements/${settlementId}/payout-account`;

    // Fase 1: el admin sin cargo solo queda fuera con el bloqueo activo (en
    // observación conserva el acceso legacy y se registra).
    await featureFlagService.upsert('rbac_enforce', { audience: 'staff' });
    await cache.flush();
    await request(app).get(url).set(await authHeader(ctx.admin)).expect(403);
    await featureFlagService.remove('rbac_enforce');
    await cache.flush();
    await request(app).get(url).set(await authHeader(ctx.owner)).expect(403);

    const ok = await request(app).get(url).set(await authHeader(ctx.finance)).expect(200);
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(ok.body.data).toMatchObject({
      settlementId, businessId: ctx.id, method: 'bank', accountNumber: '12345678901',
      accountMasked: '••••8901', holderName: 'Negocio SAS', changedSinceSettlement: false,
    });

    const audit = await AuditLog.findOne({ action: 'settlement_payout_account_revealed' }).lean();
    expect(audit!.severity).toBe('high');
    expect(JSON.stringify(audit)).not.toContain('12345678901');
  });
});

describe('2 · reautenticación, aviso al dueño y cola de cuentas pendientes', () => {
  it('cambiar la cuenta exige la contraseña actual; un token robado no basta', async () => {
    const ctx = await merchantWithPayable();
    const put = async (body: object) =>
      request(app).put(`/api/v1/businesses/${ctx.id}/payout-account`).set(await authHeader(ctx.owner)).send(body);

    const { currentPassword: _omit, ...withoutPassword } = bankBody({ accountNumber: '55555555555' });
    expect((await put(withoutPassword)).status).toBe(401);
    expect((await put(bankBody({ accountNumber: '55555555555', currentPassword: 'incorrecta' }))).status).toBe(401);
    // Nada cambió, y los intentos fallidos quedan como alerta.
    expect((await Business.findById(ctx.id).select('+payoutAccount'))!.payoutAccount!.accountLast4).toBe('8901');
    expect(await AuditLog.countDocuments({ action: 'suspicious_activity', entity: 'business' })).toBeGreaterThanOrEqual(2);

    expect((await put(bankBody({ accountNumber: '55555555555' }))).status).toBe(200);
  });

  it('avisa al dueño con los 4 últimos dígitos anterior y nuevo, sin el número completo', async () => {
    const ctx = await merchantWithPayable();
    await request(app).put(`/api/v1/businesses/${ctx.id}/payout-account`).set(await authHeader(ctx.owner))
      .send(bankBody({ accountNumber: '55555551234' })).expect(200);

    const note = await Notification.findOne({ userId: ctx.owner._id, 'data.kind': 'payout_account_changed' }).lean();
    expect(note).toBeTruthy();
    expect(note!.body).toContain('8901');
    expect(note!.body).toContain('1234');
    expect(note!.body).not.toContain('55555551234');
  });

  it('la cola de finanzas lista las cuentas pendientes de comercios ya aprobados', async () => {
    const ctx = await merchantWithPayable();
    const finance = ctx.finance;
    const url = '/api/v1/finance/payout-accounts/pending';

    expect((await request(app).get(url).set(await authHeader(ctx.admin))).status).toBe(403);
    expect((await request(app).get(url).set(await authHeader(finance)).expect(200)).body.data).toEqual([]);

    await request(app).put(`/api/v1/businesses/${ctx.id}/payout-account`).set(await authHeader(ctx.owner))
      .send(bankBody({ accountNumber: '77777770001' })).expect(200);

    // Otro comercio con la MISMA cuenta: alerta de cuenta repetida.
    const other = await makeUser({ role: UserRole.BUSINESS });
    const otherBiz = await makeBusiness(other._id, { lat: GARZON.lat, lng: GARZON.lng, withPayoutAccount: false });
    await businessService.setPayoutAccount(String(otherBiz._id), bankBody({ accountNumber: '77777770001' }), String(other._id), { asOwner: true });
    // Y uno sin aprobar, que no debe salir aquí.
    const draft = await makeUser({ role: UserRole.BUSINESS });
    const draftBiz = await makeBusiness(draft._id, { lat: GARZON.lat, lng: GARZON.lng, isApproved: false });
    await businessService.setPayoutAccount(String(draftBiz._id), bankBody({ accountNumber: '88888880002' }), String(draft._id), { asOwner: true });

    const res = await request(app).get(url).set(await authHeader(finance)).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data).toHaveLength(2);
    const mine = res.body.data.find((r: any) => r.businessId === ctx.id);
    expect(mine).toMatchObject({
      businessName: ctx.business.name,
      method: 'bank',
      accountMasked: '••••0001',
      holderName: 'Negocio SAS',
      previousLast4: '8901',
      sharedWithBusinesses: 1,
      version: 2,
      hasFreshBankCertificate: false,
    });
    expect(mine.ownerName).toBe('Usuario Prueba');
    expect(mine.updatedAt).toBeTruthy();
    expect(JSON.stringify(res.body)).not.toContain('77777770001');
    expect(res.body.data.some((r: any) => r.businessId === String(draftBiz._id))).toBe(false);
  });

  it('el OTP de reautenticación no manda nada a quien tiene contraseña', async () => {
    const ctx = await merchantWithPayable();
    const res = await request(app).post(`/api/v1/businesses/${ctx.id}/payout-account/reauth-otp`)
      .set(await authHeader(ctx.owner)).expect(200);
    expect(res.body.data).toEqual({ channel: 'password' });
  });
});

describe('3 · cambiar la identidad fiscal devuelve la cuenta a pendiente', () => {
  const legal = { documentType: 'NIT' as const, documentNumber: '900123456', legalName: 'Negocio SAS' };

  it('un NIT o razón social distintos suben la versión y dejan la cuenta pendiente; un correo, no', async () => {
    const ctx = await merchantWithPayable();
    await businessService.setLegal(ctx.id, legal, String(ctx.owner._id));
    // El setLegal inicial (sin identidad previa) no toca la cuenta.
    expect((await Business.findById(ctx.id).select('+payoutAccount'))!.payoutAccount!.verificationStatus).toBe('verified');

    await businessService.setLegal(ctx.id, { ...legal, billingEmail: 'facturas@negocio.co' }, String(ctx.owner._id));
    let account = (await Business.findById(ctx.id).select('+payoutAccount'))!.payoutAccount!;
    expect(account.verificationStatus).toBe('verified');
    const versionBefore = account.version;

    await businessService.setLegal(ctx.id, { ...legal, legalName: 'Otra Razón SAS' }, String(ctx.owner._id));
    account = (await Business.findById(ctx.id).select('+payoutAccount'))!.payoutAccount!;
    expect(account.verificationStatus).toBe('pendingVerification');
    expect(account.version).toBe(versionBefore + 1);
    expect(String(account.updatedBy)).toBe(String(ctx.owner._id));

    // Y liquidar ya no es posible hasta que finanzas vuelva a verificar.
    expect((await settleReq(ctx.finance, ctx.id)).status).toBe(422);
    // Se avisó al dueño.
    expect(await Notification.countDocuments({ userId: ctx.owner._id, 'data.kind': 'legal_identity_changed' })).toBe(1);
  });

  it('el número de documento se guarda cifrado y se lee en claro', async () => {
    const ctx = await merchantWithPayable();
    await businessService.setLegal(ctx.id, legal, String(ctx.owner._id));
    const raw = await Business.collection.findOne({ _id: ctx.business._id });
    expect(raw!.legal.documentNumber).toMatch(/^v3:/);
    expect(JSON.stringify(raw!.legal)).not.toContain('900123456');

    const read = await request(app).get(`/api/v1/businesses/${ctx.id}/legal`).set(await authHeader(ctx.owner)).expect(200);
    expect(read.body.data).toMatchObject({ documentNumber: '900123456', dv: '8', complete: true });
    expect(read.headers['cache-control']).toBe('no-store');
  });

  it('verificar exige un certificado bancario aprobado y posterior al último cambio de la cuenta', async () => {
    const ctx = await merchantWithPayable();
    // Certificado viejo (de antes del cambio) aprobado.
    await approveBusinessDocument(ctx.id, 'bank_certificate', String(ctx.admin._id));
    await new Promise((r) => setTimeout(r, 5));
    const changed = await request(app).put(`/api/v1/businesses/${ctx.id}/payout-account`).set(await authHeader(ctx.owner))
      .send(bankBody({ accountNumber: '44444440000' })).expect(200);

    await expect(businessService.verifyPayoutAccount(ctx.id, String(ctx.finance._id), changed.body.data.version))
      .rejects.toMatchObject({ statusCode: 422, code: 'PAYOUT_ACCOUNT_CERTIFICATE_REQUIRED' });

    await new Promise((r) => setTimeout(r, 5));
    await approveBusinessDocument(ctx.id, 'bank_certificate', String(ctx.admin._id));
    const ok = await businessService.verifyPayoutAccount(ctx.id, String(ctx.finance._id), changed.body.data.version);
    expect(ok!.verificationStatus).toBe('verified');
  });
});

describe('4 · separación de funciones', () => {
  it('el dueño (aunque sea admin) y sus empleados no verifican su propia cuenta', async () => {
    const adminOwner = await makeUser({ role: UserRole.ADMIN, isFinanceAdmin: true });
    const accountant = await makeUser({ role: UserRole.ADMIN });
    const business = await makeBusiness(adminOwner._id, { lat: GARZON.lat, lng: GARZON.lng, withPayoutAccount: false });
    const id = String(business._id);

    // Otro admin registra la cuenta; el admin-dueño intenta verificarla.
    const account = await businessService.setPayoutAccount(id, bankBody(), String(accountant._id));
    await approveBusinessDocument(id, 'bank_certificate', String(accountant._id));
    await expect(businessService.verifyPayoutAccount(id, String(adminOwner._id), account!.version as number))
      .rejects.toMatchObject({ statusCode: 403, code: 'PAYOUT_ACCOUNT_CONFLICT_OF_INTEREST' });

    // Un empleado activo del negocio con rol de finanzas tampoco.
    const staffFinance = await makeUser({ role: UserRole.ADMIN, isFinanceAdmin: true });
    await BusinessStaff.create({ businessId: business._id, userId: staffFinance._id, role: 'manager', isActive: true });
    await expect(businessService.verifyPayoutAccount(id, String(staffFinance._id), account!.version as number))
      .rejects.toMatchObject({ statusCode: 403, code: 'PAYOUT_ACCOUNT_CONFLICT_OF_INTEREST' });

    // Un tercero independiente sí.
    const independent = await makeUser({ role: UserRole.ADMIN, isFinanceAdmin: true });
    const ok = await businessService.verifyPayoutAccount(id, String(independent._id), account!.version as number);
    expect(ok!.verificationStatus).toBe('verified');
  });

  it('quien sube un documento no lo aprueba, y no se aprueba un papel sin archivo', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const admin = await makeUser({ role: UserRole.ADMIN });
    const other = await makeUser({ role: UserRole.ADMIN });
    const business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng, isApproved: false });
    const id = String(business._id);

    const doc = await businessService.submitDocument(id, { type: 'rut', reference: 'R-1', submittedBy: String(admin._id) });
    // Sin archivo adjunto no se aprueba.
    await expect(reviewDoc(doc._id, String(other._id), 'approved')).rejects.toMatchObject({ statusCode: 422, code: 'DOCUMENT_FILE_REQUIRED' });
    await attachTestFile(doc._id);
    // El admin que lo subió no lo aprueba; otro sí. Rechazar sí puede cualquiera.
    await expect(reviewDoc(doc._id, String(admin._id), 'approved')).rejects.toMatchObject({ statusCode: 403, code: 'DOCUMENT_SELF_REVIEW' });
    expect((await reviewDoc(doc._id, String(other._id), 'approved')).status).toBe('approved');
  });

  it('nadie aprueba un negocio del que es dueño', async () => {
    const adminOwner = await makeUser({ role: UserRole.ADMIN, isFinanceAdmin: true });
    const business = await makeBusiness(adminOwner._id, { lat: GARZON.lat, lng: GARZON.lng, isApproved: false });
    await expect(businessService.approve(String(business._id), String(adminOwner._id)))
      .rejects.toMatchObject({ statusCode: 403, code: 'BUSINESS_SELF_APPROVAL' });
  });
});

describe('5 · categoría de alimentos tras aprobar', () => {
  it('pasar a alimentos exige concepto sanitario aprobado y vigente', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const admin = await makeUser({ role: UserRole.ADMIN });
    const business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng, category: 'pharmacy' });
    const id = String(business._id);

    await expect(businessService.update(id, String(owner._id), { category: 'restaurant' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'HEALTH_PERMIT_REQUIRED' });
    // Tampoco por la vía de admin.
    await expect(businessService.update(id, String(admin._id), { category: 'cafe' }, true))
      .rejects.toMatchObject({ statusCode: 409 });
    expect((await Business.findById(id))!.category).toBe('pharmacy');

    // Un permiso vencido no sirve.
    await approveBusinessDocument(id, 'health_permit', String(admin._id));
    await BusinessDocument.updateOne({ businessId: business._id, type: 'health_permit' }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(businessService.update(id, String(owner._id), { category: 'restaurant' }))
      .rejects.toMatchObject({ statusCode: 409 });

    await BusinessDocument.updateOne({ businessId: business._id, type: 'health_permit' }, { $set: { expiresAt: new Date(Date.now() + 86_400_000) } });
    const updated = await businessService.update(id, String(owner._id), { category: 'restaurant' });
    expect(updated.category).toBe('restaurant');
  });
});

describe('6, 9, 10 · subida de documentos', () => {
  const post = async (owner: any, id: string, build: (r: request.Test) => request.Test) =>
    build(request(app).post(`/api/v1/businesses/${id}/documents`).set(await authHeader(owner)));

  it('multer acota campos y partes: un formulario con 1000 campos se corta', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
    const id = String(business._id);

    const ok = await post(owner, id, (r) => r.field('type', 'rut').field('reference', '900123456-8').attach('file', PNG, { filename: 'a.png', contentType: 'image/png' }));
    expect(ok.status).toBe(201);

    const many = await post(owner, id, (r) => {
      let req = r.field('type', 'rut').field('reference', '900123456-8');
      for (let i = 0; i < 20; i += 1) req = req.field(`extra${i}`, 'y');
      return req.attach('file', PNG, { filename: 'a.png', contentType: 'image/png' });
    });
    expect(many.status).toBe(400);
    expect(many.body.message).toMatch(/too many|demasiad/i);

    const bigField = await post(owner, id, (r) =>
      r.field('type', 'rut').field('reference', 'x'.repeat(5000)).attach('file', PNG, { filename: 'a.png', contentType: 'image/png' }));
    expect(bigField.status).toBe(400);
    expect(bigField.body.message).toMatch(/too long|largo|value/i);
  });

  it('la revisión sin `revision` se rechaza con 400', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const admin = await makeUser({ role: UserRole.ADMIN });
    const business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
    const doc = await businessService.submitDocument(String(business._id), { type: 'rut', reference: 'R' });
    const res = await request(app).patch(`/api/v1/businesses/documents/${doc._id}/review`)
      .set(await authHeader(admin)).send({ status: 'approved' });
    expect(res.status).toBe(400);
    await expect(businessService.reviewDocument(String(doc._id), String(admin._id), 'approved', undefined, undefined as never))
      .rejects.toMatchObject({ statusCode: 400, code: 'REVISION_REQUIRED' });
  });

  it('rechaza un PDF con contenido activo y deja pasar uno normal', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
    const id = String(business._id);
    const evil = Buffer.from('%PDF-1.4\n1 0 obj\n<< /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >>\nendobj\n%%EOF');
    const fine = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n%%EOF');

    expect(pdfHasActiveContent(evil)).toBe(true);
    expect(pdfHasActiveContent(Buffer.from('%PDF-1.4 /Launch /Action'))).toBe(true);
    expect(pdfHasActiveContent(Buffer.from('%PDF-1.4 /EmbeddedFile'))).toBe(true);
    expect(pdfHasActiveContent(fine)).toBe(false);

    const bad = await post(owner, id, (r) => r.field('type', 'rut').field('reference', '900123456-8').attach('file', evil, { filename: 'a.pdf', contentType: 'application/pdf' }));
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/contenido activo/);
    const good = await post(owner, id, (r) => r.field('type', 'rut').field('reference', '900123456-8').attach('file', fine, { filename: 'a.pdf', contentType: 'application/pdf' }));
    expect(good.status).toBe(201);
  });
});

describe('7 · URLs con caducidad y sin caché', () => {
  it('la cola de aprobación y los documentos van no-store, y la cola deja auditoría', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const admin = await makeUser({ role: UserRole.ADMIN });
    await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng, isApproved: false });

    const pending = await request(app).get('/api/v1/businesses/pending').set(await authHeader(admin));
    expect(pending.status).toBe(200);
    expect(pending.headers['cache-control']).toBe('no-store');
    expect(await AuditLog.countDocuments({ action: 'business_document_viewed', entityId: 'pending-approvals' })).toBe(1);
  });
});

describe('8 · zonas: versión de área/prioridad/activa y lista pública sin tarifas', () => {
  const ring = [[-75.64, 2.18], [-75.61, 2.18], [-75.61, 2.21], [-75.64, 2.21], [-75.64, 2.18]];
  const ring2 = [[-75.65, 2.17], [-75.60, 2.17], [-75.60, 2.22], [-75.65, 2.22], [-75.65, 2.17]];

  const makeZone = async (admin: any, body: Record<string, unknown> = {}) =>
    (await request(app).post('/api/v1/zones').set(await authHeader(admin))
      .send({ name: 'Centro', coordinates: [ring], baseFee: 4000, perKm: 900, surcharge: 500, minOrder: 8000, ...body }).expect(201)).body.data;

  it('la lista pública trae solo nombre, ciudad, área y mínimo; ignora includeInactive', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    await makeZone(admin, { name: 'Activa' });
    await makeZone(admin, { name: 'En preparación', isActive: false });

    const pub = await request(app).get('/api/v1/zones?includeInactive=true');
    expect(pub.status).toBe(200);
    expect(pub.body.data).toHaveLength(1);
    expect(Object.keys(pub.body.data[0]).sort()).toEqual(['_id', 'area', 'city', 'minOrder', 'name']);
    expect(JSON.stringify(pub.body)).not.toMatch(/baseFee|perKm|surcharge|priority|isActive|versions/);

    const byId = await request(app).get(`/api/v1/zones/${(await Zone.findOne({ name: 'Activa' }))!._id}`);
    expect(Object.keys(byId.body.data).sort()).toEqual(['_id', 'area', 'city', 'minOrder', 'name']);
    const inactive = await Zone.findOne({ name: 'En preparación' });
    expect((await request(app).get(`/api/v1/zones/${inactive!._id}`)).status).toBe(404);
  });

  it('el panel ve tarifas e inactivas con zones:view; un cliente no', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    const client = await makeUser({ role: UserRole.CLIENT });
    await makeZone(admin, { name: 'Activa' });
    await makeZone(admin, { name: 'Inactiva', isActive: false });

    expect((await request(app).get('/api/v1/zones/admin')).status).toBe(401);
    expect((await request(app).get('/api/v1/zones/admin').set(await authHeader(client))).status).toBe(403);
    const res = await request(app).get('/api/v1/zones/admin').set(await authHeader(admin)).expect(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data.find((z: any) => z.name === 'Activa')).toMatchObject({ baseFee: 4000, perKm: 900, surcharge: 500, priority: 0, isActive: true });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('editar polígono, prioridad o activa exige motivo y crea versión; reenviar lo mismo, no', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    const zone = await makeZone(admin);
    const patch = async (body: object) => request(app).patch(`/api/v1/zones/${zone._id}`).set(await authHeader(admin)).send(body);

    expect((await patch({ priority: 5 })).status).toBe(400);
    expect((await patch({ isActive: false })).status).toBe(400);
    expect((await patch({ coordinates: [ring2] })).status).toBe(400);

    // El panel reenvía el formulario entero: mismos valores y polígono, sin cambios.
    const same = await patch({ coordinates: [ring], priority: 0, isActive: true, baseFee: 4000, name: 'Centro' });
    expect(same.status).toBe(200);
    expect(same.body.data.version).toBe(1);

    const v2 = await patch({ priority: 5, reason: 'Se solapa con Norte' });
    expect(v2.body.data.version).toBe(2);
    const v3 = await patch({ isActive: false, reason: 'Zona en preparación' });
    expect(v3.body.data.version).toBe(3);
    const v4 = await patch({ coordinates: [ring2], reason: 'Redibujada tras el catastro' });
    expect(v4.body.data.version).toBe(4);

    const history = await request(app).get(`/api/v1/zones/${zone._id}/versions`).set(await authHeader(admin)).expect(200);
    const versions = history.body.data.versions;
    expect(versions.map((v: any) => v.version)).toEqual([4, 3, 2, 1]);
    expect(versions[0]).toMatchObject({ areaChanged: true, priority: 5, isActive: false, changeReason: 'Redibujada tras el catastro' });
    expect(versions[0].areaHash).toMatch(/^[0-9a-f]{64}$/);
    expect(versions[0].areaHash).not.toBe(versions[1].areaHash);
    expect(versions[1]).toMatchObject({ areaChanged: false, isActive: false, priority: 5 });
    expect(versions[3]).toMatchObject({ areaChanged: true, priority: 0, isActive: true });

    // Cada cambio versionado queda como HIGH (los reenvíos sin cambios, no).
    expect(await AuditLog.countDocuments({ action: 'zone_updated', severity: 'high' })).toBeGreaterThanOrEqual(3);
  });
});

describe('12 · cifrado con AAD, hash de cuenta y migración 018', () => {
  it('un texto cifrado atado a un negocio no se lee en otro', () => {
    const sealed = encrypt('12345678901', businessAad('A'));
    expect(sealed).toMatch(/^v3:/);
    expect(decrypt(sealed, businessAad('A'))).toBe('12345678901');
    // Otro negocio, o sin contexto: se devuelve intacto (no se puede abrir).
    expect(decrypt(sealed, businessAad('B'))).toBe(sealed);
    expect(decrypt(sealed)).toBe(sealed);
    // Lo anterior (v2) sigue leyéndose con o sin contexto.
    const legacy = encrypt('12345678901');
    expect(legacy).toMatch(/^v2:/);
    expect(decrypt(legacy)).toBe('12345678901');
    expect(decrypt(legacy, businessAad('A'))).toBe('12345678901');
  });

  it('copiar la cuenta cifrada de un comercio a otro no sirve para revelarla', async () => {
    const a = await merchantWithPayable();
    const b = await merchantWithPayable();
    const rawA = await Business.collection.findOne({ _id: a.business._id });
    await Business.collection.updateOne({ _id: b.business._id }, { $set: { 'payoutAccount.accountNumberEnc': rawA!.payoutAccount.accountNumberEnc } });
    await expect(businessService.revealPayoutAccount(b.id)).rejects.toMatchObject({ statusCode: 500, code: 'PAYOUT_ACCOUNT_UNREADABLE' });
  });

  it('la migración 018 cifra lo que estaba en claro, calcula el hash y es idempotente', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng, withPayoutAccount: false });
    // Estado anterior a la 018: v2 sin AAD, cédula del titular y NIT en claro, sin hash.
    await Business.collection.updateOne({ _id: business._id }, {
      $set: {
        payoutAccount: {
          method: 'bank', bankName: 'Bancolombia', accountType: 'ahorros',
          accountNumberEnc: encrypt('12345678901'), accountLast4: '8901',
          holderName: 'Legacy', holderDocument: '900123456',
          verificationStatus: 'verified', version: 1, verifiedAt: new Date(),
        },
        legal: { documentType: 'NIT', documentNumber: '900123456', dv: '8', legalName: 'Legacy SAS' },
      },
    });

    const dry = await migratePayoutAccountHardening({ dryRun: true });
    expect(dry).toMatchObject({ accountNumbersResealed: 1, holderDocumentsEncrypted: 1, legalNumbersEncrypted: 1, hashesBackfilled: 1, dryRun: true });
    expect((await Business.collection.findOne({ _id: business._id }))!.legal.documentNumber).toBe('900123456');

    const real = await migratePayoutAccountHardening();
    expect(real).toMatchObject({ accountNumbersResealed: 1, holderDocumentsEncrypted: 1, legalNumbersEncrypted: 1, hashesBackfilled: 1 });
    const raw = await Business.collection.findOne({ _id: business._id });
    expect(raw!.payoutAccount.accountNumberEnc).toMatch(/^v3:/);
    expect(raw!.payoutAccount.holderDocument).toMatch(/^v3:/);
    expect(raw!.legal.documentNumber).toMatch(/^v3:/);
    expect(raw!.payoutAccount.accountNumberHash).toMatch(/^[0-9a-f]{64}$/);
    expect(openForBusiness(raw!.legal.documentNumber, business._id)).toBe('900123456');
    expect(decrypt(raw!.payoutAccount.accountNumberEnc, businessAad(business._id))).toBe('12345678901');

    // Sigue funcionando por la API tras migrar.
    const revealed = await businessService.revealPayoutAccount(String(business._id));
    expect(revealed).toMatchObject({ accountNumber: '12345678901', holderDocument: '900123456' });

    const again = await migratePayoutAccountHardening();
    expect(again).toMatchObject({ accountNumbersResealed: 0, holderDocumentsEncrypted: 0, legalNumbersEncrypted: 0, hashesBackfilled: 0 });
  });

  it('el reporte cuenta los comercios aprobados sin cuenta verificada y las liquidaciones sin foto', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng, withPayoutAccount: false });
    const before = await migratePayoutAccountHardening({ dryRun: true });
    expect(before.approvedWithoutVerifiedAccount).toBeGreaterThanOrEqual(1);
    expect(before.approvedWithoutVerifiedSample.length).toBeGreaterThanOrEqual(1);

    await Settlement.create({
      beneficiary: PayoutBeneficiary.BUSINESS, businessId: new Types.ObjectId(), periodStart: new Date(), periodEnd: new Date(),
      payoutCount: 1, grossAmount: 1000, netAmount: 1000, createdBy: new Types.ObjectId(),
    });
    const after = await migratePayoutAccountHardening({ dryRun: true });
    expect(after.pendingSettlementsWithoutSnapshot).toBe(before.pendingSettlementsWithoutSnapshot + 1);
  });
});
