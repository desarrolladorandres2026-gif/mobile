import { ObjectId } from 'mongodb';
import { DAY_MS, dayOf, parseDay as parseCalendarDay, calendarToday } from '../core/dates.js';
import { assertCurrency, assertMinorUnits } from '../core/money.js';
import { COLLECTIONS } from '../data/db.js';
import { TenantCollection } from '../data/tenantCollection.js';
import { isDuplicate } from '../data/tx.js';

export const MAX_ADVANCE_ALLOCATIONS = 200;
export const MAX_ADVANCE_PAGE = 50;
export const KINDS = ['customer', 'supplier'];

export class AdvanceError extends Error {
  constructor(message, code = 'VALIDATION') {
    super(message);
    this.name = 'AdvanceError';
    this.code = code;
  }
}

const fail = (message, code) => {
  throw new AdvanceError(message, code);
};
const parseDay = (value, label) => parseCalendarDay(value, label, fail);
const ACCOUNT = /^[0-9]{1,12}$/;

/*
 * Anticipos: dinero que se recibe de un cliente (o se entrega a un proveedor) antes de que exista la factura.
 *
 *  - Anticipo de cliente: debe caja o bancos y acredita una cuenta de pasivo (anticipos recibidos). Es un recibo de
 *    caja (serie RC). Anticipo a proveedor: debita una cuenta de activo (anticipos entregados) y acredita caja o bancos.
 *    Es un comprobante de egreso (serie CE). Las cuentas de anticipos se configuran en Facturación.
 *  - Aplicar un anticipo a facturas (o a compras) mueve el saldo de la cuenta de anticipos a la cuenta por cobrar (o por
 *    pagar) y baja el saldo de cada documento, como un cobro o un pago, sin que entre ni salga dinero. Asiento `AA`.
 *    Un anticipo se puede aplicar en varias veces y a varios documentos hasta agotarlo.
 *  - La baja del saldo del anticipo y la de cada documento son operaciones condicionadas (`balance >= importe`) en la
 *    misma transacción del asiento: dos aplicaciones simultáneas no pueden gastar el mismo dinero dos veces.
 *  - Una aplicación se puede anular (reversa su asiento y devuelve los saldos); un anticipo solo se anula si no tiene
 *    aplicaciones vigentes.
 *
 * Límites: no hay devolución de un anticipo sobrante al cliente ni cobro de uno al proveedor (se corrige con un asiento);
 * el anticipo es de una sola moneda y solo se aplica a documentos de esa moneda.
 */
export function createAdvancesService({ client, db, ledger, accounts, parties, settings, now = () => new Date() }) {
  const advancesOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.advances), tenantId);
  const applicationsOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.advanceApplications), tenantId);
  const invoicesOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.invoices), tenantId);
  const purchasesOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.purchases), tenantId);
  const tenants = db.collection(COLLECTIONS.tenants);

  const config = {
    customer: {
      role: 'customer',
      partyLabel: 'cliente',
      docType: 'RC',
      accountKey: 'customerAdvance',
      accountLabel: 'la cuenta de anticipos de clientes',
      accountType: 'liability',
      docOf: invoicesOf,
      docLabel: 'factura',
      docIdField: 'invoiceId',
      open: { status: 'issued', collectible: true, 'accounting.status': 'posted' },
      partyPath: 'customer.partyId',
      payableAccount: (doc) => doc.accountsUsed.debit,
    },
    supplier: {
      role: 'supplier',
      partyLabel: 'proveedor',
      docType: 'CE',
      accountKey: 'supplierAdvance',
      accountLabel: 'la cuenta de anticipos a proveedores',
      accountType: 'asset',
      docOf: purchasesOf,
      docLabel: 'compra',
      docIdField: 'purchaseId',
      open: { status: 'posted' },
      partyPath: 'supplier.partyId',
      payableAccount: (doc) => doc.accountsUsed.payable,
    },
  };
  const cfgOf = (kind) => config[kind] ?? fail('el anticipo es de un cliente o de un proveedor');

  async function tenantCurrency(tenantId) {
    const tenant = await tenants.findOne({ _id: tenantId }, { projection: { currency: 1 } });
    if (!tenant) fail('la empresa no existe', 'NOT_FOUND');
    return tenant.currency;
  }

  async function advanceAccount(tenantId, kind) {
    const cfg = cfgOf(kind);
    const settingsDoc = await settings.get(tenantId);
    const code = settingsDoc?.accounts?.[cfg.accountKey];
    if (!code) fail(`falta configurar ${cfg.accountLabel} (en Facturación)`, 'SETTINGS_INCOMPLETE');
    const account = await accounts.get(tenantId, code);
    if (account?.type !== cfg.accountType) fail(`${cfg.accountLabel} debe ser de ${cfg.accountType === 'liability' ? 'pasivo' : 'activo'}`, 'SETTINGS_INCOMPLETE');
    return code;
  }

  const api = {
    async create(tenantId, kind, input, ctx = {}) {
      const cfg = cfgOf(kind);
      const { idempotencyKey, userId } = ctx;
      if (!idempotencyKey?.trim()) fail('falta la clave de idempotencia');
      const previous = await advancesOf(tenantId).findOne({ idempotencyKey });
      if (previous) return { advance: previous, replayed: true };

      const date = parseDay(input.date, 'la fecha del anticipo');
      if (date.getTime() > now().getTime() + DAY_MS) fail('la fecha del anticipo no puede ser futura');
      const amount = input.amount;
      if (!Number.isSafeInteger(amount) || amount <= 0) fail('el importe debe ser un entero positivo');
      const currency = assertCurrency(input.currency ?? (await tenantCurrency(tenantId)));
      const notes = String(input.notes ?? '').trim().slice(0, 500) || undefined;

      const party = await parties.get(tenantId, input.partyId);
      if (!party) fail(`el ${cfg.partyLabel} no existe`, 'NOT_FOUND');
      if (!party.active) fail(`el ${cfg.partyLabel} está inactivo`);
      if (!party.roles.includes(cfg.role)) fail(`el tercero elegido no está registrado como ${cfg.partyLabel}`);

      const holding = await advanceAccount(tenantId, kind);
      const account = String(input.account ?? '').trim();
      if (!ACCOUNT.test(account)) fail(kind === 'customer' ? 'indica la cuenta de caja o bancos donde entra el dinero' : 'indica la cuenta de caja o bancos de donde sale el dinero');
      if (account === holding) fail('la cuenta de caja o bancos no puede ser la de anticipos');
      const problems = await accounts.postingProblems(tenantId, [account, holding]);
      if (problems.length) fail(problems.join('; '));
      if ((await accounts.get(tenantId, account)).type !== 'asset') fail('el dinero entra o sale de una cuenta de activo: caja o bancos');

      const lines = kind === 'customer' ? [{ accountId: account, debit: amount }, { accountId: holding, credit: amount, partyId: party._id }] : [{ accountId: holding, debit: amount, partyId: party._id }, { accountId: account, credit: amount }];
      const result = await ledger
        .postJournal(
          tenantId,
          {
            docType: cfg.docType,
            date,
            currency,
            idempotencyKey: `advance-${idempotencyKey}`,
            description: kind === 'customer' ? `Anticipo de ${party.name}` : `Anticipo a ${party.name}`,
            source: { kind: `${kind}_advance`, id: idempotencyKey },
            lines,
          },
          {
            inTx: async (session, { journal }) => {
              const doc = {
                idempotencyKey,
                kind,
                number: journal.number,
                fullNumber: `${cfg.docType}${journal.number}`,
                status: 'posted',
                partyId: party._id,
                party: { name: party.name, taxIdType: party.taxIdType, taxId: party.taxId },
                date,
                currency,
                amount,
                applied: 0,
                balance: amount,
                account,
                advanceAccount: holding,
                ...(notes ? { notes } : {}),
                journalId: journal._id,
                createdBy: userId ?? null,
                createdAt: now(),
              };
              const { insertedId } = await advancesOf(tenantId).insertOne({ ...doc }, session);
              await ctx.auditTx?.(session, { action: `${kind}_advance.create`, target: insertedId, details: { number: doc.fullNumber, amount } });
            },
          },
        )
        .catch((err) => {
          if (isDuplicate(err, 'tenant_advance_idempotency')) return { replayed: true };
          throw err;
        });
      const advance = await advancesOf(tenantId).findOne({ idempotencyKey });
      if (!advance) fail('el asiento del anticipo ya existía sin anticipo: contacta a soporte', 'INVALID_STATE');
      return { advance, replayed: Boolean(result.replayed) };
    },

    /** Aplica parte o todo el saldo de un anticipo a facturas (cliente) o compras (proveedor) del mismo tercero y moneda. */
    async apply(tenantId, kind, advanceId, input, ctx = {}) {
      const cfg = cfgOf(kind);
      const { idempotencyKey, userId } = ctx;
      if (!idempotencyKey?.trim()) fail('falta la clave de idempotencia');
      const previous = await applicationsOf(tenantId).findOne({ idempotencyKey });
      if (previous) return { application: previous, replayed: true };

      const advance = await advancesOf(tenantId).findOne({ _id: new ObjectId(advanceId), kind });
      if (!advance) fail('el anticipo no existe', 'NOT_FOUND');
      if (advance.status !== 'posted') fail('el anticipo está anulado', 'INVALID_STATE');
      const date = parseDay(input.date, 'la fecha de la aplicación');
      if (date.getTime() > now().getTime() + DAY_MS) fail('la fecha de la aplicación no puede ser futura');
      if (dayOf(date) < dayOf(advance.date)) fail('la aplicación no puede ser anterior al anticipo');

      const raw = input.allocations;
      if (!Array.isArray(raw) || raw.length === 0) fail(`indica a qué ${cfg.docLabel}s se aplica el anticipo`);
      if (raw.length > MAX_ADVANCE_ALLOCATIONS) fail(`un anticipo se aplica como máximo a ${MAX_ADVANCE_ALLOCATIONS} documentos por vez`);
      const seen = new Set();
      const allocations = raw.map((a, i) => {
        const id = String(a?.documentId ?? '');
        if (!/^[a-f0-9]{24}$/.test(id)) fail(`aplicación ${i + 1}: ${cfg.docLabel} inválida`);
        if (seen.has(id)) fail(`aplicación ${i + 1}: la ${cfg.docLabel} se repite`);
        seen.add(id);
        if (!Number.isSafeInteger(a.amount) || a.amount <= 0) fail(`aplicación ${i + 1}: el importe debe ser un entero positivo`);
        return { documentId: new ObjectId(id), amount: a.amount };
      });
      let total = 0;
      for (const a of allocations) total = assertMinorUnits(total + a.amount, 'total aplicado');
      if (total > advance.balance) fail(`el anticipo solo tiene ${advance.balance} disponible y se pretende aplicar ${total}`, 'OVER_PAYMENT');

      const docs = await cfg.docOf(tenantId).find({ _id: { $in: allocations.map((a) => a.documentId) } }).toArray();
      const byId = new Map(docs.map((d) => [String(d._id), d]));
      for (const [i, a] of allocations.entries()) {
        const doc = byId.get(String(a.documentId));
        if (!doc) fail(`aplicación ${i + 1}: la ${cfg.docLabel} no existe`, 'NOT_FOUND');
        if (String(doc[cfg.partyPath.split('.')[0]].partyId) !== String(advance.partyId)) fail(`la ${cfg.docLabel} ${doc.fullNumber} es de otro ${cfg.partyLabel}`);
        if (doc.currency !== advance.currency) fail(`la ${cfg.docLabel} ${doc.fullNumber} está en ${doc.currency} y el anticipo en ${advance.currency}`);
        if (kind === 'customer') {
          if (doc.status !== 'issued' || doc.accounting?.status !== 'posted') fail(`la factura ${doc.fullNumber} no está emitida y contabilizada`, 'INVALID_STATE');
          if (!doc.collectible) fail(`la factura ${doc.fullNumber} se pagó de contado: no tiene cartera`, 'INVALID_STATE');
        } else if (doc.status !== 'posted') {
          fail(`la compra ${doc.fullNumber} está anulada`, 'INVALID_STATE');
        }
        if (dayOf(date) < dayOf(doc.issueDate)) fail(`la aplicación no puede ser anterior a ${doc.fullNumber}`);
        if (a.amount > doc.balance) fail(`${doc.fullNumber} solo tiene saldo por ${doc.balance}`, 'OVER_PAYMENT');
      }

      // Asiento: el anticipo sale de su cuenta y baja la deuda del documento (por cobrar o por pagar), sin mover dinero.
      const perAccount = new Map();
      for (const a of allocations) {
        const account = cfg.payableAccount(byId.get(String(a.documentId)));
        perAccount.set(account, (perAccount.get(account) ?? 0) + a.amount);
      }
      const side = kind === 'customer'
        ? [{ accountId: advance.advanceAccount, debit: total, partyId: advance.partyId }, ...[...perAccount].map(([accountId, credit]) => ({ accountId, credit, partyId: advance.partyId }))]
        : [...[...perAccount].map(([accountId, debit]) => ({ accountId, debit, partyId: advance.partyId })), { accountId: advance.advanceAccount, credit: total, partyId: advance.partyId }];

      const result = await ledger
        .postJournal(
          tenantId,
          {
            docType: 'AA',
            date,
            currency: advance.currency,
            idempotencyKey: `advance-apply-${idempotencyKey}`,
            description: `Aplicación del anticipo ${advance.fullNumber} de ${advance.party.name}`,
            source: { kind: `${kind}_advance_application`, id: idempotencyKey },
            lines: side,
          },
          {
            inTx: async (session, { journal }) => {
              const spent = await advancesOf(tenantId).updateOne(
                { _id: advance._id, status: 'posted', balance: { $gte: total } },
                { $inc: { applied: total, balance: -total } },
                { session },
              );
              if (spent.matchedCount === 0) fail('el anticipo ya no tiene saldo suficiente', 'OVER_PAYMENT');
              for (const a of allocations) {
                const doc = byId.get(String(a.documentId));
                const reserved = await cfg.docOf(tenantId).updateOne(
                  { _id: a.documentId, ...cfg.open, balance: { $gte: a.amount } },
                  { $inc: { paidTotal: a.amount, balance: -a.amount } },
                  { session },
                );
                if (reserved.matchedCount === 0) fail(`${doc.fullNumber} ya no tiene saldo suficiente`, 'OVER_PAYMENT');
              }
              const doc = {
                idempotencyKey,
                kind,
                advanceId: advance._id,
                number: journal.number,
                fullNumber: `AA${journal.number}`,
                status: 'posted',
                partyId: advance.partyId,
                date,
                currency: advance.currency,
                allocations: allocations.map((a) => ({ documentId: a.documentId, fullNumber: byId.get(String(a.documentId)).fullNumber, amount: a.amount })),
                total,
                journalId: journal._id,
                createdBy: userId ?? null,
                createdAt: now(),
              };
              const { insertedId } = await applicationsOf(tenantId).insertOne({ ...doc }, session);
              await ctx.auditTx?.(session, { action: `${kind}_advance.apply`, target: insertedId, details: { advance: advance.fullNumber, total, documents: allocations.length } });
            },
          },
        )
        .catch((err) => {
          if (isDuplicate(err, 'tenant_advance_application_idempotency')) return { replayed: true };
          throw err;
        });
      const application = await applicationsOf(tenantId).findOne({ idempotencyKey });
      if (!application) fail('el asiento de la aplicación ya existía sin aplicación: contacta a soporte', 'INVALID_STATE');
      return { application, advance: await advancesOf(tenantId).findOne({ _id: advance._id }), replayed: Boolean(result.replayed) };
    },

    /** Anula una aplicación: reversa su asiento y devuelve el saldo al anticipo y a cada documento. */
    async voidApplication(tenantId, kind, applicationId, input = {}, ctx = {}) {
      const cfg = cfgOf(kind);
      const application = await applicationsOf(tenantId).findOne({ _id: new ObjectId(applicationId), kind });
      if (!application) fail('la aplicación no existe', 'NOT_FOUND');
      if (application.status === 'void') return { application, replayed: true };
      const date = input.date ? parseDay(input.date, 'la fecha de la anulación') : calendarToday(now());
      if (dayOf(date) < dayOf(application.date)) fail('la anulación no puede ser anterior a la aplicación');

      await ledger.reverseJournal(
        tenantId,
        application.journalId,
        { idempotencyKey: `advance-apply-void-${application._id}`, date, description: `Anulación de la aplicación ${application.fullNumber}` },
        {
          inTx: async (session, { journal }) => {
            const changed = await applicationsOf(tenantId).updateOne(
              { _id: application._id, status: 'posted' },
              { $set: { status: 'void', voidJournalId: journal._id, voidedAt: now(), voidedBy: ctx.userId ?? null } },
              { session },
            );
            if (changed.matchedCount === 0) fail('la aplicación ya fue anulada', 'INVALID_STATE');
            await advancesOf(tenantId).updateOne({ _id: application.advanceId }, { $inc: { applied: -application.total, balance: application.total } }, { session });
            for (const a of application.allocations) {
              await cfg.docOf(tenantId).updateOne({ _id: a.documentId }, { $inc: { paidTotal: -a.amount, balance: a.amount } }, { session });
            }
            await ctx.auditTx?.(session, { action: `${kind}_advance.apply_void`, target: application._id, details: { number: application.fullNumber, total: application.total } });
          },
        },
      );
      return { application: await applicationsOf(tenantId).findOne({ _id: application._id }), replayed: false };
    },

    /** Anula un anticipo sin aplicaciones vigentes: reversa su asiento. */
    async void(tenantId, kind, advanceId, input = {}, ctx = {}) {
      cfgOf(kind);
      const advance = await advancesOf(tenantId).findOne({ _id: new ObjectId(advanceId), kind });
      if (!advance) fail('el anticipo no existe', 'NOT_FOUND');
      if (advance.status === 'void') return { advance, replayed: true };
      if (advance.balance !== advance.amount) fail('el anticipo tiene aplicaciones: anúlalas primero', 'INVALID_STATE');
      const date = input.date ? parseDay(input.date, 'la fecha de la anulación') : calendarToday(now());
      if (dayOf(date) < dayOf(advance.date)) fail('la anulación no puede ser anterior al anticipo');

      await ledger.reverseJournal(
        tenantId,
        advance.journalId,
        { idempotencyKey: `advance-void-${advance._id}`, date, description: `Anulación del anticipo ${advance.fullNumber}` },
        {
          inTx: async (session, { journal }) => {
            const changed = await advancesOf(tenantId).updateOne(
              { _id: advance._id, status: 'posted', balance: advance.amount },
              { $set: { status: 'void', voidJournalId: journal._id, voidedAt: now(), voidedBy: ctx.userId ?? null, balance: 0 } },
              { session },
            );
            if (changed.matchedCount === 0) fail('el anticipo cambió mientras se anulaba: revisa sus aplicaciones', 'INVALID_STATE');
            await ctx.auditTx?.(session, { action: `${kind}_advance.void`, target: advance._id, details: { number: advance.fullNumber, amount: advance.amount } });
          },
        },
      );
      return { advance: await advancesOf(tenantId).findOne({ _id: advance._id }), replayed: false };
    },

    async get(tenantId, kind, id) {
      cfgOf(kind);
      const advance = await advancesOf(tenantId).findOne({ _id: new ObjectId(id), kind });
      if (!advance) return null;
      const applications = await applicationsOf(tenantId).find({ advanceId: advance._id }, { sort: { _id: 1 }, limit: 200 }).toArray();
      return { ...advance, applications };
    },

    /** `open`: anticipos vigentes con saldo por aplicar. */
    async list(tenantId, kind, { partyId, open, status, limit = 25, cursor } = {}) {
      cfgOf(kind);
      const size = Math.min(Math.max(Number(limit) || 25, 1), MAX_ADVANCE_PAGE);
      const filter = {
        kind,
        ...(partyId ? { partyId: new ObjectId(partyId) } : {}),
        ...(open === true || open === 'true' ? { status: 'posted', balance: { $gt: 0 } } : status ? { status: String(status) } : {}),
        ...(cursor ? { _id: { $lt: new ObjectId(cursor) } } : {}),
      };
      const rows = await advancesOf(tenantId).find(filter, { sort: { _id: -1 }, limit: size + 1 }).toArray();
      const hasMore = rows.length > size;
      const items = hasMore ? rows.slice(0, size) : rows;
      return { items, nextCursor: hasMore ? items[items.length - 1]._id.toHexString() : null };
    },
  };
  return api;
}
