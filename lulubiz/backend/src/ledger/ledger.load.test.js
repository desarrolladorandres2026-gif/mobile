import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAccountService } from '../accounts/accounts.js';
import { BusyError } from '../core/limiter.js';
import { toTenantId } from '../core/tenant.js';
import { COLLECTIONS, ensureIndexes } from '../data/db.js';
import { statusFor } from '../http/errors.js';
import { startMongo } from '../testing/mongo.js';
import { createLedger } from './ledger.js';

let mongo;
let db;
let accounts;
let tenant;

const entry = (key, amount = 100) => ({
  docType: 'FV',
  date: new Date('2026-10-15T12:00:00Z'),
  currency: 'COP',
  idempotencyKey: key,
  lines: [
    { accountId: '110505', debit: amount },
    { accountId: '413505', credit: amount },
  ],
});

/** Todas las etapas de un plan de consulta, recorriendo el árbol. */
function stages(plan, found = []) {
  if (!plan) return found;
  found.push(plan.stage);
  stages(plan.inputStage, found);
  (plan.inputStages ?? []).forEach((p) => stages(p, found));
  stages(plan.shardPlan, found);
  return found;
}

beforeAll(async () => {
  mongo = await startMongo('lulubiz_load_test');
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
  await accounts.create(tenant, { code: '1', name: 'Activo', type: 'asset', postable: false });
  await accounts.create(tenant, { code: '110505', name: 'Caja', type: 'asset', parentCode: '1' });
  await accounts.create(tenant, { code: '4', name: 'Ingresos', type: 'income', postable: false });
  await accounts.create(tenant, { code: '413505', name: 'Ventas', type: 'income', parentCode: '4' });
});

describe('carga de una sola empresa', () => {
  it('60 asientos simultáneos: ninguno se pierde, numeración consecutiva y saldo exacto', async () => {
    const ledger = createLedger(mongo.client, db, { queueTimeoutMs: 60_000, maxQueue: 1000 });
    const results = await Promise.all(Array.from({ length: 60 }, (_, i) => ledger.postJournal(tenant, entry(`carga-${i}`))));
    const numbers = results.map((r) => r.journal.number).sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
    expect(await ledger.getBalance(tenant, '110505', '2026-10', 'COP')).toEqual({ debit: 6000, credit: 0 });
  });

  it('con cola corta, lo que no cabe se rechaza con BusyError y lo aceptado queda consecutivo', async () => {
    const ledger = createLedger(mongo.client, db, { maxQueue: 2, queueTimeoutMs: 30_000 });
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        ledger.postJournal(tenant, entry(`cola-${i}`)).then(
          (r) => ({ ok: r.journal.number }),
          (err) => ({ err }),
        ),
      ),
    );
    const accepted = outcomes.filter((o) => o.ok).map((o) => o.ok).sort((a, b) => a - b);
    const rejected = outcomes.filter((o) => o.err);
    expect(rejected.length).toBeGreaterThan(0);
    expect(rejected.every((o) => o.err instanceof BusyError)).toBe(true);
    expect(accepted).toEqual(Array.from({ length: accepted.length }, (_, i) => i + 1)); // sin huecos
    expect(accepted.length + rejected.length).toBe(8);
    expect(await db.collection(COLLECTIONS.journals).countDocuments({ tenantId: tenant })).toBe(accepted.length);
  });

  it('el servicio ocupado se traduce a 503 y no a un error del servidor', () => {
    expect(statusFor(new BusyError('x'))).toBe(503);
  });
});

describe('las consultas frecuentes usan índice', () => {
  const other = () => toTenantId(new ObjectId());

  beforeEach(async () => {
    // Datos de varias empresas, para que un filtro sin índice se note.
    const tenants = [tenant, other(), other()];
    const journals = [];
    const balances = [];
    const audit = [];
    const parties = [];
    for (const [t, id] of tenants.entries()) {
      for (let n = 0; n < 1500; n += 1) {
        const date = new Date(Date.UTC(2026, n % 12, 1 + (n % 27), 12));
        journals.push({
          tenantId: id,
          docType: n % 3 === 0 ? 'RC' : 'FV',
          number: n + 1,
          date,
          period: `2026-${String((n % 12) + 1).padStart(2, '0')}`,
          currency: 'COP',
          lines: [
            { accountId: `1105${String(n % 5).padStart(2, '0')}`, debit: 10, credit: 0 },
            { accountId: '413505', debit: 0, credit: 10 },
          ],
          idempotencyKey: `${t}-${n}`,
        });
        audit.push({ tenantId: id, action: n % 2 ? 'journal.post' : 'account.create', at: date });
        parties.push({ tenantId: id, nameKey: `cliente ${n}`, taxIdType: 'CC', taxId: `${t}${n}`, roles: ['customer'], active: true });
      }
      balances.push({ tenantId: id, accountId: '110505', period: '2026-10', currency: 'COP', debit: 1, credit: 0 });
    }
    await db.collection(COLLECTIONS.journals).insertMany(journals);
    await db.collection(COLLECTIONS.audit).insertMany(audit);
    await db.collection(COLLECTIONS.parties).insertMany(parties);
    await db.collection(COLLECTIONS.balances).insertMany(balances);
  });

  /** Falla si el plan recorre la colección entera o examina muchos más documentos de los que devuelve. */
  async function expectIndexed(collection, filter, options = {}, slack = 5) {
    const { executionStats, queryPlanner } = await db.collection(collection).find(filter, options).explain('executionStats');
    const used = stages(queryPlanner.winningPlan);
    expect(used, `${collection} ${JSON.stringify(filter)} → ${used.join(' > ')}`).not.toContain('COLLSCAN');
    expect(used).toContain('IXSCAN');
    expect(executionStats.totalDocsExamined, `${collection} examinó ${executionStats.totalDocsExamined} para devolver ${executionStats.nReturned}`).toBeLessThanOrEqual(
      executionStats.nReturned + slack,
    );
  }

  it('asientos: recientes, por período, por cuenta, por clave de idempotencia y con cursor', async () => {
    const sort = { sort: { _id: -1 }, limit: 26 };
    await expectIndexed(COLLECTIONS.journals, { tenantId: tenant }, sort);
    await expectIndexed(COLLECTIONS.journals, { tenantId: tenant, period: '2026-03' }, sort);
    await expectIndexed(COLLECTIONS.journals, { tenantId: tenant, 'lines.accountId': '413505' }, sort);
    await expectIndexed(COLLECTIONS.journals, { tenantId: tenant, idempotencyKey: 'x-1' }, { limit: 1 });
    const middle = (await db.collection(COLLECTIONS.journals).find({ tenantId: tenant }).sort({ _id: -1 }).skip(700).limit(1).next())._id;
    await expectIndexed(COLLECTIONS.journals, { tenantId: tenant, _id: { $lt: middle } }, sort);
  });

  it('saldos, auditoría, terceros, cuentas y períodos', async () => {
    await expectIndexed(COLLECTIONS.balances, { tenantId: tenant, accountId: '110505', period: '2026-10', currency: 'COP' }, { limit: 1 });
    await expectIndexed(COLLECTIONS.audit, { tenantId: tenant }, { sort: { _id: -1 }, limit: 51 });
    await expectIndexed(COLLECTIONS.parties, { tenantId: tenant, roles: 'customer' }, { sort: { _id: 1 }, limit: 51 }, 60);
    await expectIndexed(COLLECTIONS.parties, { tenantId: tenant, nameKey: { $regex: '^cliente 12' } }, { limit: 51 }, 60);
    await expectIndexed(COLLECTIONS.accounts, { tenantId: tenant }, { sort: { code: 1 } }, 10);
    await expectIndexed(COLLECTIONS.periods, { tenantId: tenant, period: '2026-10' }, { limit: 1 });
  });

  it('identidad: sesiones, tokens, membresías y usuarios', async () => {
    await db.collection(COLLECTIONS.sessions).insertOne({ tokenHash: 'h1', userId: new ObjectId(), expiresAt: new Date() });
    await db.collection(COLLECTIONS.tokens).insertOne({ tokenHash: 't1', purpose: 'invite', tenantId: tenant, email: 'a@b.co', usedAt: null });
    await db.collection(COLLECTIONS.users).insertOne({ email: 'a@b.co' });
    await db.collection(COLLECTIONS.memberships).insertOne({ tenantId: tenant, userId: new ObjectId(), role: 'owner' });
    await expectIndexed(COLLECTIONS.sessions, { tokenHash: 'h1' }, { limit: 1 });
    await expectIndexed(COLLECTIONS.tokens, { tokenHash: 't1', purpose: 'invite' }, { limit: 1 });
    await expectIndexed(COLLECTIONS.tokens, { purpose: 'invite', tenantId: tenant, email: 'a@b.co', usedAt: null });
    await expectIndexed(COLLECTIONS.users, { email: 'a@b.co' }, { limit: 1 });
    await expectIndexed(COLLECTIONS.memberships, { tenantId: tenant });
  });
});
