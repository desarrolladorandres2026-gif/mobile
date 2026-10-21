import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { COLLECTIONS, ensureIndexes } from '../data/db.js';
import { createMemoryMailer } from '../mail/mailer.js';
import { startMongo } from '../testing/mongo.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const FAST = { N: 2 ** 10, r: 8, p: 1 };
const PASSWORD = 'correcto-caballo-grapa';
const DAY_MS = 86_400_000;
const iso = (offset = 0) => new Date(Date.now() + offset * DAY_MS).toISOString().slice(0, 10);
const BANK = '111005';

let mongo;
let db;
let app;
let mailer;
let counter = 0;

const makeApp = () => {
  const config = loadConfig({});
  config.mfaEncryptionKey = Buffer.alloc(32, 5).toString('base64');
  config.rateLimit = Object.fromEntries(Object.entries(config.rateLimit).map(([k, v]) => [k, { ...v, max: 10_000 }]));
  return buildApp({ client: mongo.client, db, config, passwordParams: FAST, mailer, reporter: { report: async () => true } });
};

const call = (method, url, { cookie, body, key } = {}) =>
  app.inject({
    method,
    url,
    headers: { ...(cookie ? { cookie } : {}), ...(key ? { 'idempotency-key': key === true ? `bk-${(counter += 1)}-aaaaaaaa` : key } : {}) },
    ...(body !== undefined ? { payload: body } : {}),
  });
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
  await make({ code: BANK, name: 'Bancos', type: 'asset', parentCode: '1' });
  await make({ code: '110505', name: 'Caja', type: 'asset', parentCode: '1' });
  await make({ code: '4', name: 'Ingresos', type: 'income', postable: false });
  await make({ code: '413505', name: 'Ventas', type: 'income', parentCode: '4' });
  await make({ code: '421005', name: 'Intereses', type: 'income', parentCode: '4' });
  await make({ code: '5', name: 'Gastos', type: 'expense', postable: false });
  await make({ code: '530505', name: 'Gastos bancarios', type: 'expense', parentCode: '5' });
  await make({ code: '519595', name: 'Gastos diversos', type: 'expense', parentCode: '5' });
  return { cookie, base, tenantId: reg.json().tenantId };
}

async function joinAs(c, email, role) {
  await call('POST', '/v1/auth/register', { body: { companyName: `Empresa de ${email}`, country: 'CO', currency: 'COP', ownerName: 'X', email, password: PASSWORD } });
  const cookie = await login(email);
  expect((await call('POST', `${c.base}/members`, { cookie: c.cookie, body: { email, role } })).statusCode).toBe(202);
  expect((await call('POST', '/v1/invitations/accept', { cookie, body: { token: tokenIn(mailer.last(email)) } })).statusCode).toBe(201);
  return cookie;
}

/** Un asiento manual; devuelve el asiento. */
async function journal(c, lines, date = iso(-1)) {
  const res = await call('POST', `${c.base}/journals`, { cookie: c.cookie, key: true, body: { docType: 'AJ', date: `${date}T12:00:00Z`, currency: 'COP', lines } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().journal;
}
const deposit = (c, amount, date) => journal(c, [{ accountId: BANK, debit: amount }, { accountId: '413505', credit: amount }], date);
const withdrawal = (c, amount, date) => journal(c, [{ accountId: '519595', debit: amount }, { accountId: BANK, credit: amount }], date);
const bankIdx = (j) => j.lines.findIndex((l) => l.accountId === BANK);

const importLines = (c, lines, extra = {}, cookie = c.cookie) => call('POST', `${c.base}/bank/lines`, { cookie, body: { account: BANK, lines, ...extra } });
const line = (date, amount, description = 'Movimiento', reference) => ({ date, amount, description, ...(reference ? { reference } : {}) });
const listLines = async (c, query = {}) => (await call('GET', `${c.base}/bank/lines?${new URLSearchParams({ account: BANK, from: iso(-30), to: iso(1), ...query })}`, { cookie: c.cookie })).json();
const match = (c, bankLineId, j, lineIndex = bankIdx(j)) => call('POST', `${c.base}/bank/matches`, { cookie: c.cookie, body: { bankLineId, journalId: j._id, lineIndex } });
const summary = async (c, asOf, statementBalance) => (await call('GET', `${c.base}/bank/reconciliation?${new URLSearchParams({ account: BANK, asOf, statementBalance: String(statementBalance) })}`, { cookie: c.cookie })).json();
const close = (c, asOf, statementBalance) => call('POST', `${c.base}/bank/reconciliations`, { cookie: c.cookie, body: { account: BANK, asOf, statementBalance } });
const ids = async (c, query) => (await listLines(c, query)).items.map((l) => l._id);

beforeAll(async () => {
  mongo = await startMongo('lulubiz_bank_http_test');
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

describe('extracto', () => {
  it('carga las líneas y volver a cargar el mismo extracto no duplica nada', async () => {
    const c = await company();
    const file = [line(iso(-3), 1_000_000, 'Consignación', 'R-1'), line(iso(-2), -5_000, 'Comisión'), line(iso(-2), -5_000, 'Comisión')];
    const first = await importLines(c, file);
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json()).toEqual({ created: 3, skipped: 0 });
    // Las dos comisiones idénticas del mismo día son dos líneas distintas; al recargar se reconocen una por una.
    expect((await importLines(c, file)).json()).toEqual({ created: 0, skipped: 3 });
    // Un extracto que se traslapa con el anterior solo agrega lo nuevo.
    expect((await importLines(c, [...file, line(iso(-1), 2_000, 'Intereses')])).json()).toEqual({ created: 1, skipped: 3 });
    const listed = await listLines(c);
    expect(listed.items).toHaveLength(4);
    expect(listed.items.map((l) => [l.amount, l.status])).toEqual([[1_000_000, 'open'], [-5_000, 'open'], [-5_000, 'open'], [2_000, 'open']]);
    expect(listed.items[0]).toMatchObject({ description: 'Consignación', reference: 'R-1', accountId: BANK, currency: 'COP' });
  });

  it('rechaza lo que no es un extracto válido', async () => {
    const c = await company();
    const bad = async (lines, extra) => (await importLines(c, lines, extra)).statusCode;
    expect(await bad([])).toBe(400);
    expect(await bad([line('2026-13-01', 100)])).toBe(400);
    expect(await bad([line(iso(-1), 0)])).toBe(400);
    expect(await bad([line(iso(-1), 1.5)])).toBe(400);
    expect(await bad([{ date: iso(-1), amount: 100, description: '' }])).toBe(400);
    expect(await bad([line(iso(5), 100)])).toBe(400);
    expect(await bad([line(iso(-1), 100)], { account: '413505' })).toBe(400); // cuenta de ingresos
    expect(await bad([line(iso(-1), 100)], { account: '1' })).toBe(400); // cuenta de agrupación
    expect(await bad([line(iso(-1), 100)], { account: '999999' })).toBe(404);
    expect(await bad([line(iso(-1), 100)], { currency: 'EU' })).toBe(400);
    expect(await bad(Array.from({ length: 501 }, (_, i) => line(iso(-1), i + 1)))).toBe(400);
    expect((await listLines(c)).items).toEqual([]);
  });

  it('el lector ve el extracto pero no lo carga; el contador sí; otra empresa no lo ve', async () => {
    const a = await company('Andina SAS', 'ana@andina.co');
    const b = await company('Boreal SAS', 'bea@boreal.co');
    const viewer = await joinAs(a, 'lector@andina.co', 'viewer');
    const accountant = await joinAs(a, 'contador@andina.co', 'accountant');
    const cashier = await joinAs(a, 'cajero@andina.co', 'cashier');
    expect((await importLines(a, [line(iso(-1), 100)], {}, viewer)).statusCode).toBe(403);
    expect((await importLines(a, [line(iso(-1), 100)], {}, accountant)).statusCode).toBe(201);
    expect((await call('GET', `${a.base}/bank/lines?account=${BANK}&from=${iso(-5)}&to=${iso(0)}`, { cookie: viewer })).statusCode).toBe(200);
    expect((await call('GET', `${a.base}/bank/lines?account=${BANK}&from=${iso(-5)}&to=${iso(0)}`, { cookie: cashier })).statusCode).toBe(403);
    expect((await listLines(b)).items).toEqual([]);
    expect((await call('GET', `${a.base}/bank/lines?account=${BANK}&from=${iso(-5)}&to=${iso(0)}`, { cookie: b.cookie })).statusCode).toBe(403);
    expect((await call('GET', `${a.base}/bank/lines?account=${BANK}&from=${iso(-5)}&to=${iso(0)}`)).statusCode).toBe(401);
  });

  it('una línea sin conciliar se puede quitar; una conciliada, no', async () => {
    const c = await company();
    await importLines(c, [line(iso(-2), 100, 'Equivocada'), line(iso(-2), 700, 'Buena')]);
    const [wrong, good] = await ids(c);
    const j = await deposit(c, 700, iso(-2));
    expect((await match(c, good, j)).statusCode).toBe(201);
    expect((await call('DELETE', `${c.base}/bank/lines/${good}`, { cookie: c.cookie })).statusCode).toBe(409);
    expect((await call('DELETE', `${c.base}/bank/lines/${wrong}`, { cookie: c.cookie })).statusCode).toBe(200);
    expect((await call('DELETE', `${c.base}/bank/lines/${wrong}`, { cookie: c.cookie })).statusCode).toBe(404);
    expect((await listLines(c)).items.map((l) => l.description)).toEqual(['Buena']);
    // Quitada la línea, el mismo extracto la vuelve a cargar.
    expect((await importLines(c, [line(iso(-2), 100, 'Equivocada')])).json()).toEqual({ created: 1, skipped: 0 });
  });
});

describe('conciliar', () => {
  it('une una línea del extracto con la del libro del mismo importe, y se puede deshacer', async () => {
    const c = await company();
    await importLines(c, [line(iso(-2), 1_000_000, 'Consignación')]);
    const [lineId] = await ids(c);
    const j = await deposit(c, 1_000_000, iso(-2));
    const other = await deposit(c, 999_999, iso(-2));

    const candidates = (await call('GET', `${c.base}/bank/lines/${lineId}/candidates`, { cookie: c.cookie })).json();
    expect(candidates.items.map((x) => [x.journalId, x.lineIndex, x.amount])).toEqual([[j._id, 0, 1_000_000]]);

    expect((await match(c, lineId, other)).statusCode).toBe(400); // importes distintos
    expect((await match(c, lineId, j, 1)).statusCode).toBe(400); // la línea 1 es de ventas, no de bancos
    const ok = await match(c, lineId, j);
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().match).toMatchObject({ amount: 1_000_000, document: `AJ${j.number}` });

    const listed = (await listLines(c)).items[0];
    expect(listed.status).toBe('matched');
    expect(listed.match).toMatchObject({ journalId: j._id, lineIndex: 0, manual: false });
    expect((await ids(c, { status: 'open' }))).toEqual([]);
    expect((await call('GET', `${c.base}/bank/lines/${lineId}/candidates`, { cookie: c.cookie })).json().items).toEqual([]);

    expect((await call('DELETE', `${c.base}/bank/matches/${listed.match._id}`, { cookie: c.cookie })).statusCode).toBe(200);
    expect((await call('DELETE', `${c.base}/bank/matches/${listed.match._id}`, { cookie: c.cookie })).statusCode).toBe(404);
    expect((await ids(c, { status: 'open' }))).toEqual([lineId]);
    expect((await match(c, lineId, j)).statusCode).toBe(201);
  });

  it('una línea del libro o del extracto no se concilia dos veces, ni aunque lleguen a la vez', async () => {
    const c = await company();
    await importLines(c, [line(iso(-2), 500, 'Uno'), line(iso(-2), 500, 'Dos')]);
    const [a, b] = await ids(c);
    const j = await deposit(c, 500, iso(-2));
    const j2 = await deposit(c, 500, iso(-2));
    expect((await match(c, a, j)).statusCode).toBe(201);
    expect((await match(c, b, j)).statusCode).toBe(409); // el libro ya está conciliado
    expect((await match(c, a, j2)).statusCode).toBe(409); // el extracto ya está conciliado
    const results = await Promise.all([match(c, b, j2), match(c, b, j2), match(c, b, j2)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409, 409]);
    expect(await db.collection(COLLECTIONS.bankMatches).countDocuments({ tenantId: new ObjectId(c.tenantId), active: true })).toBe(2);
  });

  it('otra empresa no concilia con datos de esta', async () => {
    const a = await company('Andina SAS', 'ana@andina.co');
    const b = await company('Boreal SAS', 'bea@boreal.co');
    await importLines(a, [line(iso(-2), 500)]);
    const [lineId] = await ids(a);
    const mine = await deposit(a, 500, iso(-2));
    const theirs = await deposit(b, 500, iso(-2));
    expect((await match(b, lineId, theirs)).statusCode).toBe(404);
    expect((await match(a, lineId, theirs)).statusCode).toBe(404);
    expect((await match(a, lineId, mine)).statusCode).toBe(201);
  });

  it('la conciliación automática une solo lo inequívoco', async () => {
    const c = await company();
    await importLines(c, [
      line(iso(-5), 111_000, 'Único'),
      line(iso(-4), 222_000, 'Gemelo 1'),
      line(iso(-4), 222_000, 'Gemelo 2'),
      line(iso(-3), 333_000, 'Sin libro'),
      line(iso(-1), 444_000, 'Lejano'),
    ]);
    const unique = await deposit(c, 111_000, iso(-4));
    await deposit(c, 222_000, iso(-4));
    await deposit(c, 222_000, iso(-3));
    await deposit(c, 444_000, iso(-30)); // mismo importe pero fuera de la ventana de 10 días
    const result = await call('POST', `${c.base}/bank/matches/auto`, { cookie: c.cookie, body: { account: BANK } });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json()).toEqual({ matched: 1, ambiguous: 2, unmatched: 2 });
    const matched = (await listLines(c, { status: 'matched' })).items;
    expect(matched).toHaveLength(1);
    expect(matched[0]).toMatchObject({ description: 'Único', match: { journalId: unique._id } });
    // Repetirla no cambia nada.
    expect((await call('POST', `${c.base}/bank/matches/auto`, { cookie: c.cookie, body: { account: BANK } })).json()).toEqual({ matched: 0, ambiguous: 2, unmatched: 2 });
    // Con una ventana de 60 días el «Lejano» encuentra su libro.
    expect((await call('POST', `${c.base}/bank/matches/auto`, { cookie: c.cookie, body: { account: BANK, days: 60 } })).json().matched).toBe(1);
  });

  it('una línea del libro anterior al extracto se marca como conciliada con una razón', async () => {
    const c = await company();
    const opening = await deposit(c, 2_000_000, iso(-20));
    const body = { account: BANK, journalId: opening._id, lineIndex: 0 };
    expect((await call('POST', `${c.base}/bank/matches/manual`, { cookie: c.cookie, body })).statusCode).toBe(400);
    expect((await call('POST', `${c.base}/bank/matches/manual`, { cookie: c.cookie, body: { ...body, reason: 'Saldo inicial' } })).statusCode).toBe(201);
    expect((await call('POST', `${c.base}/bank/matches/manual`, { cookie: c.cookie, body: { ...body, reason: 'Otra vez' } })).statusCode).toBe(409);
    const s = await summary(c, iso(0), 0);
    expect(s.bookBalance).toBe(2_000_000);
    expect(s.unmatchedBook.count).toBe(0);
  });
});

describe('contabilizar desde el extracto', () => {
  it('una comisión sale del banco contra el gasto y queda conciliada en la misma operación', async () => {
    const c = await company();
    await importLines(c, [line(iso(-2), -5_000, 'Comisión manejo'), line(iso(-2), 2_000, 'Intereses')]);
    const [fee, interest] = await ids(c);
    const posted = await call('POST', `${c.base}/bank/lines/${fee}/book`, { cookie: c.cookie, body: { counterAccount: '530505' } });
    expect(posted.statusCode, posted.body).toBe(201);
    const j = posted.json().journal;
    expect(j).toMatchObject({ docType: 'CB', totalDebit: 5_000, totalCredit: 5_000 });
    expect(j.description).toBe('Extracto: Comisión manejo');
    expect(j.lines).toEqual([expect.objectContaining({ accountId: '530505', debit: 5_000 }), expect.objectContaining({ accountId: BANK, credit: 5_000 })]);
    expect((await listLines(c)).items.find((l) => l._id === fee)).toMatchObject({ status: 'matched', match: { document: `CB${j.number}` } });

    // Lo que ya se contabilizó no se contabiliza otra vez.
    expect((await call('POST', `${c.base}/bank/lines/${fee}/book`, { cookie: c.cookie, body: { counterAccount: '530505' } })).statusCode).toBe(409);
    // Un ingreso entra al banco contra la cuenta elegida.
    const inc = await call('POST', `${c.base}/bank/lines/${interest}/book`, { cookie: c.cookie, body: { counterAccount: '421005', description: 'Rendimientos de mayo' } });
    expect(inc.json().journal.lines).toEqual([expect.objectContaining({ accountId: BANK, debit: 2_000 }), expect.objectContaining({ accountId: '421005', credit: 2_000 })]);
    expect(inc.json().journal.description).toBe('Rendimientos de mayo');
    const s = await summary(c, iso(0), -3_000);
    expect(s.bookBalance).toBe(-3_000);
    expect(s.difference).toBe(0);
  });

  it('valida la cuenta contraria y no deja que un asiento manual use la serie CB', async () => {
    const c = await company();
    await importLines(c, [line(iso(-2), -5_000, 'Comisión')]);
    const [fee] = await ids(c);
    const book = (counterAccount) => call('POST', `${c.base}/bank/lines/${fee}/book`, { cookie: c.cookie, body: { counterAccount } });
    expect((await book(BANK)).statusCode).toBe(400);
    expect((await book('999999')).statusCode).toBe(400);
    expect((await book('5')).statusCode).toBe(400); // cuenta de agrupación
    expect((await ids(c, { status: 'open' }))).toEqual([fee]);
    expect(await db.collection(COLLECTIONS.journals).countDocuments({ tenantId: new ObjectId(c.tenantId), docType: 'CB' })).toBe(0);
    const manual = await call('POST', `${c.base}/journals`, { cookie: c.cookie, key: true, body: { docType: 'CB', date: `${iso(-1)}T12:00:00Z`, currency: 'COP', lines: [{ accountId: BANK, debit: 1 }, { accountId: '413505', credit: 1 }] } });
    expect(manual.statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe('conciliación a una fecha', () => {
  /** El caso de la guía: 1 consignación conciliada, 1 consignación y 1 cheque en tránsito, comisión e intereses sin contabilizar. */
  async function scenario(c) {
    await importLines(c, [line(iso(-3), 1_000_000, 'Consignación'), line(iso(-1), -5_000, 'Comisión'), line(iso(-1), 2_000, 'Intereses')]);
    const [l1] = await ids(c);
    const j1 = await deposit(c, 1_000_000, iso(-3));
    const inTransit = await deposit(c, 500_000, iso(-2));
    const check = await withdrawal(c, 200_000, iso(-2));
    expect((await match(c, l1, j1)).statusCode).toBe(201);
    return { j1, inTransit, check };
  }

  it('el resumen separa lo que el banco aún no tiene de lo que el libro aún no tiene, y la diferencia es cero', async () => {
    const c = await company();
    const { inTransit, check } = await scenario(c);
    const s = await summary(c, iso(-1), 997_000);
    expect(s).toMatchObject({ accountId: BANK, asOf: iso(-1), statementBalance: 997_000, bookBalance: 1_300_000, adjustedBank: 1_297_000, adjustedBook: 1_297_000, difference: 0, lastClosedAsOf: null });
    expect(s.unmatchedBook).toMatchObject({ count: 2, net: 300_000, truncated: false });
    expect(s.unmatchedBook.items.map((x) => [x.journalId, x.amount])).toEqual([[inTransit._id, 500_000], [check._id, -200_000]]);
    expect(s.unmatchedBank).toMatchObject({ count: 2, net: -3_000 });
    expect(s.unmatchedBank.items.map((x) => x.description)).toEqual(['Comisión', 'Intereses']);
    // Un saldo de extracto equivocado se ve en la diferencia.
    expect((await summary(c, iso(-1), 990_000)).difference).toBe(-7_000);
  });

  it('un movimiento posterior a la fecha no cuenta, y una conciliación que cruza la fecha deja la partida en tránsito', async () => {
    const c = await company();
    // El banco pagó el cheque (D0) después de la fecha de corte (D-1) que el libro ya tenía (D-2).
    const check = await withdrawal(c, 200_000, iso(-2));
    await importLines(c, [line(iso(0), -200_000, 'Cheque pagado')]);
    const [l] = await ids(c);
    expect((await match(c, l, check)).statusCode).toBe(201);
    const atCut = await summary(c, iso(-1), 0);
    expect(atCut.bookBalance).toBe(-200_000);
    expect(atCut.unmatchedBook).toMatchObject({ count: 1, net: -200_000 });
    expect(atCut.unmatchedBank.count).toBe(0);
    expect(atCut.difference).toBe(0);
    // Al día siguiente el cheque ya está en el extracto.
    const later = await summary(c, iso(0), -200_000);
    expect(later.unmatchedBook.count).toBe(0);
    expect(later.difference).toBe(0);
  });

  it('cerrar exige diferencia cero y deja el tramo inmodificable; solo se reabre la última', async () => {
    const c = await company();
    await scenario(c);
    const bad = await close(c, iso(-1), 990_000);
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error).toBe('NOT_BALANCED');
    expect((await close(c, iso(5), 0)).statusCode).toBe(400);

    const closed = await close(c, iso(-1), 997_000);
    expect(closed.statusCode, closed.body).toBe(201);
    expect(closed.json()).toMatchObject({ asOf: iso(-1), statementBalance: 997_000, bookBalance: 1_300_000, unmatchedBookNet: 300_000, unmatchedBankNet: -3_000, status: 'closed' });
    expect((await call('GET', `${c.base}/bank/reconciliations?account=${BANK}`, { cookie: c.cookie })).json().items.map((r) => r.asOf)).toEqual([iso(-1)]);
    expect((await summary(c, iso(0), 997_000)).lastClosedAsOf).toBe(iso(-1));

    // Lo de la fecha de cierre o anterior ya no se toca.
    expect((await close(c, iso(-1), 997_000)).statusCode).toBe(409);
    expect((await close(c, iso(-2), 0)).statusCode).toBe(409);
    expect((await importLines(c, [line(iso(-2), 77, 'Tardía')])).statusCode).toBe(409);
    const [l1, fee] = await ids(c);
    const matchId = (await listLines(c)).items.find((l) => l._id === l1).match._id;
    expect((await call('DELETE', `${c.base}/bank/matches/${matchId}`, { cookie: c.cookie })).statusCode).toBe(409);
    expect((await call('DELETE', `${c.base}/bank/lines/${fee}`, { cookie: c.cookie })).statusCode).toBe(409);
    expect((await call('POST', `${c.base}/bank/lines/${fee}/book`, { cookie: c.cookie, body: { counterAccount: '530505' } })).statusCode).toBe(409);

    // Lo posterior sí sigue su curso: se importa, se concilia, se cierra.
    expect((await importLines(c, [line(iso(0), 50_000, 'Hoy')])).statusCode).toBe(201);
    const today = await deposit(c, 50_000, iso(0));
    const todayLine = (await listLines(c)).items.find((l) => l.description === 'Hoy');
    expect((await match(c, todayLine._id, today)).statusCode).toBe(201);
    const second = await close(c, iso(0), 1_047_000);
    expect(second.statusCode, second.body).toBe(201);

    // Solo se reabre la última.
    const first = closed.json()._id;
    expect((await call('POST', `${c.base}/bank/reconciliations/${first}/reopen`, { cookie: c.cookie })).statusCode).toBe(409);
    expect((await call('POST', `${c.base}/bank/reconciliations/${second.json()._id}/reopen`, { cookie: c.cookie })).statusCode).toBe(200);
    expect((await call('POST', `${c.base}/bank/reconciliations/${second.json()._id}/reopen`, { cookie: c.cookie })).statusCode).toBe(404);
    expect((await summary(c, iso(0), 1_047_000)).lastClosedAsOf).toBe(iso(-1));
    expect((await call('POST', `${c.base}/bank/reconciliations/${first}/reopen`, { cookie: c.cookie })).statusCode).toBe(200);
    expect((await importLines(c, [line(iso(-2), 77, 'Tardía')])).statusCode).toBe(201);
  });

  it('el contador cierra y reabre; el lector solo lee el resumen', async () => {
    const c = await company();
    await scenario(c);
    const viewer = await joinAs(c, 'lector@andina.co', 'viewer');
    const accountant = await joinAs(c, 'contador@andina.co', 'accountant');
    const body = { account: BANK, asOf: iso(-1), statementBalance: 997_000 };
    expect((await call('POST', `${c.base}/bank/reconciliations`, { cookie: viewer, body })).statusCode).toBe(403);
    expect((await call('GET', `${c.base}/bank/reconciliation?account=${BANK}&asOf=${iso(-1)}&statementBalance=997000`, { cookie: viewer })).statusCode).toBe(200);
    const closed = await call('POST', `${c.base}/bank/reconciliations`, { cookie: accountant, body });
    expect(closed.statusCode).toBe(201);
    expect((await call('POST', `${c.base}/bank/reconciliations/${closed.json()._id}/reopen`, { cookie: viewer })).statusCode).toBe(403);
    expect((await call('POST', `${c.base}/bank/reconciliations/${closed.json()._id}/reopen`, { cookie: accountant })).statusCode).toBe(200);
  });

  it('valida los parámetros del resumen', async () => {
    const c = await company();
    const get = (q) => call('GET', `${c.base}/bank/reconciliation?${new URLSearchParams(q)}`, { cookie: c.cookie });
    expect((await get({ account: BANK, asOf: iso(-1) })).statusCode).toBe(400);
    expect((await get({ account: BANK, asOf: iso(-1), statementBalance: '1.5' })).statusCode).toBe(400);
    expect((await get({ account: BANK, asOf: '2026-02-30', statementBalance: '0' })).statusCode).toBe(400);
    expect((await get({ account: '413505', asOf: iso(-1), statementBalance: '0' })).statusCode).toBe(400);
  });
});

describe('auditoría', () => {
  it('cada conciliación, contabilización y cierre deja su evento', async () => {
    const c = await company();
    await importLines(c, [line(iso(-2), 1_000, 'Consignación'), line(iso(-2), -300, 'Comisión')]);
    const [l1, l2] = await ids(c);
    const j = await deposit(c, 1_000, iso(-2));
    await match(c, l1, j);
    await call('POST', `${c.base}/bank/lines/${l2}/book`, { cookie: c.cookie, body: { counterAccount: '530505' } });
    await close(c, iso(-1), 700);
    const actions = (await db.collection(COLLECTIONS.audit).find({ tenantId: new ObjectId(c.tenantId), action: /^bank\./ }).toArray()).map((e) => e.action).sort();
    expect(actions).toEqual(['bank.book', 'bank.import', 'bank.match', 'bank.reconcile']);
  });
});
