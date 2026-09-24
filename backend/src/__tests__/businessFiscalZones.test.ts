import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { featureFlagService } from '../services/featureFlag.service';
import { cache } from '../cache';
import { Permission } from '../security/rbac';
import request from 'supertest';
import { Writable } from 'stream';
import app from '../app';
import { cloudinary } from '../config';
import { Business, BusinessDocument, Zone, Order, Role } from '../models';
import { AuditLog } from '../security';
import { UserRole } from '../types';
import { businessService } from '../services/business.service';
import { zoneService } from '../services/zone.service';
import { pricingService } from '../services/pricing.service';
import { pricingConfigService } from '../services/pricingConfig.service';
import { computeNitDv } from '../utils/nit';
import { sniffPrivateFile } from '../services/privateStorage.service';
import { makeUser, makeBusiness, makePricingConfig, makeZone, authHeader, GARZON, approveBusinessDocument } from './factories';

/**
 * Fase 0: documentos privados del comercio (O4), datos fiscales y bancarios,
 * y zonas versionadas (D9).
 */

// PNG mínimo válido para `readImageHeader` (firma + IHDR con 10x10).
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0, 0, 0, 13]),
  Buffer.from('IHDR'),
  Buffer.from([0, 0, 0, 10, 0, 0, 0, 10, 8, 6, 0, 0, 0]),
  Buffer.alloc(12),
]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF');

let uploads = 0;
let uploadOptions: any[] = [];

beforeAll(() => {
  cloudinary.config({ cloud_name: 'demo', api_key: 'key', api_secret: 'secret' });
  vi.spyOn(cloudinary.uploader, 'upload_stream').mockImplementation(((options: any, cb: any) => {
    uploadOptions.push(options);
    const id = `${options.public_id ?? `${options.folder}/file`}-${++uploads}`;
    return new Writable({
      write(_chunk, _enc, next) { next(); },
      final(done) { cb(null, { public_id: id }); done(); },
    });
  }) as any);
});

afterAll(() => vi.restoreAllMocks());

beforeEach(() => { uploadOptions = []; });

/** Los helpers arman la petición tras resolver el token; `.expect(code)` comprueba el estado. */
const expecting = <T extends { status: number }>(pending: Promise<T>) =>
  Object.assign(pending, {
    expect: async (code: number) => {
      const res = await pending;
      expect(res.status).toBe(code);
      return res;
    },
  });

const upload = (as: any, businessId: string, type = 'rut', file = PNG, name = 'a.png', mime = 'image/png') =>
  expecting(
    (async () =>
      request(app)
        .post(`/api/v1/businesses/${businessId}/documents`)
        .set(await authHeader(as))
        .field('type', type)
        .field('reference', '900123456-8')
        .attach('file', file, { filename: name, contentType: mime }))()
  );

describe('NIT · dígito de verificación (DIAN, módulo 11)', () => {
  it('calcula el DV de NITs conocidos', () => {
    expect(computeNitDv('860002964')).toBe('4');
    expect(computeNitDv('890903938')).toBe('8');
    expect(computeNitDv('900123456')).toBe('8');
    expect(computeNitDv('abc')).toBeNull();
  });
});

describe('O4 · documentos del comercio con archivo privado', () => {
  it('sube una imagen y un PDF, guarda solo la llave y firma la URL al leer', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });

    const img = await upload(owner, String(business._id)).expect(201);
    expect(img.body.data.hasFile).toBe(true);
    expect(img.body.data.fileUrl).toMatch(/\/image\/authenticated\/s--/);
    expect(img.body.data.fileKey).toBeUndefined();
    expect(uploadOptions[0].type).toBe('authenticated');

    const pdf = await upload(owner, String(business._id), 'bank_certificate', PDF, 'c.pdf', 'application/pdf').expect(201);
    // El PDF va por descarga privada de la API de Cloudinary y caduca (5 min).
    expect(pdf.body.data.fileUrl).toMatch(/api\.cloudinary\.com\/v1_1\/demo\/raw\/download\?/);
    const expiresAt = Number(new URL(pdf.body.data.fileUrl).searchParams.get('expires_at'));
    expect(expiresAt).toBeGreaterThan(Date.now() / 1000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() / 1000 + 301);
    expect(new URL(pdf.body.data.fileUrl).searchParams.get('type')).toBe('authenticated');
    expect(new URL(pdf.body.data.fileUrl).searchParams.has('format')).toBe(false);
    expect(uploadOptions[1].resource_type).toBe('raw');

    // En la base: llave, jamás una URL.
    const stored = await BusinessDocument.findOne({ businessId: business._id, type: 'rut' }).lean();
    expect(stored!.fileKey).toBeTruthy();
    expect(stored!.isPrivate).toBe(true);
    expect(JSON.stringify(stored)).not.toMatch(/https?:\/\//);

    const list = await request(app)
      .get(`/api/v1/businesses/${business._id}/documents`)
      .set(await authHeader(owner))
      .expect(200);
    expect(list.body.data).toHaveLength(2);
    expect(list.body.data.every((d: any) => d.fileKey === undefined && d.fileUrl)).toBe(true);
  });

  it('rechaza lo que no es imagen ni PDF aunque declare otro tipo, y exige el archivo', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });

    await upload(owner, String(business._id), 'rut', Buffer.from('MZ ejecutable'), 'a.jpg', 'image/jpeg').expect(400);
    await upload(owner, String(business._id), 'rut', PNG, 'a.gif', 'image/gif').expect(400);
    await request(app)
      .post(`/api/v1/businesses/${business._id}/documents`)
      .set(await authHeader(owner))
      .field('type', 'rut')
      .field('reference', '123456')
      .expect(400);
    expect(sniffPrivateFile(PDF)).toBe('pdf');
    expect(sniffPrivateFile(PNG)).toBe('png');
  });

  it('otro comercio no puede leer ni subir los papeles ajenos', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const other = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
    await makeBusiness(other._id, { lat: GARZON.lat, lng: GARZON.lng });
    await upload(owner, String(business._id)).expect(201);

    await upload(other, String(business._id)).expect(403);
    await request(app).get(`/api/v1/businesses/${business._id}/documents`).set(await authHeader(other)).expect(403);
    await request(app).get(`/api/v1/businesses/${business._id}/legal`).set(await authHeader(other)).expect(403);
    await request(app).get(`/api/v1/businesses/${business._id}/payout-account`).set(await authHeader(other)).expect(403);
    await request(app).put(`/api/v1/businesses/${business._id}/legal`).set(await authHeader(other))
      .send({ documentType: 'CC', documentNumber: '1234567', legalName: 'X X' }).expect(403);
    expect(await BusinessDocument.countDocuments({ businessId: business._id })).toBe(1);
  });

  it('el rechazo exige motivo y al reenviar se conserva el historial', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const admin = await makeUser({ role: UserRole.ADMIN });
    const business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
    const first = await upload(owner, String(business._id)).expect(201);
    const id = first.body.data._id;

    await request(app).patch(`/api/v1/businesses/documents/${id}/review`).set(await authHeader(admin))
      .send({ status: 'rejected' }).expect(400);
    await request(app).patch(`/api/v1/businesses/documents/${id}/review`).set(await authHeader(admin))
      .send({ status: 'rejected', rejectionReason: 'no' }).expect(400);
    await request(app).patch(`/api/v1/businesses/documents/${id}/review`).set(await authHeader(admin))
      .send({ status: 'rejected', rejectionReason: 'Imagen borrosa, no se lee el NIT' }).expect(400);
    // `revision` es obligatoria: sin ella no se sabe qué archivo se miró.
    await request(app).patch(`/api/v1/businesses/documents/${id}/review`).set(await authHeader(admin))
      .send({ status: 'rejected', rejectionReason: 'Imagen borrosa, no se lee el NIT', revision: new Date(first.body.data.updatedAt).getTime() }).expect(200);

    // El comercio ve el motivo.
    const seen = await request(app).get(`/api/v1/businesses/${business._id}/documents`).set(await authHeader(owner)).expect(200);
    expect(seen.body.data[0].rejectionReason).toMatch(/borrosa/);

    const again = await upload(owner, String(business._id)).expect(201);
    expect(again.body.data.status).toBe('pending');
    expect(again.body.data.history).toHaveLength(1);
    expect(again.body.data.history[0]).toMatchObject({ status: 'rejected', rejectionReason: 'Imagen borrosa, no se lee el NIT' });
    // El historial no se firma en cada listado: solo bajo demanda (`?history=true`).
    expect(again.body.data.history[0].hasFile).toBe(true);
    expect(again.body.data.history[0].fileUrl).toBeUndefined();
    const withHistory = await request(app).get(`/api/v1/businesses/${business._id}/documents?history=true`).set(await authHeader(owner)).expect(200);
    expect(withHistory.body.data[0].history[0].fileUrl).toBeTruthy();
    expect(withHistory.headers['cache-control']).toBe('no-store');
    expect(await BusinessDocument.countDocuments({ businessId: business._id, type: 'rut' })).toBe(1);
  });

  it('una revisión sobre un archivo que cambió después de abrirlo falla con 409', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const admin = await makeUser({ role: UserRole.ADMIN });
    const business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
    const first = await upload(owner, String(business._id)).expect(201);
    const seenAt = new Date(first.body.data.updatedAt).getTime();
    await new Promise((r) => setTimeout(r, 5));
    await upload(owner, String(business._id)).expect(201);

    await request(app).patch(`/api/v1/businesses/documents/${first.body.data._id}/review`)
      .set(await authHeader(admin)).send({ status: 'approved', revision: seenAt }).expect(409);
  });
});

describe('Datos legales y cuenta de pago', () => {
  const legal = { documentType: 'NIT', documentNumber: '900.123.456-8', legalName: 'Panadería SAS', taxRegime: 'simple' };
  const bank = {
    method: 'bank', bankName: 'Bancolombia', accountType: 'ahorros',
    accountNumber: '12345678901', holderName: 'Panadería SAS', holderDocument: '900123456',
    // Reautenticación: `makeUser` deja esta contraseña por defecto.
    currentPassword: 'Clave.Segura123',
  };

  const setup = async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng, isApproved: false });
    return { owner, business, id: String(business._id) };
  };

  it('el servidor calcula el DV y comprueba el que llega', async () => {
    const { owner, id } = await setup();
    const ok = await request(app).put(`/api/v1/businesses/${id}/legal`).set(await authHeader(owner)).send(legal).expect(200);
    expect(ok.body.data).toMatchObject({ documentNumber: '900123456', dv: '8', complete: true });

    await request(app).put(`/api/v1/businesses/${id}/legal`).set(await authHeader(owner))
      .send({ ...legal, documentNumber: '900123456', dv: '3' }).expect(422);
    await request(app).put(`/api/v1/businesses/${id}/legal`).set(await authHeader(owner))
      .send({ documentType: 'CC', documentNumber: '1234567', dv: '1', legalName: 'Juan Pérez' }).expect(400);
  });

  it('la cuenta se guarda cifrada, sale enmascarada y queda pendiente de verificación', async () => {
    const { owner, id } = await setup();
    const res = await request(app).put(`/api/v1/businesses/${id}/payout-account`).set(await authHeader(owner)).send(bank).expect(200);
    expect(res.body.data).toMatchObject({ accountMasked: '••••8901', verificationStatus: 'pendingVerification', version: 1 });
    expect(JSON.stringify(res.body)).not.toContain('12345678901');

    const raw = await Business.collection.findOne({ _id: (await Business.findById(id))!._id });
    // v3 = cifrado atado al negocio (AAD); el documento del titular también va cifrado.
    expect(raw!.payoutAccount.accountNumberEnc).toMatch(/^v3:/);
    expect(raw!.payoutAccount.holderDocument).toMatch(/^v3:/);
    expect(raw!.payoutAccount.accountNumberHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(raw)).not.toContain('12345678901');
    expect(JSON.stringify(raw)).not.toContain('900123456');

    // Ni la ficha normal ni "mis negocios" llevan los datos sensibles.
    const mine = await request(app).get('/api/v1/businesses/my/businesses').set(await authHeader(owner)).expect(200);
    expect(JSON.stringify(mine.body)).not.toMatch(/payoutAccount|accountNumber/);

    const audit = await AuditLog.findOne({ action: 'business_payout_account_updated' }).lean();
    expect(audit!.severity).toBe('high');
    expect(JSON.stringify(audit)).not.toContain('12345678901');
  });

  it('valida por método: banco pide banco y tipo; Nequi, un celular', async () => {
    const { owner, id } = await setup();
    const put = (body: object) =>
      expecting((async () => request(app).put(`/api/v1/businesses/${id}/payout-account`).set(await authHeader(owner)).send(body))());
    await put({ ...bank, bankName: null }).expect(400);
    await put({ ...bank, method: 'nequi', accountNumber: '12345678901' }).expect(400);
    await put({ method: 'nequi', accountNumber: '3101234567', holderName: 'Ana Ruiz', holderDocument: '1234567', currentPassword: 'Clave.Segura123' }).expect(200);
  });

  it('solo el admin financiero verifica y ve el número completo; cambiar la cuenta la deja pendiente', async () => {
    const { owner, id } = await setup();
    const plainAdmin = await makeUser({ role: UserRole.ADMIN });
    const finance = await makeUser({ role: UserRole.ADMIN, isFinanceAdmin: true });
    await request(app).put(`/api/v1/businesses/${id}/payout-account`).set(await authHeader(owner)).send(bank).expect(200);

    await request(app).get(`/api/v1/businesses/${id}/payout-account/reveal`).set(await authHeader(owner)).expect(403);
    // Fase 1: el admin sin cargo queda fuera solo con el bloqueo activo (en observación pasa y se registra).
    await featureFlagService.upsert('rbac_enforce', { audience: 'staff' });
    await cache.flush();
    await request(app).get(`/api/v1/businesses/${id}/payout-account/reveal`).set(await authHeader(plainAdmin)).expect(403);
    await request(app).patch(`/api/v1/businesses/${id}/payout-account/verify`).set(await authHeader(plainAdmin)).send({ version: 1 }).expect(403);
    await featureFlagService.remove('rbac_enforce');
    await cache.flush();

    const full = await request(app).get(`/api/v1/businesses/${id}/payout-account/reveal`).set(await authHeader(finance)).expect(200);
    expect(full.body.data).toMatchObject({ accountNumber: '12345678901', holderDocument: '900123456', version: 1 });
    expect(await AuditLog.countDocuments({ action: 'business_payout_account_revealed', severity: 'high' })).toBe(1);

    // Sin certificado bancario posterior al cambio no se verifica.
    const noCert = await request(app).patch(`/api/v1/businesses/${id}/payout-account/verify`).set(await authHeader(finance)).send({ version: 1 }).expect(422);
    expect(noCert.body.code ?? noCert.body.error?.code).toBe('PAYOUT_ACCOUNT_CERTIFICATE_REQUIRED');
    await approveBusinessDocument(id, 'bank_certificate', plainAdmin._id.toString());

    // Versión distinta a la que se revisó: no se verifica a ciegas.
    await request(app).patch(`/api/v1/businesses/${id}/payout-account/verify`).set(await authHeader(finance)).send({ version: 7 }).expect(409);
    const ok = await request(app).patch(`/api/v1/businesses/${id}/payout-account/verify`).set(await authHeader(finance)).send({ version: 1 }).expect(200);
    expect(ok.body.data.verificationStatus).toBe('verified');
    expect(await businessService.payoutAccountStatus(id)).toBe('verified');
    await request(app).patch(`/api/v1/businesses/${id}/payout-account/verify`).set(await authHeader(finance)).send({ version: 1 }).expect(409);

    // El dueño cambia la cuenta: vuelve a pendiente con otra versión.
    const changed = await request(app).put(`/api/v1/businesses/${id}/payout-account`).set(await authHeader(owner))
      .send({ ...bank, accountNumber: '99999999999' }).expect(200);
    expect(changed.body.data).toMatchObject({ verificationStatus: 'pendingVerification', version: 2 });
    await expect(businessService.assertPayoutAccountVerified(id)).rejects.toMatchObject({ statusCode: 422 });
  });

  it('quien registró la cuenta no puede verificarla', async () => {
    const { id } = await setup();
    // Escribir la cuenta de un comercio es solo del Super Administrador (Fase 1).
    const finance = await makeUser({ role: UserRole.ADMIN, isFinanceAdmin: true });
    const superRole = await Role.create({ name: 'Super Administrador', slug: 'super_admin', permissions: Object.values(Permission), isActive: true, isSystem: true });
    finance.roleIds = [superRole._id] as any;
    await finance.save();
    await request(app).put(`/api/v1/businesses/${id}/payout-account`).set(await authHeader(finance)).send(bank).expect(200);
    await request(app).patch(`/api/v1/businesses/${id}/payout-account/verify`).set(await authHeader(finance)).send({ version: 1 }).expect(403);
  });

  it('un negocio suspendido no cambia su cuenta por su cuenta', async () => {
    const { owner, business, id } = await setup();
    await Business.updateOne({ _id: business._id }, { isSuspended: true });
    await request(app).put(`/api/v1/businesses/${id}/payout-account`).set(await authHeader(owner)).send(bank).expect(403);
  });

  it('aprobar exige datos legales completos y cuenta verificada, y no toca a los ya aprobados', async () => {
    const { owner, business, id } = await setup();
    const admin = await makeUser({ role: UserRole.ADMIN });
    const finance = await makeUser({ role: UserRole.ADMIN, isFinanceAdmin: true });
    for (const type of ['rut', 'chamber_of_commerce', 'legal_rep_id', 'bank_certificate', 'health_permit']) {
      await approveBusinessDocument(id, type, admin._id.toString());
    }

    const denied = await request(app).patch(`/api/v1/businesses/${id}/approve`).set(await authHeader(admin)).expect(422);
    expect(denied.body.code ?? denied.body.error?.code).toBe('BUSINESS_FISCAL_DATA_MISSING');

    await request(app).put(`/api/v1/businesses/${id}/legal`).set(await authHeader(owner)).send(legal).expect(200);
    await request(app).put(`/api/v1/businesses/${id}/payout-account`).set(await authHeader(owner)).send(bank).expect(200);
    await request(app).patch(`/api/v1/businesses/${id}/approve`).set(await authHeader(admin)).expect(422);
    // El certificado tiene que ser posterior al cambio de la cuenta.
    await approveBusinessDocument(id, 'bank_certificate', admin._id.toString());

    await request(app).patch(`/api/v1/businesses/${id}/payout-account/verify`).set(await authHeader(finance)).send({ version: 1 }).expect(200);
    await request(app).patch(`/api/v1/businesses/${id}/approve`).set(await authHeader(admin)).expect(200);
    expect((await Business.findById(business._id))!.isApproved).toBe(true);

    // Un comercio aprobado antes de la Fase 0 sigue aprobado sin datos fiscales.
    const legacy = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng, isApproved: true });
    expect((await Business.findById(legacy._id))!.isApproved).toBe(true);
  });

  it('un PUT genérico no puede escribir legal ni payoutAccount', async () => {
    const { owner, id } = await setup();
    await request(app).put(`/api/v1/businesses/${id}`).set(await authHeader(owner))
      .send({ payoutAccount: { method: 'bank' } }).expect(400);
  });
});

describe('D9 · zonas con versión, motivo y permiso', () => {
  const ring = [[-75.64, 2.18], [-75.61, 2.18], [-75.61, 2.21], [-75.64, 2.21], [-75.64, 2.18]];

  it('solo un admin con zones:manage escribe; un cliente no', async () => {
    const client = await makeUser({ role: UserRole.CLIENT });
    await request(app).post('/api/v1/zones').set(await authHeader(client))
      .send({ name: 'Centro', coordinates: [ring] }).expect(403);
  });

  it('cambiar la tarifa exige motivo, crea versión y se audita; reenviar lo mismo no', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    const created = await request(app).post('/api/v1/zones').set(await authHeader(admin))
      .send({ name: 'Centro', coordinates: [ring], baseFee: 4000, perKm: 900, surcharge: 0, minOrder: 0 }).expect(201);
    const id = created.body.data._id;
    expect(created.body.data.version).toBe(1);
    expect(created.body.data.versions).toBeUndefined();

    await request(app).patch(`/api/v1/zones/${id}`).set(await authHeader(admin)).send({ baseFee: 5000 }).expect(400);
    await request(app).patch(`/api/v1/zones/${id}`).set(await authHeader(admin)).send({ baseFee: 4500.5, reason: 'Subida por gasolina' }).expect(400);

    // Mismos valores + un cambio no tarifario: sin motivo y sin versión.
    const same = await request(app).patch(`/api/v1/zones/${id}`).set(await authHeader(admin))
      .send({ baseFee: 4000, name: 'Centro Garzón' }).expect(200);
    expect(same.body.data.version).toBe(1);

    const changed = await request(app).patch(`/api/v1/zones/${id}`).set(await authHeader(admin))
      .send({ baseFee: 5000, surcharge: 500, reason: 'Subida por gasolina' }).expect(200);
    expect(changed.body.data).toMatchObject({ version: 2, baseFee: 5000, surcharge: 500 });
    expect(changed.body.data.versions).toBeUndefined();

    const versions = await request(app).get(`/api/v1/zones/${id}/versions`).set(await authHeader(admin)).expect(200);
    expect(versions.body.data.versions.map((v: any) => v.version)).toEqual([2, 1]);
    expect(versions.body.data.versions[0]).toMatchObject({
      baseFee: 5000, surcharge: 500, changeReason: 'Subida por gasolina', changedBy: String(admin._id),
    });
    expect(versions.body.data.versions[1]).toMatchObject({ baseFee: 4000, version: 1 });

    const audit = await AuditLog.findOne({ action: 'zone_tariff_changed' }).lean();
    expect(audit!.severity).toBe('high');
    expect(audit!.metadata!.reason).toBe('Subida por gasolina');

    // Las lecturas públicas no filtran el historial.
    const pub = await request(app).get(`/api/v1/zones/${id}`).expect(200);
    expect(pub.body.data.versions).toBeUndefined();
    await request(app).get(`/api/v1/zones/${id}/versions`).expect(401);
  });

  it('una zona anterior al versionado conserva su tarifa vieja en el historial', async () => {
    const zone = await makeZone(GARZON, 3, { baseFee: 3000 });
    const admin = await makeUser({ role: UserRole.ADMIN });
    await zoneService.update(zone._id.toString(), { baseFee: 3500 }, { actorId: admin._id.toString(), reason: 'Ajuste trimestral' });
    const { versions } = await zoneService.listVersions(zone._id.toString());
    expect(versions.map((v) => [v.version, v.baseFee])).toEqual([[2, 3500], [1, 3000]]);
  });

  it('dos ediciones de tarifa simultáneas no se pisan', async () => {
    const zone = await makeZone(GARZON, 3, { baseFee: 3000 });
    const ctx = { actorId: String((await makeUser({ role: UserRole.ADMIN }))._id), reason: 'Ajuste de prueba' };
    const results = await Promise.allSettled([
      zoneService.update(zone._id.toString(), { baseFee: 3100 }, ctx),
      zoneService.update(zone._id.toString(), { baseFee: 3200 }, ctx),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await Zone.findById(zone._id))!.version).toBe(2);
  });

  it('una zona con pedidos no se borra', async () => {
    const used = await makeZone(GARZON, 3);
    const free = await makeZone({ lat: 3, lng: -76 }, 1);
    await Order.collection.insertOne({ zoneId: used._id });
    const admin = await makeUser({ role: UserRole.ADMIN });
    await request(app).delete(`/api/v1/zones/${used._id}`).set(await authHeader(admin)).expect(409);
    await request(app).delete(`/api/v1/zones/${free._id}`).set(await authHeader(admin)).expect(200);
  });

  it('la cotización lleva zoneId y zoneVersion de la zona usada', async () => {
    await makePricingConfig();
    pricingConfigService.invalidate();
    const zone = await makeZone(GARZON, 5, { baseFee: 5000 });
    const admin = await makeUser({ role: UserRole.ADMIN });
    await zoneService.update(zone._id.toString(), { baseFee: 6000 }, { actorId: admin._id.toString(), reason: 'Ajuste de prueba' });

    const cfg = await pricingConfigService.getCurrent();
    const quote = await pricingService.priceRoute(GARZON, { lat: GARZON.lat + 0.01, lng: GARZON.lng }, 'Garzón', cfg);
    expect(String(quote.zoneId)).toBe(String(zone._id));
    expect(quote.zoneVersion).toBe(2);
  });
});
