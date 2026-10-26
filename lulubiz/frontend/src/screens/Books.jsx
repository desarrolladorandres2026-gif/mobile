import { useState } from 'react';
import { PartyPicker } from '../components/PartyPicker.jsx';
import { Button, DataTable, ExportInfo, Notice, PageHeader, SelectField, TextField, errorMessage, useSubmit } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { REPORTS, KIND_LABELS, buildQuery, monthRange, rateLabel } from '../lib/books.js';
import { formatDay, rangeText } from '../lib/format.js';
import { formatAmount } from '../lib/money.js';
import { useSession, useTenantApi } from '../lib/session.jsx';

const today = () => new Date().toISOString().slice(0, 10);
const partyText = (p) => `${p.name} — ${p.taxIdType === 'NIT' && p.checkDigit !== undefined ? `NIT ${p.taxId}-${p.checkDigit}` : `${p.taxIdType} ${p.taxId}`}`;

/** Libros: un documento por fila, con la base y el IVA de cada tarifa que hubo en el rango. */
function bookColumns(data, currency, purchases) {
  const money = (v) => formatAmount(v, currency);
  const rates = data.totals.rates;
  return [
    { key: 'date', title: 'Fecha', nowrap: true, render: (r) => formatDay(r.date) },
    { key: 'kind', title: 'Documento', nowrap: true, render: (r) => KIND_LABELS[r.kind] },
    { key: 'number', title: 'Número', nowrap: true, render: (r) => r.number },
    ...(purchases ? [{ key: 'doc', title: 'Del proveedor', nowrap: true, render: (r) => r.supplierDocNumber }] : []),
    { key: 'party', title: purchases ? 'Proveedor' : 'Cliente', render: (r) => partyText(r.party) },
    ...rates.flatMap((rate) => [
      { key: `base-${rate.vatBps}`, title: `Base ${rateLabel(rate.vatBps)}`, align: 'right', render: (r) => (r.rates[rate.vatBps] ? money(r.rates[rate.vatBps].base) : '') },
      { key: `tax-${rate.vatBps}`, title: `IVA ${rateLabel(rate.vatBps)}`, align: 'right', render: (r) => (r.rates[rate.vatBps] ? money(r.rates[rate.vatBps].tax) : '') },
    ]),
    { key: 'total', title: 'Total', align: 'right', render: (r) => money(r.total) },
    ...(purchases
      ? [
          { key: 'withheld', title: 'Retenciones', align: 'right', render: (r) => money(r.withheld) },
          { key: 'payable', title: 'A pagar', align: 'right', render: (r) => money(r.payable) },
        ]
      : []),
  ];
}

function BookResult({ data, currency, purchases }) {
  const money = (v) => formatAmount(v, currency);
  return (
    <>
      <DataTable caption={purchases ? 'Libro de compras' : 'Libro de ventas'} columns={bookColumns(data, currency, purchases)} rows={data.rows} rowKey={(r) => r.id} empty="No hay documentos en este rango." />
      {data.rows.length ? (
        <dl className="mb-6 ml-auto mt-3 grid max-w-md grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm text-tinta">
          <dt>Documentos</dt>
          <dd className="text-right tabular-nums">{data.totals.documents}</dd>
          {data.totals.rates.map((r) => (
            <div key={r.vatBps} className="contents">
              <dt>Base {rateLabel(r.vatBps)} · IVA</dt>
              <dd className="text-right tabular-nums">
                {money(r.base)} · {money(r.tax)}
              </dd>
            </div>
          ))}
          <dt>Subtotal</dt>
          <dd className="text-right tabular-nums">{money(data.totals.subtotal)}</dd>
          <dt>IVA</dt>
          <dd className="text-right tabular-nums">{money(data.totals.tax)}</dd>
          {purchases ? (
            <>
              <dt>Retenciones</dt>
              <dd className="text-right tabular-nums">{money(data.totals.withheld)}</dd>
            </>
          ) : null}
          <dt className="font-semibold">Total</dt>
          <dd className="text-right font-semibold tabular-nums">{money(data.totals.total)}</dd>
        </dl>
      ) : null}
    </>
  );
}

function StatementResult({ data, currency, supplier }) {
  const money = (v) => formatAmount(v, currency);
  // Para un cliente, lo que aumenta la deuda es el débito; para un proveedor, el crédito.
  const up = (r) => (supplier ? r.credit : r.debit);
  const down = (r) => (supplier ? r.debit : r.credit);
  const columns = [
    { key: 'date', title: 'Fecha', nowrap: true, render: (r) => formatDay(r.date) },
    { key: 'kind', title: 'Documento', nowrap: true, render: (r) => `${KIND_LABELS[r.kind]} ${r.number}` },
    { key: 'detail', title: 'Detalle', render: (r) => r.detail },
    { key: 'due', title: 'Vence', nowrap: true, render: (r) => (r.dueDate ? formatDay(r.dueDate) : '') },
    { key: 'up', title: supplier ? 'Se le debe más' : 'Debe más', align: 'right', render: (r) => (up(r) ? money(up(r)) : '') },
    { key: 'down', title: supplier ? 'Se le debe menos' : 'Debe menos', align: 'right', render: (r) => (down(r) ? money(down(r)) : '') },
    { key: 'balance', title: 'Saldo', align: 'right', render: (r) => money(r.balance) },
  ];
  return (
    <>
      <p className="mb-3 text-sm text-tinta">
        {partyText(data.party)}. Saldo al {formatDay(data.from)}: <span className="tabular-nums">{money(data.opening)}</span>.
      </p>
      <DataTable caption={`Estado de cuenta de ${data.party.name}`} columns={columns} rows={data.rows} rowKey={(r) => `${r.kind}-${r.number}`} empty="No hubo movimientos en este rango." />
      <p className="mb-6 mt-3 text-right text-sm font-semibold text-tinta">
        {supplier ? 'Se le debe' : 'Debe'} al {formatDay(data.to)}: <span className="tabular-nums">{money(data.closing)}</span> {currency}
      </p>
    </>
  );
}

function CostCenterResult({ data, currency }) {
  const money = (v) => formatAmount(v, currency);
  const sections = [...data.centers.map((c) => ({ key: c.code, title: `${c.code} · ${c.name ?? 'sin nombre'}`, ...c })), { key: 'none', title: 'Sin centro de costo', ...data.unassigned }];
  const columns = [
    { key: 'center', title: 'Centro de costo', render: (s) => s.title },
    { key: 'income', title: 'Ingresos', align: 'right', render: (s) => money(s.totals.income) },
    { key: 'cost', title: 'Costos', align: 'right', render: (s) => money(s.totals.cost) },
    { key: 'expense', title: 'Gastos', align: 'right', render: (s) => money(s.totals.expense) },
    { key: 'result', title: 'Resultado', align: 'right', render: (s) => money(s.totals.result) },
  ];
  return (
    <>
      <DataTable caption="Resultado por centro de costo" columns={columns} rows={sections} rowKey={(s) => s.key} empty="No hubo movimiento en este rango." />
      <p className="mb-6 mt-3 text-right text-sm font-semibold text-tinta">
        Resultado del rango (igual al estado de resultados): <span className="tabular-nums">{money(data.totals.result)}</span> {currency}
      </p>
    </>
  );
}

function PartyLedgerResult({ data, currency }) {
  const money = (v) => formatAmount(v, currency);
  const summary = [
    { key: 'account', title: 'Cuenta', render: (a) => `${a.code} · ${a.name ?? ''}` },
    { key: 'opening', title: 'Saldo inicial', align: 'right', render: (a) => money(a.opening) },
    { key: 'debit', title: 'Débitos', align: 'right', render: (a) => money(a.debit) },
    { key: 'credit', title: 'Créditos', align: 'right', render: (a) => money(a.credit) },
    { key: 'closing', title: 'Saldo final', align: 'right', render: (a) => money(a.closing) },
  ];
  const moves = [
    { key: 'date', title: 'Fecha', nowrap: true, render: (m) => formatDay(m.date) },
    { key: 'document', title: 'Asiento', nowrap: true, render: (m) => `${m.document}${m.reversal ? ' (reverso)' : ''}` },
    { key: 'account', title: 'Cuenta', nowrap: true, render: (m) => m.accountId },
    { key: 'description', title: 'Detalle', render: (m) => m.description },
    { key: 'debit', title: 'Débito', align: 'right', render: (m) => (m.debit ? money(m.debit) : '') },
    { key: 'credit', title: 'Crédito', align: 'right', render: (m) => (m.credit ? money(m.credit) : '') },
  ];
  return (
    <>
      <p className="mb-3 text-sm text-tinta">
        {partyText(data.party)}. Solo aparece lo registrado con este tercero en la línea del asiento: las facturas, compras, recibos, pagos y anticipos lo hacen solos; un asiento manual solo si lo eliges en la línea.
      </p>
      <DataTable caption={`Saldos de ${data.party.name} por cuenta`} columns={summary} rows={data.accounts} rowKey={(a) => a.code} empty="Este tercero no tiene movimientos en este rango ni saldo anterior." />
      <h2 className="mb-2 mt-6 text-lg font-semibold text-tinta">Movimientos</h2>
      <DataTable caption="Movimientos del tercero" columns={moves} rows={data.movements} rowKey={(m) => `${m.journalId}-${m.accountId}-${m.debit}-${m.credit}`} empty="No hubo movimientos en este rango." />
    </>
  );
}

function SummaryResult({ data, currency }) {
  const money = (v) => formatAmount(v, currency);
  const byCustomer = data.by === 'customer';
  const columns = [
    { key: 'key', title: byCustomer ? 'Cliente' : 'Mes', render: (r) => (byCustomer ? `${r.name} — ${r.taxId}` : r.key) },
    { key: 'invoices', title: 'Facturas', align: 'right', render: (r) => r.invoices },
    { key: 'notes', title: 'Notas crédito', align: 'right', render: (r) => r.notes },
    { key: 'subtotal', title: 'Subtotal', align: 'right', render: (r) => money(r.subtotal) },
    { key: 'tax', title: 'IVA', align: 'right', render: (r) => money(r.tax) },
    { key: 'total', title: 'Ventas netas', align: 'right', render: (r) => money(r.total) },
  ];
  return (
    <>
      <DataTable caption="Ventas netas" columns={columns} rows={data.rows} rowKey={(r) => r.key} empty="No hubo ventas en este rango." />
      {data.rows.length ? (
        <p className="mb-6 mt-3 text-right text-sm font-semibold text-tinta">
          Ventas netas: <span className="tabular-nums">{money(data.totals.total)}</span> {currency}
        </p>
      ) : null}
    </>
  );
}

export function BooksScreen() {
  const base = useTenantApi();
  const { tenant } = useSession();
  const [report, setReport] = useState('sales-book');
  const [range, setRange] = useState(() => monthRange(today()));
  const [currency, setCurrency] = useState(tenant.currency);
  const [partyId, setPartyId] = useState('');
  const [result, setResult] = useState(null);
  const [errors, setErrors] = useState([]);
  const kind = REPORTS.find((r) => r.value === report);

  const change = (setter) => (e) => {
    setter(e.target.value);
    setResult(null);
    setErrors([]);
  };

  const run = useSubmit(async () => {
    const built = buildQuery({ report, ...range, currency, partyId });
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }
    setErrors([]);
    setResult({ report, range, data: await api.get(`${base}/${built.path}?${built.query}`) });
  });

  return (
    <>
      <PageHeader title="Libros y estados de cuenta" />
      <p className="mb-4 text-sm text-tinta">
        Listados de lo emitido y registrado en un rango de fechas, para revisar con tu contador. Salen de los documentos, salvo el resultado por centro de costo y el auxiliar de un tercero, que salen del libro contable (por mes completo). El libro de ventas no incluye las ventas de mostrador, y los formatos no son los oficiales de la DIAN.
      </p>
      <div className="grid gap-x-4 sm:grid-cols-4">
        <SelectField label="Informe" value={report} onChange={(e) => { change(setReport)(e); setPartyId(''); }} options={REPORTS.map((r) => ({ value: r.value, label: r.label }))} />
        <TextField label="Desde" type="date" value={range.from} onChange={(e) => { setRange((r) => ({ ...r, from: e.target.value })); setResult(null); }} />
        <TextField label="Hasta" type="date" value={range.to} onChange={(e) => { setRange((r) => ({ ...r, to: e.target.value })); setResult(null); }} />
        <TextField label="Moneda" value={currency} onChange={(e) => { setCurrency(e.target.value.toUpperCase()); setResult(null); }} maxLength={3} />
      </div>
      {kind.needsParty ? <PartyPicker key={kind.value} base={base} role={kind.needsParty} value={partyId} onChange={(id) => { setPartyId(id); setResult(null); }} /> : null}
      {errors.length ? (
        <Notice kind="error">
          {errors.map((m) => (
            <p key={m}>{m}</p>
          ))}
        </Notice>
      ) : null}
      {run.error ? <Notice kind="error">{errorMessage(run.error)}</Notice> : null}
      <Button variant="primary" busy={run.busy} onClick={() => run.run()}>
        Ver informe
      </Button>

      {result ? (
        <ExportInfo
          period={rangeText(result.data.from ?? result.range.from, result.data.to ?? result.range.to)}
          filters={result.data.party ? [['Tercero', partyText(result.data.party)]] : undefined}
          currency={result.data.currency}
        >
        <div className="mt-6">
          {result.report === 'sales-book' ? <BookResult data={result.data} currency={result.data.currency} /> : null}
          {result.report === 'purchases-book' ? <BookResult data={result.data} currency={result.data.currency} purchases /> : null}
          {result.report === 'customer-statement' ? <StatementResult data={result.data} currency={result.data.currency} /> : null}
          {result.report === 'supplier-statement' ? <StatementResult data={result.data} currency={result.data.currency} supplier /> : null}
          {result.report === 'cost-center-result' ? <CostCenterResult data={result.data} currency={result.data.currency} /> : null}
          {result.report === 'party-ledger' ? <PartyLedgerResult data={result.data} currency={result.data.currency} /> : null}
          {result.report === 'sales-by-customer' || result.report === 'sales-by-month' ? <SummaryResult data={result.data} currency={result.data.currency} /> : null}
        </div>
        </ExportInfo>
      ) : null}
    </>
  );
}
