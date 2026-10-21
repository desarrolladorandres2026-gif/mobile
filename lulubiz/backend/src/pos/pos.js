import { ObjectId } from 'mongodb';
import { DAY_MS, dayOf, parseDay as parseCalendarDay } from '../core/dates.js';
import { assertMinorUnits } from '../core/money.js';
import { vatRatesFor } from '../countries/index.js';
import { COLLECTIONS } from '../data/db.js';
import { TenantCollection } from '../data/tenantCollection.js';
import { isDuplicate, withTransaction } from '../data/tx.js';
import { averageCost } from '../inventory/inventory.js';
import { TaxError, computeLine, computeTotals } from '../invoicing/tax.js';

export const PAYMENT_METHODS = ['cash', 'card', 'transfer'];
export const MAX_SALE_LINES = 200;
export const MAX_POS_PAGE = 50;

export class PosError extends Error {
  constructor(message, code = 'VALIDATION') {
    super(message);
    this.name = 'PosError';
    this.code = code;
  }
}

const fail = (message, code) => {
  throw new PosError(message, code);
};
const parseDay = (value, label) => parseCalendarDay(value, label, fail);
const text = (value, label, { required = false, max = 200 } = {}) => {
  const clean = String(value ?? '').trim();
  if (required && !clean) fail(`falta ${label}`);
  if (clean.length > max) fail(`${label} admite como máximo ${max} caracteres`);
  return clean || undefined;
};
const ACCOUNT = /^[0-9]{1,12}$/;
const addTo = (map, key, amount) => map.set(key, (map.get(key) ?? 0) + amount);

/*
 * Punto de venta.
 *
 *  - Caja (`posRegisters`): { code, name, accounts { cash, card?, transfer?, shortage?, surplus? }, warehouseId?, active, lastSale }.
 *    Cada método de pago entra a su cuenta de activo; sin cuenta para un método, ese método no se acepta en esa caja.
 *    `shortage` (gasto) y `surplus` (ingreso) reciben la diferencia del cierre sin que el cajero elija una cuenta.
 *  - Turno (`posShifts`): una caja tiene a lo sumo un turno abierto (índice único parcial). Lleva el efectivo con el que
 *    abrió y los totales vivos de sus ventas (`salesCount`, `salesTotal`, `cashTotal`, `cardTotal`, `transferTotal`,
 *    `voidedCount`, `voidedTotal`), que cada venta o anulación ajusta con `$inc` dentro de su transacción y con el
 *    turno abierto como condición: una venta no puede entrar a un turno que se cerró.
 *  - Venta (`posSales`, asiento `PV`): líneas como las de una factura (con `itemId` salen del inventario al costo
 *    promedio, en la misma transacción), pagos mixtos que suman exactamente el total, cliente opcional (sin cliente es
 *    «consumidor final») y consecutivo propio por caja (`CAJA1-000012`) para repartir la numeración. El asiento debita
 *    cada método de pago y acredita ingresos e IVA; con inventario suma costo de ventas contra inventario.
 *  - Cierre (asiento `CJ`): el efectivo esperado es lo que abrió más lo cobrado en efectivo; el contado se compara y la
 *    diferencia se asienta contra la cuenta que se indique (faltante o sobrante). El efectivo inicial no mueve la
 *    contabilidad: ya estaba en la caja.
 *  - Anulación: solo con el turno abierto; reversa el asiento y regresa los bienes al costo al que salieron.
 *
 * Límites: no emite documento electrónico (el equivalente POS de la DIAN depende del proveedor y todavía no hay uno
 * real); no hay devoluciones de un turno ya cerrado (se corrigen con ajustes); el consecutivo del asiento `PV` es uno por
 * empresa, así que el techo de ventas por segundo es el del libro de esa empresa.
 */
export function createPosService({ client, db, ledger, accounts, parties, settings, inventory, now = () => new Date() }) {
  const registersOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.posRegisters), tenantId);
  const shiftsOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.posShifts), tenantId);
  const salesOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.posSales), tenantId);
  const tenants = db.collection(COLLECTIONS.tenants);

  const oid = (id, label) => {
    if (!/^[a-f0-9]{24}$/.test(String(id ?? ''))) fail(`${label} inválido`);
    return new ObjectId(String(id));
  };

  async function tenantInfo(tenantId) {
    const tenant = await tenants.findOne({ _id: tenantId }, { projection: { country: 1, currency: 1 } });
    if (!tenant) fail('la empresa no existe', 'NOT_FOUND');
    return tenant;
  }

  /** Cuentas de cobro de la caja: cada una debe recibir asientos y ser un activo (caja, bancos, datáfono por cobrar). */
  async function checkPaymentAccounts(tenantId, raw) {
    const out = {};
    for (const method of PAYMENT_METHODS) {
      const code = String(raw?.[method] ?? '').trim();
      if (!code) continue;
      if (!ACCOUNT.test(code)) fail(`la cuenta de ${method} debe ser un código numérico`);
      const problems = await accounts.postingProblems(tenantId, [code]);
      if (problems.length) fail(problems.join('; '));
      if ((await accounts.get(tenantId, code)).type !== 'asset') fail(`la cuenta ${code} no sirve para cobrar: debe ser un activo`);
      out[method] = code;
    }
    if (!out.cash) fail('la caja necesita su cuenta de efectivo');
    // Dónde se asientan los faltantes y sobrantes del cierre: así el cajero no elige una cuenta contable.
    for (const [key, types, label] of [['shortage', ['expense', 'cost'], 'faltantes'], ['surplus', ['income'], 'sobrantes']]) {
      const code = String(raw?.[key] ?? '').trim();
      if (!code) continue;
      if (!ACCOUNT.test(code)) fail(`la cuenta de ${label} debe ser un código numérico`);
      const problems = await accounts.postingProblems(tenantId, [code]);
      if (problems.length) fail(problems.join('; '));
      if (!types.includes((await accounts.get(tenantId, code)).type)) fail(`la cuenta ${code} no sirve para ${label}`);
      out[key] = code;
    }
    return out;
  }

  const present = (sale) => sale;

  const api = {
    // ------------------------------------------------------------------ cajas

    async createRegister(tenantId, input, { inTx } = {}) {
      const code = text(input.code, 'el código de la caja', { required: true, max: 10 }).toUpperCase();
      if (!/^[A-Z0-9][A-Z0-9_-]*$/.test(code)) fail('el código de la caja admite letras, números, guion y guion bajo');
      const name = text(input.name, 'el nombre de la caja', { required: true, max: 100 });
      const accountCodes = await checkPaymentAccounts(tenantId, input.accounts);
      const warehouse = input.warehouseId ? await inventory.resolveWarehouse(tenantId, input.warehouseId) : null;
      const doc = { code, name, accounts: accountCodes, ...(warehouse ? { warehouseId: warehouse._id } : {}), active: true, lastSale: 0, createdAt: now() };
      return withTransaction(client, async (session) => {
        try {
          const { insertedId } = await registersOf(tenantId).insertOne({ ...doc }, session);
          const created = { ...doc, _id: insertedId, tenantId };
          if (inTx) await inTx(session, created);
          return created;
        } catch (err) {
          if (isDuplicate(err, 'tenant_register_code')) fail(`ya existe una caja con el código ${code}`, 'DUPLICATE');
          throw err;
        }
      });
    },

    async updateRegister(tenantId, id, changes, { inTx } = {}) {
      const register = await registersOf(tenantId).findOne({ _id: oid(id, 'caja') });
      if (!register) fail('la caja no existe', 'NOT_FOUND');
      const open = await shiftsOf(tenantId).findOne({ registerId: register._id, status: 'open' });
      const set = {};
      if ('name' in changes) set.name = text(changes.name, 'el nombre de la caja', { required: true, max: 100 });
      if ('accounts' in changes) {
        if (open) fail('la caja tiene un turno abierto: ciérralo antes de cambiar sus cuentas', 'SHIFT_OPEN');
        set.accounts = await checkPaymentAccounts(tenantId, changes.accounts);
      }
      if ('active' in changes) {
        if (!changes.active && open) fail('la caja tiene un turno abierto: ciérralo antes de desactivarla', 'SHIFT_OPEN');
        set.active = Boolean(changes.active);
      }
      if ('warehouseId' in changes) {
        if (open) fail('la caja tiene un turno abierto: ciérralo antes de cambiar su bodega', 'SHIFT_OPEN');
        set.warehouseId = (await inventory.resolveWarehouse(tenantId, changes.warehouseId))._id;
      }
      if (Object.keys(set).length) {
        await withTransaction(client, async (session) => {
          await registersOf(tenantId).updateOne({ _id: register._id }, { $set: set }, { session });
          if (inTx) await inTx(session, { id });
        });
      }
      return registersOf(tenantId).findOne({ _id: register._id });
    },

    /** Cajas con el turno que tienen abierto (si lo hay), para elegir dónde vender. */
    async listRegisters(tenantId) {
      const registers = await registersOf(tenantId).find({}, { sort: { code: 1 }, limit: 200 }).toArray();
      const open = await shiftsOf(tenantId).find({ status: 'open' }, { limit: 200 }).toArray();
      const byRegister = new Map(open.map((s) => [String(s.registerId), s]));
      return registers.map((r) => ({ ...r, openShift: byRegister.get(String(r._id)) ?? null }));
    },

    // ------------------------------------------------------------------ turnos

    async openShift(tenantId, registerId, input, ctx = {}) {
      const register = await registersOf(tenantId).findOne({ _id: oid(registerId, 'caja') });
      if (!register) fail('la caja no existe', 'NOT_FOUND');
      if (!register.active) fail(`la caja ${register.code} está inactiva`);
      const openingCash = input.openingCash ?? 0;
      if (!Number.isSafeInteger(openingCash) || openingCash < 0) fail('el efectivo inicial debe ser un entero mayor o igual a cero');
      const doc = {
        registerId: register._id,
        registerCode: register.code,
        registerName: register.name,
        status: 'open',
        openingCash,
        salesCount: 0,
        salesTotal: 0,
        cashTotal: 0,
        cardTotal: 0,
        transferTotal: 0,
        voidedCount: 0,
        voidedTotal: 0,
        openedBy: ctx.userId ?? null,
        openedAt: now(),
      };
      return withTransaction(client, async (session) => {
        try {
          const { insertedId } = await shiftsOf(tenantId).insertOne({ ...doc }, session);
          const created = { ...doc, _id: insertedId, tenantId };
          await ctx.auditTx?.(session, { action: 'pos.shift_open', target: insertedId, details: { register: register.code, openingCash } });
          return created;
        } catch (err) {
          if (isDuplicate(err, 'tenant_shift_open')) fail(`la caja ${register.code} ya tiene un turno abierto`, 'SHIFT_OPEN');
          throw err;
        }
      });
    },

    async getShift(tenantId, id) {
      const shift = await shiftsOf(tenantId).findOne({ _id: oid(id, 'turno') });
      return shift ? { ...shift, expectedCash: shift.status === 'open' ? shift.openingCash + shift.cashTotal : shift.expectedCash } : null;
    },

    async listShifts(tenantId, { registerId, status, limit = 25, cursor } = {}) {
      const size = Math.min(Math.max(Number(limit) || 25, 1), MAX_POS_PAGE);
      const filter = {
        ...(registerId ? { registerId: oid(registerId, 'caja') } : {}),
        ...(status ? { status: String(status) } : {}),
        ...(cursor ? { _id: { $lt: oid(cursor, 'cursor') } } : {}),
      };
      const rows = await shiftsOf(tenantId).find(filter, { sort: { _id: -1 }, limit: size + 1 }).toArray();
      const hasMore = rows.length > size;
      const items = hasMore ? rows.slice(0, size) : rows;
      return {
        items: items.map((s) => ({ ...s, expectedCash: s.status === 'open' ? s.openingCash + s.cashTotal : s.expectedCash })),
        nextCursor: hasMore ? items[items.length - 1]._id.toHexString() : null,
      };
    },

    /**
     * Cierra el turno: compara el efectivo contado con el esperado y asienta la diferencia. La condición de igualdad
     * sobre los totales hace que una venta que entre mientras se cierra obligue a recalcular, no a cerrar mal.
     */
    async closeShift(tenantId, id, input, ctx = {}) {
      const countedCash = input.countedCash;
      if (!Number.isSafeInteger(countedCash) || countedCash < 0) fail('el efectivo contado debe ser un entero mayor o igual a cero');
      const notes = text(input.notes, 'las notas', { max: 500 });
      const date = parseDay(input.date, 'la fecha del cierre');
      if (date.getTime() > now().getTime() + DAY_MS) fail('la fecha del cierre no puede ser futura');

      for (let attempt = 0; attempt < 4; attempt += 1) {
        const shift = await shiftsOf(tenantId).findOne({ _id: oid(id, 'turno') });
        if (!shift) fail('el turno no existe', 'NOT_FOUND');
        if (shift.status === 'closed') return { shift: await api.getShift(tenantId, id), replayed: true };
        const register = await registersOf(tenantId).findOne({ _id: shift.registerId });
        const expectedCash = shift.openingCash + shift.cashTotal;
        const difference = countedCash - expectedCash;
        const tenant = await tenantInfo(tenantId);

        let counterAccount;
        if (difference !== 0) {
          counterAccount = String(input.counterAccount ?? register.accounts[difference < 0 ? 'shortage' : 'surplus'] ?? '').trim();
          if (!ACCOUNT.test(counterAccount)) fail(`hay un ${difference < 0 ? 'faltante' : 'sobrante'} de caja y la caja no tiene cuenta para asentarlo: configúrala en Cajas o indícala`);
          if (counterAccount === register.accounts.cash) fail('la cuenta de la diferencia no puede ser la misma cuenta de efectivo');
          const problems = await accounts.postingProblems(tenantId, [counterAccount, register.accounts.cash]);
          if (problems.length) fail(problems.join('; '));
        }

        const guard = { _id: shift._id, status: 'open', salesCount: shift.salesCount, cashTotal: shift.cashTotal, voidedCount: shift.voidedCount };
        const closed = {
          status: 'closed',
          closedAt: now(),
          closedBy: ctx.userId ?? null,
          closeDate: date,
          expectedCash,
          countedCash,
          difference,
          ...(notes ? { closeNotes: notes } : {}),
        };
        const audit = (session) =>
          ctx.auditTx?.(session, { action: 'pos.shift_close', target: shift._id, details: { register: shift.registerCode, expectedCash, countedCash, difference } });

        try {
          if (difference === 0) {
            const done = await withTransaction(client, async (session) => {
              const res = await shiftsOf(tenantId).updateOne(guard, { $set: closed }, { session });
              if (res.matchedCount === 0) return false;
              await audit(session);
              return true;
            });
            if (!done) continue;
          } else {
            // Faltante: sale dinero de la caja contra la cuenta de pérdida. Sobrante: entra contra la cuenta indicada.
            const amount = Math.abs(difference);
            const lines =
              difference < 0
                ? [{ accountId: counterAccount, debit: amount }, { accountId: register.accounts.cash, credit: amount }]
                : [{ accountId: register.accounts.cash, debit: amount }, { accountId: counterAccount, credit: amount }];
            await ledger.postJournal(
              tenantId,
              {
                docType: 'CJ',
                date,
                currency: tenant.currency,
                idempotencyKey: `pos-close-${shift._id}`,
                description: `Cierre de la caja ${shift.registerCode}: ${difference < 0 ? 'faltante' : 'sobrante'}`,
                source: { kind: 'pos_close', id: String(shift._id) },
                lines,
              },
              {
                inTx: async (session, { journal }) => {
                  const res = await shiftsOf(tenantId).updateOne(guard, { $set: { ...closed, closeJournalId: journal._id } }, { session });
                  if (res.matchedCount === 0) throw new PosError('el turno cambió mientras se cerraba', 'INVALID_STATE');
                  await audit(session);
                },
              },
            );
          }
        } catch (err) {
          if (err instanceof PosError && err.code === 'INVALID_STATE') continue;
          throw err;
        }
        return { shift: await api.getShift(tenantId, id), replayed: false };
      }
      return fail('el turno se está modificando en este momento: inténtalo de nuevo', 'INVALID_STATE');
    },

    // ------------------------------------------------------------------ ventas

    async createSale(tenantId, input, ctx = {}) {
      const { idempotencyKey, userId } = ctx;
      if (!idempotencyKey?.trim()) fail('falta la clave de idempotencia');
      const previous = await salesOf(tenantId).findOne({ idempotencyKey });
      if (previous) return { sale: present(previous), replayed: true };

      const register = await registersOf(tenantId).findOne({ _id: oid(input.registerId, 'caja') });
      if (!register) fail('la caja no existe', 'NOT_FOUND');
      if (!register.active) fail(`la caja ${register.code} está inactiva`);
      const shift = await shiftsOf(tenantId).findOne({ registerId: register._id, status: 'open' });
      if (!shift) fail(`la caja ${register.code} no tiene un turno abierto: ábrelo para vender`, 'NO_SHIFT');

      const date = parseDay(input.date, 'la fecha de la venta');
      if (date.getTime() > now().getTime() + DAY_MS) fail('la fecha de la venta no puede ser futura');
      const cfg = await settings.get(tenantId);
      const missing = [...(cfg?.accounts?.income ? [] : ['la cuenta de ingresos']), ...(cfg?.accounts?.vatPayable ? [] : ['la cuenta de IVA por pagar'])];
      if (missing.length) fail(`falta configurar: ${missing.join(', ')} (en Facturación)`, 'SETTINGS_INCOMPLETE');
      const tenant = await tenantInfo(tenantId);
      const notes = text(input.notes, 'las notas', { max: 500 });

      let customer;
      if (input.customerId) {
        const party = await parties.get(tenantId, input.customerId);
        if (!party) fail('el cliente no existe', 'NOT_FOUND');
        if (!party.active) fail('el cliente está inactivo');
        if (!party.roles.includes('customer')) fail('el tercero elegido no está registrado como cliente');
        customer = { partyId: party._id, name: party.name, taxIdType: party.taxIdType, taxId: party.taxId };
      }

      // Líneas: bienes del inventario (con su bodega, la de la caja si la tiene) y servicios o conceptos libres.
      const raw = input.lines;
      if (!Array.isArray(raw) || raw.length === 0) fail('agrega al menos una línea');
      if (raw.length > MAX_SALE_LINES) fail(`una venta admite como máximo ${MAX_SALE_LINES} líneas`);
      const wanted = raw.map((l) => l?.itemId);
      const items = wanted.some(Boolean) ? await inventory.loadItems(tenantId, wanted.filter(Boolean)) : new Map();
      const warehouse = wanted.some(Boolean) ? await inventory.resolveWarehouse(tenantId, register.warehouseId) : null;
      const rates = vatRatesFor(tenant.country);
      const lines = raw.map((l, i) => {
        const where = `línea ${i + 1}`;
        const description = text(l?.description, `la descripción de la ${where}`, { required: true });
        const item = l.itemId ? items.get(String(l.itemId)) : null;
        if (item) {
          if (item.type !== 'goods') fail(`${where}: solo los bienes salen del inventario; un servicio se vende sin artículo`);
          if (!item.active) fail(`${where}: el artículo ${item.sku} está inactivo`);
        }
        const vatBps = l.vatBps ?? 0;
        if (rates && !rates.includes(vatBps)) fail(`${where}: la tarifa de IVA ${vatBps / 100} % no existe en el país`);
        if (cfg.issuer?.regime === 'no_responsable' && vatBps !== 0) fail(`${where}: un emisor no responsable de IVA no puede vender con IVA`);
        let computed;
        try {
          computed = computeLine({ quantity: l.quantity, unitPrice: l.unitPrice, discountBps: l.discountBps ?? 0, vatBps });
        } catch (err) {
          if (err instanceof TaxError) fail(`${where}: ${err.message}`);
          throw err;
        }
        const accountId = String(l.accountId ?? item?.incomeAccount ?? cfg.accounts.income).trim();
        if (!ACCOUNT.test(accountId)) fail(`${where}: cuenta de ingresos inválida`);
        return {
          description,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          discountBps: l.discountBps ?? 0,
          vatBps,
          accountId,
          ...(item ? { itemId: item._id, warehouseId: warehouse._id, inventoryAccount: item.inventoryAccount, cogsAccount: item.cogsAccount } : {}),
          ...computed,
        };
      });
      const totals = computeTotals(lines);
      if (totals.total <= 0) fail('el total de la venta debe ser mayor que cero');

      // Pagos: uno por método, en una cuenta que la caja acepte, sumando exactamente el total.
      const rawPayments = input.payments;
      if (!Array.isArray(rawPayments) || rawPayments.length === 0) fail('indica cómo paga el cliente');
      const seen = new Set();
      let paid = 0;
      const payments = rawPayments.map((p, i) => {
        if (!PAYMENT_METHODS.includes(p?.method)) fail(`pago ${i + 1}: el método es efectivo, tarjeta o transferencia`);
        if (seen.has(p.method)) fail(`pago ${i + 1}: el método ${p.method} se repite`);
        seen.add(p.method);
        if (!Number.isSafeInteger(p.amount) || p.amount <= 0) fail(`pago ${i + 1}: el importe debe ser un entero positivo`);
        const account = register.accounts[p.method];
        if (!account) fail(`la caja ${register.code} no recibe pagos por ${p.method}`);
        paid = assertMinorUnits(paid + p.amount, 'total de los pagos');
        return { method: p.method, amount: p.amount, account };
      });
      if (paid !== totals.total) fail(`los pagos suman ${paid} y la venta ${totals.total}: deben ser iguales`, 'VALIDATION');
      const cashPaid = payments.find((p) => p.method === 'cash')?.amount ?? 0;
      let cashTendered;
      let change = 0;
      if (input.cashTendered !== undefined) {
        if (!Number.isSafeInteger(input.cashTendered) || input.cashTendered < cashPaid) fail('el efectivo recibido no puede ser menor que lo que se cobra en efectivo');
        if (cashPaid === 0) fail('hay efectivo recibido pero ningún pago en efectivo');
        cashTendered = input.cashTendered;
        change = cashTendered - cashPaid;
      }

      const problems = await accounts.postingProblems(tenantId, [...lines.map((l) => l.accountId), cfg.accounts.vatPayable, ...payments.map((p) => p.account)]);
      if (problems.length) fail(problems.join('; '));

      const saleId = new ObjectId();
      const stockLines = lines.map((line, index) => ({ line, index })).filter(({ line }) => line.itemId);

      /** Planea la salida de inventario y devuelve lo que el asiento y la transacción necesitan. */
      const planStock = async () => {
        if (!stockLines.length) return null;
        const plan = await inventory.planOut(tenantId, stockLines.map(({ line }) => ({ itemId: line.itemId, warehouseId: line.warehouseId, quantity: line.quantity })));
        const left = new Map(plan.map((p) => [`${p.itemId}:${p.warehouseId}`, { quantity: p.quantity, value: p.cost }]));
        const stockCost = lines.map(() => 0);
        for (const { line, index } of stockLines) {
          const group = left.get(`${line.itemId}:${line.warehouseId}`);
          stockCost[index] = averageCost(group, line.quantity);
          group.quantity -= line.quantity;
          group.value -= stockCost[index];
        }
        const cogs = new Map();
        const stock = new Map();
        for (const { line, index } of stockLines) {
          if (stockCost[index] <= 0) continue;
          addTo(cogs, line.cogsAccount, stockCost[index]);
          addTo(stock, line.inventoryAccount, stockCost[index]);
        }
        return {
          stockCost,
          lines: [...[...cogs].map(([accountId, debit]) => ({ accountId, debit })), ...[...stock].map(([accountId, credit]) => ({ accountId, credit }))],
          apply: (session) => inventory.applyOut(tenantId, plan, session, { type: 'pos_sale', date, source: { kind: 'pos_sale', id: String(saleId) }, userId }),
        };
      };

      const income = new Map();
      for (const l of lines) addTo(income, l.accountId, l.net);
      const baseLines = [
        ...payments.map((p) => ({ accountId: p.account, debit: p.amount })),
        ...[...income].filter(([, amount]) => amount > 0).map(([accountId, credit]) => ({ accountId, credit })),
        ...(totals.tax > 0 ? [{ accountId: cfg.accounts.vatPayable, credit: totals.tax }] : []),
      ];

      const attempt = async () => {
        const extra = await planStock();
        return ledger.postJournal(
          tenantId,
          {
            docType: 'PV',
            date,
            currency: tenant.currency,
            idempotencyKey: `pos-sale-${idempotencyKey}`,
            description: `Venta de mostrador en la caja ${register.code}`,
            source: { kind: 'pos_sale', id: String(saleId) },
            lines: [...baseLines, ...(extra?.lines ?? [])],
          },
          {
            inTx: async (session, { journal }) => {
              const reserved = await shiftsOf(tenantId).updateOne(
                { _id: shift._id, status: 'open' },
                {
                  $inc: {
                    salesCount: 1,
                    salesTotal: totals.total,
                    cashTotal: cashPaid,
                    cardTotal: payments.find((p) => p.method === 'card')?.amount ?? 0,
                    transferTotal: payments.find((p) => p.method === 'transfer')?.amount ?? 0,
                  },
                },
                { session },
              );
              if (reserved.matchedCount === 0) fail('el turno se cerró mientras se registraba la venta', 'SHIFT_CLOSED');
              const counter = await registersOf(tenantId).findOneAndUpdate({ _id: register._id }, { $inc: { lastSale: 1 } }, { session, returnDocument: 'after' });
              const number = counter.lastSale;
              await extra?.apply(session);
              await salesOf(tenantId).insertOne(
                {
                  _id: saleId,
                  idempotencyKey,
                  status: 'posted',
                  registerId: register._id,
                  registerCode: register.code,
                  shiftId: shift._id,
                  number,
                  fullNumber: `${register.code}-${String(number).padStart(6, '0')}`,
                  ...(customer ? { customer } : {}),
                  date,
                  currency: tenant.currency,
                  lines,
                  totals,
                  payments,
                  ...(cashTendered !== undefined ? { cashTendered, change } : {}),
                  ...(extra ? { stockCost: extra.stockCost } : {}),
                  ...(notes ? { notes } : {}),
                  journalId: journal._id,
                  createdBy: userId ?? null,
                  createdAt: now(),
                },
                session,
              );
              await ctx.auditTx?.(session, { action: 'pos.sale', target: saleId, details: { register: register.code, number, total: totals.total } });
            },
          },
        );
      };

      let replayed = false;
      try {
        const posted = await (stockLines.length ? inventory.withStockRetry(attempt) : attempt());
        replayed = posted.replayed;
      } catch (err) {
        if (!isDuplicate(err, 'tenant_possale_idempotency')) throw err;
        replayed = true;
      }
      const sale = await salesOf(tenantId).findOne({ idempotencyKey });
      if (!sale) fail('el asiento de la venta ya existía sin venta: contacta a soporte', 'INVALID_STATE');
      return { sale: present(sale), replayed };
    },

    /** Anula una venta con su turno todavía abierto: reversa el asiento y regresa los bienes al costo al que salieron. */
    async voidSale(tenantId, id, input = {}, ctx = {}) {
      const sale = await salesOf(tenantId).findOne({ _id: oid(id, 'venta') });
      if (!sale) fail('la venta no existe', 'NOT_FOUND');
      if (sale.status === 'void') return { sale: present(sale), replayed: true };
      const shift = await shiftsOf(tenantId).findOne({ _id: sale.shiftId });
      if (shift.status !== 'open') fail('el turno de la venta ya se cerró: no se anula, se corrige con un ajuste', 'SHIFT_CLOSED');
      const reason = text(input.reason, 'el motivo de la anulación', { required: true, max: 200 });
      const date = input.date ? parseDay(input.date, 'la fecha de la anulación') : now();
      if (dayOf(date) < dayOf(sale.date)) fail('la anulación no puede ser anterior a la venta');
      const cashPaid = sale.payments.find((p) => p.method === 'cash')?.amount ?? 0;

      await ledger.reverseJournal(
        tenantId,
        sale.journalId,
        { idempotencyKey: `pos-void-${sale._id}`, date, description: `Anulación de la venta ${sale.fullNumber}: ${reason}` },
        {
          inTx: async (session, { journal }) => {
            const changed = await salesOf(tenantId).updateOne(
              { _id: sale._id, status: 'posted' },
              { $set: { status: 'void', voidJournalId: journal._id, voidedAt: now(), voidedBy: ctx.userId ?? null, voidReason: reason } },
              { session },
            );
            if (changed.matchedCount === 0) fail('la venta cambió mientras se anulaba', 'INVALID_STATE');
            const adjusted = await shiftsOf(tenantId).updateOne(
              { _id: shift._id, status: 'open' },
              {
                $inc: {
                  salesCount: -1,
                  salesTotal: -sale.totals.total,
                  cashTotal: -cashPaid,
                  cardTotal: -(sale.payments.find((p) => p.method === 'card')?.amount ?? 0),
                  transferTotal: -(sale.payments.find((p) => p.method === 'transfer')?.amount ?? 0),
                  voidedCount: 1,
                  voidedTotal: sale.totals.total,
                },
              },
              { session },
            );
            if (adjusted.matchedCount === 0) fail('el turno se cerró mientras se anulaba la venta', 'SHIFT_CLOSED');
            const back = sale.lines
              .map((line, index) => ({ line, index }))
              .filter(({ line }) => line.itemId)
              .map(({ line, index }) => ({ itemId: line.itemId, warehouseId: line.warehouseId, quantity: line.quantity, value: sale.stockCost[index], lineIndex: index }));
            if (back.length) {
              await inventory.applyIn(tenantId, back, session, { type: 'pos_void', date, source: { kind: 'pos_sale', id: String(sale._id) }, userId: ctx.userId });
            }
            await ctx.auditTx?.(session, { action: 'pos.void', target: sale._id, details: { number: sale.fullNumber, reason } });
          },
        },
      );
      return { sale: present(await salesOf(tenantId).findOne({ _id: sale._id })), replayed: false };
    },

    async getSale(tenantId, id) {
      return salesOf(tenantId).findOne({ _id: oid(id, 'venta') });
    },

    async listSales(tenantId, { shiftId, registerId, status, limit = 25, cursor } = {}) {
      const size = Math.min(Math.max(Number(limit) || 25, 1), MAX_POS_PAGE);
      const filter = {
        ...(shiftId ? { shiftId: oid(shiftId, 'turno') } : {}),
        ...(registerId ? { registerId: oid(registerId, 'caja') } : {}),
        ...(status ? { status: String(status) } : {}),
        ...(cursor ? { _id: { $lt: oid(cursor, 'cursor') } } : {}),
      };
      const rows = await salesOf(tenantId).find(filter, { sort: { _id: -1 }, limit: size + 1 }).toArray();
      const hasMore = rows.length > size;
      const items = hasMore ? rows.slice(0, size) : rows;
      return { items, nextCursor: hasMore ? items[items.length - 1]._id.toHexString() : null };
    },
  };
  return api;
}
