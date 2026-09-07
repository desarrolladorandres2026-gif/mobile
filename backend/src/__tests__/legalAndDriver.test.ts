import { describe, expect, it } from 'vitest';
import request from 'supertest';
import app from '../app';
import { DriverDocument, LegalAcceptance, LegalDocument, Pqrs } from '../models';
import { UserRole } from '../types';
import { authHeader, makeDriver, makeUser } from './factories';

describe('Centro legal, derechos de datos y PQRS', () => {
  it('registra la versión exacta de un documento aceptado', async () => {
    const user = await makeUser();
    const document = await LegalDocument.create({ kind: 'privacy', version: '2026.08', title: 'Datos', content: 'Política de prueba suficientemente clara.', effectiveAt: new Date() });
    await request(app).post(`/api/v1/legal/documents/${document._id}/accept`).set(authHeader(user)).expect(200);
    const record = await LegalAcceptance.findOne({ userId: user._id, documentId: document._id });
    expect(record?.version).toBe('2026.08');
    expect(record?.ipHash).not.toBe('');
  });

  it('permite crear, consultar y responder una PQRS sin exponer la de otros usuarios', async () => {
    const client = await makeUser(); const other = await makeUser(); const admin = await makeUser({ role: UserRole.ADMIN });
    const create = await request(app).post('/api/v1/pqrs').set(authHeader(client)).send({ type: 'claim', subject: 'Pedido incompleto', detail: 'Faltó un producto en la entrega solicitada.' }).expect(201);
    await request(app).post(`/api/v1/pqrs/${create.body.data._id}/evidence`).set(authHeader(client)).send({ url: 'https://example.com/evidence.jpg', name: 'foto.jpg' }).expect(201);
    const mine = await request(app).get('/api/v1/pqrs/my').set(authHeader(client)).expect(200);
    expect(mine.body.data).toHaveLength(1);
    await request(app).get('/api/v1/pqrs/my').set(authHeader(other)).expect(200).expect((res) => expect(res.body.data).toHaveLength(0));
    await request(app).patch(`/api/v1/pqrs/${create.body.data._id}/respond`).set(authHeader(admin)).send({ message: 'Revisaremos tu caso.', status: 'answered' }).expect(200);
    expect((await Pqrs.findById(create.body.data._id))?.responses).toHaveLength(1);
  });

  it('registra solicitudes de derechos de datos y solo permite su gestión administrativa', async () => {
    const client = await makeUser(); const admin = await makeUser({ role: UserRole.ADMIN });
    const created = await request(app).post('/api/v1/legal/data-requests').set(authHeader(client)).send({ type: 'access', detail: 'Solicito una copia de mis datos personales.' }).expect(201);
    await request(app).patch(`/api/v1/legal/admin/data-requests/${created.body.data._id}`).set(authHeader(client)).send({ status: 'resolved', response: 'No autorizado' }).expect(403);
    await request(app).patch(`/api/v1/legal/admin/data-requests/${created.body.data._id}`).set(authHeader(admin)).send({ status: 'resolved', response: 'Se preparó la copia solicitada.' }).expect(200);
  });
});

describe('Documentos de domiciliario', () => {
  it('recibe documentos y exige revisión administrativa fuera del modo de pruebas', async () => {
    const driverUser = await makeUser({ role: UserRole.DRIVER }); const driver = await makeDriver(driverUser._id); const admin = await makeUser({ role: UserRole.ADMIN });
    const submitted = await request(app).post('/api/v1/drivers/documents').set(authHeader(driverUser)).send({ type: 'license', reference: 'LIC-123', expiresAt: '2027-01-01' }).expect(201);
    expect(submitted.body.data.status).toBe('pending');
    await request(app).patch(`/api/v1/drivers/documents/${submitted.body.data._id}/review`).set(authHeader(admin)).send({ status: 'approved' }).expect(200);
    expect((await DriverDocument.findOne({ driverId: driver._id, type: 'license' }))?.status).toBe('approved');
  });
});
