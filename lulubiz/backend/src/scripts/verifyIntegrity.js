import { COLLECTIONS } from '../data/db.js';
import { accumulatedAfter } from '../fixedAssets/fixedAssets.js';

/*
 * Verificador de integridad. Solo lee. Recalcula desde lo que no se puede editar (los asientos) lo que el sistema
 * mantiene aparte (saldos, consecutivos, existencias, totales de turno) y avisa de cualquier diferencia. Sirve para
 * comprobar una base restaurada de una copia de seguridad, antes y después de un despliegue, y de vez en cuando como
 * vigilancia: un resultado distinto de «todo en orden» no se corrige a mano, se investiga.
 *
 * Cada comprobación devuelve `{ name, ok, detail }`; `detail` dice qué se encontró y cuántos casos hay.
 */

const sample = (list, n = 5) => list.slice(0, n);

async function balancesMatchJournals(db, tenantId) {
  const journals = await db
    .collection(COLLECTIONS.journals)
    .aggregate([
      { $match: { tenantId } },
      { $unwind: '$lines' },
      { $group: { _id: { a: '$lines.accountId', p: '$period', c: '$currency' }, debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' } } },
    ])
    .toArray();
  const balances = await db.collection(COLLECTIONS.balances).find({ tenantId }).toArray();
  const key = (a, p, c) => `${c}|${p}|${a}`;
  const fromJournals = new Map(journals.map((r) => [key(r._id.a, r._id.p, r._id.c), { debit: Number(r.debit), credit: Number(r.credit) }]));
  const stored = new Map(balances.map((b) => [key(b.accountId, b.period, b.currency), { debit: b.debit, credit: b.credit }]));
  const problems = [];
  for (const [k, v] of fromJournals) {
    const s = stored.get(k);
    if (!s) problems.push(`${k}: hay asientos y no hay saldo`);
    else if (s.debit !== v.debit || s.credit !== v.credit) problems.push(`${k}: saldo ${s.debit}/${s.credit} y asientos ${v.debit}/${v.credit}`);
  }
  for (const [k, s] of stored) if (!fromJournals.has(k) && (s.debit !== 0 || s.credit !== 0)) problems.push(`${k}: hay saldo y no hay asientos`);
  return { name: 'Los saldos por cuenta y período coinciden con los asientos', ok: problems.length === 0, detail: problems.length ? `${problems.length} diferencias: ${sample(problems).join('; ')}` : `${fromJournals.size} saldos revisados.` };
}

async function journalsBalanced(db, tenantId) {
  const bad = await db
    .collection(COLLECTIONS.journals)
    .aggregate([
      { $match: { tenantId } },
      { $project: { docType: 1, number: 1, totalDebit: 1, totalCredit: 1, sumDebit: { $sum: '$lines.debit' }, sumCredit: { $sum: '$lines.credit' } } },
      { $match: { $expr: { $or: [{ $ne: ['$totalDebit', '$totalCredit'] }, { $ne: ['$sumDebit', '$totalDebit'] }, { $ne: ['$sumCredit', '$totalCredit'] }] } } },
      { $limit: 20 },
    ])
    .toArray();
  return { name: 'Todo asiento cuadra (débitos iguales a créditos)', ok: bad.length === 0, detail: bad.length ? `${bad.length} asientos no cuadran: ${sample(bad.map((j) => `${j.docType}${j.number}`)).join(', ')}` : 'Todos cuadran.' };
}

async function consecutives(db, tenantId) {
  const counters = await db.collection(COLLECTIONS.counters).find({ tenantId }).toArray();
  const problems = [];
  for (const c of counters) {
    // El consecutivo de traspasos (TR) numera documentos de inventario, no asientos: se compara con ellos.
    const source = c.docType === 'TR' ? { collection: COLLECTIONS.stockDocs, filter: { kind: 'transfer' } } : { collection: COLLECTIONS.journals, filter: { docType: c.docType } };
    const [stats] = await db
      .collection(source.collection)
      .aggregate([{ $match: { tenantId, ...source.filter } }, { $group: { _id: null, count: { $sum: 1 }, max: { $max: '$number' }, min: { $min: '$number' } } }])
      .toArray();
    const count = stats?.count ?? 0;
    const max = stats?.max ?? 0;
    if (c.last !== max) problems.push(`${c.docType}: el contador está en ${c.last} y el último asiento es ${max}`);
    else if (count !== max) problems.push(`${c.docType}: hay ${count} asientos y el consecutivo llega a ${max}`);
  }
  return { name: 'La numeración de asientos es consecutiva, sin saltos ni repetidos', ok: problems.length === 0, detail: problems.length ? problems.join('; ') : `${counters.length} series revisadas.` };
}

async function stockMatchesKardex(db, tenantId) {
  const stock = await db.collection(COLLECTIONS.stock).find({ tenantId }).toArray();
  const problems = [];
  for (const row of stock) {
    if (row.quantity < 0 || row.value < 0) problems.push(`${row.itemId}: existencia negativa (${row.quantity} / ${row.value})`);
    const last = await db.collection(COLLECTIONS.movements).find({ tenantId, itemId: row.itemId, warehouseId: row.warehouseId }, { sort: { _id: -1 }, limit: 1 }).toArray();
    const expected = last[0] ?? { balanceQuantity: 0, balanceValue: 0 };
    if (expected.balanceQuantity !== row.quantity || expected.balanceValue !== row.value) {
      problems.push(`${row.itemId}: existencia ${row.quantity} / ${row.value} y el kardex termina en ${expected.balanceQuantity} / ${expected.balanceValue}`);
    }
  }
  const sums = await db
    .collection(COLLECTIONS.movements)
    .aggregate([{ $match: { tenantId } }, { $group: { _id: { i: '$itemId', w: '$warehouseId' }, quantity: { $sum: '$quantity' }, value: { $sum: '$value' } } }])
    .toArray();
  const byKey = new Map(stock.map((s) => [`${s.itemId}|${s.warehouseId}`, s]));
  for (const m of sums) {
    const s = byKey.get(`${m._id.i}|${m._id.w}`);
    if (!s && (m.quantity !== 0 || m.value !== 0)) problems.push(`${m._id.i}: hay movimientos y no hay existencia`);
    else if (s && (Number(m.quantity) !== s.quantity || Number(m.value) !== s.value)) problems.push(`${m._id.i}: los movimientos suman ${m.quantity} / ${m.value} y la existencia dice ${s.quantity} / ${s.value}`);
  }
  return { name: 'Las existencias coinciden con el kardex y ninguna es negativa', ok: problems.length === 0, detail: problems.length ? `${problems.length} diferencias: ${sample(problems).join('; ')}` : `${stock.length} existencias revisadas.` };
}

async function inventoryMatchesLedger(db, tenantId) {
  const accounts = await db
    .collection(COLLECTIONS.stock)
    .aggregate([
      { $match: { tenantId } },
      { $lookup: { from: COLLECTIONS.items, localField: 'itemId', foreignField: '_id', as: 'item' } },
      { $unwind: '$item' },
      { $group: { _id: '$item.inventoryAccount', value: { $sum: '$value' } } },
    ])
    .toArray();
  const problems = [];
  for (const a of accounts) {
    const rows = await db.collection(COLLECTIONS.balances).find({ tenantId, accountId: a._id }).toArray();
    const ledger = rows.reduce((acc, r) => acc + r.debit - r.credit, 0);
    if (ledger !== Number(a.value)) problems.push(`cuenta ${a._id}: existencias por ${a.value} y libro por ${ledger}`);
  }
  return { name: 'El valor del inventario coincide con el saldo de su cuenta en el libro', ok: problems.length === 0, detail: problems.length ? problems.join('; ') : `${accounts.length} cuentas de inventario revisadas.` };
}

async function documentsHaveJournals(db, tenantId) {
  const refs = [
    ['facturas', COLLECTIONS.invoices, 'accounting.journalId', { 'accounting.status': 'posted' }],
    ['notas crédito', COLLECTIONS.creditNotes, 'accounting.journalId', { 'accounting.status': 'posted' }],
    ['recibos de caja', COLLECTIONS.receipts, 'journalId', {}],
    ['compras', COLLECTIONS.purchases, 'journalId', {}],
    ['notas de proveedor', COLLECTIONS.supplierNotes, 'journalId', {}],
    ['pagos', COLLECTIONS.payments, 'journalId', {}],
    ['ventas de mostrador', COLLECTIONS.posSales, 'journalId', {}],
    ['anticipos', COLLECTIONS.advances, 'journalId', {}],
    ['aplicaciones de anticipos', COLLECTIONS.advanceApplications, 'journalId', {}],
  ];
  const problems = [];
  let checked = 0;
  for (const [label, collection, field, filter] of refs) {
    const docs = await db.collection(collection).find({ tenantId, ...filter }, { projection: { [field]: 1 } }).toArray();
    const ids = docs.map((d) => field.split('.').reduce((o, k) => o?.[k], d)).filter(Boolean);
    checked += docs.length;
    const without = docs.length - ids.length;
    if (without) problems.push(`${without} ${label} sin asiento`);
    if (ids.length) {
      const found = await db.collection(COLLECTIONS.journals).countDocuments({ tenantId, _id: { $in: ids } });
      if (found !== new Set(ids.map(String)).size) problems.push(`${label}: ${new Set(ids.map(String)).size - found} apuntan a un asiento que no existe`);
    }
  }
  return { name: 'Todo documento contabilizado apunta a un asiento que existe', ok: problems.length === 0, detail: problems.length ? problems.join('; ') : `${checked} documentos revisados.` };
}

async function advancesMatchApplications(db, tenantId) {
  const advances = await db.collection(COLLECTIONS.advances).find({ tenantId }).toArray();
  const applied = await db
    .collection(COLLECTIONS.advanceApplications)
    .aggregate([{ $match: { tenantId, status: 'posted' } }, { $group: { _id: '$advanceId', total: { $sum: '$total' } } }])
    .toArray();
  const byAdvance = new Map(applied.map((a) => [String(a._id), Number(a.total)]));
  const problems = [];
  for (const a of advances) {
    const used = byAdvance.get(String(a._id)) ?? 0;
    const expectedBalance = a.status === 'void' ? 0 : a.amount - used;
    if (a.applied !== (a.status === 'void' ? 0 : used) || a.balance !== expectedBalance || a.balance < 0) {
      problems.push(`${a.fullNumber}: aplicado ${a.applied}, saldo ${a.balance} y las aplicaciones vigentes suman ${used} de ${a.amount}`);
    }
  }
  return { name: 'El saldo de cada anticipo coincide con sus aplicaciones vigentes', ok: problems.length === 0, detail: problems.length ? `${problems.length} anticipos: ${sample(problems, 3).join('; ')}` : `${advances.length} anticipos revisados.` };
}

async function openShiftsMatchSales(db, tenantId) {
  const shifts = await db.collection(COLLECTIONS.posShifts).find({ tenantId }).toArray();
  const problems = [];
  for (const s of shifts) {
    const sales = await db
      .collection(COLLECTIONS.posSales)
      .aggregate([
        { $match: { tenantId, shiftId: s._id, status: 'posted' } },
        { $unwind: '$payments' },
        { $group: { _id: '$payments.method', amount: { $sum: '$payments.amount' } } },
      ])
      .toArray();
    const by = Object.fromEntries(sales.map((r) => [r._id, Number(r.amount)]));
    const count = await db.collection(COLLECTIONS.posSales).countDocuments({ tenantId, shiftId: s._id, status: 'posted' });
    const expected = { cash: by.cash ?? 0, card: by.card ?? 0, transfer: by.transfer ?? 0 };
    if (s.salesCount !== count || s.cashTotal !== expected.cash || s.cardTotal !== expected.card || s.transferTotal !== expected.transfer) {
      problems.push(`turno ${s.registerCode} ${s._id}: totales ${s.salesCount}/${s.cashTotal}/${s.cardTotal}/${s.transferTotal} y ventas ${count}/${expected.cash}/${expected.card}/${expected.transfer}`);
    }
  }
  return { name: 'Los totales de cada turno de caja coinciden con sus ventas', ok: problems.length === 0, detail: problems.length ? `${problems.length} turnos: ${sample(problems, 3).join('; ')}` : `${shifts.length} turnos revisados.` };
}

async function closedYearsAreZero(db, tenantId) {
  const closes = await db.collection(COLLECTIONS.journals).find({ tenantId, docType: 'CA', 'source.kind': 'year_close' }).toArray();
  if (!closes.length) return { name: 'Los ejercicios cerrados tienen sus cuentas de resultados en cero', ok: true, detail: 'No hay ejercicios cerrados.' };
  const reversed = new Set((await db.collection(COLLECTIONS.journals).find({ tenantId, reversesJournalId: { $in: closes.map((c) => c._id) } }).toArray()).map((r) => String(r.reversesJournalId)));
  const accounts = await db.collection(COLLECTIONS.accounts).find({ tenantId, type: { $in: ['income', 'cost', 'expense'] } }).toArray();
  const codes = accounts.map((a) => a.code);
  const problems = [];
  for (const close of closes.filter((c) => !reversed.has(String(c._id)))) {
    const periods = Array.from({ length: 12 }, (_, i) => `${close.source.year}-${String(i + 1).padStart(2, '0')}`);
    const rows = await db.collection(COLLECTIONS.balances).find({ tenantId, currency: close.currency, accountId: { $in: codes }, period: { $in: periods } }).toArray();
    const net = new Map();
    for (const r of rows) net.set(r.accountId, (net.get(r.accountId) ?? 0) + r.debit - r.credit);
    const open = [...net].filter(([, v]) => v !== 0);
    if (open.length) problems.push(`${close.source.year} ${close.currency}: ${open.length} cuentas de resultados no quedaron en cero (${sample(open.map(([a, v]) => `${a}: ${v}`), 3).join(', ')})`);
  }
  return { name: 'Los ejercicios cerrados tienen sus cuentas de resultados en cero', ok: problems.length === 0, detail: problems.length ? problems.join('; ') : `${closes.length - reversed.size} ejercicios cerrados revisados.` };
}

async function dimensionsMatchJournals(db, tenantId) {
  const rows = async (field) =>
    db
      .collection(COLLECTIONS.journals)
      .aggregate([
        { $match: { tenantId } },
        { $unwind: '$lines' },
        { $match: { [`lines.${field}`]: { $exists: true, $ne: null } } },
        { $group: { _id: { k: `$lines.${field}`, a: '$lines.accountId', p: '$period', c: '$currency' }, debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' } } },
      ])
      .toArray();
  const key = (d, k, a, p, c) => `${d}|${c}|${p}|${a}|${String(k)}`;
  const fromJournals = new Map();
  for (const [dimension, field] of [['costCenter', 'costCenter'], ['party', 'partyId']]) {
    for (const r of await rows(field)) fromJournals.set(key(dimension, r._id.k, r._id.a, r._id.p, r._id.c), { debit: Number(r.debit), credit: Number(r.credit) });
  }
  const stored = new Map((await db.collection(COLLECTIONS.dimBalances).find({ tenantId }).toArray()).map((b) => [key(b.dimension, b.key, b.accountId, b.period, b.currency), { debit: b.debit, credit: b.credit }]));
  const problems = [];
  for (const [k, v] of fromJournals) {
    const s = stored.get(k);
    if (!s) problems.push(`${k}: hay asientos y no hay saldo`);
    else if (s.debit !== v.debit || s.credit !== v.credit) problems.push(`${k}: saldo ${s.debit}/${s.credit} y asientos ${v.debit}/${v.credit}`);
  }
  for (const [k, s] of stored) if (!fromJournals.has(k) && (s.debit !== 0 || s.credit !== 0)) problems.push(`${k}: hay saldo y no hay asientos`);
  return { name: 'Los saldos por centro de costo y por tercero coinciden con los asientos', ok: problems.length === 0, detail: problems.length ? `${problems.length} diferencias: ${sample(problems).join('; ')}` : `${fromJournals.size} saldos por dimensión revisados.` };
}

async function bankMatchesAreConsistent(db, tenantId) {
  const matches = await db.collection(COLLECTIONS.bankMatches).find({ tenantId, active: true }).toArray();
  if (!matches.length) return { name: 'Cada conciliación bancaria une importes iguales de la misma cuenta', ok: true, detail: 'No hay conciliaciones.' };
  const journals = new Map((await db.collection(COLLECTIONS.journals).find({ tenantId, _id: { $in: [...new Set(matches.map((m) => m.journalId))] } }, { projection: { lines: 1 } }).toArray()).map((j) => [String(j._id), j]));
  const bankIds = matches.filter((m) => m.bankLineId).map((m) => m.bankLineId);
  const bankLines = new Map((await db.collection(COLLECTIONS.bankLines).find({ tenantId, _id: { $in: bankIds } }, { projection: { amount: 1, accountId: 1, status: 1 } }).toArray()).map((l) => [String(l._id), l]));
  const problems = [];
  for (const m of matches) {
    const line = journals.get(String(m.journalId))?.lines?.[m.lineIndex];
    if (!line) problems.push(`${m.document}: la línea del libro no existe`);
    else if (line.accountId !== m.accountId || (line.debit ?? 0) - (line.credit ?? 0) !== m.amount) problems.push(`${m.document}: la línea del libro ya no coincide con la conciliación`);
    if (m.bankLineId) {
      const bank = bankLines.get(String(m.bankLineId));
      if (!bank || bank.status !== 'active') problems.push(`${m.document}: la línea del extracto no existe o fue quitada`);
      else if (bank.amount !== m.amount || bank.accountId !== m.accountId) problems.push(`${m.document}: la línea del extracto no coincide con la conciliación`);
    }
  }
  return { name: 'Cada conciliación bancaria une importes iguales de la misma cuenta', ok: problems.length === 0, detail: problems.length ? `${problems.length} conciliaciones: ${sample(problems, 3).join('; ')}` : `${matches.length} conciliaciones revisadas.` };
}

async function fixedAssetsAreConsistent(db, tenantId) {
  const assets = await db.collection(COLLECTIONS.fixedAssets).find({ tenantId }).toArray();
  const name = 'La depreciación de cada activo fijo coincide con su calendario y con sus corridas';
  if (!assets.length) return { name, ok: true, detail: 'No hay activos fijos.' };
  const runs = await db
    .collection(COLLECTIONS.depreciationRuns)
    .aggregate([{ $match: { tenantId } }, { $unwind: '$items' }, { $group: { _id: '$items.assetId', amount: { $sum: '$items.amount' } } }])
    .toArray();
  const posted = new Map(runs.map((r) => [String(r._id), Number(r.amount)]));
  const disposals = assets.filter((a) => a.status === 'disposed').map((a) => a.disposal?.journalId);
  const found = new Set((await db.collection(COLLECTIONS.journals).find({ tenantId, _id: { $in: disposals.filter(Boolean) } }, { projection: { _id: 1 } }).toArray()).map((j) => String(j._id)));
  const problems = [];
  for (const a of assets) {
    const expected = accumulatedAfter(a.cost - a.salvageValue, a.usefulLifeMonths, a.depreciatedMonths);
    if (a.depreciatedTotal !== expected) problems.push(`${a.code}: acumulada ${a.depreciatedTotal} y el calendario dice ${expected}`);
    else if ((posted.get(String(a._id)) ?? 0) !== a.depreciatedTotal) problems.push(`${a.code}: las corridas suman ${posted.get(String(a._id)) ?? 0} y la ficha ${a.depreciatedTotal}`);
    if (a.status === 'disposed' && !found.has(String(a.disposal?.journalId))) problems.push(`${a.code}: la baja no tiene asiento`);
  }
  return { name, ok: problems.length === 0, detail: problems.length ? `${problems.length} activos: ${sample(problems, 3).join('; ')}` : `${assets.length} activos revisados.` };
}

async function payrollMatchesJournals(db, tenantId) {
  const name = 'Cada nómina y prestación liquidada coincide con su asiento';
  const [runs, benefits, terminations] = await Promise.all([
    db.collection(COLLECTIONS.payrollRuns).find({ tenantId, status: 'posted' }).toArray(),
    db.collection(COLLECTIONS.payrollBenefits).find({ tenantId, status: 'posted' }).toArray(),
    db.collection(COLLECTIONS.payrollTerminations).find({ tenantId, status: 'posted' }).toArray(),
  ]);
  if (!runs.length && !benefits.length && !terminations.length) return { name, ok: true, detail: 'No hay nóminas.' };
  const ids = [...runs.flatMap((r) => [r.journalId, r.payment?.journalId, r.contributionsPayment?.journalId]), ...benefits.flatMap((b) => [b.journalId, b.payment?.journalId]), ...terminations.flatMap((t) => [t.journalId, t.payment?.journalId])].filter(Boolean);
  const journals = new Map((await db.collection(COLLECTIONS.journals).find({ tenantId, _id: { $in: ids } }, { projection: { totalDebit: 1 } }).toArray()).map((j) => [String(j._id), j]));
  const sum = (list, pick) => list.reduce((acc, item) => acc + pick(item), 0);
  const problems = [];
  for (const r of runs) {
    const label = `nómina ${r.period}`;
    const journal = journals.get(String(r.journalId));
    if (!journal) problems.push(`${label}: no tiene asiento`);
    else if (journal.totalDebit !== r.totals.gross + r.totals.employerTotal + r.totals.provisionsTotal) problems.push(`${label}: el asiento no coincide con los totales`);
    if (sum(r.items, (i) => i.net) !== r.totals.net || sum(r.items, (i) => i.gross) !== r.totals.gross) problems.push(`${label}: los empleados no suman los totales`);
    if (r.payment && (!journals.has(String(r.payment.journalId)) || r.payment.total !== r.totals.net)) problems.push(`${label}: el pago no coincide`);
    if (r.contributionsPayment && !journals.has(String(r.contributionsPayment.journalId))) problems.push(`${label}: el pago de aportes no tiene asiento`);
  }
  for (const b of benefits) {
    const label = `${b.kind} ${b.label}`;
    const journal = journals.get(String(b.journalId));
    const owed = sum(b.items, (i) => i.amount + (i.interest ?? 0));
    if (!journal) problems.push(`${label}: no tiene asiento`);
    else if (owed !== b.total) problems.push(`${label}: los empleados no suman el total`);
    if (b.payment && (!journals.has(String(b.payment.journalId)) || b.payment.total !== b.total)) problems.push(`${label}: el pago no coincide`);
  }
  for (const t of terminations) {
    const label = `liquidación de ${t.employee?.name}`;
    if (!journals.has(String(t.journalId))) problems.push(`${label}: no tiene asiento`);
    const gross = t.lines.prima.amount + t.lines.cesantias.amount + t.lines.interest.amount + t.lines.vacations.amount + t.lines.severance.amount;
    if (gross !== t.gross || t.gross - t.withholding !== t.net) problems.push(`${label}: los renglones no suman el total`);
    if (t.payment && (!journals.has(String(t.payment.journalId)) || t.payment.total !== t.net)) problems.push(`${label}: el pago no coincide`);
  }
  return { name, ok: problems.length === 0, detail: problems.length ? `${problems.length} diferencias: ${sample(problems, 3).join('; ')}` : `${runs.length} nóminas, ${benefits.length} prestaciones y ${terminations.length} liquidaciones de contrato revisadas.` };
}

/** Una conciliación bancaria cerrada fija el saldo del libro a su fecha: un asiento fechado en ese tramo y registrado después la deja desactualizada. */
async function closedReconciliationsMatchLedger(db, tenantId) {
  const name = 'Las conciliaciones bancarias cerradas siguen coincidiendo con el saldo del libro a su fecha';
  const closed = await db.collection(COLLECTIONS.bankReconciliations).find({ tenantId, status: 'closed' }).toArray();
  if (!closed.length) return { name, ok: true, detail: 'No hay conciliaciones cerradas.' };
  const problems = [];
  for (const rec of closed) {
    const end = new Date(Date.UTC(rec.asOf.getUTCFullYear(), rec.asOf.getUTCMonth(), rec.asOf.getUTCDate()) + 86_400_000);
    const [row] = await db
      .collection(COLLECTIONS.journals)
      .aggregate([
        { $match: { tenantId, currency: rec.currency, date: { $lt: end }, 'lines.accountId': rec.accountId } },
        { $unwind: '$lines' },
        { $match: { 'lines.accountId': rec.accountId } },
        { $group: { _id: null, debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' } } },
      ])
      .toArray();
    const current = row ? Number(row.debit) - Number(row.credit) : 0;
    if (current !== rec.bookBalance) {
      problems.push(`cuenta ${rec.accountId} al ${rec.asOf.toISOString().slice(0, 10)}: se cerró con ${rec.bookBalance} y el libro dice ${current} (hay asientos de ese tramo registrados después del cierre)`);
    }
  }
  return { name, ok: problems.length === 0, detail: problems.length ? `${problems.length} conciliaciones: ${sample(problems, 3).join('; ')}` : `${closed.length} conciliaciones cerradas revisadas.` };
}

const sumBy = async (db, collection, pipeline, key) => new Map((await db.collection(collection).aggregate(pipeline).toArray()).map((r) => [String(r._id), Number(r[key])]));

/** El saldo de cada factura es su total menos lo acreditado y lo cobrado, y lo cobrado y acreditado coincide con los recibos, anticipos y notas vigentes. */
async function invoicesMatchPayments(db, tenantId) {
  const name = 'El saldo de cada factura coincide con sus recibos, anticipos aplicados y notas crédito vigentes';
  const invoices = await db.collection(COLLECTIONS.invoices).find({ tenantId, status: 'issued' }, { projection: { fullNumber: 1, totals: 1, paidTotal: 1, creditedTotal: 1, balance: 1 } }).toArray();
  const [receipts, applications, notes] = await Promise.all([
    sumBy(db, COLLECTIONS.receipts, [{ $match: { tenantId, status: 'posted' } }, { $unwind: '$allocations' }, { $group: { _id: '$allocations.invoiceId', amount: { $sum: '$allocations.amount' } } }], 'amount'),
    sumBy(db, COLLECTIONS.advanceApplications, [{ $match: { tenantId, kind: 'customer', status: 'posted' } }, { $unwind: '$allocations' }, { $group: { _id: '$allocations.documentId', amount: { $sum: '$allocations.amount' } } }], 'amount'),
    sumBy(db, COLLECTIONS.creditNotes, [{ $match: { tenantId, status: { $in: ['issued', 'pending_provider'] } } }, { $group: { _id: '$invoiceId', amount: { $sum: '$totals.total' } } }], 'amount'),
  ]);
  const problems = [];
  for (const inv of invoices) {
    const id = String(inv._id);
    const paid = (receipts.get(id) ?? 0) + (applications.get(id) ?? 0);
    const credited = notes.get(id) ?? 0;
    if (inv.paidTotal !== paid) problems.push(`${inv.fullNumber}: cobrado ${inv.paidTotal} y los recibos y anticipos vigentes suman ${paid}`);
    else if (inv.creditedTotal !== credited) problems.push(`${inv.fullNumber}: acreditado ${inv.creditedTotal} y las notas crédito vigentes suman ${credited}`);
    else if (inv.balance !== inv.totals.total - credited - paid) problems.push(`${inv.fullNumber}: saldo ${inv.balance} y debería ser ${inv.totals.total - credited - paid}`);
    else if (inv.balance < 0) problems.push(`${inv.fullNumber}: saldo negativo (${inv.balance}): se acreditó o aplicó más de lo que valía`);
  }
  return { name, ok: problems.length === 0, detail: problems.length ? `${problems.length} facturas: ${sample(problems, 3).join('; ')}` : `${invoices.length} facturas revisadas.` };
}

/** Lo mismo para las compras: saldo = por pagar − pagos − anticipos aplicados − efecto de las notas de proveedor vigentes (puede quedar a favor). */
async function purchasesMatchPayments(db, tenantId) {
  const name = 'El saldo de cada compra coincide con sus pagos, anticipos aplicados y notas de proveedor vigentes';
  const purchases = await db.collection(COLLECTIONS.purchases).find({ tenantId, status: 'posted' }, { projection: { fullNumber: 1, payable: 1, paidTotal: 1, creditedTotal: 1, balance: 1 } }).toArray();
  const [payments, applications, notes, effects] = await Promise.all([
    sumBy(db, COLLECTIONS.payments, [{ $match: { tenantId, status: 'posted' } }, { $unwind: '$allocations' }, { $group: { _id: '$allocations.purchaseId', amount: { $sum: '$allocations.amount' } } }], 'amount'),
    sumBy(db, COLLECTIONS.advanceApplications, [{ $match: { tenantId, kind: 'supplier', status: 'posted' } }, { $unwind: '$allocations' }, { $group: { _id: '$allocations.documentId', amount: { $sum: '$allocations.amount' } } }], 'amount'),
    sumBy(db, COLLECTIONS.supplierNotes, [{ $match: { tenantId, status: 'posted' } }, { $group: { _id: '$purchaseId', amount: { $sum: '$totals.total' } } }], 'amount'),
    sumBy(db, COLLECTIONS.supplierNotes, [{ $match: { tenantId, status: 'posted' } }, { $group: { _id: '$purchaseId', amount: { $sum: '$effect' } } }], 'amount'),
  ]);
  const problems = [];
  for (const p of purchases) {
    const id = String(p._id);
    const paid = (payments.get(id) ?? 0) + (applications.get(id) ?? 0);
    const credited = notes.get(id) ?? 0;
    const expected = p.payable - paid - (effects.get(id) ?? 0);
    if (p.paidTotal !== paid) problems.push(`${p.fullNumber}: pagado ${p.paidTotal} y los pagos y anticipos vigentes suman ${paid}`);
    else if (p.creditedTotal !== credited) problems.push(`${p.fullNumber}: acreditado ${p.creditedTotal} y las notas vigentes suman ${credited}`);
    else if (p.balance !== expected) problems.push(`${p.fullNumber}: saldo ${p.balance} y debería ser ${expected}`);
  }
  return { name, ok: problems.length === 0, detail: problems.length ? `${problems.length} compras: ${sample(problems, 3).join('; ')}` : `${purchases.length} compras revisadas.` };
}

/** Cierres de IVA vigentes: cada uno con su asiento, su resultado cuadrado y sin traslapar con otro de la misma moneda. */
async function vatClosesAreConsistent(db, tenantId) {
  const name = 'Los cierres de IVA vigentes tienen su asiento, cuadran y no se traslapan';
  const closes = await db.collection(COLLECTIONS.taxCloses).find({ tenantId, status: 'posted' }, { sort: { from: 1 } }).toArray();
  if (!closes.length) return { name, ok: true, detail: 'No hay cierres de IVA.' };
  const found = new Set((await db.collection(COLLECTIONS.journals).find({ tenantId, _id: { $in: closes.map((c) => c.journalId) } }, { projection: { _id: 1 } }).toArray()).map((j) => String(j._id)));
  const day = (d) => d.toISOString().slice(0, 10);
  const problems = [];
  for (const [i, c] of closes.entries()) {
    if (!found.has(String(c.journalId))) problems.push(`${c.document}: no tiene asiento`);
    if (c.net !== c.generated - c.deductible) problems.push(`${c.document}: el resultado ${c.net} no es generado menos descontable`);
    for (const other of closes.slice(i + 1)) {
      if (other.currency === c.currency && other.from <= c.to && other.to >= c.from) problems.push(`${c.document} (${day(c.from)} a ${day(c.to)}) se traslapa con ${other.document} (${day(other.from)} a ${day(other.to)})`);
    }
  }
  return { name, ok: problems.length === 0, detail: problems.length ? `${problems.length} problemas: ${sample(problems, 3).join('; ')}` : `${closes.length} cierres revisados.` };
}

const CHECKS = [balancesMatchJournals, journalsBalanced, consecutives, stockMatchesKardex, inventoryMatchesLedger, documentsHaveJournals, openShiftsMatchSales, closedYearsAreZero, advancesMatchApplications, dimensionsMatchJournals, bankMatchesAreConsistent, fixedAssetsAreConsistent, payrollMatchesJournals,
  closedReconciliationsMatchLedger, invoicesMatchPayments, purchasesMatchPayments, vatClosesAreConsistent];

/** Revisa una empresa (o todas, si no se indica). Una comprobación que falla por un error propio cuenta como no superada. */
export async function verifyIntegrity(db, { tenantId } = {}) {
  const tenants = await db
    .collection(COLLECTIONS.tenants)
    .find(tenantId ? { _id: tenantId } : {}, { projection: { name: 1 } })
    .toArray();
  const report = [];
  for (const tenant of tenants) {
    const checks = [];
    for (const check of CHECKS) {
      try {
        checks.push(await check(db, tenant._id));
      } catch (error) {
        checks.push({ name: check.name, ok: false, detail: `la comprobación falló: ${error.message}` });
      }
    }
    report.push({ tenantId: tenant._id, name: tenant.name, ok: checks.every((c) => c.ok), checks });
  }
  return { ok: report.every((t) => t.ok), tenants: report };
}
