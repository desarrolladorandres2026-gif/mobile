import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { accumulatedAfter, monthsThrough, scheduleOf } from '../fixedAssets/fixedAssets.js';
import { COLLECTIONS, ensureIndexes } from '../data/db.js';
import { createMemoryMailer } from '../mail/mailer.js';
import { startMongo } from '../testing/mongo.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const FAST = { N: 2 ** 10, r: 8, p: 1 };
const PASSWORD = 'correcto-caballo-grapa';

/** `AAAA-MM` de hace `back` meses. */
const ym = (back = 0) => {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - back, 1);
  return d.toISOString().slice(0, 7);
};
const firstDay = (back = 0) => `${ym(back)}-01`;
const today = () => new Date().toISOString().slice(0, 10);

let mongo;
let db;
let app;
let mailer;

const makeApp = () => {
  const config = loadConfig({});
  config.mfaEncryptionKey = Buffer.alloc(32, 5).toString('base64');
  config.rateLimit = Object.fromEntries(Object.entries(config.rateLimit).map(([k, v]) => [k, { ...v, max: 10_000 }]));
  return buildApp({ client: mongo.client, db, config, passwordParams: FAST, mailer, reporter: { report: async () => true } });
};

const call = (method, url, { cookie, body } = {}) => app.inject({ method, url, headers: cookie ? { cookie } : {}, ...(body !== undefined ? { payload: body } : {}) });
const cookieOf = (res) => `${res.cookies[0].name}=${res.cookies[0].value}`;
const tokenIn = (mail) => decodeURIComponent(mail.text.match(/#token=([^\s]+)/)[1]);
const login = async (email) => cookieOf(await call('POST', '/v1/auth/login', { body: { email, password: PASSWORD } }));

async function company(name = 'Andina SAS', email = 'ana@andina.co') {
  const reg = await call('POST', '/v1/auth/register', { body: { companyName: name, country: 'CO', currency: 'COP', ownerName: 'Ana', email, password: PASSWORD } });
  expect((await call('POST', '/v1/auth/verify-email', { body: { token: tokenIn(mailer.last(email)) } })).statusCode).toBe(204);
  const cookie = await login(email);
  const base = `/v1/tenants/${reg.json().tenantId}`;
  const make = (body) => call('POST', `${base}/accounts`, { cookie, body });
  await make({ code: '1', name: 'Activo', type: 'asset', postable: false });
  await make({ code: '111005', name: 'Bancos', type: 'asset', parentCode: '1' });
  await make({ code: '152405', name: 'Equipo de oficina', type: 'asset', parentCode: '1' });
  await make({ code: '153205', name: 'Maquinaria', type: 'asset', parentCode: '1' });
  await make({ code: '159205', name: 'Depreciación acumulada de equipo', type: 'asset', parentCode: '1' });
  await make({ code: '159210', name: 'Depreciación acumulada de maquinaria', type: 'asset', parentCode: '1' });
  await make({ code: '3', name: 'Patrimonio', type: 'equity', postable: false });
  await make({ code: '310505', name: 'Capital', type: 'equity', parentCode: '3' });
  await make({ code: '4', name: 'Ingresos', type: 'income', postable: false });
  await make({ code: '429581', name: 'Utilidad en venta de activos', type: 'income', parentCode: '4' });
  await make({ code: '5', name: 'Gastos', type: 'expense', postable: false });
  await make({ code: '516005', name: 'Gasto por depreciación de equipo', type: 'expense', parentCode: '5' });
  await make({ code: '516010', name: 'Gasto por depreciación de maquinaria', type: 'expense', parentCode: '5' });
  await make({ code: '539595', name: 'Pérdida en venta de activos', type: 'expense', parentCode: '5' });
  return { cookie, base, tenantId: new ObjectId(reg.json().tenantId) };
}

async function joinAs(c, email, role) {
  await call('POST', '/v1/auth/register', { body: { companyName: `Empresa de ${email}`, country: 'CO', currency: 'COP', ownerName: 'X', email, password: PASSWORD } });
  const cookie = await login(email);
  expect((await call('POST', `${c.base}/members`, { cookie: c.cookie, body: { email, role } })).statusCode).toBe(202);
  expect((await call('POST', '/v1/invitations/accept', { cookie, body: { token: tokenIn(mailer.last(email)) } })).statusCode).toBe(201);
  return cookie;
}

const post = (c, path, body, cookie = c.cookie) => call('POST', `${c.base}${path}`, { cookie, body });
const get = (c, path, cookie = c.cookie) => call('GET', `${c.base}${path}`, { cookie });
const assetBody = (patch = {}) => ({
  code: 'eq-1',
  name: 'Computador portátil',
  acquisitionDate: firstDay(2),
  cost: 1_200_000,
  usefulLifeMonths: 12,
  accounts: { asset: '152405', accumulated: '159205', expense: '516005' },
  ...patch,
});
const create = async (c, patch) => {
  const res = await post(c, '/fixed-assets', assetBody(patch));
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
};
const depreciate = (c, period = ym(0)) => post(c, '/fixed-assets/depreciation', { period });
const net = async (c, account) => {
  const rows = await db.collection(COLLECTIONS.balances).find({ tenantId: c.tenantId, accountId: account }).toArray();
  return rows.reduce((acc, r) => acc + r.debit - r.credit, 0);
};
/** Lleva el costo del activo al libro, como lo haría la compra que lo trajo. */
const book = (c, account, amount, date = firstDay(2)) =>
  call('POST', `${c.base}/journals`, { cookie: c.cookie, headers: {}, body: { docType: 'AJ', date: `${date}T12:00:00Z`, currency: 'COP', lines: [{ accountId: account, debit: amount }, { accountId: '310505', credit: amount }] } });
const journalWithKey = (c, body) => app.inject({ method: 'POST', url: `${c.base}/journals`, headers: { cookie: c.cookie, 'idempotency-key': `fa-${Math.random().toString(16).slice(2)}-aaaaaaaa` }, payload: body });

beforeAll(async () => {
  mongo = await startMongo('lulubiz_fixedassets_http_test');
  db = mongo.db;
});

afterAll(async () => {
  await app?.close();
  await mongo?.stop();
});

beforeEach(async () => {
  await app?.close();
  await db.dropDatabase();
  await ensureIndexes(db);
  mailer = createMemoryMailer();
  app = await makeApp();
});

describe('calendario de depreciación', () => {
  it('cada mes es la diferencia de dos acumulados, así que la suma es exacta', () => {
    expect(accumulatedAfter(100, 3, 0)).toBe(0);
    expect(accumulatedAfter(100, 3, 1)).toBe(33);
    expect(accumulatedAfter(100, 3, 2)).toBe(66);
    expect(accumulatedAfter(100, 3, 3)).toBe(100);
    expect(accumulatedAfter(100, 3, 99)).toBe(100); // pasado de la vida, no pasa del valor depreciable
    const asset = { cost: 1_000_001, salvageValue: 1, usefulLifeMonths: 7, depreciationStart: '2026-11', depreciatedMonths: 3 };
    const rows = scheduleOf(asset);
    expect(rows).toHaveLength(7);
    expect(rows.reduce((acc, r) => acc + r.amount, 0)).toBe(1_000_000);
    expect(rows.at(-1)).toMatchObject({ month: 7, period: '2027-05', accumulated: 1_000_000, bookValue: 1 });
    expect(rows.map((r) => r.posted)).toEqual([true, true, true, false, false, false, false]);
    expect(rows[1].period).toBe('2026-12');
    expect(rows[2].period).toBe('2027-01');
  });

  it('cuenta los meses desde el inicio hasta el período, ambos incluidos', () => {
    expect(monthsThrough('2026-10', '2026-10')).toBe(1);
    expect(monthsThrough('2026-10', '2027-01')).toBe(4);
    expect(monthsThrough('2026-10', '2026-09')).toBe(0);
  });
});

describe('ficha del activo', () => {
  it('se crea con su código en mayúsculas y no asienta nada', async () => {
    const c = await company();
    const asset = await create(c, { salvageValue: 200_000, description: 'Oficina principal' });
    expect(asset).toMatchObject({ code: 'EQ-1', status: 'active', cost: 1_200_000, salvageValue: 200_000, depreciatedMonths: 0, depreciatedTotal: 0, bookValue: 1_200_000, fullyDepreciated: false, nextAmount: 83_333, method: 'straight_line', depreciationStart: ym(2) });
    expect(await db.collection(COLLECTIONS.journals).countDocuments({ tenantId: c.tenantId })).toBe(0);
    const detail = (await get(c, `/fixed-assets/${asset._id}`)).json();
    expect(detail.schedule).toHaveLength(12);
    expect(detail.schedule.reduce((acc, r) => acc + r.amount, 0)).toBe(1_000_000);
    expect((await get(c, '/fixed-assets')).json().items.map((a) => a.code)).toEqual(['EQ-1']);
  });

  it('rechaza lo que no es un activo válido', async () => {
    const c = await company();
    const bad = async (patch) => (await post(c, '/fixed-assets', assetBody(patch))).statusCode;
    expect(await bad({ cost: 0 })).toBe(400);
    expect(await bad({ cost: 1.5 })).toBe(400);
    expect(await bad({ salvageValue: 1_200_000 })).toBe(400); // residual igual al costo
    expect(await bad({ usefulLifeMonths: 0 })).toBe(400);
    expect(await bad({ usefulLifeMonths: 601 })).toBe(400);
    expect(await bad({ acquisitionDate: '2026-02-30' })).toBe(400);
    expect(await bad({ acquisitionDate: '2099-01-01' })).toBe(400);
    expect(await bad({ depreciationStart: ym(5) })).toBe(400); // antes de adquirir
    expect(await bad({ depreciationStart: '2026-13' })).toBe(400);
    expect(await bad({ code: 'con espacio' })).toBe(400);
    expect(await bad({ accounts: { asset: '111005', accumulated: '111005', expense: '516005' } })).toBe(400); // repetidas
    expect(await bad({ accounts: { asset: '516005', accumulated: '159205', expense: '516005' } })).toBe(400); // el activo no es de gasto
    expect(await bad({ accounts: { asset: '152405', accumulated: '159205', expense: '152405' } })).toBe(400); // el gasto no es de activo
    expect(await bad({ accounts: { asset: '999999', accumulated: '159205', expense: '516005' } })).toBe(400);
    expect(await bad({ costCenter: 'NOPE' })).toBe(400);
    expect((await get(c, '/fixed-assets')).json().items).toEqual([]);
  });

  it('el código no se repite; se renombra pero el costo no se edita', async () => {
    const c = await company();
    const asset = await create(c);
    expect((await post(c, '/fixed-assets', assetBody({ code: 'EQ-1' }))).statusCode).toBe(409);
    const renamed = await call('PATCH', `${c.base}/fixed-assets/${asset._id}`, { cookie: c.cookie, body: { name: 'Portátil de gerencia', description: 'Piso 2' } });
    expect(renamed.json()).toMatchObject({ name: 'Portátil de gerencia', description: 'Piso 2', cost: 1_200_000 });
    expect((await call('PATCH', `${c.base}/fixed-assets/${asset._id}`, { cookie: c.cookie, body: { cost: 5 } })).statusCode).toBe(400);
    expect((await call('PATCH', `${c.base}/fixed-assets/${asset._id}`, { cookie: c.cookie, body: {} })).statusCode).toBe(400);
    expect((await get(c, `/fixed-assets/${new ObjectId()}`)).statusCode).toBe(404);
  });

  it('el lector las ve pero no las crea; el contador sí; otra empresa no las ve', async () => {
    const a = await company('Andina SAS', 'ana@andina.co');
    const b = await company('Boreal SAS', 'bea@boreal.co');
    const asset = await create(a);
    const viewer = await joinAs(a, 'lector@andina.co', 'viewer');
    const accountant = await joinAs(a, 'contador@andina.co', 'accountant');
    const cashier = await joinAs(a, 'cajero@andina.co', 'cashier');
    expect((await get(a, '/fixed-assets', viewer)).statusCode).toBe(200);
    expect((await post(a, '/fixed-assets', assetBody({ code: 'X' }), viewer)).statusCode).toBe(403);
    expect((await post(a, '/fixed-assets/depreciation', { period: ym(0) }, viewer)).statusCode).toBe(403);
    expect((await post(a, '/fixed-assets', assetBody({ code: 'EQ-2' }), accountant)).statusCode).toBe(201);
    expect((await get(a, '/fixed-assets', cashier)).statusCode).toBe(403);
    expect((await get(b, `/fixed-assets/${asset._id}`)).statusCode).toBe(404);
    expect((await get(b, '/fixed-assets')).json().items).toEqual([]);
  });
});

describe('depreciación', () => {
  it('pone al día los meses que se deben en un solo asiento DP, y repetir no depreciaría dos veces', async () => {
    const c = await company();
    const asset = await create(c); // 1.200.000 en 12 meses, empezó hace 2 meses: el mes actual es el tercero
    const run = await depreciate(c);
    expect(run.statusCode, run.body).toBe(201);
    expect(run.json()).toMatchObject({ assets: 1, total: 300_000, run: { period: ym(0), total: 300_000 } });
    expect(run.json().run.document).toMatch(/^DP\d+$/);
    const journal = (await get(c, `/journals/${run.json().run.journalId}`)).json();
    expect(journal).toMatchObject({ docType: 'DP', totalDebit: 300_000, totalCredit: 300_000, source: { kind: 'depreciation' } });
    expect(journal.lines).toEqual([expect.objectContaining({ accountId: '516005', debit: 300_000 }), expect.objectContaining({ accountId: '159205', credit: 300_000 })]);
    const after = (await get(c, `/fixed-assets/${asset._id}`)).json();
    expect(after).toMatchObject({ depreciatedMonths: 3, depreciatedTotal: 300_000, bookValue: 900_000, lastDepreciatedPeriod: ym(0) });
    expect(after.schedule.filter((r) => r.posted)).toHaveLength(3);

    const again = await depreciate(c);
    expect(again.statusCode).toBe(201);
    expect(again.json()).toEqual({ run: null, assets: 0, total: 0 });
    expect(await net(c, '159205')).toBe(-300_000);
    expect((await get(c, '/fixed-assets/depreciation-runs')).json().items).toHaveLength(1);
  });

  it('agrupa por cuenta de gasto y centro de costo, y respeta la vida útil', async () => {
    const c = await company();
    expect((await post(c, '/cost-centers', { code: 'NORTE', name: 'Norte' })).statusCode).toBe(201);
    await create(c, { code: 'A', costCenter: 'norte' });
    await create(c, { code: 'B', cost: 600_000, usefulLifeMonths: 2, costCenter: 'NORTE' }); // se agota en 2 meses
    await create(c, { code: 'M', cost: 2_400_000, accounts: { asset: '153205', accumulated: '159210', expense: '516010' } });
    const run = (await depreciate(c)).json();
    // A: 3 × 100.000; B: solo 2 meses × 300.000; M: 3 × 200.000
    expect(run.total).toBe(300_000 + 600_000 + 600_000);
    const journal = (await get(c, `/journals/${run.run.journalId}`)).json();
    expect(journal.lines.filter((l) => l.debit).map((l) => [l.accountId, l.costCenter ?? null, l.debit]).sort()).toEqual([['516005', 'NORTE', 900_000], ['516010', null, 600_000]].sort());
    expect(journal.lines.filter((l) => l.credit).map((l) => [l.accountId, l.credit]).sort()).toEqual([['159205', 900_000], ['159210', 600_000]]);
    const items = (await get(c, '/fixed-assets')).json().items;
    expect(items.find((a) => a.code === 'B')).toMatchObject({ depreciatedMonths: 2, fullyDepreciated: true, bookValue: 0 });
    // El mes siguiente solo siguen A y M.
    const next = await depreciate(c, ym(0));
    expect(next.json().assets).toBe(0);
  });

  it('un activo con valor residual no se deprecia por debajo de él', async () => {
    const c = await company();
    await create(c, { cost: 1_000_000, salvageValue: 400_000, usefulLifeMonths: 3, acquisitionDate: firstDay(5) });
    const run = (await depreciate(c)).json();
    expect(run.total).toBe(600_000);
    const asset = (await get(c, '/fixed-assets')).json().items[0];
    expect(asset).toMatchObject({ depreciatedMonths: 3, depreciatedTotal: 600_000, bookValue: 400_000, fullyDepreciated: true });
  });

  it('dos corridas a la vez depreciarían dos veces: solo una cuenta', async () => {
    const c = await company();
    await create(c);
    const results = await Promise.all([depreciate(c), depreciate(c), depreciate(c)]);
    for (const r of results) expect([201, 409]).toContain(r.statusCode);
    expect(results.some((r) => r.statusCode === 201 && r.json().run)).toBe(true);
    expect(await net(c, '159205')).toBe(-300_000);
    expect((await get(c, '/fixed-assets')).json().items[0].depreciatedTotal).toBe(300_000);
    expect(await db.collection(COLLECTIONS.depreciationRuns).countDocuments({ tenantId: c.tenantId })).toBe(1);
  });

  it('un activo que empieza después del período no se deprecia todavía; un período futuro o inválido se rechaza', async () => {
    const c = await company();
    await create(c, { acquisitionDate: firstDay(0) });
    const early = await depreciate(c, ym(1));
    expect(early.json()).toEqual({ run: null, assets: 0, total: 0 });
    expect((await depreciate(c, '2099-01')).statusCode).toBe(400);
    expect((await depreciate(c, '2026-13')).statusCode).toBe(400);
    expect((await depreciate(c, ym(0))).json().assets).toBe(1);
  });

  it('un período cerrado impide la corrida completa y no deja nada a medias', async () => {
    const c = await company();
    const asset = await create(c);
    const closed = await post(c, `/periods/${ym(0)}/close`, undefined);
    expect(closed.statusCode, closed.body).toBeLessThan(300);
    const run = await depreciate(c);
    expect(run.statusCode).toBe(409);
    expect((await get(c, `/fixed-assets/${asset._id}`)).json()).toMatchObject({ depreciatedMonths: 0, depreciatedTotal: 0 });
    expect(await db.collection(COLLECTIONS.depreciationRuns).countDocuments({ tenantId: c.tenantId })).toBe(0);
  });
});

describe('baja de un activo', () => {
  async function aged(c, patch) {
    const asset = await create(c, patch);
    await depreciate(c);
    return (await get(c, `/fixed-assets/${asset._id}`)).json();
  }

  it('una venta por más que su valor en libros deja utilidad', async () => {
    const c = await company();
    const asset = await aged(c); // valor en libros 900.000
    const sold = await post(c, `/fixed-assets/${asset._id}/dispose`, { date: today(), proceeds: 1_000_000, proceedsAccount: '111005', gainAccount: '429581' });
    expect(sold.statusCode, sold.body).toBe(201);
    const journal = sold.json().journal;
    expect(journal).toMatchObject({ docType: 'BF', totalDebit: 1_300_000, totalCredit: 1_300_000 });
    expect(journal.lines.map((l) => [l.accountId, l.debit ?? 0, l.credit ?? 0])).toEqual(
      expect.arrayContaining([['152405', 0, 1_200_000], ['159205', 300_000, 0], ['111005', 1_000_000, 0], ['429581', 0, 100_000]]),
    );
    expect(sold.json().asset).toMatchObject({ status: 'disposed', disposal: { proceeds: 1_000_000, bookValue: 900_000, difference: 100_000 } });
    // Ya no se deprecia ni se vuelve a dar de baja.
    expect((await depreciate(c)).json().assets).toBe(0);
    expect((await post(c, `/fixed-assets/${asset._id}/dispose`, { date: today() })).statusCode).toBe(409);
    expect((await get(c, '/fixed-assets?status=active')).json().items).toEqual([]);
    expect((await get(c, '/fixed-assets?status=disposed')).json().items).toHaveLength(1);
  });

  it('una venta por menos deja pérdida; un retiro sin precio manda todo el valor en libros a pérdida', async () => {
    const c = await company();
    const a = await aged(c, { code: 'A' });
    const b = await aged(c, { code: 'B' }).catch(() => null);
    const sold = await post(c, `/fixed-assets/${a._id}/dispose`, { date: today(), proceeds: 500_000, proceedsAccount: '111005', lossAccount: '539595' });
    expect(sold.statusCode, sold.body).toBe(201);
    expect(sold.json().journal.lines.find((l) => l.accountId === '539595').debit).toBe(400_000);
    expect(b).not.toBeNull();
    const retired = await post(c, `/fixed-assets/${b._id}/dispose`, { date: today(), lossAccount: '539595' });
    expect(retired.statusCode, retired.body).toBe(201);
    expect(retired.json().journal.lines.find((l) => l.accountId === '539595').debit).toBe(900_000);
  });

  it('exige depreciación al día, la cuenta de la diferencia y datos válidos, sin asentar nada si falla', async () => {
    const c = await company();
    const fresh = await create(c, { code: 'F' });
    const behind = await post(c, `/fixed-assets/${fresh._id}/dispose`, { date: today() });
    expect(behind.statusCode).toBe(409);
    expect(behind.json().message).toMatch(/deprecia/);
    await depreciate(c);
    const noAccount = await post(c, `/fixed-assets/${fresh._id}/dispose`, { date: today(), proceeds: 1_000_000, proceedsAccount: '111005' });
    expect(noAccount.statusCode).toBe(400); // hay utilidad y no se dijo en qué cuenta
    expect((await post(c, `/fixed-assets/${fresh._id}/dispose`, { date: today(), proceeds: 1_000_000, gainAccount: '429581' })).statusCode).toBe(400); // falta dónde entra el dinero
    expect((await post(c, `/fixed-assets/${fresh._id}/dispose`, { date: '2099-01-01' })).statusCode).toBe(400);
    expect((await post(c, `/fixed-assets/${fresh._id}/dispose`, { date: firstDay(5), lossAccount: '539595' })).statusCode).toBe(400); // antes de adquirirlo
    expect((await post(c, `/fixed-assets/${new ObjectId()}/dispose`, { date: today() })).statusCode).toBe(404);
    expect(await db.collection(COLLECTIONS.journals).countDocuments({ tenantId: c.tenantId, docType: 'BF' })).toBe(0);
    expect((await get(c, `/fixed-assets/${fresh._id}`)).json().status).toBe('active');
  });
});

describe('conciliación con el libro', () => {
  it('compara la suma de las fichas con el saldo de las cuentas', async () => {
    const c = await company();
    await create(c);
    await create(c, { code: 'EQ-2', cost: 800_000 });
    const before = (await get(c, '/fixed-assets/reconciliation')).json();
    expect(before.ok).toBe(false);
    expect(before.lines).toEqual([
      { code: '152405', name: 'Equipo de oficina', kind: 'cost', subledger: 2_000_000, ledger: 0, difference: -2_000_000 },
      { code: '159205', name: 'Depreciación acumulada de equipo', kind: 'accumulated', subledger: 0, ledger: 0, difference: 0 },
    ]);
    expect((await journalWithKey(c, { docType: 'AJ', date: `${firstDay(2)}T12:00:00Z`, currency: 'COP', lines: [{ accountId: '152405', debit: 2_000_000 }, { accountId: '310505', credit: 2_000_000 }] })).statusCode).toBe(201);
    await depreciate(c);
    const after = (await get(c, '/fixed-assets/reconciliation')).json();
    expect(after.ok).toBe(true);
    expect(after.lines.map((l) => [l.code, l.subledger, l.ledger])).toEqual([['152405', 2_000_000, 2_000_000], ['159205', 500_000, 500_000]]);
    // Una depreciación asentada por fuera de la corrida se ve como diferencia.
    expect((await journalWithKey(c, { docType: 'AJ', date: `${firstDay(0)}T12:00:00Z`, currency: 'COP', lines: [{ accountId: '516005', debit: 10 }, { accountId: '159205', credit: 10 }] })).statusCode).toBe(201);
    expect((await get(c, '/fixed-assets/reconciliation')).json().lines.find((l) => l.code === '159205').difference).toBe(10);
  });
});
