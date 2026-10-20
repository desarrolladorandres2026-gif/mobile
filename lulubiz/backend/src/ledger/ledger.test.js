import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAccountService } from '../accounts/accounts.js';
import { MoneyError } from '../core/money.js';
import { toTenantId } from '../core/tenant.js';
import { COLLECTIONS, ensureIndexes } from '../data/db.js';
import { TenantCollection } from '../data/tenantCollection.js';
import { startMongo } from '../testing/mongo.js';
import {
  JournalAlreadyReversedError,
  LedgerImbalanceError,
  LedgerValidationError,
  createLedger,
} from './ledger.js';

let mongo;
let client;
let db;
let ledger;
let accounts;
let tenantA;
let tenantB;

async function openChart(tenantId) {
  await accounts.create(tenantId, { code: '1', name: 'Activo', type: 'asset', postable: false });
  await accounts.create(tenantId, { code: '130505', name: 'Clientes', type: 'asset', parentCode: '1' });
  await accounts.create(tenantId, { code: '4', name: 'Ingresos', type: 'income', postable: false });
  await accounts.create(tenantId, { code: '413535', name: 'Ventas', type: 'income', parentCode: '4' });
}

const sale = (key, amount = 119_000) => ({
  docType: 'FV',
  date: new Date('2026-10-15T12:00:00Z'),
  currency: 'COP',
  idempotencyKey: key,
  lines: [
    { accountId: '130505', debit: amount },
    { accountId: '413535', credit: amount },
  ],
});

beforeAll(async () => {
  mongo = await startMongo();
  ({ client, db } = mongo);
  ledger = createLedger(client, db);
  accounts = createAccountService(mongo.client, db);
});

afterAll(async () => {
  await mongo?.stop();
});

beforeEach(async () => {
  await db.dropDatabase();
  await ensureIndexes(db);
  tenantA = toTenantId(new ObjectId());
  tenantB = toTenantId(new ObjectId());
  await openChart(tenantA);
  await openChart(tenantB);
});

describe('libro: validación', () => {
  it('rechaza un asiento descuadrado y no escribe nada', async () => {
    const input = sale('k1');
    input.lines = [
      { accountId: '130505', debit: 100 },
      { accountId: '413535', credit: 99 },
    ];
    await expect(ledger.postJournal(tenantA, input)).rejects.toBeInstanceOf(LedgerImbalanceError);
    expect(await db.collection(COLLECTIONS.journals).countDocuments()).toBe(0);
    expect(await db.collection(COLLECTIONS.balances).countDocuments()).toBe(0);
  });

  it('rechaza decimales y negativos', async () => {
    const decimal = sale('k2');
    decimal.lines = [
      { accountId: '130505', debit: 10.5 },
      { accountId: '413535', credit: 10.5 },
    ];
    await expect(ledger.postJournal(tenantA, decimal)).rejects.toBeInstanceOf(MoneyError);

    const negative = sale('k3');
    negative.lines = [
      { accountId: '130505', debit: -5 },
      { accountId: '413535', credit: -5 },
    ];
    await expect(ledger.postJournal(tenantA, negative)).rejects.toBeInstanceOf(LedgerValidationError);
  });

  it('rechaza una línea con débito y crédito a la vez, y una moneda desconocida', async () => {
    const both = sale('k4');
    both.lines = [
      { accountId: '130505', debit: 10, credit: 10 },
      { accountId: '413535', credit: 10 },
    ];
    await expect(ledger.postJournal(tenantA, both)).rejects.toBeInstanceOf(LedgerValidationError);

    await expect(ledger.postJournal(tenantA, { ...sale('k5'), currency: 'XXX' })).rejects.toBeInstanceOf(MoneyError);
  });
});

describe('libro: plan de cuentas', () => {
  const post = (tenantId, accountId, key) => ledger.postJournal(tenantId, {
    ...sale(key),
    lines: [
      { accountId, debit: 1_000 },
      { accountId: '413535', credit: 1_000 },
    ],
  });

  it('rechaza una cuenta inexistente, de agrupación o inactiva, sin escribir nada', async () => {
    await expect(post(tenantA, '999999', 'p1')).rejects.toThrow(/999999 no existe/);
    await expect(post(tenantA, '1', 'p2')).rejects.toThrow(/agrupación/);
    await accounts.deactivate(tenantA, '130505');
    await expect(post(tenantA, '130505', 'p3')).rejects.toThrow(/inactiva/);
    expect(await db.collection(COLLECTIONS.journals).countDocuments()).toBe(0);
    expect(await db.collection(COLLECTIONS.balances).countDocuments()).toBe(0);
  });

  it('no usa las cuentas de otra empresa', async () => {
    const otra = toTenantId(new ObjectId());
    await expect(post(otra, '130505', 'p4')).rejects.toThrow(/no existe/);
  });

  it('una reversión sigue funcionando aunque la cuenta se haya desactivado después', async () => {
    const { journal } = await post(tenantA, '130505', 'p5');
    await accounts.deactivate(tenantA, '130505');
    const reversal = await ledger.reverseJournal(tenantA, journal._id, { idempotencyKey: 'rp5' });
    expect(reversal.replayed).toBe(false);
    expect(await ledger.getBalance(tenantA, '130505', '2026-10', 'COP')).toEqual({ debit: 1_000, credit: 1_000 });
  });
});

describe('libro: escritura', () => {
  it('registra el asiento, numera desde 1 y actualiza saldos', async () => {
    const { journal, replayed } = await ledger.postJournal(tenantA, sale('k1'));
    expect(replayed).toBe(false);
    expect(journal.number).toBe(1);
    expect(journal.period).toBe('2026-10');
    expect(await ledger.getBalance(tenantA, '130505', '2026-10', 'COP')).toEqual({ debit: 119_000, credit: 0 });
    expect(await ledger.getBalance(tenantA, '413535', '2026-10', 'COP')).toEqual({ debit: 0, credit: 119_000 });
  });

  it('repetir la clave devuelve el mismo asiento sin duplicar saldos ni consumir número', async () => {
    const first = await ledger.postJournal(tenantA, sale('same'));
    const again = await ledger.postJournal(tenantA, sale('same'));
    expect(again.replayed).toBe(true);
    expect(again.journal._id.equals(first.journal._id)).toBe(true);
    expect(await ledger.getBalance(tenantA, '130505', '2026-10', 'COP')).toEqual({ debit: 119_000, credit: 0 });

    const next = await ledger.postJournal(tenantA, sale('other'));
    expect(next.journal.number).toBe(2);
  });

  it('20 asientos concurrentes: números 1..20 sin huecos ni repetidos y saldo exacto', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => ledger.postJournal(tenantA, sale(`c${i}`, 1_000))),
    );
    const numbers = results.map((r) => r.journal.number).sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(await ledger.getBalance(tenantA, '130505', '2026-10', 'COP')).toEqual({ debit: 20_000, credit: 0 });
  });

  it('10 peticiones concurrentes con la misma clave producen un solo asiento', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => ledger.postJournal(tenantA, sale('dup', 5_000))),
    );
    const ids = new Set(results.map((r) => r.journal._id.toHexString()));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await db.collection(COLLECTIONS.journals).countDocuments()).toBe(1);
    expect(await ledger.getBalance(tenantA, '130505', '2026-10', 'COP')).toEqual({ debit: 5_000, credit: 0 });
  });
});

describe('libro: reversión', () => {
  it('revierte dejando el saldo neto en cero, y solo una vez', async () => {
    const { journal } = await ledger.postJournal(tenantA, sale('k1'));
    const reversal = await ledger.reverseJournal(tenantA, journal._id, {
      idempotencyKey: 'r1',
      date: new Date('2026-10-20T12:00:00Z'),
    });
    expect(reversal.journal.reversesJournalId.equals(journal._id)).toBe(true);
    expect(reversal.journal.number).toBe(2);
    expect(await ledger.getBalance(tenantA, '130505', '2026-10', 'COP')).toEqual({ debit: 119_000, credit: 119_000 });

    await expect(ledger.reverseJournal(tenantA, journal._id, { idempotencyKey: 'r2' })).rejects.toBeInstanceOf(
      JournalAlreadyReversedError,
    );
    await expect(ledger.reverseJournal(tenantA, reversal.journal._id, { idempotencyKey: 'r3' })).rejects.toBeInstanceOf(
      LedgerValidationError,
    );
  });
});

describe('aislamiento entre empresas', () => {
  it('una empresa no ve asientos ni saldos de otra, y la numeración es independiente', async () => {
    const a = await ledger.postJournal(tenantA, sale('k1'));
    const b = await ledger.postJournal(tenantB, sale('k1', 7_000));
    expect(a.journal.number).toBe(1);
    expect(b.journal.number).toBe(1);
    expect(a.journal._id.equals(b.journal._id)).toBe(false);

    expect(await ledger.getJournal(tenantB, a.journal._id)).toBeNull();
    expect(await ledger.getBalance(tenantB, '130505', '2026-10', 'COP')).toEqual({ debit: 7_000, credit: 0 });
    await expect(ledger.reverseJournal(tenantB, a.journal._id, { idempotencyKey: 'x' })).rejects.toThrow();
  });

  it('TenantCollection rechaza un filtro o un documento con tenantId propio', () => {
    const coll = new TenantCollection(db.collection(COLLECTIONS.balances), tenantA);
    expect(() => coll.find({ tenantId: tenantB })).toThrow(/tenantId/);
    expect(() => coll.insertOne({ tenantId: tenantB, accountId: 'x' })).toThrow(/tenantId/);
  });
});
