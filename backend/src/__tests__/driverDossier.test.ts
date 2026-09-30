import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { PDFDocument } from 'pdf-lib';
import app from '../app';
import { AuditLog, AuditAction } from '../security';
import { Role, Driver, DriverDocument, DriverContract, User } from '../models';
import { UserRole } from '../types';
import { Permission } from '../security/rbac';
import { featureFlagService } from '../services/featureFlag.service';
import { cache } from '../cache';
import { pushService } from '../services/push.service';
import { authHeader, makeUser, makeDriver } from './factories';
import {
  documentIndicator,
  documentMessage,
  effectiveExpiry,
  summarizeCompliance,
  accountStatus,
  DOSSIER_DOCUMENTS,
  CRIMINAL_RECORD_MAX_AGE_DAYS,
} from '../services/driverDossier.logic';
import { buildDossierPdf } from '../services/driverDossierPdf.service';

// Sin red ni Cloudinary: el archivo "descargado" es un JPG mínimo válido.
const TINY_JPG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  'base64'
);
vi.mock('../services/driverDossierFiles', () => ({
  readDriverDocumentFile: vi.fn(async () => ({ buffer: TINY_JPG, format: 'jpg', contentType: 'image/jpeg' })),
  readContractFile: vi.fn(async () => ({ buffer: TINY_JPG, format: 'jpg', contentType: 'image/jpeg' })),
}));

const API = '/api/v1';
const DAY = 86_400_000;
const spec = (type: string) => DOSSIER_DOCUMENTS.find((s) => s.type === type)!;

describe('Expediente: reglas de vigencia', () => {
  const now = new Date('2026-09-30T12:00:00Z');
  const at = (days: number) => new Date(now.getTime() + days * DAY);

  it('clasifica cada documento con su indicador', () => {
    expect(documentIndicator('soat', null, now)).toBe('not_uploaded');
    expect(documentIndicator('soat', { status: 'pending' }, now)).toBe('in_review');
    expect(documentIndicator('soat', { status: 'rejected' }, now)).toBe('rejected');
    expect(documentIndicator('soat', { status: 'approved', expiresAt: at(-1) }, now)).toBe('expired');
    expect(documentIndicator('soat', { status: 'expired' }, now)).toBe('expired');
    expect(documentIndicator('soat', { status: 'approved', expiresAt: at(12) }, now)).toBe('expiring');
    expect(documentIndicator('soat', { status: 'approved', expiresAt: at(200) }, now)).toBe('valid');
    expect(documentIndicator('identity', { status: 'approved' }, now)).toBe('valid');
    // Vencido gana sobre "en revisión": un papel viejo no está al día por haberse reenviado.
    expect(documentIndicator('soat', { status: 'pending', expiresAt: at(-3) }, now)).toBe('expired');
  });

  it('escribe la frase que lee el administrador', () => {
    const exp = at(12);
    expect(documentMessage(spec('technical_review'), 'expiring', exp, now)).toBe('Tecnomecánica vence en 12 días');
    expect(documentMessage(spec('technical_review'), 'expiring', at(1), now)).toBe('Tecnomecánica vence en 1 día');
    expect(documentMessage(spec('soat'), 'expired', at(-2), now)).toBe('SOAT vencido');
    expect(documentMessage(spec('license'), 'valid', null, now)).toBe('Licencia vigente');
    expect(documentMessage(spec('criminal_record'), 'expired', null, now)).toBe('Antecedentes requieren actualización');
  });

  it('antecedentes sin vencimiento escrito caducan por política desde su expedición', () => {
    const issuedAt = at(-(CRIMINAL_RECORD_MAX_AGE_DAYS + 5));
    expect(effectiveExpiry('criminal_record', { status: 'approved', issuedAt })!.getTime()).toBeLessThan(now.getTime());
    expect(documentIndicator('criminal_record', { status: 'approved', issuedAt }, now)).toBe('expired');
    expect(documentIndicator('criminal_record', { status: 'approved', issuedAt: at(-10) }, now)).toBe('valid');
    // Solo aplica a antecedentes: una cédula sin vencimiento no caduca por edad.
    expect(effectiveExpiry('identity', { status: 'approved', issuedAt })).toBeNull();
  });

  it('"al día" exige todo cargado y aprobado; próximo a vencer aún cuenta', () => {
    const rows = (inds: string[]) =>
      DOSSIER_DOCUMENTS.map((s, i) => ({ spec: s, indicator: inds[i] as any, message: `${s.short} ${inds[i]}` }));
    expect(summarizeCompliance(rows(Array(7).fill('valid'))).upToDate).toBe(true);
    expect(summarizeCompliance(rows(['valid', 'valid', 'valid', 'valid', 'valid', 'expiring', 'valid'])).upToDate).toBe(true);
    const bad = summarizeCompliance(rows(['valid', 'not_uploaded', 'valid', 'expired', 'valid', 'expiring', 'rejected']));
    expect(bad.upToDate).toBe(false);
    // Lo más urgente primero: vencido, rechazado, sin cargar, próximo a vencer.
    expect(bad.issues[0]).toContain('expired');
    expect(bad.issues[1]).toContain('rejected');
    expect(bad.issues[2]).toContain('not_uploaded');
    expect(bad.issues[3]).toContain('expiring');
  });

  it('deduce el estado de la relación', () => {
    expect(accountStatus({ isApproved: true, isActive: true }, [])).toBe('active');
    expect(accountStatus({ isApproved: true, isActive: false }, [])).toBe('suspended');
    expect(accountStatus({ isApproved: false, isActive: true }, [{ status: 'pending' }])).toBe('in_review');
    expect(accountStatus({ isApproved: false, isActive: true }, [{ status: 'rejected' }, { status: 'approved' }])).toBe('rejected');
    expect(accountStatus({ isApproved: false, isActive: true }, [])).toBe('pending');
  });
});

describe('Expediente: PDF', () => {
  it('genera un PDF con portada, tablas y anexos (imagen y PDF) aunque un anexo falle', async () => {
    const inner = await PDFDocument.create();
    inner.addPage([300, 300]);
    inner.addPage([300, 300]);
    const innerBytes = Buffer.from(await inner.save());

    const bytes = await buildDossierPdf({
      driverId: 'abc',
      generatedAt: new Date('2026-09-30T12:00:00Z'),
      generatedBy: 'Ana Admin',
      person: { name: 'Juan Pérez Ñandú', documentNumber: 'CC 123456', status: 'active', city: 'Garzón' },
      vehicle: { type: 'Moto', plate: 'ABC12D' },
      compliance: { upToDate: false, issues: ['SOAT vencido'] },
      documents: [{ label: 'SOAT', indicator: 'expired', history: [{ action: 'approved', at: new Date(), byName: 'Ana' }] }],
      contract: { status: 'active', extraNames: [], history: [] },
      annexes: [
        { title: 'Cédula', caption: 'Vigente', file: { buffer: TINY_JPG, format: 'jpg' } },
        { title: 'Contrato', caption: 'Firmado', file: { buffer: innerBytes, format: 'pdf' } },
        { title: 'Roto', caption: 'x', error: 'No se pudo leer el archivo' },
      ],
    });

    const doc = await PDFDocument.load(bytes);
    // portada + datos + 3 hojas de anexo + 2 del PDF incrustado (más lo que desborde la tabla)
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(7);
    expect(Buffer.from(bytes).subarray(0, 5).toString()).toBe('%PDF-');
  });
});

describe('Expediente: API', () => {
  let admin: any, driverUser: any, driver: any;

  beforeEach(async () => {
    await featureFlagService.remove('rbac_enforce');
    await cache.flush();
    admin = await makeUser({ role: UserRole.ADMIN, name: 'Ana Admin' });
    driverUser = await makeUser({ role: UserRole.DRIVER, name: 'Juan Domiciliario' });
    driver = await makeDriver(driverUser._id, { isApproved: false });
    await DriverDocument.deleteMany({ driverId: driver._id });
    vi.spyOn(pushService, 'sendToUser').mockResolvedValue();
  });

  const doc = (type: string, extra: Record<string, unknown> = {}) =>
    DriverDocument.create({
      driverId: driver._id, type, reference: 'REF-1', imageKey: `k/${type}`, isPrivate: true, status: 'pending', ...extra,
    });

  it('devuelve el expediente con indicadores y "no cargado" para lo que falta', async () => {
    await doc('soat', { status: 'approved', expiresAt: new Date(Date.now() + 10 * DAY), reviewedBy: admin._id, reviewedAt: new Date() });
    const res = await request(app).get(`${API}/drivers/${driver._id}/dossier`).set(await authHeader(admin));
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.documents).toHaveLength(7);
    const soat = d.documents.find((x: any) => x.type === 'soat');
    expect(soat.indicator).toBe('expiring');
    expect(soat.reviewedByName).toBe('Ana Admin');
    expect(d.documents.find((x: any) => x.type === 'identity').indicator).toBe('not_uploaded');
    expect(d.compliance.upToDate).toBe(false);
    expect(res.headers['cache-control']).toContain('no-store');
    // Nunca sale la llave del almacén ni una URL.
    expect(JSON.stringify(d)).not.toContain('k/soat');
    expect(await AuditLog.countDocuments({ action: AuditAction.DRIVER_DOSSIER_VIEWED })).toBe(1);
  });

  it('un domiciliario o un cliente no pueden abrir expedientes', async () => {
    const other = await makeUser({ role: UserRole.DRIVER });
    const res = await request(app).get(`${API}/drivers/${driver._id}/dossier`).set(await authHeader(other));
    expect(res.status).toBe(403);
    const anon = await request(app).get(`${API}/drivers/${driver._id}/dossier`);
    expect(anon.status).toBe(401);
  });

  it('un admin sin drivers:approve no ve ni el expediente ni los archivos', async () => {
    await featureFlagService.upsert('rbac_enforce', { audience: 'staff' });
    const role = await Role.create({ name: 'solo_ver', slug: 'solo_ver', permissions: [Permission.DRIVERS_VIEW], isActive: true, isSystem: false });
    const viewer = await makeUser({ role: UserRole.ADMIN });
    viewer.roleIds = [role._id] as any;
    await viewer.save();
    const d = await doc('identity');

    const a = await request(app).get(`${API}/drivers/${driver._id}/dossier`).set(await authHeader(viewer));
    const b = await request(app).get(`${API}/drivers/${driver._id}/documents/${d._id}/file`).set(await authHeader(viewer));
    const c = await request(app).get(`${API}/drivers/${driver._id}/dossier/pdf`).set(await authHeader(viewer));
    expect([a.status, b.status, c.status]).toEqual([403, 403, 403]);
  });

  it('sirve el archivo por el backend y audita ver y descargar por separado', async () => {
    const d = await doc('identity');
    const view = await request(app).get(`${API}/drivers/${driver._id}/documents/${d._id}/file`).set(await authHeader(admin));
    expect(view.status).toBe(200);
    expect(view.headers['content-type']).toContain('image/jpeg');
    expect(view.headers['content-disposition']).toMatch(/^inline/);
    expect(view.headers['cache-control']).toContain('no-store');

    const dl = await request(app).get(`${API}/drivers/${driver._id}/documents/${d._id}/file?disposition=attachment`).set(await authHeader(admin));
    expect(dl.headers['content-disposition']).toMatch(/^attachment/);

    expect(await AuditLog.countDocuments({ action: AuditAction.DRIVER_DOCUMENT_VIEWED, entityId: String(d._id) })).toBe(1);
    expect(await AuditLog.countDocuments({ action: AuditAction.DRIVER_DOCUMENT_DOWNLOADED, entityId: String(d._id) })).toBe(1);
  });

  it('no entrega el documento de otro domiciliario cambiando la ruta', async () => {
    const otherUser = await makeUser({ role: UserRole.DRIVER });
    const otherDriver = await makeDriver(otherUser._id);
    const foreign = await DriverDocument.create({
      driverId: otherDriver._id, type: 'identity', reference: 'X-99', imageKey: 'k/x', isPrivate: true, status: 'pending',
    });
    const res = await request(app).get(`${API}/drivers/${driver._id}/documents/${foreign._id}/file`).set(await authHeader(admin));
    expect(res.status).toBe(404);
  });

  it('exporta el PDF completo y deja auditoría', async () => {
    await doc('identity');
    await doc('soat');
    const res = await request(app)
      .get(`${API}/drivers/${driver._id}/dossier/pdf`)
      .set(await authHeader(admin))
      .buffer(true)
      .parse((r, cb) => { const chunks: Buffer[] = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="expediente-/);
    expect((res.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    const log = await AuditLog.findOne({ action: AuditAction.DRIVER_DOSSIER_EXPORTED });
    expect(log?.metadata?.annexes).toBe(2);
  });

  it('aprobar y rechazar quedan en el historial con quién y cuándo', async () => {
    const d = await doc('license');
    await request(app).patch(`${API}/drivers/documents/${d._id}/review`).set(await authHeader(admin)).send({ status: 'rejected', rejectionReason: 'Foto borrosa' });
    await request(app).patch(`${API}/drivers/documents/${d._id}/review`).set(await authHeader(admin)).send({ status: 'approved' });
    const dossier = await request(app).get(`${API}/drivers/${driver._id}/dossier`).set(await authHeader(admin));
    const lic = dossier.body.data.documents.find((x: any) => x.type === 'license');
    expect(lic.history.map((h: any) => h.action)).toEqual(['approved', 'rejected']);
    expect(lic.history[1]).toMatchObject({ byName: 'Ana Admin', note: 'Foto borrosa' });
  });

  it('solicitar actualización avisa al domiciliario, no cambia el estado y el reenvío la cierra', async () => {
    const d = await doc('soat', { status: 'approved', expiresAt: new Date(Date.now() + 100 * DAY) });
    const short = await request(app).post(`${API}/drivers/${driver._id}/documents/${d._id}/request-update`).set(await authHeader(admin)).send({ reason: 'x' });
    expect(short.status).toBe(400);

    const ok = await request(app).post(`${API}/drivers/${driver._id}/documents/${d._id}/request-update`).set(await authHeader(admin)).send({ reason: 'La foto se corta en el borde' });
    expect(ok.status).toBe(200);
    expect(pushService.sendToUser).toHaveBeenCalledWith(String(driverUser._id), expect.objectContaining({ body: 'La foto se corta en el borde' }));
    let fresh: any = await DriverDocument.findById(d._id);
    expect(fresh!.status).toBe('approved');
    expect(fresh!.updateRequest?.reason).toContain('borde');

    // Reenvío del domiciliario: vuelve a revisión y la solicitud se cierra.
    const { driverService } = await import('../services/driver.service');
    await driverService.submitDocument(String(driverUser._id), { type: 'soat', reference: 'REF-2' });
    fresh = await DriverDocument.findById(d._id).select('+history');
    expect(fresh!.status).toBe('pending');
    expect(fresh!.updateRequest).toBeUndefined();
    expect(fresh!.history!.map((h: any) => h.action)).toEqual(['update_requested', 'submitted']);
  });

  it('las observaciones son internas: no aparecen en los documentos que ve el domiciliario', async () => {
    const d = await doc('identity');
    const res = await request(app).post(`${API}/drivers/${driver._id}/documents/${d._id}/observations`).set(await authHeader(admin)).send({ note: 'Coincide con la selfie' });
    expect(res.status).toBe(201);
    const mine = await request(app).get(`${API}/drivers/documents`).set(await authHeader(driverUser));
    expect(mine.status).toBe(200);
    expect(JSON.stringify(mine.body)).not.toContain('Coincide con la selfie');
    expect(mine.body.data[0].history).toBeUndefined();
  });

  it('el vehículo lo completa el domiciliario y lo corrige el admin; la placa se valida', async () => {
    const own = await request(app).patch(`${API}/drivers/vehicle`).set(await authHeader(driverUser)).send({ brand: 'Yamaha', model: 'FZ 150', color: 'Negro' });
    expect(own.status).toBe(200);
    // La placa no la cambia el domiciliario: sale en el tracking del cliente.
    const plateTry = await request(app).patch(`${API}/drivers/vehicle`).set(await authHeader(driverUser)).send({ licensePlate: 'ZZZ99Z' });
    expect(plateTry.status).toBe(400);
    const bad = await request(app).put(`${API}/drivers/${driver._id}/vehicle`).set(await authHeader(admin)).send({ licensePlate: '12' });
    expect(bad.status).toBe(400);
    const fix = await request(app).put(`${API}/drivers/${driver._id}/vehicle`).set(await authHeader(admin)).send({ color: 'Rojo' });
    expect(fix.status).toBe(200);
    const fresh = await Driver.findById(driver._id);
    expect(fresh!.vehicle).toMatchObject({ brand: 'Yamaha', color: 'Rojo' });
  });

  it('contrato: reglas de fechas, historial y anexos', async () => {
    const noStart = await request(app).put(`${API}/drivers/${driver._id}/contract`).set(await authHeader(admin)).send({ status: 'active' });
    expect(noStart.status).toBe(400);
    const backwards = await request(app).put(`${API}/drivers/${driver._id}/contract`).set(await authHeader(admin)).send({ status: 'active', startDate: '2026-05-01', endDate: '2026-01-01' });
    expect(backwards.status).toBe(400);

    const ok = await request(app).put(`${API}/drivers/${driver._id}/contract`).set(await authHeader(admin)).send({ status: 'active', startDate: '2026-01-15' });
    expect(ok.status).toBe(200);
    await request(app).put(`${API}/drivers/${driver._id}/contract`).set(await authHeader(admin)).send({ status: 'terminated', startDate: '2026-01-15', endDate: '2026-08-01' });

    const contract = await DriverContract.findOne({ driverId: driver._id });
    expect(contract!.history.map((h) => h.action)).toEqual(['created', 'updated']);
    expect(contract!.status).toBe('terminated');
    expect(contract!.history[0].byName).toBe('Ana Admin');

    const dossier = await request(app).get(`${API}/drivers/${driver._id}/dossier`).set(await authHeader(admin));
    expect(dossier.body.data.contract.status).toBe('terminated');
    expect(dossier.body.data.person.linkedAt).toContain('2026-01-15');
    expect(await AuditLog.countDocuments({ action: AuditAction.DRIVER_CONTRACT_UPDATED })).toBe(2);
  });

  it('al aprobar al domiciliario se guarda la fecha de vinculación una sola vez', async () => {
    await User.updateOne({ _id: driverUser._id }, { $set: { documentNumber: '123' } });
    const { driverService } = await import('../services/driver.service');
    const first = await driverService.approve(String(driver._id));
    const firstAt = first.approvedAt!;
    expect(firstAt).toBeInstanceOf(Date);
    await Driver.updateOne({ _id: driver._id }, { $set: { isApproved: false } });
    const again = await driverService.approve(String(driver._id));
    expect(again.approvedAt!.getTime()).toBe(firstAt.getTime());
  });
});

describe('Expediente: endurecimiento', () => {
  let admin: any, driverUser: any, driver: any;
  beforeEach(async () => {
    await featureFlagService.remove('rbac_enforce');
    admin = await makeUser({ role: UserRole.ADMIN, name: 'Ana Admin' });
    driverUser = await makeUser({ role: UserRole.DRIVER });
    driver = await makeDriver(driverUser._id, { isApproved: false });
    await DriverDocument.deleteMany({ driverId: driver._id });
  });

  it('aprobar con una revisión vieja da 409 si el domiciliario reenvió', async () => {
    const submittedAt = new Date(Date.now() - 60_000);
    const d = await DriverDocument.create({ driverId: driver._id, type: 'license', reference: 'L-1', imageKey: 'k/l', isPrivate: true, status: 'pending', submittedAt });
    const { driverService } = await import('../services/driver.service');
    await driverService.submitDocument(String(driverUser._id), { type: 'license', reference: 'L-2' });
    const res = await request(app).patch(`${API}/drivers/documents/${d._id}/review`).set(await authHeader(admin)).send({ status: 'approved', revision: submittedAt.getTime() });
    expect(res.status).toBe(409);
    expect((await DriverDocument.findById(d._id))!.status).toBe('pending');
  });

  it('reenviar sin cambios no llena el historial de eventos "enviado"', async () => {
    const { driverService } = await import('../services/driver.service');
    await DriverDocument.create({ driverId: driver._id, type: 'license', reference: 'L-1', imageKey: 'k/l', isPrivate: true, status: 'approved' });
    for (let i = 0; i < 6; i++) await driverService.submitDocument(String(driverUser._id), { type: 'license', reference: 'L-1' });
    const doc: any = await DriverDocument.findOne({ driverId: driver._id, type: 'license' }).select('+history');
    expect(doc.history.filter((h: any) => h.action === 'submitted')).toHaveLength(1);
  });

  it('el domiciliario no recibe el id del admin en la solicitud de actualización', async () => {
    const d = await DriverDocument.create({ driverId: driver._id, type: 'soat', reference: 'S', imageKey: 'k/s', isPrivate: true, status: 'approved' });
    await request(app).post(`${API}/drivers/${driver._id}/documents/${d._id}/request-update`).set(await authHeader(admin)).send({ reason: 'Foto cortada' });
    const mine = await request(app).get(`${API}/drivers/documents`).set(await authHeader(driverUser));
    expect(mine.body.data[0].updateRequest).toEqual({ reason: 'Foto cortada', requestedAt: expect.any(String) });
  });
});
