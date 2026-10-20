import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { toTenantId } from '../core/tenant.js';
import { ensureIndexes } from '../data/db.js';
import { PUC_COLOMBIA_BORRADOR } from '../countries/co/puc.js';
import { startMongo } from '../testing/mongo.js';
import { AccountError, createAccountService } from './accounts.js';

let mongo;
let db;
let accounts;
let tenant;

beforeAll(async () => {
  mongo = await startMongo('lulubiz_accounts_test');
  db = mongo.db;
  accounts = createAccountService(mongo.client, db);
});

afterAll(async () => {
  await mongo?.stop();
});

beforeEach(async () => {
  await db.dropDatabase();
  await ensureIndexes(db);
  tenant = toTenantId(new ObjectId());
});

describe('plan de cuentas: creación', () => {
  it('deriva la naturaleza del tipo y exige explícita en cuentas de orden', async () => {
    const asset = await accounts.create(tenant, { code: '1', name: 'Activo', type: 'asset', postable: false });
    expect(asset.nature).toBe('debit');
    const income = await accounts.create(tenant, { code: '4', name: 'Ingresos', type: 'income', postable: false });
    expect(income.nature).toBe('credit');

    await expect(accounts.create(tenant, { code: '8', name: 'Orden', type: 'memo' })).rejects.toBeInstanceOf(AccountError);
    const memo = await accounts.create(tenant, { code: '8', name: 'Orden', type: 'memo', nature: 'debit' });
    expect(memo.nature).toBe('debit');
  });

  it('rechaza código inválido, tipo inválido, naturaleza contradictoria y duplicados', async () => {
    await expect(accounts.create(tenant, { code: '12a', name: 'x', type: 'asset' })).rejects.toThrow(/numérico/);
    await expect(accounts.create(tenant, { code: '1', name: 'x', type: 'otro' })).rejects.toThrow(/tipo de cuenta/);
    await expect(accounts.create(tenant, { code: '1', name: 'x', type: 'asset', nature: 'credit' })).rejects.toThrow(/naturaleza/);
    await accounts.create(tenant, { code: '1', name: 'Activo', type: 'asset', postable: false });
    await expect(accounts.create(tenant, { code: '1', name: 'Otra', type: 'asset' })).rejects.toThrow(/ya existe/);
  });

  it('valida la jerarquía: padre existente, de agrupación, mismo tipo y prefijo', async () => {
    await expect(accounts.create(tenant, { code: '11', name: 'x', type: 'asset', parentCode: '1' })).rejects.toThrow(/no existe/);
    await accounts.create(tenant, { code: '1', name: 'Activo', type: 'asset', postable: false });
    await accounts.create(tenant, { code: '4', name: 'Ingresos', type: 'income', postable: false });
    await expect(accounts.create(tenant, { code: '41', name: 'x', type: 'asset', parentCode: '4' })).rejects.toThrow(/mismo tipo/);
    await expect(accounts.create(tenant, { code: '21', name: 'x', type: 'asset', parentCode: '1' })).rejects.toThrow(/empezar/);

    await accounts.create(tenant, { code: '11', name: 'Disponible', type: 'asset', parentCode: '1' });
    await expect(accounts.create(tenant, { code: '1105', name: 'Caja', type: 'asset', parentCode: '11' })).rejects.toThrow(/agrupación/);
  });
});

describe('plan de cuentas: uso', () => {
  it('desactiva en vez de borrar y lista ordenado', async () => {
    await accounts.create(tenant, { code: '2', name: 'Pasivo', type: 'liability', postable: false });
    await accounts.create(tenant, { code: '1', name: 'Activo', type: 'asset', postable: false });
    await accounts.deactivate(tenant, '2');
    expect((await accounts.list(tenant)).map((a) => a.code)).toEqual(['1', '2']);
    expect((await accounts.list(tenant, { activeOnly: true })).map((a) => a.code)).toEqual(['1']);
    await expect(accounts.deactivate(tenant, '9')).rejects.toThrow(/no existe/);
  });

  it('una cuenta desactivada se puede reactivar, y reactivar una inexistente falla', async () => {
    await accounts.create(tenant, { code: '1', name: 'Activo', type: 'asset', postable: false });
    await accounts.deactivate(tenant, '1');
    expect((await accounts.get(tenant, '1')).active).toBe(false);
    await accounts.reactivate(tenant, '1');
    expect((await accounts.get(tenant, '1')).active).toBe(true);
    await expect(accounts.reactivate(tenant, '9')).rejects.toThrow(/no existe/);
    const other = toTenantId(new ObjectId());
    await expect(accounts.reactivate(other, '1')).rejects.toThrow(/no existe/); // no toca cuentas de otra empresa
  });

  it('cada empresa tiene su propio plan', async () => {
    const otra = toTenantId(new ObjectId());
    await accounts.create(tenant, { code: '1', name: 'Activo', type: 'asset', postable: false });
    expect(await accounts.get(otra, '1')).toBeNull();
    await accounts.create(otra, { code: '1', name: 'Activo', type: 'asset', postable: false });
  });
});

describe('paquete de Colombia (borrador)', () => {
  it('siembra clases y grupos, y repetirlo no duplica nada', async () => {
    const first = await accounts.seed(tenant, PUC_COLOMBIA_BORRADOR);
    expect(first.created).toBe(PUC_COLOMBIA_BORRADOR.length);
    const again = await accounts.seed(tenant, PUC_COLOMBIA_BORRADOR);
    expect(again.created).toBe(0);
    expect((await accounts.get(tenant, '11')).parentCode).toBe('1');
    expect((await accounts.get(tenant, '61')).nature).toBe('debit');
  });
});
