import { ObjectId } from 'mongodb';
import { DAY_MS, parseDay as parseCalendarDay } from '../core/dates.js';
import { assertMinorUnits } from '../core/money.js';
import { toNameKey } from '../core/text.js';
import { COLLECTIONS } from '../data/db.js';
import { TenantCollection } from '../data/tenantCollection.js';
import { isDuplicate, withTransaction } from '../data/tx.js';
import { roundDiv } from '../invoicing/tax.js';

export const MAX_ITEM_PAGE = 50;
export const MAX_KARDEX_PAGE = 100;
export const MAX_VALUATION_ROWS = 500;
export const ITEM_TYPES = ['goods', 'service'];
export const DEFAULT_WAREHOUSE = 'PRINCIPAL';
const SKU = /^[A-Z0-9][A-Z0-9._-]{0,39}$/;
const ACCOUNT = /^[0-9]{1,12}$/;

export class InventoryError extends Error {
  constructor(message, code = 'VALIDATION') {
    super(message);
    this.name = 'InventoryError';
    this.code = code;
  }
}

const fail = (message, code) => {
  throw new InventoryError(message, code);
};
const parseDay = (value, label) => parseCalendarDay(value, label, fail);

const text = (value, label, { required = false, max = 200 } = {}) => {
  const clean = String(value ?? '').trim();
  if (!clean) {
    if (required) fail(`falta ${label}`);
    return undefined;
  }
  if (clean.length > max) fail(`${label} admite como máximo ${max} caracteres`);
  return clean;
};

const optionalInt = (value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  if (value === undefined || value === null || value === '') return undefined;
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${label} debe ser un entero entre ${min} y ${max}`);
  return value;
};

/** Valor de `quantity` (milésimas) a `unitCost` (unidades menores por unidad entera), medio hacia arriba. */
export const valueOf = (quantity, unitCost) => Number(roundDiv(BigInt(unitCost) * BigInt(quantity), 1000n));

/** Costo de sacar `quantity` de una existencia: el promedio, o todo el valor si sale todo (sin residuos). */
export function averageCost(stock, quantity) {
  if (quantity === stock.quantity) return stock.value;
  return Number(roundDiv(BigInt(stock.value) * BigInt(quantity), BigInt(stock.quantity)));
}

/**
 * Costo que vuelve a la existencia al devolver `quantity` de una línea vendida por `soldQuantity` a `soldCost`.
 * Vuelve al costo al que salió, no al promedio de hoy. La devolución que agota lo vendido recibe lo que quede,
 * para que devolver todo en varias partes sume exactamente el costo original.
 */
export function returnedCost(soldCost, soldQuantity, { quantity, restockedQuantity = 0, restockedCost = 0 }) {
  const remaining = soldQuantity - restockedQuantity;
  if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > remaining) throw new InventoryError('no se puede devolver más de lo vendido');
  if (quantity === remaining) return soldCost - restockedCost;
  return Math.min(Number(roundDiv(BigInt(soldCost) * BigInt(quantity), BigInt(soldQuantity))), soldCost - restockedCost);
}

/*
 * Inventario con costo promedio ponderado, permanente.
 *
 *  - Artículo: { sku, name, nameKey, type 'goods'|'service', unit, inventoryAccount?, cogsAccount?, incomeAccount?,
 *    price?, vatBps?, minStock?, active }. Un bien lleva cuenta de inventario (activo) y de costo de ventas; un
 *    servicio no maneja existencias.
 *  - Existencia (`stock`): una por artículo y bodega, con cantidad (milésimas) y valor (unidades menores). El costo
 *    promedio es valor / cantidad. El valor de todas las existencias de una cuenta debe ser el saldo de esa cuenta.
 *  - Movimiento (`movements`, solo se agrega): cantidad y valor con signo, y los saldos que quedaron después de aplicarlo.
 *    Un movimiento nunca se edita: se corrige con otro de signo contrario.
 *
 * Una salida cuesta el promedio del momento, que depende del estado de la existencia. Por eso se planea leyendo y se
 * aplica con una condición de igualdad sobre cantidad y valor: si otra operación cambió la existencia entremedias,
 * la aplicación falla con `STOCK_CONFLICT` y quien llama repite todo (`withStockRetry`). Las entradas y las salidas
 * de valor exacto (reversos) no dependen del promedio.
 */
export function createInventoryService({ client, db, ledger, accounts, now = () => new Date() }) {
  const itemsOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.items), tenantId);
  const warehousesOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.warehouses), tenantId);
  const stockOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.stock), tenantId);
  const movementsOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.movements), tenantId);
  const docsOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.stockDocs), tenantId);
  const tenants = db.collection(COLLECTIONS.tenants);

  async function currencyOf(tenantId) {
    const tenant = await tenants.findOne({ _id: tenantId }, { projection: { currency: 1 } });
    if (!tenant) fail('la empresa no existe', 'NOT_FOUND');
    return tenant.currency;
  }

  /** El contador debe existir antes de la transacción: un upsert dentro de ella chocaría entre concurrentes (mismo patrón que el libro). */
  async function ensureCounter(tenantId, docType) {
    try {
      await db.collection(COLLECTIONS.counters).updateOne({ tenantId, docType }, { $setOnInsert: { last: 0 } }, { upsert: true });
    } catch (err) {
      if (!isDuplicate(err, 'tenant_doctype')) throw err;
    }
  }

  async function nextNumber(tenantId, docType, session) {
    const doc = await db.collection(COLLECTIONS.counters).findOneAndUpdate({ tenantId, docType }, { $inc: { last: 1 } }, { returnDocument: 'after', session });
    if (!doc) throw new Error('contador inexistente: falta ensureCounter');
    return doc.last;
  }

  async function checkAccount(tenantId, code, types, label, { required }) {
    const clean = String(code ?? '').trim();
    if (!clean) {
      if (required) fail(`falta ${label}`);
      return undefined;
    }
    if (!ACCOUNT.test(clean)) fail(`${label} debe ser un código numérico`);
    const problems = await accounts.postingProblems(tenantId, [clean]);
    if (problems.length) fail(problems.join('; '));
    const account = await accounts.get(tenantId, clean);
    if (!types.includes(account.type)) fail(`la cuenta ${clean} no sirve como ${label}`);
    return clean;
  }

  // ------------------------------------------------------------------ bodegas

  async function ensureDefaultWarehouse(tenantId) {
    const found = await warehousesOf(tenantId).findOne({ code: DEFAULT_WAREHOUSE });
    if (found) return found;
    try {
      await warehousesOf(tenantId).insertOne({ code: DEFAULT_WAREHOUSE, name: 'Bodega principal', active: true, isDefault: true, createdAt: now() });
    } catch (err) {
      if (!isDuplicate(err, 'tenant_warehouse_code')) throw err;
    }
    return warehousesOf(tenantId).findOne({ code: DEFAULT_WAREHOUSE });
  }

  async function resolveWarehouse(tenantId, id) {
    if (!id) return ensureDefaultWarehouse(tenantId);
    if (!/^[a-f0-9]{24}$/.test(String(id))) fail('bodega inválida');
    const warehouse = await warehousesOf(tenantId).findOne({ _id: new ObjectId(String(id)) });
    if (!warehouse) fail('la bodega no existe', 'NOT_FOUND');
    if (!warehouse.active) fail(`la bodega ${warehouse.code} está inactiva`);
    return warehouse;
  }

  // ------------------------------------------------------------------ existencias (primitivas para otros módulos)

  /** Agrupa entradas del mismo artículo y bodega. */
  function groupSpecs(specs) {
    const map = new Map();
    for (const s of specs) {
      if (!Number.isSafeInteger(s.quantity) || s.quantity <= 0) fail('la cantidad debe ser un entero positivo (milésimas)');
      const key = `${s.itemId}:${s.warehouseId}`;
      const cur = map.get(key);
      if (cur) cur.quantity += s.quantity;
      else map.set(key, { itemId: new ObjectId(String(s.itemId)), warehouseId: new ObjectId(String(s.warehouseId)), quantity: s.quantity });
    }
    return [...map.values()];
  }

  /**
   * Planea salidas al costo promedio actual. Lee, no escribe. Devuelve por artículo y bodega la cantidad, el costo
   * y el estado leído (`expect`), que `applyOut` exige intacto.
   */
  async function planOut(tenantId, specs, session) {
    const plan = [];
    for (const spec of groupSpecs(specs)) {
      const stock = await stockOf(tenantId).findOne({ itemId: spec.itemId, warehouseId: spec.warehouseId }, session ? { session } : undefined);
      if (!stock || stock.quantity < spec.quantity) {
        const item = await itemsOf(tenantId).findOne({ _id: spec.itemId }, session ? { session } : undefined);
        const have = stock?.quantity ?? 0;
        fail(`no hay existencias suficientes de ${item?.sku ?? 'el artículo'} (hay ${have / 1000}, se piden ${spec.quantity / 1000})`, 'INSUFFICIENT_STOCK');
      }
      plan.push({ ...spec, cost: averageCost(stock, spec.quantity), expect: { quantity: stock.quantity, value: stock.value } });
    }
    return plan;
  }

  async function record(tenantId, session, entry, meta) {
    const { insertedId } = await movementsOf(tenantId).insertOne(
      {
        itemId: entry.itemId,
        warehouseId: entry.warehouseId,
        date: meta.date,
        type: meta.type,
        quantity: entry.quantity,
        value: entry.value,
        balanceQuantity: entry.balanceQuantity,
        balanceValue: entry.balanceValue,
        source: meta.source,
        ...(meta.lineIndex !== undefined ? { lineIndex: meta.lineIndex } : {}),
        ...(meta.note ? { note: meta.note } : {}),
        createdBy: meta.userId ?? null,
        createdAt: now(),
      },
      session,
    );
    return insertedId;
  }

  /** Aplica un plan de `planOut` dentro de la transacción de `session`. Falla con `STOCK_CONFLICT` si la existencia cambió. */
  async function applyOut(tenantId, plan, session, meta) {
    const ids = [];
    for (const p of plan) {
      const updated = await stockOf(tenantId).findOneAndUpdate(
        { itemId: p.itemId, warehouseId: p.warehouseId, quantity: p.expect.quantity, value: p.expect.value },
        { $inc: { quantity: -p.quantity, value: -p.cost } },
        { session, returnDocument: 'after' },
      );
      if (!updated) fail('otra operación cambió las existencias mientras se registraba', 'STOCK_CONFLICT');
      ids.push(await record(tenantId, session, { itemId: p.itemId, warehouseId: p.warehouseId, quantity: -p.quantity, value: -p.cost, balanceQuantity: updated.quantity, balanceValue: updated.value }, meta));
    }
    return ids;
  }

  /** Entradas con valor conocido (compras, ajustes, devoluciones de venta). No dependen del estado anterior. */
  async function applyIn(tenantId, entries, session, meta) {
    const ids = [];
    for (const e of entries) {
      assertMinorUnits(e.value, 'valor de la entrada');
      if (!Number.isSafeInteger(e.quantity) || e.quantity <= 0) fail('la cantidad debe ser un entero positivo (milésimas)');
      const updated = await stockOf(tenantId).findOneAndUpdate(
        { itemId: new ObjectId(String(e.itemId)), warehouseId: new ObjectId(String(e.warehouseId)) },
        { $inc: { quantity: e.quantity, value: e.value }, $setOnInsert: { createdAt: now() } },
        { upsert: true, session, returnDocument: 'after' },
      );
      ids.push(await record(tenantId, session, { itemId: updated.itemId, warehouseId: updated.warehouseId, quantity: e.quantity, value: e.value, balanceQuantity: updated.quantity, balanceValue: updated.value }, { ...meta, lineIndex: e.lineIndex }));
    }
    return ids;
  }

  /**
   * Salida de cantidad y valor exactos: el reverso de una entrada. Exige que quede al menos eso en existencia,
   * para no dejar el promedio de lo que ya se vendió en negativo.
   */
  async function applyExactOut(tenantId, entries, session, meta) {
    const ids = [];
    for (const e of entries) {
      const updated = await stockOf(tenantId).findOneAndUpdate(
        { itemId: new ObjectId(String(e.itemId)), warehouseId: new ObjectId(String(e.warehouseId)), quantity: { $gte: e.quantity }, value: { $gte: e.value } },
        { $inc: { quantity: -e.quantity, value: -e.value } },
        { session, returnDocument: 'after' },
      );
      if (!updated) fail('ya se vendió o se sacó parte de lo que entró: no se puede deshacer esa entrada', 'INSUFFICIENT_STOCK');
      ids.push(await record(tenantId, session, { itemId: updated.itemId, warehouseId: updated.warehouseId, quantity: -e.quantity, value: -e.value, balanceQuantity: updated.quantity, balanceValue: updated.value }, { ...meta, lineIndex: e.lineIndex }));
    }
    return ids;
  }

  /** Repite `fn` si una operación concurrente cambió las existencias que había leído. */
  async function withStockRetry(fn, attempts = 12) {
    for (let i = 0; i < attempts; i += 1) {
      try {
        return await fn();
      } catch (err) {
        if (err?.code !== 'STOCK_CONFLICT' || i === attempts - 1) throw err;
        // Desfase aleatorio: varias operaciones sobre el mismo artículo no se vuelven a chocar a la vez.
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 25));
      }
    }
    return undefined;
  }

  /** Artículos por id, para validar líneas de otros módulos. */
  async function loadItems(tenantId, ids, session) {
    const unique = [...new Set(ids.map(String))];
    if (unique.some((id) => !/^[a-f0-9]{24}$/.test(id))) fail('artículo inválido');
    const found = await itemsOf(tenantId).find({ _id: { $in: unique.map((id) => new ObjectId(id)) } }, session ? { session } : undefined).toArray();
    const map = new Map(found.map((i) => [String(i._id), i]));
    for (const id of unique) if (!map.has(id)) fail('un artículo de las líneas no existe', 'NOT_FOUND');
    return map;
  }

  // ------------------------------------------------------------------ API pública

  return {
    planOut,
    applyOut,
    applyIn,
    applyExactOut,
    withStockRetry,
    loadItems,
    resolveWarehouse,
    ensureDefaultWarehouse,

    // ---- artículos ----
    async createItem(tenantId, input, { inTx } = {}) {
      const sku = text(input.sku, 'el código del artículo', { required: true, max: 40 }).toUpperCase();
      if (!SKU.test(sku)) fail('el código admite letras, números, punto, guion y guion bajo');
      const name = text(input.name, 'el nombre del artículo', { required: true });
      if (!ITEM_TYPES.includes(input.type)) fail('el artículo es un bien o un servicio');
      const goods = input.type === 'goods';
      const doc = {
        sku,
        name,
        nameKey: toNameKey(name),
        type: input.type,
        unit: (text(input.unit, 'la unidad', { max: 10 }) ?? 'UND').toUpperCase(),
        ...(goods
          ? {
              inventoryAccount: await checkAccount(tenantId, input.inventoryAccount, ['asset'], 'cuenta de inventario', { required: true }),
              cogsAccount: await checkAccount(tenantId, input.cogsAccount, ['cost', 'expense'], 'cuenta de costo de ventas', { required: true }),
            }
          : {}),
        ...(input.incomeAccount ? { incomeAccount: await checkAccount(tenantId, input.incomeAccount, ['income'], 'cuenta de ingresos', { required: false }) } : {}),
        ...(optionalInt(input.price, 'el precio') !== undefined ? { price: input.price } : {}),
        ...(optionalInt(input.vatBps, 'la tarifa de IVA', { max: 10_000 }) !== undefined ? { vatBps: input.vatBps } : {}),
        ...(goods && optionalInt(input.minStock, 'el mínimo de existencias') !== undefined ? { minStock: input.minStock } : {}),
        active: true,
        createdAt: now(),
      };
      if (!goods && (input.inventoryAccount || input.cogsAccount || input.minStock)) fail('un servicio no maneja inventario ni costo de ventas');
      return withTransaction(client, async (session) => {
        try {
          const { insertedId } = await itemsOf(tenantId).insertOne({ ...doc }, session);
          const created = { ...doc, _id: insertedId, tenantId };
          if (inTx) await inTx(session, created);
          return created;
        } catch (err) {
          if (isDuplicate(err, 'tenant_item_sku')) fail(`ya existe un artículo con el código ${sku}`, 'DUPLICATE');
          throw err;
        }
      });
    },

    async updateItem(tenantId, id, changes, { inTx } = {}) {
      const item = await itemsOf(tenantId).findOne({ _id: new ObjectId(id) });
      if (!item) fail('el artículo no existe', 'NOT_FOUND');
      const set = {};
      if ('name' in changes) {
        set.name = text(changes.name, 'el nombre del artículo', { required: true });
        set.nameKey = toNameKey(set.name);
      }
      if ('unit' in changes) set.unit = (text(changes.unit, 'la unidad', { required: true, max: 10 })).toUpperCase();
      if ('active' in changes) set.active = Boolean(changes.active);
      for (const [key, label, max] of [['price', 'el precio', undefined], ['vatBps', 'la tarifa de IVA', 10_000], ['minStock', 'el mínimo de existencias', undefined]]) {
        if (key in changes) set[key] = optionalInt(changes[key], label, max === undefined ? {} : { max }) ?? null;
      }
      if (item.type === 'service' && set.minStock) fail('un servicio no maneja existencias');
      if ('incomeAccount' in changes) set.incomeAccount = (await checkAccount(tenantId, changes.incomeAccount, ['income'], 'cuenta de ingresos', { required: false })) ?? null;
      const touchesAccounts = ['inventoryAccount', 'cogsAccount'].filter((k) => k in changes && changes[k] !== item[k]);
      if (touchesAccounts.length) {
        if (item.type !== 'goods') fail('un servicio no maneja inventario ni costo de ventas');
        if (await movementsOf(tenantId).findOne({ itemId: item._id })) fail('el artículo ya tiene movimientos: sus cuentas de inventario y de costo no se cambian', 'ITEM_IN_USE');
        if ('inventoryAccount' in changes) set.inventoryAccount = await checkAccount(tenantId, changes.inventoryAccount, ['asset'], 'cuenta de inventario', { required: true });
        if ('cogsAccount' in changes) set.cogsAccount = await checkAccount(tenantId, changes.cogsAccount, ['cost', 'expense'], 'cuenta de costo de ventas', { required: true });
      }
      const unset = Object.fromEntries(Object.entries(set).filter(([, v]) => v === null).map(([k]) => [k, '']));
      const toSet = Object.fromEntries(Object.entries(set).filter(([, v]) => v !== null));
      await withTransaction(client, async (session) => {
        const update = { ...(Object.keys(toSet).length ? { $set: toSet } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) };
        if (Object.keys(update).length) await itemsOf(tenantId).updateOne({ _id: item._id }, update, { session });
        if (inTx) await inTx(session, { id });
      });
      return itemsOf(tenantId).findOne({ _id: item._id });
    },

    getItem(tenantId, id) {
      return itemsOf(tenantId).findOne({ _id: new ObjectId(id) });
    },

    /** Lista artículos con lo que hay en total en existencia. `search` es prefijo del código o del nombre. */
    async listItems(tenantId, { search, type, active, limit = 25, cursor } = {}) {
      const size = Math.min(Math.max(Number(limit) || 25, 1), MAX_ITEM_PAGE);
      const filter = {
        ...(type ? { type } : {}),
        ...(active !== undefined ? { active: active === true || active === 'true' } : {}),
        ...(cursor ? { _id: { $gt: new ObjectId(cursor) } } : {}),
      };
      if (search) {
        const term = String(search).trim();
        const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        filter.$or = [{ nameKey: { $regex: `^${toNameKey(escaped)}` } }, { sku: { $regex: `^${escaped.toUpperCase()}` } }];
      }
      const rows = await itemsOf(tenantId).find(filter, { sort: { _id: 1 }, limit: size + 1 }).toArray();
      const hasMore = rows.length > size;
      const items = hasMore ? rows.slice(0, size) : rows;
      const totals = items.length
        ? await stockOf(tenantId)
            .aggregate([{ $match: { itemId: { $in: items.map((i) => i._id) } } }, { $group: { _id: '$itemId', quantity: { $sum: '$quantity' }, value: { $sum: '$value' } } }])
            .toArray()
        : [];
      const byItem = new Map(totals.map((t) => [String(t._id), t]));
      return {
        items: items.map((i) => ({ ...i, onHand: byItem.get(String(i._id))?.quantity ?? 0, stockValue: byItem.get(String(i._id))?.value ?? 0 })),
        nextCursor: hasMore ? items[items.length - 1]._id.toHexString() : null,
      };
    },

    // ---- bodegas ----
    async createWarehouse(tenantId, input, { inTx } = {}) {
      await ensureDefaultWarehouse(tenantId);
      const code = text(input.code, 'el código de la bodega', { required: true, max: 10 }).toUpperCase();
      if (!/^[A-Z0-9][A-Z0-9_-]*$/.test(code)) fail('el código de la bodega admite letras, números, guion y guion bajo');
      const doc = { code, name: text(input.name, 'el nombre de la bodega', { required: true, max: 100 }), active: true, isDefault: false, createdAt: now() };
      return withTransaction(client, async (session) => {
        try {
          const { insertedId } = await warehousesOf(tenantId).insertOne({ ...doc }, session);
          const created = { ...doc, _id: insertedId, tenantId };
          if (inTx) await inTx(session, created);
          return created;
        } catch (err) {
          if (isDuplicate(err, 'tenant_warehouse_code')) fail(`ya existe una bodega con el código ${code}`, 'DUPLICATE');
          throw err;
        }
      });
    },

    async listWarehouses(tenantId) {
      await ensureDefaultWarehouse(tenantId);
      return warehousesOf(tenantId).find({}, { sort: { code: 1 } }).toArray();
    },

    async setWarehouseActive(tenantId, id, active, { inTx } = {}) {
      const warehouse = await warehousesOf(tenantId).findOne({ _id: new ObjectId(id) });
      if (!warehouse) fail('la bodega no existe', 'NOT_FOUND');
      if (warehouse.isDefault && !active) fail('la bodega principal no se desactiva');
      if (!active) {
        const withStock = await stockOf(tenantId).findOne({ warehouseId: warehouse._id, quantity: { $gt: 0 } });
        if (withStock) fail('la bodega todavía tiene existencias: tráspasalas antes de desactivarla', 'ITEM_IN_USE');
      }
      await withTransaction(client, async (session) => {
        await warehousesOf(tenantId).updateOne({ _id: warehouse._id }, { $set: { active } }, { session });
        if (inTx) await inTx(session, { id, active });
      });
      return warehousesOf(tenantId).findOne({ _id: warehouse._id });
    },

    // ---- existencias, kardex y valoración ----
    async listStock(tenantId, { itemId, warehouseId } = {}) {
      return stockOf(tenantId)
        .find({ ...(itemId ? { itemId: new ObjectId(itemId) } : {}), ...(warehouseId ? { warehouseId: new ObjectId(warehouseId) } : {}) }, { limit: 500 })
        .toArray();
    },

    /** Kardex de un artículo: movimientos en orden de aplicación, con los saldos que dejó cada uno. */
    async kardex(tenantId, { itemId, warehouseId, from, to, limit = 50, cursor }) {
      const size = Math.min(Math.max(Number(limit) || 50, 1), MAX_KARDEX_PAGE);
      const filter = { itemId: new ObjectId(itemId) };
      if (warehouseId) filter.warehouseId = new ObjectId(warehouseId);
      if (from || to) {
        filter.date = {};
        if (from) filter.date.$gte = parseDay(from, 'la fecha inicial');
        if (to) filter.date.$lt = new Date(parseDay(to, 'la fecha final').getTime() + DAY_MS);
      }
      if (cursor) filter._id = { $gt: new ObjectId(cursor) };
      const rows = await movementsOf(tenantId).find(filter, { sort: { _id: 1 }, limit: size + 1 }).toArray();
      const hasMore = rows.length > size;
      const items = hasMore ? rows.slice(0, size) : rows;
      return { items, nextCursor: hasMore ? items[items.length - 1]._id.toHexString() : null };
    },

    /**
     * Valoración de las existencias, por artículo y bodega, y su cuadre con el libro: el valor de las existencias
     * de cada cuenta de inventario contra el saldo de esa cuenta. Una diferencia indica asientos manuales sobre la cuenta.
     */
    async valuation(tenantId, { warehouseId } = {}) {
      const match = { quantity: { $ne: 0 }, ...(warehouseId ? { warehouseId: new ObjectId(warehouseId) } : {}) };
      const joined = [
        { $match: match },
        { $lookup: { from: COLLECTIONS.items, localField: 'itemId', foreignField: '_id', as: 'item' } },
        { $unwind: '$item' },
        { $lookup: { from: COLLECTIONS.warehouses, localField: 'warehouseId', foreignField: '_id', as: 'warehouse' } },
        { $unwind: '$warehouse' },
      ];
      const [rows, byAccount] = await Promise.all([
        stockOf(tenantId)
          .aggregate([
            ...joined,
            { $project: { _id: 0, itemId: 1, warehouseId: 1, quantity: 1, value: 1, sku: '$item.sku', name: '$item.name', unit: '$item.unit', inventoryAccount: '$item.inventoryAccount', warehouseCode: '$warehouse.code' } },
            { $sort: { sku: 1, warehouseCode: 1 } },
            { $limit: MAX_VALUATION_ROWS + 1 },
          ])
          .toArray(),
        stockOf(tenantId)
          .aggregate([...joined, { $group: { _id: '$item.inventoryAccount', value: { $sum: '$value' }, items: { $sum: 1 } } }])
          .toArray(),
      ]);
      const truncated = rows.length > MAX_VALUATION_ROWS;
      const shown = truncated ? rows.slice(0, MAX_VALUATION_ROWS) : rows;
      const ledgerRows = byAccount.length
        ? await db
            .collection(COLLECTIONS.balances)
            .aggregate([{ $match: { tenantId, accountId: { $in: byAccount.map((a) => a._id) } } }, { $group: { _id: '$accountId', net: { $sum: { $subtract: ['$debit', '$credit'] } } } }])
            .toArray()
        : [];
      const ledgerByAccount = new Map(ledgerRows.map((r) => [r._id, Number(r.net)]));
      const accountsView = byAccount
        .map((a) => ({ account: a._id, stockValue: Number(a.value), ledgerBalance: ledgerByAccount.get(a._id) ?? 0, difference: Number(a.value) - (ledgerByAccount.get(a._id) ?? 0) }))
        .sort((a, b) => (a.account < b.account ? -1 : 1));
      return {
        rows: shown.map((r) => ({ ...r, averageCost: r.quantity ? Number(roundDiv(BigInt(r.value) * 1000n, BigInt(r.quantity))) : 0 })),
        truncated,
        total: byAccount.reduce((acc, a) => acc + Number(a.value), 0),
        accounts: accountsView,
      };
    },

    /** Bienes con un mínimo definido y menos existencias que ese mínimo, sumando todas las bodegas. */
    async lowStock(tenantId) {
      const items = await itemsOf(tenantId).find({ type: 'goods', active: true, minStock: { $gt: 0 } }, { limit: 1000 }).toArray();
      if (!items.length) return [];
      const totals = await stockOf(tenantId)
        .aggregate([{ $match: { itemId: { $in: items.map((i) => i._id) } } }, { $group: { _id: '$itemId', quantity: { $sum: '$quantity' } } }])
        .toArray();
      const byItem = new Map(totals.map((t) => [String(t._id), t.quantity]));
      return items
        .map((i) => ({ _id: i._id, sku: i.sku, name: i.name, unit: i.unit, minStock: i.minStock, onHand: byItem.get(String(i._id)) ?? 0 }))
        .filter((i) => i.onHand < i.minStock)
        .sort((a, b) => a.onHand - a.minStock - (b.onHand - b.minStock))
        .slice(0, 200);
    },

    // ---- ajustes y traspasos ----

    /**
     * Ajuste manual de existencias, con su asiento `MI`. Una entrada trae su costo unitario; una salida cuesta el
     * promedio. `counterAccount` es la otra pata del asiento: capital o ganancia en una entrada, pérdida o gasto en una salida.
     */
    async adjust(tenantId, input, ctx = {}) {
      const { idempotencyKey, userId } = ctx;
      if (!idempotencyKey?.trim()) fail('falta la clave de idempotencia');
      const previous = await docsOf(tenantId).findOne({ idempotencyKey });
      if (previous) return { doc: previous, replayed: true };

      const date = parseDay(input.date, 'la fecha del ajuste');
      if (date.getTime() > now().getTime() + DAY_MS) fail('la fecha del ajuste no puede ser futura');
      if (!['in', 'out'].includes(input.direction)) fail('el ajuste es una entrada o una salida');
      if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0) fail('la cantidad debe ser un entero positivo (milésimas)');
      const reason = text(input.reason, 'el motivo del ajuste', { required: true, max: 200 });
      const items = await loadItems(tenantId, [input.itemId]);
      const item = items.get(String(input.itemId));
      if (item.type !== 'goods') fail('solo los bienes manejan existencias');
      if (!item.active) fail(`el artículo ${item.sku} está inactivo`);
      const warehouse = await resolveWarehouse(tenantId, input.warehouseId);
      const counterAccount = String(input.counterAccount ?? '').trim();
      if (!ACCOUNT.test(counterAccount)) fail('indica la cuenta contrapartida del ajuste');
      const problems = await accounts.postingProblems(tenantId, [counterAccount]);
      if (problems.length) fail(problems.join('; '));
      if (counterAccount === item.inventoryAccount) fail('la contrapartida no puede ser la cuenta de inventario');
      const currency = await currencyOf(tenantId);

      const unitCost = input.direction === 'in' ? optionalInt(input.unitCost, 'el costo unitario') : undefined;
      if (input.direction === 'in' && unitCost === undefined) fail('indica el costo unitario de la entrada');

      const run = async () => {
        const spec = { itemId: item._id, warehouseId: warehouse._id, quantity: input.quantity };
        const plan = input.direction === 'out' ? await planOut(tenantId, [spec]) : null;
        const value = input.direction === 'in' ? valueOf(input.quantity, unitCost) : plan[0].cost;
        if (value <= 0) fail(input.direction === 'in' ? 'el valor de la entrada debe ser mayor que cero' : 'las existencias no tienen valor: registra primero su costo');
        const lines =
          input.direction === 'in'
            ? [{ accountId: item.inventoryAccount, debit: value }, { accountId: counterAccount, credit: value }]
            : [{ accountId: counterAccount, debit: value }, { accountId: item.inventoryAccount, credit: value }];
        return ledger.postJournal(
          tenantId,
          {
            docType: 'MI',
            date,
            currency,
            idempotencyKey: `stock-${idempotencyKey}`,
            description: `Ajuste de inventario de ${item.sku}: ${reason}`,
            source: { kind: 'stock_adjustment', id: idempotencyKey },
            lines,
          },
          {
            inTx: async (session, { journal }) => {
              const meta = { type: input.direction === 'in' ? 'adjust_in' : 'adjust_out', date, source: { kind: 'stock_adjustment', id: idempotencyKey }, note: reason, userId };
              if (input.direction === 'in') await applyIn(tenantId, [{ itemId: item._id, warehouseId: warehouse._id, quantity: input.quantity, value }], session, meta);
              else await applyOut(tenantId, plan, session, meta);
              const doc = {
                idempotencyKey,
                kind: 'adjustment',
                number: journal.number,
                fullNumber: `MI${journal.number}`,
                direction: input.direction,
                itemId: item._id,
                sku: item.sku,
                warehouseId: warehouse._id,
                date,
                quantity: input.quantity,
                value,
                counterAccount,
                reason,
                journalId: journal._id,
                createdBy: userId ?? null,
                createdAt: now(),
              };
              const { insertedId } = await docsOf(tenantId).insertOne({ ...doc }, session);
              await ctx.auditTx?.(session, { action: 'stock.adjust', target: insertedId, details: { number: doc.fullNumber, sku: item.sku, direction: input.direction, quantity: input.quantity, value } });
            },
          },
        );
      };

      let replayed = false;
      try {
        const posted = await withStockRetry(run);
        replayed = posted.replayed;
      } catch (err) {
        if (!isDuplicate(err, 'tenant_stockdoc_idempotency')) throw err;
        replayed = true;
      }
      const doc = await docsOf(tenantId).findOne({ idempotencyKey });
      if (!doc) fail('el asiento del ajuste ya existía sin documento: contacta a soporte', 'INVALID_STATE');
      return { doc, replayed };
    },

    /** Traspaso entre bodegas: sale al costo promedio de la bodega de origen y entra con ese mismo valor. Sin asiento. */
    async transfer(tenantId, input, ctx = {}) {
      const { idempotencyKey, userId } = ctx;
      if (!idempotencyKey?.trim()) fail('falta la clave de idempotencia');
      const previous = await docsOf(tenantId).findOne({ idempotencyKey });
      if (previous) return { doc: previous, replayed: true };

      const date = parseDay(input.date, 'la fecha del traspaso');
      if (date.getTime() > now().getTime() + DAY_MS) fail('la fecha del traspaso no puede ser futura');
      if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0) fail('la cantidad debe ser un entero positivo (milésimas)');
      const items = await loadItems(tenantId, [input.itemId]);
      const item = items.get(String(input.itemId));
      if (item.type !== 'goods') fail('solo los bienes manejan existencias');
      const from = await resolveWarehouse(tenantId, input.fromWarehouseId);
      const to = await resolveWarehouse(tenantId, input.toWarehouseId);
      if (String(from._id) === String(to._id)) fail('la bodega de origen y la de destino son la misma');
      const note = text(input.note, 'la nota', { max: 200 });
      await ensureCounter(tenantId, 'TR');

      const run = async () => {
        const plan = await planOut(tenantId, [{ itemId: item._id, warehouseId: from._id, quantity: input.quantity }]);
        return withTransaction(client, async (session) => {
          const existing = await docsOf(tenantId).findOne({ idempotencyKey }, { session });
          if (existing) return { doc: existing, replayed: true };
          const source = { kind: 'stock_transfer', id: idempotencyKey };
          const meta = { date, source, note, userId };
          await applyOut(tenantId, plan, session, { ...meta, type: 'transfer_out' });
          await applyIn(tenantId, [{ itemId: item._id, warehouseId: to._id, quantity: input.quantity, value: plan[0].cost }], session, { ...meta, type: 'transfer_in' });
          const number = await nextNumber(tenantId, 'TR', session);
          const doc = {
            idempotencyKey,
            kind: 'transfer',
            number,
            fullNumber: `TR${number}`,
            itemId: item._id,
            sku: item.sku,
            fromWarehouseId: from._id,
            toWarehouseId: to._id,
            date,
            quantity: input.quantity,
            value: plan[0].cost,
            ...(note ? { note } : {}),
            createdBy: userId ?? null,
            createdAt: now(),
          };
          const { insertedId } = await docsOf(tenantId).insertOne({ ...doc }, session);
          await ctx.auditTx?.(session, { action: 'stock.transfer', target: insertedId, details: { number: doc.fullNumber, sku: item.sku, quantity: input.quantity, from: from.code, to: to.code } });
          return { doc: { ...doc, _id: insertedId, tenantId }, replayed: false };
        });
      };

      try {
        return await withStockRetry(run);
      } catch (err) {
        if (!isDuplicate(err, 'tenant_stockdoc_idempotency')) throw err;
        return { doc: await docsOf(tenantId).findOne({ idempotencyKey }), replayed: true };
      }
    },

    async listStockDocs(tenantId, { kind, limit = 25, cursor } = {}) {
      const size = Math.min(Math.max(Number(limit) || 25, 1), MAX_ITEM_PAGE);
      const filter = { ...(kind ? { kind } : {}), ...(cursor ? { _id: { $lt: new ObjectId(cursor) } } : {}) };
      const rows = await docsOf(tenantId).find(filter, { sort: { _id: -1 }, limit: size + 1 }).toArray();
      const hasMore = rows.length > size;
      const items = hasMore ? rows.slice(0, size) : rows;
      return { items, nextCursor: hasMore ? items[items.length - 1]._id.toHexString() : null };
    },
  };
}
