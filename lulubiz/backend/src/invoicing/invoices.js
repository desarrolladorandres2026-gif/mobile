import { ObjectId } from 'mongodb';
import { creditNoteReasonsFor, vatRatesFor } from '../countries/index.js';
import { COLLECTIONS } from '../data/db.js';
import { TenantCollection } from '../data/tenantCollection.js';
import { isDuplicate, withTransaction } from '../data/tx.js';
import { ProviderUnavailableError, assertProvider } from './provider.js';
import { InvoicingError, missingSettings } from './settings.js';
import { computeLine, computeTotals, proportionalShare } from './tax.js';

const MAX_LINES = 200;
export const PAYMENT_METHODS = ['cash', 'credit'];
export const MAX_INVOICE_PAGE = 50;

const NOT_FINAL = ['pending_provider', 'rejected'];
const DAY_MS = 86_400_000;

function parseDay(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ''))) throw new InvoicingError(`${label} debe ser una fecha AAAA-MM-DD`);
  const date = new Date(`${value}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new InvoicingError(`${label} no es una fecha válida`);
  return date;
}

const isoDay = (date) => date.toISOString().slice(0, 10);

/*
 * Factura (referencia, sin tipos):
 * { _id, tenantId, idempotencyKey, resolutionId, prefix, number, fullNumber, resolution{...},
 *   status 'pending_provider'|'rejected'|'issued',
 *   customer { partyId, name, taxIdType, taxId, checkDigit?, email?, phone?, address? },
 *   issueDate, dueDate?, paymentMethod, currency, notes?,
 *   lines [{ description, quantity, unitPrice, discountBps, vatBps, accountId, gross, discount, net, tax, total }],
 *   totals { subtotal, discount, tax, total, taxByRate[] },
 *   accountsUsed { debit, vat },                          cuentas fijadas al crearla: un cambio posterior de configuración no la altera
 *   credited { quantity[], net[], tax[] }, creditedTotal,   lo ya acreditado por notas crédito
 *   collectible, paidTotal, balance                        cartera: si queda por cobrar (su débito fue a por cobrar), lo cobrado y
 *                                                          lo que falta (total − acreditado − cobrado; puede quedar negativo si se acredita lo ya cobrado)
 *   cufe?, qr?, validatedAt?, provider? { name, sandbox, reference }, issuedAt?,
 *   rejection? { code, message },
 *   accounting { status 'pending'|'posted', journalId?, error? },
 *   createdBy, createdAt }
 *
 * Ciclo de vida. Crear reserva el número y guarda la factura (`pending_provider`). Luego se envía al proveedor,
 * que es una llamada externa y por eso no va dentro de ninguna transacción:
 *   · aceptada  → `issued` y se contabiliza en la misma transacción;
 *   · rechazada → `rejected` (conserva su número; se puede reenviar);
 *   · sin respuesta → sigue `pending_provider` y se reintenta con `submit`. El proveedor es idempotente por referencia.
 * Si el proveedor ya la validó pero la contabilización falla (período cerrado, cuenta inactiva…), la validación
 * NO se pierde: la factura queda `issued` con la contabilización pendiente y se reintenta con `account`.
 */
export function createInvoicingService({ client, db, ledger, accounts, parties, settings, resolutions, provider = null, now = () => new Date() }) {
  if (provider) assertProvider(provider);
  const invoicesOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.invoices), tenantId);
  const notesOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.creditNotes), tenantId);
  const tenants = db.collection(COLLECTIONS.tenants);

  const requireProvider = () => {
    if (!provider) throw new InvoicingError('la facturación electrónica no está configurada: no hay proveedor', 'NOT_CONFIGURED');
    return provider;
  };

  async function tenantInfo(tenantId) {
    const tenant = await tenants.findOne({ _id: tenantId }, { projection: { country: 1, currency: 1 } });
    if (!tenant) throw new InvoicingError('la empresa no existe', 'NOT_FOUND');
    return tenant;
  }

  async function readySettings(tenantId) {
    const cfg = await settings.get(tenantId);
    const missing = missingSettings(cfg);
    if (missing.length) throw new InvoicingError(`falta configurar: ${missing.join(', ')}`, 'SETTINGS_INCOMPLETE');
    return cfg;
  }

  const present = (doc) => {
    if (!doc) return doc;
    if (doc.credited) {
      const left = doc.lines.some((l, i) => l.quantity - doc.credited.quantity[i] > 0);
      return { ...doc, creditStatus: doc.creditedTotal === 0 ? 'none' : left ? 'partial' : 'full' };
    }
    return doc;
  };

  const customerSnapshot = (party) => ({
    partyId: party._id,
    name: party.name,
    taxIdType: party.taxIdType,
    taxId: party.taxId,
    ...(party.checkDigit !== undefined ? { checkDigit: party.checkDigit } : {}),
    ...(party.email ? { email: party.email } : {}),
    ...(party.phone ? { phone: party.phone } : {}),
    ...(party.address ? { address: party.address } : {}),
  });

  function providerDocument(kind, doc, cfg) {
    return {
      kind,
      issuer: cfg.issuer,
      number: { prefix: doc.prefix, number: doc.number, fullNumber: doc.fullNumber, resolution: doc.resolution },
      issueDate: isoDay(doc.issueDate),
      ...(doc.dueDate ? { dueDate: isoDay(doc.dueDate) } : {}),
      ...(doc.paymentMethod ? { paymentMethod: doc.paymentMethod } : {}),
      currency: doc.currency,
      customer: doc.customer,
      lines: doc.lines,
      totals: doc.totals,
      ...(doc.notes ? { notes: doc.notes } : {}),
      ...(kind === 'credit_note'
        ? { reason: { code: doc.reasonCode, text: doc.reasonText }, invoice: { fullNumber: doc.invoiceFullNumber, cufe: doc.invoiceCufe } }
        : {}),
    };
  }

  /** Asiento de una factura: débito a por cobrar (o caja), créditos a ingresos por cuenta y a IVA por pagar. */
  function invoiceJournal(invoice) {
    const income = new Map();
    for (const line of invoice.lines) income.set(line.accountId, (income.get(line.accountId) ?? 0) + line.net);
    const lines = [{ accountId: invoice.accountsUsed.debit, debit: invoice.totals.total }];
    for (const [accountId, amount] of income) if (amount > 0) lines.push({ accountId, credit: amount });
    if (invoice.totals.tax > 0) lines.push({ accountId: invoice.accountsUsed.vat, credit: invoice.totals.tax });
    return {
      docType: 'FV',
      date: invoice.issueDate,
      currency: invoice.currency,
      idempotencyKey: `invoice-${invoice._id}`,
      description: `Factura ${invoice.fullNumber}`,
      source: { kind: 'invoice', id: String(invoice._id) },
      lines,
    };
  }

  /** Asiento de una nota crédito: el inverso proporcional, con los importes de la nota. */
  function noteJournal(note, invoice) {
    const income = new Map();
    for (const line of note.lines) income.set(line.accountId, (income.get(line.accountId) ?? 0) + line.net);
    const lines = [];
    for (const [accountId, amount] of income) if (amount > 0) lines.push({ accountId, debit: amount });
    if (note.totals.tax > 0) lines.push({ accountId: invoice.accountsUsed.vat, debit: note.totals.tax });
    lines.push({ accountId: invoice.accountsUsed.debit, credit: note.totals.total });
    return {
      docType: 'NC',
      date: note.issueDate,
      currency: note.currency,
      idempotencyKey: `credit-note-${note._id}`,
      description: `Nota crédito ${note.fullNumber} a la factura ${note.invoiceFullNumber}`,
      source: { kind: 'credit_note', id: String(note._id) },
      lines,
    };
  }

  /**
   * Contabiliza un documento ya validado por el proveedor y lo marca emitido, en una sola transacción.
   * Si la contabilización falla, la validación se conserva: queda emitido con la contabilización pendiente.
   */
  async function finalize({ tenantId, collection, doc, receipt, journalInput, auditAction, auditDetails, ctx }) {
    const target = collection(tenantId);
    const issuedFields = {
      status: 'issued',
      cufe: receipt.cufe,
      qr: receipt.qr,
      validatedAt: receipt.validatedAt,
      provider: { name: provider.name, sandbox: provider.sandbox, reference: receipt.reference },
      issuedAt: now(),
    };
    try {
      const { journal, replayed } = await ledger.postJournal(tenantId, journalInput, {
        inTx: async (session, { journal: created }) => {
          const result = await target.updateOne(
            { _id: doc._id, status: { $in: NOT_FINAL } },
            { $set: { ...issuedFields, accounting: { status: 'posted', journalId: created._id } }, $unset: { rejection: '' } },
            { session },
          );
          if (result.matchedCount === 0) throw new InvoicingError('el estado del documento cambió mientras se emitía', 'INVALID_STATE');
          await ctx.auditTx?.(session, { action: auditAction, target: doc._id, details: auditDetails });
        },
      });
      if (replayed) {
        // El asiento ya existía (un intento anterior lo registró): solo falta marcar el documento.
        await target.updateOne(
          { _id: doc._id, status: { $in: NOT_FINAL } },
          { $set: { ...issuedFields, accounting: { status: 'posted', journalId: journal._id } }, $unset: { rejection: '' } },
        );
      }
    } catch (err) {
      if (err instanceof InvoicingError && err.code === 'INVALID_STATE') return target.findOne({ _id: doc._id });
      await withTransaction(client, async (session) => {
        await target.updateOne(
          { _id: doc._id, status: { $in: NOT_FINAL } },
          { $set: { ...issuedFields, accounting: { status: 'pending', error: err.message, at: now() } }, $unset: { rejection: '' } },
          { session },
        );
        await ctx.auditTx?.(session, { action: auditAction, target: doc._id, details: { ...auditDetails, accounting: 'pending', reason: err.message } });
      });
    }
    return target.findOne({ _id: doc._id });
  }

  async function markRejected({ tenantId, collection, doc, result, auditAction, release, ctx }) {
    const target = collection(tenantId);
    await withTransaction(client, async (session) => {
      const updated = await target.updateOne(
        { _id: doc._id, status: { $in: NOT_FINAL } },
        { $set: { status: 'rejected', rejection: { code: result.code, message: result.message }, rejectedAt: now() } },
        { session },
      );
      if (updated.matchedCount === 1 && release) await release(session);
      await ctx.auditTx?.(session, { action: auditAction, target: doc._id, details: { code: result.code } });
    });
    return target.findOne({ _id: doc._id });
  }

  function prepareLines(inputLines, { country, regime, defaultAccount }) {
    if (!Array.isArray(inputLines) || inputLines.length === 0) throw new InvoicingError('la factura necesita al menos una línea');
    if (inputLines.length > MAX_LINES) throw new InvoicingError(`la factura admite como máximo ${MAX_LINES} líneas`);
    const allowed = vatRatesFor(country);
    return inputLines.map((line, i) => {
      const n = i + 1;
      const description = String(line.description ?? '').trim();
      if (!description) throw new InvoicingError(`línea ${n}: falta la descripción`);
      if (description.length > 200) throw new InvoicingError(`línea ${n}: la descripción admite como máximo 200 caracteres`);
      const vatBps = line.vatBps ?? 0;
      if (allowed && !allowed.includes(vatBps)) throw new InvoicingError(`línea ${n}: tarifa de IVA no válida (${vatBps / 100} %)`);
      if (regime === 'no_responsable' && vatBps !== 0) throw new InvoicingError(`línea ${n}: un emisor no responsable de IVA no puede facturar con IVA`);
      let computed;
      try {
        computed = computeLine({ quantity: line.quantity, unitPrice: line.unitPrice, discountBps: line.discountBps ?? 0, vatBps });
      } catch (error) {
        throw new InvoicingError(`línea ${n}: ${error.message}`);
      }
      const accountId = String(line.accountId ?? defaultAccount).trim();
      return { description, quantity: line.quantity, unitPrice: line.unitPrice, discountBps: line.discountBps ?? 0, vatBps, accountId, ...computed };
    });
  }

  // ------------------------------------------------------------------ facturas

  async function submitInvoice(tenantId, invoiceId, ctx = {}) {
    requireProvider();
    const invoice = await invoicesOf(tenantId).findOne({ _id: new ObjectId(invoiceId) });
    if (!invoice) throw new InvoicingError('la factura no existe', 'NOT_FOUND');
    if (invoice.status === 'issued') return { invoice: present(invoice), replayed: true };

    const cfg = await readySettings(tenantId);
    let result;
    try {
      result = await provider.issue({ kind: 'invoice', reference: String(invoice._id), document: providerDocument('invoice', invoice, cfg) });
    } catch (err) {
      if (err instanceof ProviderUnavailableError) return { invoice: present(invoice), pending: true };
      throw err;
    }
    if (result.status === 'rejected') {
      const rejected = await markRejected({ tenantId, collection: invoicesOf, doc: invoice, result, auditAction: 'invoice.reject', ctx });
      return { invoice: present(rejected), rejected: true };
    }
    const issued = await finalize({
      tenantId,
      collection: invoicesOf,
      doc: invoice,
      receipt: result,
      journalInput: invoiceJournal(invoice),
      auditAction: 'invoice.issue',
      auditDetails: { number: invoice.fullNumber, total: invoice.totals.total, sandbox: provider.sandbox },
      ctx,
    });
    return { invoice: present(issued) };
  }

  async function issueInvoice(tenantId, input, ctx = {}) {
    requireProvider();
    const { idempotencyKey, userId } = ctx;
    if (!idempotencyKey?.trim()) throw new InvoicingError('falta la clave de idempotencia');

    const previous = await invoicesOf(tenantId).findOne({ idempotencyKey });
    if (previous) return { ...(await submitInvoice(tenantId, previous._id, ctx)), replayed: true };

    const cfg = await readySettings(tenantId);
    const tenant = await tenantInfo(tenantId);
    const party = await parties.get(tenantId, input.customerId);
    if (!party) throw new InvoicingError('el cliente no existe', 'NOT_FOUND');
    if (!party.active) throw new InvoicingError('el cliente está inactivo');
    if (!party.roles.includes('customer')) throw new InvoicingError('el tercero elegido no está registrado como cliente');

    const issueDate = parseDay(input.issueDate, 'la fecha de emisión');
    if (issueDate.getTime() > now().getTime() + DAY_MS) throw new InvoicingError('la fecha de emisión no puede ser futura');
    const paymentMethod = input.paymentMethod;
    if (!PAYMENT_METHODS.includes(paymentMethod)) throw new InvoicingError('la forma de pago debe ser contado o crédito');
    let dueDate;
    if (input.dueDate) {
      dueDate = parseDay(input.dueDate, 'la fecha de vencimiento');
      if (dueDate < issueDate) throw new InvoicingError('el vencimiento no puede ser anterior a la emisión');
    }
    if (paymentMethod === 'credit' && !dueDate) throw new InvoicingError('una venta a crédito necesita fecha de vencimiento');
    const notes = String(input.notes ?? '').trim().slice(0, 500) || undefined;

    const lines = prepareLines(input.lines, { country: tenant.country, regime: cfg.issuer.regime, defaultAccount: cfg.accounts.income });
    const totals = computeTotals(lines);
    if (totals.total <= 0) throw new InvoicingError('el total de la factura debe ser mayor que cero');

    const debit = paymentMethod === 'cash' && cfg.accounts.cash ? cfg.accounts.cash : cfg.accounts.receivable;
    const problems = await accounts.postingProblems(tenantId, [debit, cfg.accounts.vatPayable, ...lines.map((l) => l.accountId)]);
    if (problems.length) throw new InvoicingError(problems.join('; '));

    let created;
    try {
      created = await withTransaction(client, async (session) => {
        const number = await resolutions.allocate(tenantId, 'invoice', now(), session);
        const doc = {
          idempotencyKey,
          resolutionId: number.resolutionId,
          prefix: number.prefix,
          number: number.number,
          fullNumber: number.fullNumber,
          resolution: number.resolution,
          status: 'pending_provider',
          customer: customerSnapshot(party),
          issueDate,
          ...(dueDate ? { dueDate } : {}),
          paymentMethod,
          currency: tenant.currency,
          ...(notes ? { notes } : {}),
          lines,
          totals,
          accountsUsed: { debit, vat: cfg.accounts.vatPayable },
          credited: { quantity: lines.map(() => 0), net: lines.map(() => 0), tax: lines.map(() => 0) },
          creditedTotal: 0,
          collectible: debit === cfg.accounts.receivable,
          paidTotal: 0,
          balance: totals.total,
          accounting: { status: 'pending' },
          createdBy: userId ?? null,
          createdAt: now(),
        };
        const { insertedId } = await invoicesOf(tenantId).insertOne({ ...doc }, session);
        await ctx.auditTx?.(session, { action: 'invoice.create', target: insertedId, details: { number: number.fullNumber, total: totals.total } });
        return { ...doc, _id: insertedId, tenantId };
      });
    } catch (err) {
      if (isDuplicate(err, 'tenant_invoice_idempotency')) {
        const winner = await invoicesOf(tenantId).findOne({ idempotencyKey });
        return { ...(await submitInvoice(tenantId, winner._id, ctx)), replayed: true };
      }
      throw err;
    }
    return { ...(await submitInvoice(tenantId, created._id, ctx)), replayed: false };
  }

  /** Contabiliza una factura emitida cuya contabilización quedó pendiente (por ejemplo, tras reabrir el período). */
  async function accountInvoice(tenantId, invoiceId, ctx = {}) {
    const invoice = await invoicesOf(tenantId).findOne({ _id: new ObjectId(invoiceId) });
    if (!invoice) throw new InvoicingError('la factura no existe', 'NOT_FOUND');
    if (invoice.status !== 'issued') throw new InvoicingError('solo se contabilizan facturas ya emitidas', 'INVALID_STATE');
    if (invoice.accounting?.status === 'posted') return present(invoice);
    await ledger.postJournal(tenantId, invoiceJournal(invoice), {
      inTx: async (session, { journal }) => {
        await invoicesOf(tenantId).updateOne(
          { _id: invoice._id, 'accounting.status': 'pending' },
          { $set: { accounting: { status: 'posted', journalId: journal._id } } },
          { session },
        );
        await ctx.auditTx?.(session, { action: 'invoice.account', target: invoice._id, details: { number: invoice.fullNumber } });
      },
    });
    return present(await invoicesOf(tenantId).findOne({ _id: invoice._id }));
  }

  // ------------------------------------------------------------- notas crédito

  async function submitCreditNote(tenantId, noteId, ctx = {}) {
    requireProvider();
    const note = await notesOf(tenantId).findOne({ _id: new ObjectId(noteId) });
    if (!note) throw new InvoicingError('la nota crédito no existe', 'NOT_FOUND');
    if (note.status === 'issued') return { note, replayed: true };
    if (note.status === 'rejected') return { note, rejected: true };

    const cfg = await readySettings(tenantId);
    const invoice = await invoicesOf(tenantId).findOne({ _id: note.invoiceId });
    let result;
    try {
      result = await provider.issue({ kind: 'credit_note', reference: String(note._id), document: providerDocument('credit_note', note, cfg) });
    } catch (err) {
      if (err instanceof ProviderUnavailableError) return { note, pending: true };
      throw err;
    }
    if (result.status === 'rejected') {
      // Una nota rechazada es definitiva: se libera lo que había reservado en la factura y se crea otra si hace falta.
      const rejected = await markRejected({
        tenantId,
        collection: notesOf,
        doc: note,
        result,
        auditAction: 'credit_note.reject',
        ctx,
        release: (session) =>
          invoicesOf(tenantId).updateOne(
            { _id: note.invoiceId },
            {
              $inc: {
                creditedTotal: -note.totals.total,
                balance: note.totals.total,
                ...Object.fromEntries(note.lines.flatMap((l) => [
                  [`credited.quantity.${l.lineIndex}`, -l.quantity],
                  [`credited.net.${l.lineIndex}`, -l.net],
                  [`credited.tax.${l.lineIndex}`, -l.tax],
                ])),
              },
            },
            { session },
          ),
      });
      return { note: rejected, rejected: true };
    }
    const issued = await finalize({
      tenantId,
      collection: notesOf,
      doc: note,
      receipt: result,
      journalInput: noteJournal(note, invoice),
      auditAction: 'credit_note.issue',
      auditDetails: { number: note.fullNumber, invoice: note.invoiceFullNumber, total: note.totals.total, sandbox: provider.sandbox },
      ctx,
    });
    return { note: issued };
  }

  async function issueCreditNote(tenantId, invoiceId, input, ctx = {}) {
    requireProvider();
    const { idempotencyKey, userId } = ctx;
    if (!idempotencyKey?.trim()) throw new InvoicingError('falta la clave de idempotencia');

    const previous = await notesOf(tenantId).findOne({ idempotencyKey });
    if (previous) return { ...(await submitCreditNote(tenantId, previous._id, ctx)), replayed: true };

    const tenant = await tenantInfo(tenantId);
    const reasons = creditNoteReasonsFor(tenant.country);
    const reason = reasons.find((r) => r.code === String(input.reasonCode));
    if (!reason) throw new InvoicingError('elige el motivo de la nota crédito');
    const issueDate = parseDay(input.issueDate ?? isoDay(now()), 'la fecha de emisión');
    if (issueDate.getTime() > now().getTime() + DAY_MS) throw new InvoicingError('la fecha de emisión no puede ser futura');

    // La reserva en la factura es optimista: si otra nota crédito la modificó entre la lectura y la escritura, se relee.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const invoice = await invoicesOf(tenantId).findOne({ _id: new ObjectId(invoiceId) });
      if (!invoice) throw new InvoicingError('la factura no existe', 'NOT_FOUND');
      if (invoice.status !== 'issued') throw new InvoicingError('solo se acreditan facturas ya emitidas', 'INVALID_STATE');
      if (issueDate < invoice.issueDate) throw new InvoicingError('la nota crédito no puede ser anterior a la factura');

      const wanted = input.all
        ? invoice.lines.map((l, i) => ({ lineIndex: i, quantity: l.quantity - invoice.credited.quantity[i] })).filter((w) => w.quantity > 0)
        : (input.lines ?? []);
      if (!wanted.length) throw new InvoicingError('no queda nada por acreditar en esta factura', 'OVER_CREDIT');
      const seen = new Set();
      const noteLines = wanted.map((w) => {
        if (!Number.isInteger(w.lineIndex) || w.lineIndex < 0 || w.lineIndex >= invoice.lines.length) throw new InvoicingError('línea de factura inexistente');
        if (seen.has(w.lineIndex)) throw new InvoicingError('una línea de la factura solo puede acreditarse una vez por nota');
        seen.add(w.lineIndex);
        const line = invoice.lines[w.lineIndex];
        let share;
        try {
          share = proportionalShare(line, {
            quantity: w.quantity,
            creditedQuantity: invoice.credited.quantity[w.lineIndex],
            creditedNet: invoice.credited.net[w.lineIndex],
            creditedTax: invoice.credited.tax[w.lineIndex],
          });
        } catch (error) {
          throw new InvoicingError(`línea ${w.lineIndex + 1}: ${error.message}`, 'OVER_CREDIT');
        }
        return {
          lineIndex: w.lineIndex,
          description: line.description,
          quantity: w.quantity,
          unitPrice: line.unitPrice,
          discountBps: line.discountBps,
          vatBps: line.vatBps,
          accountId: line.accountId,
          discount: 0,
          net: share.net,
          tax: share.tax,
          total: share.total,
        };
      });
      const totals = computeTotals(noteLines);
      if (totals.total <= 0) throw new InvoicingError('el valor de la nota crédito debe ser mayor que cero');

      const guard = { _id: invoice._id, status: 'issued' };
      const inc = { creditedTotal: totals.total, balance: -totals.total };
      for (const l of noteLines) {
        guard[`credited.quantity.${l.lineIndex}`] = invoice.credited.quantity[l.lineIndex];
        guard[`credited.net.${l.lineIndex}`] = invoice.credited.net[l.lineIndex];
        guard[`credited.tax.${l.lineIndex}`] = invoice.credited.tax[l.lineIndex];
        inc[`credited.quantity.${l.lineIndex}`] = l.quantity;
        inc[`credited.net.${l.lineIndex}`] = l.net;
        inc[`credited.tax.${l.lineIndex}`] = l.tax;
      }

      let created = null;
      try {
        created = await withTransaction(client, async (session) => {
          const reserved = await invoicesOf(tenantId).updateOne(guard, { $inc: inc }, { session });
          if (reserved.matchedCount === 0) return null; // otra nota crédito se adelantó: se relee
          const number = await resolutions.allocate(tenantId, 'credit_note', now(), session);
          const doc = {
            idempotencyKey,
            invoiceId: invoice._id,
            invoiceFullNumber: invoice.fullNumber,
            invoiceCufe: invoice.cufe,
            resolutionId: number.resolutionId,
            prefix: number.prefix,
            number: number.number,
            fullNumber: number.fullNumber,
            resolution: number.resolution,
            status: 'pending_provider',
            reasonCode: reason.code,
            reasonText: reason.label,
            customer: invoice.customer,
            issueDate,
            currency: invoice.currency,
            lines: noteLines,
            totals,
            accounting: { status: 'pending' },
            createdBy: userId ?? null,
            createdAt: now(),
          };
          const { insertedId } = await notesOf(tenantId).insertOne({ ...doc }, session);
          await ctx.auditTx?.(session, { action: 'credit_note.create', target: insertedId, details: { number: number.fullNumber, invoice: invoice.fullNumber, total: totals.total } });
          return { ...doc, _id: insertedId, tenantId };
        });
      } catch (err) {
        if (isDuplicate(err, 'tenant_note_idempotency')) {
          const winner = await notesOf(tenantId).findOne({ idempotencyKey });
          return { ...(await submitCreditNote(tenantId, winner._id, ctx)), replayed: true };
        }
        throw err;
      }
      if (created) return { ...(await submitCreditNote(tenantId, created._id, ctx)), replayed: false };
    }
    throw new InvoicingError('la factura se está modificando en este momento: inténtalo de nuevo', 'INVALID_STATE');
  }

  async function accountCreditNote(tenantId, noteId, ctx = {}) {
    const note = await notesOf(tenantId).findOne({ _id: new ObjectId(noteId) });
    if (!note) throw new InvoicingError('la nota crédito no existe', 'NOT_FOUND');
    if (note.status !== 'issued') throw new InvoicingError('solo se contabilizan notas crédito ya emitidas', 'INVALID_STATE');
    if (note.accounting?.status === 'posted') return note;
    const invoice = await invoicesOf(tenantId).findOne({ _id: note.invoiceId });
    await ledger.postJournal(tenantId, noteJournal(note, invoice), {
      inTx: async (session, { journal }) => {
        await notesOf(tenantId).updateOne(
          { _id: note._id, 'accounting.status': 'pending' },
          { $set: { accounting: { status: 'posted', journalId: journal._id } } },
          { session },
        );
        await ctx.auditTx?.(session, { action: 'credit_note.account', target: note._id, details: { number: note.fullNumber } });
      },
    });
    return notesOf(tenantId).findOne({ _id: note._id });
  }

  // ------------------------------------------------------------------ consultas

  async function list(collection, tenantId, { status, customerId, from, to, invoiceId, limit = 25, cursor } = {}) {
    const size = Math.min(Math.max(Number(limit) || 25, 1), MAX_INVOICE_PAGE);
    const filter = {};
    if (status) filter.status = String(status);
    if (customerId) filter['customer.partyId'] = new ObjectId(customerId);
    if (invoiceId) filter.invoiceId = new ObjectId(invoiceId);
    if (from || to) {
      filter.issueDate = {};
      if (from) filter.issueDate.$gte = parseDay(from, 'la fecha inicial');
      if (to) filter.issueDate.$lte = parseDay(to, 'la fecha final');
    }
    if (cursor) filter._id = { $lt: new ObjectId(cursor) };
    const rows = await collection(tenantId).find(filter, { sort: { _id: -1 }, limit: size + 1 }).toArray();
    const hasMore = rows.length > size;
    const items = hasMore ? rows.slice(0, size) : rows;
    return { items: items.map(present), nextCursor: hasMore ? items[items.length - 1]._id.toHexString() : null };
  }

  return {
    async status(tenantId) {
      const cfg = await settings.get(tenantId);
      const resolutionList = await resolutions.list(tenantId);
      const missing = missingSettings(cfg);
      const usable = (docType) => resolutionList.some((r) => r.docType === docType && r.active && r.validTo >= now() && r.next <= r.to);
      if (!usable('invoice')) missing.push('una resolución de numeración vigente para facturas');
      if (!usable('credit_note')) missing.push('una resolución de numeración vigente para notas crédito');
      return {
        configured: Boolean(provider),
        provider: provider?.name ?? null,
        sandbox: provider?.sandbox ?? null,
        missing,
        ready: Boolean(provider) && missing.length === 0,
      };
    },
    issueInvoice,
    submitInvoice,
    accountInvoice,
    issueCreditNote,
    submitCreditNote,
    accountCreditNote,
    async getInvoice(tenantId, id) {
      return present(await invoicesOf(tenantId).findOne({ _id: new ObjectId(id) }));
    },
    listInvoices: (tenantId, options) => list(invoicesOf, tenantId, options),
    getCreditNote: (tenantId, id) => notesOf(tenantId).findOne({ _id: new ObjectId(id) }),
    listCreditNotes: (tenantId, options) => list(notesOf, tenantId, options),
  };
}

