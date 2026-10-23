import { ObjectId } from 'mongodb';
import { DAY_MS, dayOf, parseDay as parseCalendarDay } from '../core/dates.js';
import { assertMinorUnits } from '../core/money.js';
import { normalizeCenter } from '../core/dims.js';
import { COLLECTIONS } from '../data/db.js';
import { TenantCollection } from '../data/tenantCollection.js';
import { isDuplicate, withTransaction } from '../data/tx.js';

export const MAX_LIFE_MONTHS = 600;
export const MAX_PAGE = 50;
const CODE = /^[A-Z0-9][A-Z0-9._-]{0,19}$/;
const ACCOUNT = /^[0-9]{1,12}$/;
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;

export class FixedAssetError extends Error {
  constructor(message, code = 'VALIDATION') {
    super(message);
    this.name = 'FixedAssetError';
    this.code = code;
  }
}

const fail = (message, code) => {
  throw new FixedAssetError(message, code);
};
const parseDay = (value, label) => parseCalendarDay(value, label, fail);
const text = (value, label, { required = false, max = 200 } = {}) => {
  const clean = String(value ?? '').trim();
  if (required && !clean) fail(`falta ${label}`);
  if (clean.length > max) fail(`${label} admite como máximo ${max} caracteres`);
  return clean || undefined;
};

/** `AAAA-MM` de una fecha. */
export const periodOf = (date) => date.toISOString().slice(0, 7);

/** Meses contados desde `start` hasta `period`, ambos incluidos; 0 si el período es anterior al inicio. */
export function monthsThrough(start, period) {
  const [y1, m1] = start.split('-').map(Number);
  const [y2, m2] = period.split('-').map(Number);
  return Math.max(0, (y2 - y1) * 12 + (m2 - m1) + 1);
}

/**
 * Depreciación acumulada tras `months` meses en línea recta: `floor(depreciable × meses / vida)`. Cada mes es la diferencia
 * entre dos acumulados, así que la suma de todos los meses es exactamente el valor depreciable, sin céntimos perdidos,
 * y el residuo del redondeo cae donde corresponde. Aritmética con BigInt: sin números decimales.
 */
export function accumulatedAfter(depreciable, lifeMonths, months) {
  const k = Math.min(Math.max(months, 0), lifeMonths);
  return Number((BigInt(depreciable) * BigInt(k)) / BigInt(lifeMonths));
}

/** Calendario completo de un activo: mes, cuota, acumulado y valor en libros, y si ya se contabilizó. */
export function scheduleOf(asset) {
  const depreciable = asset.cost - asset.salvageValue;
  const [y, m] = asset.depreciationStart.split('-').map(Number);
  const rows = [];
  for (let k = 1; k <= asset.usefulLifeMonths; k += 1) {
    const date = new Date(Date.UTC(y, m - 1 + (k - 1), 1));
    const accumulated = accumulatedAfter(depreciable, asset.usefulLifeMonths, k);
    rows.push({ month: k, period: periodOf(date), amount: accumulated - accumulatedAfter(depreciable, asset.usefulLifeMonths, k - 1), accumulated, bookValue: asset.cost - accumulated, posted: k <= asset.depreciatedMonths });
  }
  return rows;
}

const present = (asset) => {
  if (!asset) return asset;
  const depreciable = asset.cost - asset.salvageValue;
  const nextAmount = asset.depreciatedMonths < asset.usefulLifeMonths ? accumulatedAfter(depreciable, asset.usefulLifeMonths, asset.depreciatedMonths + 1) - asset.depreciatedTotal : 0;
  return { ...asset, bookValue: asset.cost - asset.depreciatedTotal, fullyDepreciated: asset.depreciatedMonths >= asset.usefulLifeMonths, nextAmount };
};

/*
 * Activos fijos y su depreciación en línea recta.
 *
 *  - La ficha del activo (código, costo, valor residual, vida útil en meses, cuentas) es un auxiliar del libro. **Registrarla
 *    no asienta nada**: el costo del activo entra al libro por la compra que lo trajo (una línea sobre la cuenta del activo) o
 *    por un asiento de saldos iniciales. El informe de conciliación compara la suma de las fichas con el saldo de cada cuenta.
 *  - La depreciación mensual se contabiliza **por período**: un asiento `DP` por corrida con una línea de gasto por cuenta y
 *    centro de costo, y otra de depreciación acumulada. Cada activo recibe los meses que le deben hasta ese período (puede
 *    ser más de uno si la corrida se atrasó). Cada actualización de un activo está condicionada a los meses que se
 *    esperaba que llevara, dentro de la misma transacción del asiento: dos corridas simultáneas no depreciarían dos veces.
 *  - Dar de baja un activo (venta o retiro) exige que esté depreciado hasta el mes de la baja, asienta `BF` (acumulada y
 *    precio de venta al débito, costo al crédito, y la diferencia como pérdida o ganancia) y lo deja `disposed`.
 *
 * Límites: solo línea recta; sin revaluación ni deterioro; sin depreciación por días (el mes de compra cuenta completo si así
 * se elige el inicio); sin componentes de un activo; el costo no se edita una vez registrado (se da de baja y se registra otro).
 */
export function createFixedAssetService({ client, db, ledger, accounts, now = () => new Date() }) {
  const assetsOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.fixedAssets), tenantId);
  const runsOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.depreciationRuns), tenantId);
  const balancesOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.balances), tenantId);
  const tenants = db.collection(COLLECTIONS.tenants);

  async function tenantCurrency(tenantId) {
    const tenant = await tenants.findOne({ _id: tenantId }, { projection: { currency: 1 } });
    if (!tenant) fail('la empresa no existe', 'NOT_FOUND');
    return tenant.currency;
  }

  async function checkAccount(tenantId, code, types, label) {
    if (!ACCOUNT.test(String(code ?? ''))) fail(`indica ${label}`);
    const problems = await accounts.postingProblems(tenantId, [code]);
    if (problems.length) fail(problems.join('; '));
    const account = await accounts.get(tenantId, code);
    if (!types.includes(account.type)) fail(`${label}: la cuenta ${code} no es de un tipo válido (${types.join(' o ')})`);
  }

  const lastDayOf = (period) => {
    const [y, m] = period.split('-').map(Number);
    const end = new Date(Date.UTC(y, m, 0, 12));
    const today = parseCalendarDay(dayOf(now()), 'hoy', fail);
    return end > today ? today : end;
  };

  const api = {
    async create(tenantId, input, ctx = {}) {
      const code = text(input.code, 'el código del activo', { required: true, max: 20 }).toUpperCase();
      if (!CODE.test(code)) fail('el código admite letras, números, punto, guion y guion bajo (hasta 20 caracteres)');
      const name = text(input.name, 'el nombre del activo', { required: true, max: 200 });
      const acquisitionDate = parseDay(input.acquisitionDate, 'la fecha de adquisición');
      if (acquisitionDate.getTime() > now().getTime() + DAY_MS) fail('la fecha de adquisición no puede ser futura');
      const cost = assertMinorUnits(input.cost, 'el costo');
      if (cost <= 0) fail('el costo debe ser mayor que cero');
      const salvageValue = assertMinorUnits(input.salvageValue ?? 0, 'el valor residual');
      if (salvageValue >= cost) fail('el valor residual debe ser menor que el costo');
      const life = input.usefulLifeMonths;
      if (!Number.isInteger(life) || life < 1 || life > MAX_LIFE_MONTHS) fail(`la vida útil va de 1 a ${MAX_LIFE_MONTHS} meses`);
      const start = input.depreciationStart ?? periodOf(acquisitionDate);
      if (!PERIOD.test(start)) fail('el mes de inicio de la depreciación debe tener el formato AAAA-MM');
      if (start < periodOf(acquisitionDate)) fail('la depreciación no puede empezar antes de la adquisición');
      const costCenter = normalizeCenter(input.costCenter);
      const a = input.accounts ?? {};
      await checkAccount(tenantId, a.asset, ['asset'], 'la cuenta del activo');
      await checkAccount(tenantId, a.accumulated, ['asset'], 'la cuenta de depreciación acumulada');
      await checkAccount(tenantId, a.expense, ['expense', 'cost'], 'la cuenta del gasto de depreciación');
      if (new Set([a.asset, a.accumulated, a.expense]).size < 3) fail('las tres cuentas del activo deben ser distintas');
      if (costCenter && !(await db.collection(COLLECTIONS.costCenters).findOne({ tenantId, code: costCenter, active: true }))) fail(`el centro de costo ${costCenter} no existe o está inactivo`);
      const doc = {
        code,
        name,
        ...(text(input.description, 'la descripción', { max: 500 }) ? { description: text(input.description, 'la descripción', { max: 500 }) } : {}),
        status: 'active',
        acquisitionDate,
        currency: await tenantCurrency(tenantId),
        cost,
        salvageValue,
        usefulLifeMonths: life,
        method: 'straight_line',
        depreciationStart: start,
        accounts: { asset: a.asset, accumulated: a.accumulated, expense: a.expense },
        ...(costCenter ? { costCenter } : {}),
        ...(input.purchaseId && /^[a-f0-9]{24}$/.test(String(input.purchaseId)) ? { purchaseId: new ObjectId(String(input.purchaseId)) } : {}),
        depreciatedMonths: 0,
        depreciatedTotal: 0,
        createdBy: ctx.userId ?? null,
        createdAt: now(),
      };
      try {
        const { insertedId } = await assetsOf(tenantId).insertOne({ ...doc });
        await ctx.auditTx?.(undefined, { action: 'fixed_asset.create', target: insertedId, details: { code, cost } });
        return present({ ...doc, _id: insertedId, tenantId });
      } catch (err) {
        if (isDuplicate(err, 'tenant_fixedasset_code')) fail(`ya existe un activo con el código ${code}`, 'DUPLICATE');
        throw err;
      }
    },

    async get(tenantId, id) {
      if (!/^[a-f0-9]{24}$/.test(String(id))) fail('activo inválido');
      const asset = await assetsOf(tenantId).findOne({ _id: new ObjectId(id) });
      return asset ? { ...present(asset), schedule: scheduleOf(asset) } : null;
    },

    async list(tenantId, { status, limit = 25, cursor } = {}) {
      const size = Math.min(Math.max(Number(limit) || 25, 1), MAX_PAGE);
      const filter = { ...(status ? { status: String(status) } : {}), ...(cursor ? { _id: { $lt: new ObjectId(cursor) } } : {}) };
      const rows = await assetsOf(tenantId).find(filter, { sort: { _id: -1 }, limit: size + 1 }).toArray();
      const hasMore = rows.length > size;
      const items = hasMore ? rows.slice(0, size) : rows;
      return { items: items.map(present), nextCursor: hasMore ? items[items.length - 1]._id.toHexString() : null };
    },

    /** Renombra o cambia la descripción y el centro de costo. El costo, la vida y las cuentas no se editan. */
    async update(tenantId, id, input, ctx = {}) {
      const asset = await api.get(tenantId, id);
      if (!asset) fail('el activo no existe', 'NOT_FOUND');
      const set = {};
      const unset = {};
      if (input.name !== undefined) set.name = text(input.name, 'el nombre del activo', { required: true, max: 200 });
      if (input.description !== undefined) {
        const d = text(input.description, 'la descripción', { max: 500 });
        if (d) set.description = d;
        else unset.description = '';
      }
      if (input.costCenter !== undefined) {
        const c = normalizeCenter(input.costCenter);
        if (c) {
          if (!(await db.collection(COLLECTIONS.costCenters).findOne({ tenantId, code: c, active: true }))) fail(`el centro de costo ${c} no existe o está inactivo`);
          set.costCenter = c;
        } else unset.costCenter = '';
      }
      if (!Object.keys(set).length && !Object.keys(unset).length) fail('no hay nada que cambiar');
      await assetsOf(tenantId).updateOne({ _id: asset._id }, { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) });
      await ctx.auditTx?.(undefined, { action: 'fixed_asset.update', target: asset._id, details: { code: asset.code } });
      return api.get(tenantId, id);
    },

    /**
     * Contabiliza la depreciación de todos los activos hasta el período dado: un asiento `DP`. Cada activo recibe los meses
     * que le deben (más de uno si se atrasó). Si no hay nada que depreciar no se asienta nada.
     */
    async depreciate(tenantId, { period }, ctx = {}) {
      if (!PERIOD.test(String(period ?? ''))) fail('el período debe tener el formato AAAA-MM');
      if (period > periodOf(now())) fail('no se deprecia un período futuro');
      const assets = await assetsOf(tenantId).find({ status: 'active', depreciationStart: { $lte: period }, $expr: { $lt: ['$depreciatedMonths', '$usefulLifeMonths'] } }).toArray();
      const owed = [];
      for (const asset of assets) {
        const depreciable = asset.cost - asset.salvageValue;
        const target = Math.min(monthsThrough(asset.depreciationStart, period), asset.usefulLifeMonths);
        if (target <= asset.depreciatedMonths) continue;
        const total = accumulatedAfter(depreciable, asset.usefulLifeMonths, target);
        const amount = total - asset.depreciatedTotal;
        owed.push({ asset, target, total, amount });
      }
      const payable = owed.filter((o) => o.amount > 0);
      if (payable.length === 0) {
        // Meses sin importe (valor depreciable muy pequeño): se avanzan sin asiento para no quedar atrasados.
        for (const o of owed) await assetsOf(tenantId).updateOne({ _id: o.asset._id, depreciatedMonths: o.asset.depreciatedMonths }, { $set: { depreciatedMonths: o.target, depreciatedTotal: o.total, lastDepreciatedPeriod: period } });
        return { run: null, assets: 0, total: 0 };
      }

      const expense = new Map();
      const accumulated = new Map();
      for (const o of payable) {
        const key = `${o.asset.accounts.expense}|${o.asset.costCenter ?? ''}`;
        expense.set(key, { accountId: o.asset.accounts.expense, costCenter: o.asset.costCenter, amount: (expense.get(key)?.amount ?? 0) + o.amount });
        accumulated.set(o.asset.accounts.accumulated, (accumulated.get(o.asset.accounts.accumulated) ?? 0) + o.amount);
      }
      const lines = [
        ...[...expense.values()].map((e) => ({ accountId: e.accountId, debit: e.amount, ...(e.costCenter ? { costCenter: e.costCenter } : {}) })),
        ...[...accumulated].map(([accountId, amount]) => ({ accountId, credit: amount })),
      ];
      const total = payable.reduce((acc, o) => acc + o.amount, 0);
      const runId = new ObjectId();
      const currency = payable[0].asset.currency;
      const { journal } = await ledger.postJournal(
        tenantId,
        { docType: 'DP', date: lastDayOf(period), currency, idempotencyKey: `depreciation-${runId}`, description: `Depreciación de ${period}`, source: { kind: 'depreciation', id: String(runId) }, lines },
        {
          inTx: async (session, { journal: posted }) => {
            for (const o of owed) {
              const res = await assetsOf(tenantId).updateOne(
                { _id: o.asset._id, status: 'active', depreciatedMonths: o.asset.depreciatedMonths },
                { $set: { depreciatedMonths: o.target, depreciatedTotal: o.total, lastDepreciatedPeriod: period } },
                { session },
              );
              if (res.matchedCount === 0) fail('un activo cambió mientras se depreciaba (otra corrida o una baja): vuelve a intentarlo', 'INVALID_STATE');
            }
            await runsOf(tenantId).insertOne(
              { _id: runId, period, journalId: posted._id, document: `DP${posted.number}`, total, items: payable.map((o) => ({ assetId: o.asset._id, code: o.asset.code, fromMonth: o.asset.depreciatedMonths + 1, toMonth: o.target, amount: o.amount })), createdBy: ctx.userId ?? null, createdAt: now() },
              session,
            );
            await ctx.auditTx?.(session, { action: 'fixed_asset.depreciate', target: runId, details: { period, assets: payable.length, total } });
          },
        },
      );
      return { run: { _id: runId, period, journalId: journal._id, document: `DP${journal.number}`, total }, assets: payable.length, total };
    },

    async listRuns(tenantId, { limit = 25 } = {}) {
      const rows = await runsOf(tenantId).find({}, { sort: { _id: -1 }, limit: Math.min(Math.max(Number(limit) || 25, 1), MAX_PAGE) }).toArray();
      return { items: rows };
    },

    /** Da de baja un activo: venta (con precio) o retiro (sin precio). */
    async dispose(tenantId, id, input, ctx = {}) {
      const asset = await assetsOf(tenantId).findOne({ _id: new ObjectId(id) });
      if (!asset) fail('el activo no existe', 'NOT_FOUND');
      if (asset.status !== 'active') fail('el activo ya fue dado de baja', 'INVALID_STATE');
      const date = parseDay(input.date, 'la fecha de la baja');
      if (date.getTime() > now().getTime() + DAY_MS) fail('la fecha de la baja no puede ser futura');
      if (date < asset.acquisitionDate) fail('la baja no puede ser anterior a la adquisición');
      const period = periodOf(date);
      const through = Math.min(monthsThrough(asset.depreciationStart, period), asset.usefulLifeMonths);
      if (asset.depreciatedMonths < through) fail(`primero deprecia el activo hasta ${period} (le faltan ${through - asset.depreciatedMonths} meses)`, 'INVALID_STATE');
      if (asset.depreciatedMonths > through) fail('el activo ya se depreció después de esa fecha: la baja no puede ser anterior', 'INVALID_STATE');
      const proceeds = assertMinorUnits(input.proceeds ?? 0, 'el precio de venta');
      const bookValue = asset.cost - asset.depreciatedTotal;
      const lines = [{ accountId: asset.accounts.asset, credit: asset.cost, ...(asset.costCenter ? { costCenter: asset.costCenter } : {}) }];
      if (asset.depreciatedTotal > 0) lines.push({ accountId: asset.accounts.accumulated, debit: asset.depreciatedTotal });
      if (proceeds > 0) {
        await checkAccount(tenantId, input.proceedsAccount, ['asset'], 'la cuenta donde entra el dinero de la venta');
        lines.push({ accountId: input.proceedsAccount, debit: proceeds });
      }
      const difference = proceeds - bookValue;
      if (difference < 0) {
        await checkAccount(tenantId, input.lossAccount, ['expense'], 'la cuenta de la pérdida en la baja');
        lines.push({ accountId: input.lossAccount, debit: -difference, ...(asset.costCenter ? { costCenter: asset.costCenter } : {}) });
      } else if (difference > 0) {
        await checkAccount(tenantId, input.gainAccount, ['income'], 'la cuenta de la utilidad en la venta');
        lines.push({ accountId: input.gainAccount, credit: difference, ...(asset.costCenter ? { costCenter: asset.costCenter } : {}) });
      }
      const { journal } = await ledger.postJournal(
        tenantId,
        {
          docType: 'BF',
          date,
          currency: asset.currency,
          idempotencyKey: `asset-disposal-${asset._id}`,
          description: `${proceeds > 0 ? 'Venta' : 'Baja'} del activo ${asset.code} ${asset.name}`,
          source: { kind: 'asset_disposal', id: String(asset._id) },
          lines,
        },
        {
          inTx: async (session, { journal: posted }) => {
            const res = await assetsOf(tenantId).updateOne(
              { _id: asset._id, status: 'active', depreciatedMonths: asset.depreciatedMonths },
              { $set: { status: 'disposed', disposal: { date, proceeds, bookValue, difference, journalId: posted._id, document: `BF${posted.number}` }, disposedAt: now(), disposedBy: ctx.userId ?? null } },
              { session },
            );
            if (res.matchedCount === 0) fail('el activo cambió mientras se daba de baja: vuelve a intentarlo', 'INVALID_STATE');
            await ctx.auditTx?.(session, { action: 'fixed_asset.dispose', target: asset._id, details: { code: asset.code, proceeds, bookValue, difference } });
          },
        },
      );
      return { asset: await api.get(tenantId, id), journal };
    },

    /** Compara la suma de las fichas con el saldo de cada cuenta del libro: cuánto del libro respalda la ficha. */
    async reconciliation(tenantId, { currency } = {}) {
      const cur = currency ?? (await tenantCurrency(tenantId));
      const active = await assetsOf(tenantId).find({ status: 'active', currency: cur }).toArray();
      const wanted = new Map();
      const add = (code, field, amount) => {
        const row = wanted.get(code) ?? { code, assets: 0, accumulated: 0, kind: field === 'assets' ? 'cost' : 'accumulated' };
        row[field] += amount;
        wanted.set(code, row);
      };
      for (const a of active) {
        add(a.accounts.asset, 'assets', a.cost);
        add(a.accounts.accumulated, 'accumulated', a.depreciatedTotal);
      }
      const codes = [...wanted.keys()];
      const rows = codes.length
        ? await balancesOf(tenantId)
            .aggregate([{ $match: { currency: cur, accountId: { $in: codes } } }, { $group: { _id: '$accountId', debit: { $sum: '$debit' }, credit: { $sum: '$credit' } } }])
            .toArray()
        : [];
      const net = new Map(rows.map((r) => [r._id, Number(r.debit) - Number(r.credit)]));
      const named = new Map((await accounts.list(tenantId)).map((a) => [a.code, a.name]));
      const lines = [...wanted.values()].map((row) => {
        // Una cuenta de activo suma por el débito; la depreciación acumulada, por el crédito.
        const ledgerCost = net.get(row.code) ?? 0;
        const isAccumulated = row.kind === 'accumulated';
        const subledger = isAccumulated ? row.accumulated : row.assets;
        const ledgerBalance = isAccumulated ? 0 - ledgerCost : ledgerCost;
        return { code: row.code, name: named.get(row.code) ?? null, kind: isAccumulated ? 'accumulated' : 'cost', subledger, ledger: ledgerBalance, difference: ledgerBalance - subledger };
      });
      return { currency: cur, lines: lines.sort((a, b) => (a.code < b.code ? -1 : 1)), ok: lines.every((l) => l.difference === 0) };
    },
  };
  return api;
}
