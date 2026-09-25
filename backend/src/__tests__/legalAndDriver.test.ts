import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { DriverDocument, LegalAcceptance, LegalDocument, Pqrs } from '../models';
import { UserRole } from '../types';
import { authHeader, makeDriver, makeUser } from './factories';
import { driverService } from '../services/driver.service';

describe('Centro legal, derechos de datos y PQRS', () => {
  it('registra la versión exacta de un documento aceptado', async () => {
    const user = await makeUser();
    const document = await LegalDocument.create({ kind: 'privacy', version: '2026.08', title: 'Datos', content: 'Política de prueba suficientemente clara.', effectiveAt: new Date() });
    await request(app).post(`/api/v1/legal/documents/${document._id}/accept`).set(await authHeader(user)).expect(200);
    const record = await LegalAcceptance.findOne({ userId: user._id, documentId: document._id });
    expect(record?.version).toBe('2026.08');
    expect(record?.ipHash).not.toBe('');
    // Con clave: no coincide con el SHA-256 sin sal de ninguna IP de prueba.
    const crypto = await import('crypto');
    for (const ip of ['::ffff:127.0.0.1', '127.0.0.1', '::1']) {
      expect(record?.ipHash).not.toBe(crypto.createHash('sha256').update(ip).digest('hex').slice(0, 32));
    }
  });

  it('pendientes: términos y privacidad vigentes sin aceptar, y otra vez al publicar versión nueva', async () => {
    const user = await makeUser();
    const header = await authHeader(user);
    // Sin nada publicado, la app no pide nada.
    expect((await request(app).get('/api/v1/legal/pending').set(header).expect(200)).body.data).toEqual([]);

    const mk = (kind: string, version: string) =>
      LegalDocument.create({ kind, version, title: kind, content: 'Texto de prueba suficientemente claro.', effectiveAt: new Date() });
    const terms = await mk('terms', '1.0');
    const privacy = await mk('privacy', '1.0');
    await mk('promotions', '1.0'); // no exigido

    let pending = (await request(app).get('/api/v1/legal/pending').set(header).expect(200)).body.data;
    expect(pending.map((d: { kind: string }) => d.kind).sort()).toEqual(['privacy', 'terms']);
    expect(pending.every((d: { isUpdate: boolean }) => d.isUpdate === false)).toBe(true);

    await request(app).post(`/api/v1/legal/documents/${terms._id}/accept`).set(header).expect(200);
    await request(app).post(`/api/v1/legal/documents/${privacy._id}/accept`).set(header).expect(200);
    expect((await request(app).get('/api/v1/legal/pending').set(header).expect(200)).body.data).toEqual([]);

    // Versión nueva de términos: la anterior se archiva y se vuelve a pedir, marcada como actualización.
    await LegalDocument.updateOne({ _id: terms._id }, { $set: { isActive: false } });
    await mk('terms', '2.0');
    pending = (await request(app).get('/api/v1/legal/pending').set(header).expect(200)).body.data;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ kind: 'terms', version: '2.0', isUpdate: true });
  });

  it('permite crear, consultar y responder una PQRS sin exponer la de otros usuarios', async () => {
    const client = await makeUser(); const other = await makeUser(); const admin = await makeUser({ role: UserRole.ADMIN });
    const create = await request(app).post('/api/v1/pqrs').set(await authHeader(client)).send({ type: 'claim', subject: 'Pedido incompleto', detail: 'Faltó un producto en la entrega solicitada.' }).expect(201);
    await request(app).post(`/api/v1/pqrs/${create.body.data._id}/evidence`).set(await authHeader(client)).send({ url: 'https://example.com/evidence.jpg', name: 'foto.jpg' }).expect(201);
    const mine = await request(app).get('/api/v1/pqrs/my').set(await authHeader(client)).expect(200);
    expect(mine.body.data).toHaveLength(1);
    await request(app).get('/api/v1/pqrs/my').set(await authHeader(other)).expect(200).expect((res) => expect(res.body.data).toHaveLength(0));
    await request(app).patch(`/api/v1/pqrs/${create.body.data._id}/respond`).set(await authHeader(admin)).send({ message: 'Revisaremos tu caso.', status: 'answered' }).expect(200);
    expect((await Pqrs.findById(create.body.data._id))?.responses).toHaveLength(1);
  });

  it('registra solicitudes de derechos de datos y solo permite su gestión administrativa', async () => {
    const client = await makeUser(); const admin = await makeUser({ role: UserRole.ADMIN });
    const created = await request(app).post('/api/v1/legal/data-requests').set(await authHeader(client)).send({ type: 'access', detail: 'Solicito una copia de mis datos personales.' }).expect(201);
    await request(app).patch(`/api/v1/legal/admin/data-requests/${created.body.data._id}`).set(await authHeader(client)).send({ status: 'resolved', response: 'No autorizado' }).expect(403);
    await request(app).patch(`/api/v1/legal/admin/data-requests/${created.body.data._id}`).set(await authHeader(admin)).send({ status: 'resolved', response: 'Se preparó la copia solicitada.' }).expect(200);
  });
});

/**
 * Documentos del domiciliario.
 *
 * Lo que se prueba aquí es sobre todo una regla: no se da de alta a nadie
 * con un número escrito a mano. Durante un tiempo esto aceptaba
 * `{ reference: 'LIC-123' }` y devolvía 201, y la cola de revisión del
 * admin era un trámite de aprobar cifras que nadie podía contrastar.
 */
describe('Documentos de domiciliario', () => {
  /** Un JPEG mínimo. Basta: la subida real está mockeada. */
  const photo = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

  beforeEach(() => {
    // Cloudinary no se toca en pruebas. Se intercepta el único punto donde
    // el servicio sale a la red, no la librería entera: así, si mañana el
    // método cambia de nombre, la prueba se rompe en vez de pasar por un
    // mock que ya no intercepta nada.
    vi.spyOn(driverService as any, 'storeDocumentImage').mockResolvedValue(
      'https://cdn.zipp.test/driver-documents/licencia.jpg'
    );
  });

  afterEach(() => vi.restoreAllMocks());

  const submit = async (user: any, fields: Record<string, string>, withPhoto = true) => {
    const req = request(app).post('/api/v1/drivers/documents').set(await authHeader(user));
    for (const [k, v] of Object.entries(fields)) req.field(k, v);
    if (withPhoto) req.attach('image', photo, 'licencia.jpg');
    return req;
  };

  it('recibe documentos con foto y exige revisión administrativa', async () => {
    const driverUser = await makeUser({ role: UserRole.DRIVER });
    const driver = await makeDriver(driverUser._id);
    const admin = await makeUser({ role: UserRole.ADMIN });

    const submitted = await submit(driverUser, {
      type: 'license',
      reference: 'LIC-123',
      expiresAt: '2027-01-01',
    });

    expect(submitted.status).toBe(201);
    expect(submitted.body.data.status).toBe('pending');
    expect(submitted.body.data.imageUrl).toContain('driver-documents');

    await request(app)
      .patch(`/api/v1/drivers/documents/${submitted.body.data._id}/review`)
      .set(await authHeader(admin))
      .send({ status: 'approved' })
      .expect(200);

    expect((await DriverDocument.findOne({ driverId: driver._id, type: 'license' }))?.status).toBe('approved');
  });

  it('rechaza un documento nuevo sin foto', async () => {
    // La regla entera. Un número suelto es un dato, no una prueba.
    const driverUser = await makeUser({ role: UserRole.DRIVER });
    await makeDriver(driverUser._id);

    expect((await submit(driverUser, { type: 'soat', reference: 'SOAT-9' }, false)).status).toBe(400);
  });

  it('deja corregir el número sin volver a fotografiar el documento', async () => {
    // Una errata en un dígito no debería costar levantarse a buscar la
    // cédula otra vez: la foto que ya está en el servidor sigue valiendo.
    const driverUser = await makeUser({ role: UserRole.DRIVER });
    const driver = await makeDriver(driverUser._id);

    expect((await submit(driverUser, { type: 'identity', reference: '1075-MAL' })).status).toBe(201);
    const fixed = await submit(driverUser, { type: 'identity', reference: '1075-BIEN' }, false);
    expect(fixed.status).toBe(201);

    expect(fixed.body.data.reference).toBe('1075-BIEN');
    expect(fixed.body.data.imageUrl).toContain('driver-documents');
    expect(await DriverDocument.countDocuments({ driverId: driver._id, type: 'identity' })).toBe(1);
  });

  it('un reenvío vuelve a dejar el documento sin revisar', async () => {
    // Aunque la foto sea la misma: un documento cambiado después de
    // aprobarse es un documento que nadie ha mirado en su forma actual.
    const driverUser = await makeUser({ role: UserRole.DRIVER });
    const driver = await makeDriver(driverUser._id);
    const admin = await makeUser({ role: UserRole.ADMIN });

    const first = await submit(driverUser, { type: 'license', reference: 'LIC-1' });
    expect(first.status).toBe(201);
    await request(app)
      .patch(`/api/v1/drivers/documents/${first.body.data._id}/review`)
      .set(await authHeader(admin))
      .send({ status: 'approved' })
      .expect(200);

    expect((await submit(driverUser, { type: 'license', reference: 'LIC-2' })).status).toBe(201);

    const saved = await DriverDocument.findOne({ driverId: driver._id, type: 'license' });
    expect(saved?.status).toBe('pending');
    expect(saved?.reviewedAt).toBeFalsy();
  });

  it('rechaza un número demasiado corto para ser un documento', async () => {
    const driverUser = await makeUser({ role: UserRole.DRIVER });
    await makeDriver(driverUser._id);

    expect((await submit(driverUser, { type: 'soat', reference: 'X' })).status).toBe(400);
  });
});
