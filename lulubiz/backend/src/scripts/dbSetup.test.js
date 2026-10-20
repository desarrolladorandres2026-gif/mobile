import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpAt } from '../auth/totp.js';
import { COLLECTIONS } from '../data/db.js';
import { buildApp } from '../http/app.js';
import { loadConfig } from '../http/config.js';
import { createMemoryMailer } from '../mail/mailer.js';
import { startMongoWithAuth } from '../testing/mongo.js';
import { appPrivileges, setupDatabase } from './dbSetup.js';

const DB = 'lulubiz_perm';
const APP_USER = 'lulubiz_app';
const APP_PASSWORD = 'clave-de-aplicacion-1234';
const PASSWORD = 'correcto-caballo-grapa';
const FAST = { N: 2 ** 10, r: 8, p: 1 };

let mongo;
let appClient;
let db;

/** La operación debe fallar por falta de permisos (código 13), no por otra razón. */
async function denied(promise) {
  const err = await promise.then(() => null, (e) => e);
  expect(err, 'la operación debería haberse rechazado').not.toBeNull();
  expect(err.codeName ?? err.message).toMatch(/Unauthorized|not authorized/i);
}

beforeAll(async () => {
  mongo = await startMongoWithAuth();
  await setupDatabase({ adminClient: mongo.rootClient, dbName: DB, appUser: APP_USER, appPassword: APP_PASSWORD });
  appClient = await mongo.connectAs(APP_USER, APP_PASSWORD);
  db = appClient.db(DB);
});

afterAll(async () => {
  await appClient?.close();
  await mongo?.stop();
});

describe('permisos de la aplicación contra una base de datos con autenticación real', () => {
  it('toda la aplicación funciona de punta a punta con solo esos permisos', async () => {
    const mailer = createMemoryMailer();
    const config = loadConfig({});
    config.mfaEncryptionKey = Buffer.alloc(32, 9).toString('base64');
    config.rateLimit = { ...config.rateLimit, global: { max: 10_000, timeWindow: '1 minute' } };
    const app = await buildApp({ client: appClient, db, config, mailer, passwordParams: FAST, reporter: { report: async () => true } });

    const call = async (method, url, { cookie, body, headers } = {}) => {
      const res = await app.inject({ method, url, headers: { ...(cookie ? { cookie } : {}), ...headers }, ...(body !== undefined ? { payload: body } : {}) });
      expect(res.statusCode, `${method} ${url} → ${res.body}`).toBeLessThan(500);
      return res;
    };
    const ok = async (...args) => {
      const res = await call(...args);
      expect(res.statusCode, `${args[0]} ${args[1]} → ${res.body}`).toBeLessThan(400);
      return res;
    };
    const token = (to) => decodeURIComponent(mailer.last(to).text.match(/#token=([^\s]+)/)[1]);
    const cookieOf = (res) => `${res.cookies[0].name}=${res.cookies[0].value}`;

    // Cuenta, correo y sesión.
    const { tenantId } = (await ok('POST', '/v1/auth/register', { body: { companyName: 'Permisos SAS', country: 'CO', currency: 'COP', ownerName: 'Ana', email: 'ana@perm.co', password: PASSWORD } })).json();
    await ok('POST', '/v1/auth/verify-email', { body: { token: token('ana@perm.co') } });
    const cookie = cookieOf(await ok('POST', '/v1/auth/login', { body: { email: 'ana@perm.co', password: PASSWORD } }));
    const base = `/v1/tenants/${tenantId}`;

    // Plan de cuentas y terceros.
    await ok('POST', `${base}/accounts/seed`, { cookie });
    await ok('POST', `${base}/accounts`, { cookie, body: { code: '110505', name: 'Caja', type: 'asset', parentCode: '11' } });
    await ok('POST', `${base}/accounts`, { cookie, body: { code: '413505', name: 'Ventas', type: 'income', parentCode: '41' } });
    await ok('POST', `${base}/accounts`, { cookie, body: { code: '110510', name: 'Cajas menores', type: 'asset', parentCode: '11' } });
    await ok('POST', `${base}/accounts/110510/deactivate`, { cookie });
    const party = (await ok('POST', `${base}/parties`, { cookie, body: { name: 'Droguería Los Andes', roles: ['customer'], taxIdType: 'NIT', taxId: '890903938', checkDigit: 8 } })).json();
    await ok('PATCH', `${base}/parties/${party._id}`, { cookie, body: { phone: '3001234567' } });
    await ok('POST', `${base}/parties/${party._id}/active`, { cookie, body: { active: false } });

    // Libro: asiento, reversión, listados, saldos y períodos.
    const entry = { docType: 'CC', date: '2026-10-15T12:00:00Z', currency: 'COP', lines: [{ accountId: '110505', debit: 5000 }, { accountId: '413505', credit: 5000 }] };
    const posted = (await ok('POST', `${base}/journals`, { cookie, body: entry, headers: { 'idempotency-key': 'permisos-0001' } })).json();
    await ok('POST', `${base}/journals/${posted.journal._id}/reverse`, { cookie, headers: { 'idempotency-key': 'permisos-rev-1' } });
    await ok('GET', `${base}/journals`, { cookie });
    await ok('GET', `${base}/balances?account=110505&period=2026-10&currency=COP`, { cookie });
    await ok('POST', `${base}/periods/2026-09/close`, { cookie });
    await ok('POST', `${base}/periods/2026-09/reopen`, { cookie });

    // Miembros: invitar, aceptar, cambiar rol, quitar.
    const invite = await call('POST', '/v1/auth/register', { body: { companyName: 'Otra', country: 'CO', currency: 'COP', ownerName: 'Beto', email: 'beto@perm.co', password: PASSWORD } });
    expect(invite.statusCode).toBe(201);
    const betoCookie = cookieOf(await ok('POST', '/v1/auth/login', { body: { email: 'beto@perm.co', password: PASSWORD } }));
    await ok('POST', `${base}/members`, { cookie, body: { email: 'beto@perm.co', role: 'viewer' } });
    await ok('POST', '/v1/invitations/accept', { cookie: betoCookie, body: { token: token('beto@perm.co') } });
    await ok('PATCH', `${base}/members/${invite.json().userId}`, { cookie, body: { role: 'accountant' } });
    await ok('DELETE', `${base}/members/${invite.json().userId}`, { cookie });
    await ok('GET', `${base}/audit`, { cookie });

    // Facturación: configuración, resoluciones, factura, nota crédito y su contabilización.
    await ok('POST', `${base}/accounts`, { cookie, body: { code: '130505', name: 'Clientes', type: 'asset', parentCode: '13' } });
    await ok('POST', `${base}/accounts`, { cookie, body: { code: '240805', name: 'IVA por pagar', type: 'liability', parentCode: '24' } });
    await ok('PUT', `${base}/invoicing/settings`, {
      cookie,
      body: {
        issuer: { name: 'Permisos SAS', taxIdType: 'NIT', taxId: '890903938', checkDigit: 8, regime: 'responsable_iva', address: { line: 'Calle 1', city: 'Garzón', region: 'Huila' } },
        accounts: { receivable: '130505', income: '413505', vatPayable: '240805' },
      },
    });
    for (const [docType, prefix] of [['invoice', 'FE'], ['credit_note', 'NC']]) {
      await ok('POST', `${base}/invoicing/resolutions`, { cookie, body: { docType, prefix, number: '1', from: 1, to: 50, validFrom: '2020-01-01', validTo: '2999-12-31' } });
    }
    const buyer = (await ok('POST', `${base}/parties`, { cookie, body: { name: 'Comprador SAS', roles: ['customer'], taxIdType: 'NIT', taxId: '800197268', checkDigit: 4 } })).json();
    const sale = (
      await ok('POST', `${base}/invoices`, {
        cookie,
        headers: { 'idempotency-key': 'permisos-factura-1' },
        body: { customerId: buyer._id, issueDate: new Date().toISOString().slice(0, 10), paymentMethod: 'cash', lines: [{ description: 'Servicio', quantity: 1000, unitPrice: 100000, vatBps: 1900 }] },
      })
    ).json();
    expect(sale.invoice.status).toBe('issued');
    const credit = await ok('POST', `${base}/invoices/${sale.invoice._id}/credit-notes`, { cookie, headers: { 'idempotency-key': 'permisos-nota-1' }, body: { reasonCode: '1', all: true } });
    expect(credit.json().note.status).toBe('issued');
    await ok('GET', `${base}/invoices`, { cookie });
    await ok('GET', `${base}/invoicing/status`, { cookie });

    // Dos pasos y recuperación de contraseña.
    const enroll = (await ok('POST', '/v1/auth/mfa/enroll', { cookie })).json();
    const { recoveryCodes } = (await ok('POST', '/v1/auth/mfa/confirm', { cookie, body: { code: totpAt(enroll.secret, Date.now()) } })).json();
    const challenge = (await ok('POST', '/v1/auth/login', { body: { email: 'ana@perm.co', password: PASSWORD } })).json().challenge;
    const second = await ok('POST', '/v1/auth/mfa/verify', { body: { challenge, code: recoveryCodes[0] } });
    await ok('POST', '/v1/auth/mfa/disable', { cookie: cookieOf(second), body: { password: PASSWORD, code: recoveryCodes[1] } });
    await ok('POST', '/v1/auth/password/forgot', { body: { email: 'ana@perm.co' } });
    await ok('POST', '/v1/auth/password/reset', { body: { token: token('ana@perm.co'), password: 'otra-clave-muy-larga-7' } });
    await ok('POST', '/v1/auth/logout', { cookie });
    expect((await call('GET', '/readyz')).json()).toEqual({ status: 'ready' });

    await app.close();
  });

  it('no puede editar ni borrar asientos ni eventos de auditoría', async () => {
    for (const name of [COLLECTIONS.journals, COLLECTIONS.audit]) {
      const col = db.collection(name);
      expect(await col.countDocuments()).toBeGreaterThan(0); // leer sí puede
      await denied(col.updateOne({}, { $set: { alterado: true } }));
      await denied(col.updateMany({}, { $set: { alterado: true } }));
      await denied(col.replaceOne({}, { alterado: true }));
      await denied(col.findOneAndUpdate({}, { $set: { alterado: true } }));
      await denied(col.deleteOne({}));
      await denied(col.deleteMany({}));
      await denied(col.findOneAndDelete({}));
      await denied(col.drop());
    }
  });

  it('no puede borrar saldos, contadores, períodos, cuentas, terceros, empresas ni usuarios', async () => {
    for (const name of [COLLECTIONS.balances, COLLECTIONS.counters, COLLECTIONS.periods, COLLECTIONS.accounts, COLLECTIONS.parties, COLLECTIONS.tenants, COLLECTIONS.users]) {
      await denied(db.collection(name).deleteOne({}));
      await denied(db.collection(name).deleteMany({}));
    }
  });

  it('solo puede borrar lo que caduca o se retira: sesiones, tokens y membresías', async () => {
    await db.collection(COLLECTIONS.sessions).deleteMany({});
    await db.collection(COLLECTIONS.tokens).deleteMany({});
    await db.collection(COLLECTIONS.memberships).deleteOne({ _id: null });
  });

  it('no puede crear ni borrar colecciones, índices ni bases de datos, ni sobrescribir con $out', async () => {
    await denied(db.collection(COLLECTIONS.journals).createIndex({ trampa: 1 }));
    await denied(db.collection(COLLECTIONS.journals).dropIndex('tenant_recent'));
    await denied(db.createCollection('coleccion_nueva'));
    await denied(db.dropDatabase());
    await denied(db.collection(COLLECTIONS.journals).aggregate([{ $match: {} }, { $out: COLLECTIONS.journals }]).toArray());
    await denied(db.collection(COLLECTIONS.journals).aggregate([{ $match: {} }, { $out: 'copia_robada' }]).toArray());
  });

  it('no puede leer otras bases ni administrar usuarios', async () => {
    await denied(appClient.db('admin').collection('system.users').find({}).toArray());
    await denied(appClient.db('otra_base').collection('x').insertOne({ a: 1 }));
    await denied(appClient.db('admin').command({ createUser: 'intruso', pwd: 'clave-intrusa-12345', roles: ['root'] }));
  });
});

describe('preparación de la base de datos', () => {
  it('es repetible: actualiza el rol y rota la contraseña, y la anterior deja de servir', async () => {
    const again = await setupDatabase({ adminClient: mongo.rootClient, dbName: DB, appUser: APP_USER, appPassword: 'clave-rotada-de-aplicacion-5678' });
    expect(again).toMatchObject({ roleCreated: false, userCreated: false });
    await expect(mongo.connectAs(APP_USER, APP_PASSWORD).then((c) => c.db(DB).collection('journals').findOne({}))).rejects.toThrow();
    const fresh = await mongo.connectAs(APP_USER, 'clave-rotada-de-aplicacion-5678');
    expect(await fresh.db(DB).collection('journals').countDocuments()).toBeGreaterThan(0);
    await fresh.close();
  });

  it('rechaza una contraseña corta o ausente', async () => {
    await expect(setupDatabase({ adminClient: mongo.rootClient, dbName: DB, appUser: APP_USER, appPassword: 'corta' })).rejects.toThrow(/16 caracteres/);
    await expect(setupDatabase({ adminClient: mongo.rootClient, dbName: DB, appUser: APP_USER })).rejects.toThrow(/faltan/);
  });

  it('declara permisos solo para las colecciones conocidas y nunca da borrado en el libro ni en la auditoría', () => {
    const privileges = appPrivileges(DB);
    const byCollection = Object.fromEntries(privileges.map((p) => [p.resource.collection, p.actions]));
    expect(Object.keys(byCollection).sort()).toEqual(Object.values(COLLECTIONS).sort());
    expect(byCollection[COLLECTIONS.journals]).toEqual(['find', 'insert']);
    expect(byCollection[COLLECTIONS.audit]).toEqual(['find', 'insert']);
    for (const p of privileges) {
      expect(p.actions).not.toContain('dropCollection');
      expect(p.actions).not.toContain('createIndex');
    }
  });
});
