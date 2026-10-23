import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { COLLECTIONS, ensureIndexes } from '../data/db.js';
import { startMongo } from '../testing/mongo.js';
import { DeleteTenantError, deleteTenantData } from './deleteTenant.js';

let mongo;
let db;
const A = new ObjectId();
const B = new ObjectId();
const ana = new ObjectId();
const luis = new ObjectId();
const maria = new ObjectId();

beforeAll(async () => {
  mongo = await startMongo('lulubiz_delete_tenant_test');
  db = mongo.db;
});

afterAll(async () => {
  await mongo?.stop();
});

beforeEach(async () => {
  await db.dropDatabase();
  await ensureIndexes(db);
  await db.collection(COLLECTIONS.tenants).insertMany([{ _id: A, name: 'Andina SAS' }, { _id: B, name: 'Otra SAS' }]);
  await db.collection(COLLECTIONS.users).insertMany([
    { _id: ana, email: 'ana@andina.co' },
    { _id: luis, email: 'luis@otra.co' },
    { _id: maria, email: 'maria@ambas.co' },
  ]);
  await db.collection(COLLECTIONS.memberships).insertMany([
    { tenantId: A, userId: ana, role: 'owner' },
    { tenantId: A, userId: maria, role: 'admin' },
    { tenantId: B, userId: luis, role: 'owner' },
    { tenantId: B, userId: maria, role: 'viewer' },
  ]);
  await db.collection(COLLECTIONS.accounts).insertMany([
    { tenantId: A, code: '1' },
    { tenantId: A, code: '2' },
    { tenantId: B, code: '1' },
  ]);
  await db.collection(COLLECTIONS.journals).insertOne({ tenantId: A, number: 1 });
  await db.collection(COLLECTIONS.audit).insertOne({ tenantId: A, action: 'x' });
  await db.collection(COLLECTIONS.apiKeys).insertOne({ tenantId: A, prefix: 'abcd1234' });
  await db.collection(COLLECTIONS.sessions).insertOne({ userId: ana, tokenHash: 'h' });
});

const count = (name, tenantId) => db.collection(name).countDocuments(tenantId ? { tenantId } : {});

describe('borrado definitivo de una empresa', () => {
  it('por defecto solo cuenta: no borra nada y dice qué cuentas quedarían sin empresa', async () => {
    const result = await deleteTenantData(db, A);
    expect(result).toMatchObject({ deleted: false, name: 'Andina SAS', orphanUsers: ['ana@andina.co'] });
    expect(result.counts).toMatchObject({ accounts: 2, journals: 1, audit: 1, apiKeys: 1, memberships: 2 });
    expect(await count(COLLECTIONS.accounts, A)).toBe(2);
    expect(await count(COLLECTIONS.tenants)).toBe(2);
  });

  it('exige el nombre exacto y la confirmación de que el cliente recibió su exportación', async () => {
    const attempt = (options) => deleteTenantData(db, A, { apply: true, ...options });
    await expect(attempt({})).rejects.toThrow(DeleteTenantError);
    await expect(attempt({ confirmName: 'andina sas', exportDelivered: true })).rejects.toThrow(/nombre/);
    await expect(attempt({ confirmName: 'Andina SAS' })).rejects.toMatchObject({ code: 'EXPORT_NOT_CONFIRMED' });
    await expect(attempt({ confirmName: 'Otra SAS', exportDelivered: true })).rejects.toThrow(/nombre/);
    expect(await count(COLLECTIONS.accounts, A)).toBe(2);
    expect(await count(COLLECTIONS.tenants)).toBe(2);
  });

  it('borra todo lo de la empresa, incluido el libro y la auditoría, sin tocar a otra ni a las cuentas de usuario', async () => {
    const result = await deleteTenantData(db, A, { apply: true, confirmName: 'Andina SAS', exportDelivered: true });
    expect(result.deleted).toBe(true);
    for (const name of [COLLECTIONS.accounts, COLLECTIONS.journals, COLLECTIONS.audit, COLLECTIONS.apiKeys, COLLECTIONS.memberships]) expect(await count(name, A)).toBe(0);
    expect(await db.collection(COLLECTIONS.tenants).findOne({ _id: A })).toBeNull();
    expect(await count(COLLECTIONS.accounts, B)).toBe(1);
    expect(await count(COLLECTIONS.memberships, B)).toBe(2);
    expect(await db.collection(COLLECTIONS.tenants).findOne({ _id: B })).not.toBeNull();
    expect(await count(COLLECTIONS.users)).toBe(3);
    expect(await count(COLLECTIONS.sessions)).toBe(1);
  });

  it('rechaza una empresa que no existe, y repetir tras borrarla también', async () => {
    await expect(deleteTenantData(db, new ObjectId())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await deleteTenantData(db, A, { apply: true, confirmName: 'Andina SAS', exportDelivered: true });
    await expect(deleteTenantData(db, A)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
