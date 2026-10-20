import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { MongoClient, ObjectId } from 'mongodb';
import { createAccountService } from '../accounts/accounts.js';
import { toTenantId } from '../core/tenant.js';
import { COLLECTIONS, ensureIndexes } from '../data/db.js';
import { createLedger } from '../ledger/ledger.js';

/**
 * Medición de rendimiento del libro contra un MongoDB local de un solo nodo.
 * Sirve para comparar versiones del código y detectar regresiones; las cifras absolutas de un
 * clúster real (Atlas) serán distintas: ahí hay red, replicación a varios nodos y fragmentación.
 *
 *   npm run bench
 */
const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
const ms = (n) => `${n.toFixed(1)} ms`;

async function runConcurrent(total, concurrency, task) {
  const latencies = [];
  let next = 0;
  const started = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (true) {
        const i = next++;
        if (i >= total) return;
        const t0 = performance.now();
        await task(i);
        latencies.push(performance.now() - t0);
      }
    }),
  );
  const seconds = (performance.now() - started) / 1000;
  latencies.sort((a, b) => a - b);
  return {
    perSecond: Math.round(total / seconds),
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    max: latencies[latencies.length - 1],
  };
}

async function chart(accounts, tenantId) {
  await accounts.create(tenantId, { code: '1', name: 'Activo', type: 'asset', postable: false });
  await accounts.create(tenantId, { code: '110505', name: 'Caja', type: 'asset', parentCode: '1' });
  await accounts.create(tenantId, { code: '4', name: 'Ingresos', type: 'income', postable: false });
  await accounts.create(tenantId, { code: '413505', name: 'Ventas', type: 'income', parentCode: '4' });
}

const entry = (key, date = new Date('2026-10-15T12:00:00Z')) => ({
  docType: 'FV',
  date,
  currency: 'COP',
  idempotencyKey: key,
  lines: [
    { accountId: '110505', debit: 1000 },
    { accountId: '413505', credit: 1000 },
  ],
});

console.log('simultáneas por empresa:', Number(process.env.BENCH_CONC ?? 1));
const rows = [];
const report = (name, r) =>
  rows.push({ escenario: name, 'ops/s': r.perSecond, p50: ms(r.p50), p95: ms(r.p95), p99: ms(r.p99), máx: ms(r.max) });

const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
const client = await MongoClient.connect(replSet.getUri());
const db = client.db('lulubiz_bench');
await ensureIndexes(db);
const concurrencyPerTenant = Number(process.env.BENCH_CONC ?? 1);
const ledger = createLedger(client, db, { concurrencyPerTenant, maxQueue: 10_000, queueTimeoutMs: 120_000 });
const accounts = createAccountService(client, db);

try {
  // A) Un solo tenant, mismo tipo y período: el peor caso, porque todos comparten consecutivo y compuerta de período.
  const hot = toTenantId(new ObjectId());
  await chart(accounts, hot);
  for (const concurrency of [1, 8, 32]) {
    const total = concurrency === 1 ? 600 : 1200;
    const r = await runConcurrent(total, concurrency, (i) => ledger.postJournal(hot, entry(`hot-${concurrency}-${i}`)));
    report(`asientos, 1 empresa, concurrencia ${concurrency}`, r);
  }

  // B) Empresas distintas: no comparten documentos calientes, así que debería escalar con la concurrencia.
  const tenants = Array.from({ length: 20 }, () => toTenantId(new ObjectId()));
  for (const t of tenants) await chart(accounts, t);
  const spread = await runConcurrent(2400, 32, (i) => ledger.postJournal(tenants[i % 20], entry(`spread-${i}`)));
  report('asientos, 20 empresas, concurrencia 32', spread);

  // C) y las lecturas con volumen solo si no se pidió BENCH_ONLY_WRITES=1.
  if (!process.env.BENCH_ONLY_WRITES) {
    // C) Volumen: 200 000 asientos de una empresa repartidos en 24 períodos, insertados en bloque.
    const big = toTenantId(new ObjectId());
    await chart(accounts, big);
    const journals = db.collection(COLLECTIONS.journals);
    const TOTAL = 200_000;
    for (let batch = 0; batch < TOTAL; batch += 10_000) {
      const docs = Array.from({ length: 10_000 }, (_, k) => {
        const n = batch + k;
        const month = (n % 24) + 1;
        const date = new Date(Date.UTC(2025 + Math.floor((month - 1) / 12), (month - 1) % 12, 1 + (n % 27), 12));
        return {
          tenantId: big,
          docType: 'FV',
          number: n + 1,
          date,
          period: `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`,
          currency: 'COP',
          lines: [
            { accountId: '110505', debit: 1000, credit: 0 },
            { accountId: '413505', debit: 0, credit: 1000 },
          ],
          totalDebit: 1000,
          totalCredit: 1000,
          idempotencyKey: `big-${n}`,
          createdAt: date,
        };
      });
      await journals.insertMany(docs, { ordered: false });
    }

    const sample = async (fn, runs = 60) => {
      const times = [];
      for (let i = 0; i < runs; i += 1) {
        const t0 = performance.now();
        await fn(i);
        times.push(performance.now() - t0);
      }
      times.sort((a, b) => a - b);
      return { perSecond: Math.round(1000 / (times.reduce((s, x) => s + x, 0) / runs)), p50: percentile(times, 50), p95: percentile(times, 95), p99: percentile(times, 99), max: times[times.length - 1] };
    };

    report('listar: página reciente (200 mil asientos)', await sample(() => ledger.listJournals(big, { limit: 25 })));
    report('listar: un período', await sample(() => ledger.listJournals(big, { period: '2026-03', limit: 25 })));
    report('listar: por cuenta', await sample(() => ledger.listJournals(big, { accountId: '413505', limit: 25 })));
    const deep = (await ledger.listJournals(big, { limit: 50 })).nextCursor;
    let cursor = deep;
    for (let i = 0; i < 400; i += 1) cursor = (await ledger.listJournals(big, { limit: 50, cursor })).nextCursor;
    report('listar: página profunda (cursor tras 20 000 filas)', await sample(() => ledger.listJournals(big, { limit: 50, cursor })));
    report('saldo de una cuenta', await sample(() => ledger.getBalance(big, '110505', '2026-03', 'COP')));

    // Plan de consulta de las lecturas más frecuentes: deben usar índice y examinar pocos documentos.
    const explain = async (name, filter, options = {}) => {
      const stats = (await journals.find(filter, options).explain('executionStats')).executionStats;
      rows.push({ escenario: `plan: ${name}`, 'ops/s': '', p50: `examinados ${stats.totalDocsExamined}`, p95: `devueltos ${stats.nReturned}`, p99: '', máx: '' });
    };
    await explain('reciente', { tenantId: big }, { sort: { _id: -1 }, limit: 26 });
    await explain('por período', { tenantId: big, period: '2026-03' }, { sort: { _id: -1 }, limit: 26 });
    await explain('por cuenta', { tenantId: big, 'lines.accountId': '413505' }, { sort: { _id: -1 }, limit: 26 });

  }

  console.table(rows);
} finally {
  await client.close();
  await replSet.stop();
}
