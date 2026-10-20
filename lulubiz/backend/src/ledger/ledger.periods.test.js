import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAccountService } from '../accounts/accounts.js';
import { toTenantId } from '../core/tenant.js';
import { COLLECTIONS, ensureIndexes } from '../data/db.js';
import { startMongo } from '../testing/mongo.js';
import { PeriodClosedError, createLedger } from './ledger.js';

let mongo;
let db;
let ledger;
let accounts;
let tenant;
let other;
const user = new ObjectId();

const code = (promise) => promise.then(() => null, (err) => err.code ?? err.name);

const entry = (key, { date = '2026-10-15T12:00:00Z', docType = 'FV', amount = 1_000, debit = '110505' } = {}) => ({
  docType,
  date: new Date(date),
  currency: 'COP',
  idempotencyKey: key,
  lines: [
    { accountId: debit, debit: amount },
    { accountId: '413505', credit: amount },
  ],
});

async function openChart(tenantId) {
  await accounts.create(tenantId, { code: '1', name: 'Activo', type: 'asset', postable: false });
  await accounts.create(tenantId, { code: '110505', name: 'Caja', type: 'asset', parentCode: '1' });
  await accounts.create(tenantId, { code: '130505', name: 'Clientes', type: 'asset', parentCode: '1' });
  await accounts.create(tenantId, { code: '4', name: 'Ingresos', type: 'income', postable: false });
  await accounts.create(tenantId, { code: '413505', name: 'Ventas', type: 'income', parentCode: '4' });
}

beforeAll(async () => {
  mongo = await startMongo('lulubiz_periods_test');
  db = mongo.db;
  ledger = createLedger(mongo.client, db);
  accounts = createAccountService(mongo.client, db);
});

afterAll(async () => {
  await mongo?.stop();
});

beforeEach(async () => {
  await db.dropDatabase();
  await ensureIndexes(db);
  tenant = toTenantId(new ObjectId());
  other = toTenantId(new ObjectId());
  await openChart(tenant);
  await openChart(other);
});

describe('cierre de períodos', () => {
  it('un período cerrado rechaza asientos y reversiones fechados en él, y se reabre', async () => {
    const { journal } = await ledger.postJournal(tenant, entry('a1'));
    await ledger.closePeriod(tenant, '2026-10', user);

    await expect(ledger.postJournal(tenant, entry('a2'))).rejects.toBeInstanceOf(PeriodClosedError);
    await expect(
      ledger.reverseJournal(tenant, journal._id, { idempotencyKey: 'r1', date: new Date('2026-10-20T12:00:00Z') }),
    ).rejects.toBeInstanceOf(PeriodClosedError);

    // Otro período sigue abierto, y una reversión fechada ahí corrige el asiento sin tocar el cerrado.
    const nov = await ledger.postJournal(tenant, entry('a3', { date: '2026-11-02T12:00:00Z' }));
    expect(nov.replayed).toBe(false);
    const reversal = await ledger.reverseJournal(tenant, journal._id, { idempotencyKey: 'r2', date: new Date('2026-11-05T12:00:00Z') });
    expect(reversal.journal.period).toBe('2026-11');

    await ledger.reopenPeriod(tenant, '2026-10', user);
    expect((await ledger.postJournal(tenant, entry('a4'))).replayed).toBe(false);
  });

  it('valida el formato y los estados', async () => {
    expect(await code(ledger.closePeriod(tenant, '2026-13', user))).toBe('LedgerValidationError');
    expect(await code(ledger.closePeriod(tenant, 'octubre', user))).toBe('LedgerValidationError');
    expect(await code(ledger.closePeriod(tenant, '2026-10', user))).toBeNull();
    expect(await code(ledger.closePeriod(tenant, '2026-10', user))).toBe('ALREADY_CLOSED');
    expect(await code(ledger.reopenPeriod(tenant, '2026-11', user))).toBe('NOT_CLOSED');
  });

  it('el cierre de una empresa no afecta a otra', async () => {
    await ledger.closePeriod(tenant, '2026-10', user);
    expect((await ledger.postJournal(other, entry('b1'))).replayed).toBe(false);
  });

  it('repetir un asiento ya registrado en un período luego cerrado devuelve el original', async () => {
    const first = await ledger.postJournal(tenant, entry('a1'));
    await ledger.closePeriod(tenant, '2026-10', user);
    const again = await ledger.postJournal(tenant, entry('a1'));
    expect(again.replayed).toBe(true);
    expect(again.journal._id.equals(first.journal._id)).toBe(true);
  });

  it('cierre y asientos simultáneos: cada asiento queda registrado o rechazado, nunca a medias', async () => {
    const posts = Array.from({ length: 8 }, (_, i) =>
      ledger.postJournal(tenant, entry(`c${i}`, { amount: 500 })).then(
        () => 'ok',
        (err) => err.name,
      ),
    );
    const closing = ledger.closePeriod(tenant, '2026-10', user);
    const outcomes = await Promise.all([...posts, closing.then(() => 'closed')]);

    expect(outcomes.filter((o) => o === 'closed')).toHaveLength(1);
    expect(outcomes.every((o) => ['ok', 'PeriodClosedError', 'closed'].includes(o))).toBe(true);

    const committed = outcomes.filter((o) => o === 'ok').length;
    expect(await db.collection(COLLECTIONS.journals).countDocuments({ tenantId: tenant })).toBe(committed);
    expect(await ledger.getBalance(tenant, '110505', '2026-10', 'COP')).toEqual({ debit: committed * 500, credit: 0 });
    // Con el período ya cerrado, ningún asiento nuevo entra.
    await expect(ledger.postJournal(tenant, entry('tarde'))).rejects.toBeInstanceOf(PeriodClosedError);
  });

  it('lista los períodos con su estado', async () => {
    await ledger.postJournal(tenant, entry('a1'));
    await ledger.postJournal(tenant, entry('a2', { date: '2026-11-03T12:00:00Z' }));
    await ledger.closePeriod(tenant, '2026-10', user);
    const list = await ledger.listPeriods(tenant);
    expect(list.map((p) => [p.period, p.status])).toEqual([['2026-11', 'open'], ['2026-10', 'closed']]);
  });
});

describe('listado de asientos', () => {
  beforeEach(async () => {
    await ledger.postJournal(tenant, entry('l1', { date: '2026-09-10T12:00:00Z', docType: 'FV' }));
    await ledger.postJournal(tenant, entry('l2', { date: '2026-10-10T12:00:00Z', docType: 'FV' }));
    await ledger.postJournal(tenant, entry('l3', { date: '2026-10-11T12:00:00Z', docType: 'RC', debit: '130505' }));
    await ledger.postJournal(tenant, entry('l4', { date: '2026-10-12T12:00:00Z', docType: 'FV' }));
    await ledger.postJournal(other, entry('x1'));
  });

  it('devuelve el más reciente primero y filtra por período, tipo y cuenta', async () => {
    const all = await ledger.listJournals(tenant);
    expect(all.items.map((j) => j.idempotencyKey)).toEqual(['l4', 'l3', 'l2', 'l1']);
    expect((await ledger.listJournals(tenant, { period: '2026-10' })).items).toHaveLength(3);
    expect((await ledger.listJournals(tenant, { docType: 'RC' })).items.map((j) => j.idempotencyKey)).toEqual(['l3']);
    expect((await ledger.listJournals(tenant, { accountId: '130505' })).items.map((j) => j.idempotencyKey)).toEqual(['l3']);
    expect(await code(ledger.listJournals(tenant, { period: 'xx' }))).toBe('LedgerValidationError');
  });

  it('pagina con cursor sin repetir ni saltar, y no mezcla empresas', async () => {
    const first = await ledger.listJournals(tenant, { limit: 3 });
    expect(first.items).toHaveLength(3);
    const second = await ledger.listJournals(tenant, { limit: 3, cursor: first.nextCursor });
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    const ids = new Set([...first.items, ...second.items].map((j) => j._id.toHexString()));
    expect(ids.size).toBe(4);
    expect((await ledger.listJournals(other)).items).toHaveLength(1);
  });

  it('marca los asientos revertidos y limita el tamaño de página', async () => {
    const target = (await ledger.listJournals(tenant, { docType: 'RC' })).items[0];
    const reversal = await ledger.reverseJournal(tenant, target._id, { idempotencyKey: 'rv', date: new Date('2026-10-20T12:00:00Z') });
    const listed = (await ledger.listJournals(tenant, { docType: 'RC' })).items;
    const original = listed.find((j) => j._id.equals(target._id));
    expect(original.reversedByJournalId.equals(reversal.journal._id)).toBe(true);
    expect((await ledger.listJournals(tenant, { limit: 100_000 })).items.length).toBeLessThanOrEqual(50);
  });
});

describe('atomicidad', () => {
  /** Base de datos cuyo `balances.updateOne` falla en la segunda llamada: simula una caída a mitad de la transacción. */
  function flakyDb() {
    let calls = 0;
    const wrap = (collection) =>
      new Proxy(collection, {
        get(target, prop) {
          if (prop === 'updateOne') {
            return async (...args) => {
              calls += 1;
              if (calls === 2) throw new Error('fallo simulado a mitad de la transacción');
              return target.updateOne(...args);
            };
          }
          const value = target[prop];
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    return new Proxy(db, {
      get(target, prop) {
        if (prop === 'collection') {
          return (name) => (name === COLLECTIONS.balances ? wrap(target.collection(name)) : target.collection(name));
        }
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  it('un fallo después de insertar el asiento no deja asiento, saldos ni consecutivo consumido', async () => {
    const broken = createLedger(mongo.client, flakyDb());
    await expect(broken.postJournal(tenant, entry('f1'))).rejects.toThrow(/fallo simulado/);

    expect(await db.collection(COLLECTIONS.journals).countDocuments({ tenantId: tenant })).toBe(0);
    expect(await db.collection(COLLECTIONS.balances).countDocuments({ tenantId: tenant })).toBe(0);
    expect((await db.collection(COLLECTIONS.counters).findOne({ tenantId: tenant, docType: 'FV' })).last).toBe(0);
    expect((await db.collection(COLLECTIONS.periods).findOne({ tenantId: tenant, period: '2026-10' })).seq).toBe(0);

    // La misma operación sobre una base sana funciona y toma el número 1: nada quedó consumido.
    const ok = await ledger.postJournal(tenant, entry('f1'));
    expect(ok.journal.number).toBe(1);
  });

  it('si falla el evento de auditoría (inTx), el asiento tampoco se confirma', async () => {
    const failing = () => Promise.reject(new Error('auditoría caída'));
    await expect(ledger.postJournal(tenant, entry('f2'), { inTx: failing })).rejects.toThrow(/auditoría caída/);
    expect(await db.collection(COLLECTIONS.journals).countDocuments({ tenantId: tenant })).toBe(0);
    expect(await ledger.getBalance(tenant, '110505', '2026-10', 'COP')).toEqual({ debit: 0, credit: 0 });
    expect((await db.collection(COLLECTIONS.counters).findOne({ tenantId: tenant, docType: 'FV' })).last).toBe(0);
  });

  it('inTx solo se invoca cuando se escribe algo nuevo, no en una repetición', async () => {
    let calls = 0;
    const inTx = async () => {
      calls += 1;
    };
    await ledger.postJournal(tenant, entry('f3'), { inTx });
    await ledger.postJournal(tenant, entry('f3'), { inTx });
    expect(calls).toBe(1);
  });

  it('crear una cuenta con inTx que falla no deja la cuenta creada', async () => {
    await expect(
      accounts.create(tenant, { code: '999', name: 'Prueba', type: 'asset' }, { inTx: () => Promise.reject(new Error('auditoría caída')) }),
    ).rejects.toThrow(/auditoría caída/);
    expect(await accounts.get(tenant, '999')).toBeNull();
  });

  it('la siembra del plan es todo o nada', async () => {
    const chart = [
      { code: '2', name: 'Pasivo', type: 'liability', postable: false },
      { code: '21', name: 'Obligaciones', type: 'liability', parentCode: '2', postable: false },
      { code: '22', name: 'Proveedores', type: 'asset', parentCode: '2', postable: false }, // tipo distinto del padre: inválida
    ];
    await expect(accounts.seed(tenant, chart)).rejects.toThrow(/mismo tipo/);
    expect(await accounts.get(tenant, '2')).toBeNull();
    expect(await accounts.get(tenant, '21')).toBeNull();
  });
});
