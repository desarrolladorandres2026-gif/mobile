import { useState } from 'react';
import { Button, DataTable, Notice, PageHeader, SelectField, TextField, errorMessage, useLoad, useSubmit } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { formatDay } from '../lib/format.js';
import { CURRENCY_EXPONENT, formatAmount } from '../lib/money.js';
import { balanceNotice, ledgerRows, withDepth } from '../lib/reports.js';
import { useSession, useTenantApi } from '../lib/session.jsx';

const currentMonth = () => new Date().toISOString().slice(0, 7);
const yearStart = () => `${new Date().getUTCFullYear()}-01`;
const INDENT = ['pl-0', 'pl-4', 'pl-8', 'pl-12', 'pl-16', 'pl-20'];

const REPORTS = [
  { value: 'trial-balance', label: 'Balance de prueba', needs: ['from', 'to'] },
  { value: 'income-statement', label: 'Estado de resultados', needs: ['from', 'to'] },
  { value: 'balance-sheet', label: 'Balance general', needs: ['to'] },
  { value: 'general-ledger', label: 'Libro auxiliar de una cuenta', needs: ['account', 'from', 'to'] },
];

const Name = ({ row }) => (
  <span className={`${INDENT[Math.min(row.depth ?? 0, INDENT.length - 1)]} ${row.postable === false ? 'font-semibold' : ''} inline-block`}>
    {row.code} · {row.name ?? 'cuenta sin nombre'}
  </span>
);

function TrialBalance({ report }) {
  const c = report.currency;
  const rows = withDepth(report.rows);
  const strong = (row, value) => <span className={row.postable === false ? 'font-semibold' : ''}>{formatAmount(value, c)}</span>;
  return (
    <DataTable
      caption="Balance de prueba"
      empty="No hay movimientos en este rango."
      rows={[...rows, ...(rows.length ? [{ code: 'TOTAL', total: true }] : [])]}
      rowKey={(r) => r.code}
      columns={[
        { key: 'account', title: 'Cuenta', render: (r) => (r.total ? <strong>Totales</strong> : <Name row={r} />) },
        { key: 'opening', title: 'Saldo inicial', align: 'right', render: (r) => (r.total ? '' : strong(r, r.opening)) },
        { key: 'debit', title: 'Débitos', align: 'right', render: (r) => (r.total ? <strong>{formatAmount(report.totals.debit, c)}</strong> : strong(r, r.debit)) },
        { key: 'credit', title: 'Créditos', align: 'right', render: (r) => (r.total ? <strong>{formatAmount(report.totals.credit, c)}</strong> : strong(r, r.credit)) },
        { key: 'closing', title: 'Saldo final', align: 'right', render: (r) => (r.total ? '' : strong(r, r.closing)) },
      ]}
    />
  );
}

function Section({ title, rows, currency, total, totalLabel }) {
  const list = [...withDepth(rows), { code: 'TOTAL', total: true }];
  return (
    <div className="mb-6">
      <h2 className="mb-1 text-lg font-semibold text-tinta">{title}</h2>
      <DataTable
        caption={title}
        empty="Sin cuentas con movimiento."
        rows={rows.length ? list : []}
        rowKey={(r) => r.code}
        columns={[
          { key: 'account', title: 'Cuenta', render: (r) => (r.total ? <strong>{totalLabel}</strong> : <Name row={r} />) },
          {
            key: 'amount',
            title: `Importe (${currency})`,
            align: 'right',
            render: (r) => (r.total ? <strong>{formatAmount(total, currency)}</strong> : <span className={r.postable === false ? 'font-semibold' : ''}>{formatAmount(r.amount, currency)}</span>),
          },
        ]}
      />
    </div>
  );
}

function IncomeStatement({ report }) {
  const c = report.currency;
  const t = report.totals;
  return (
    <>
      <Section title="Ingresos" rows={report.income} currency={c} total={t.income} totalLabel="Total ingresos" />
      <Section title="Costos" rows={report.cost} currency={c} total={t.cost} totalLabel="Total costos" />
      <p className="mb-6 text-sm font-semibold text-tinta">Utilidad bruta: {formatAmount(t.grossProfit, c)}</p>
      <Section title="Gastos" rows={report.expense} currency={c} total={t.expense} totalLabel="Total gastos" />
      <p className="text-base font-semibold text-tinta">Utilidad neta del período: {formatAmount(t.net, c)}</p>
    </>
  );
}

function BalanceSheet({ report }) {
  const c = report.currency;
  const t = report.totals;
  return (
    <>
      <Section title="Activos" rows={report.assets} currency={c} total={t.assets} totalLabel="Total activos" />
      <Section title="Pasivos" rows={report.liabilities} currency={c} total={t.liabilities} totalLabel="Total pasivos" />
      <Section title="Patrimonio" rows={report.equity} currency={c} total={t.equity} totalLabel="Total patrimonio" />
      <p className="mb-1 text-sm text-tinta">Resultado acumulado de ingresos, costos y gastos hasta {report.asOf}: <strong>{formatAmount(t.result, c)}</strong></p>
      <p className="mb-1 text-sm text-tinta">Pasivo + patrimonio + resultado: <strong>{formatAmount(t.liabilitiesAndEquity, c)}</strong></p>
      {report.memoNet !== 0 ? <p className="text-sm text-tinta">Saldo neto de cuentas de orden, fuera de la ecuación: {formatAmount(report.memoNet, c)}</p> : null}
    </>
  );
}

function GeneralLedger({ query, base, first }) {
  const [pages, setPages] = useState([first]);
  const last = pages[pages.length - 1];
  const more = useSubmit(async () => {
    const q = new URLSearchParams({ ...query, cursor: last.nextCursor });
    const page = await api.get(`${base}/reports/general-ledger?${q}`);
    setPages((p) => [...p, page]);
  });
  const c = first.currency;
  const rows = pages.flatMap((page, i) => ledgerRows(page, { first: i === 0, last: page === last })).map((r, i) => ({ ...r, id: i }));
  return (
    <>
      <p className="mb-2 text-sm text-tinta">
        {first.account.code} · {first.account.name} (naturaleza {first.account.nature === 'debit' ? 'deudora' : 'acreedora'})
      </p>
      <DataTable
        caption="Libro auxiliar"
        empty="Sin movimientos."
        rows={rows}
        rowKey={(r) => r.id}
        columns={[
          { key: 'date', title: 'Fecha', nowrap: true, render: (r) => (r.kind === 'entry' ? formatDay(r.date) : '') },
          {
            key: 'doc',
            title: 'Documento',
            nowrap: true,
            render: (r) => (r.kind === 'opening' ? <strong>Saldo inicial</strong> : r.kind === 'closing' ? <strong>Saldo final</strong> : `${r.docType}-${r.number}${r.reversesJournalId ? ' (reversión)' : ''}`),
          },
          { key: 'description', title: 'Descripción', render: (r) => (r.kind === 'entry' ? r.description ?? '' : '') },
          { key: 'debit', title: 'Débito', align: 'right', render: (r) => (r.kind === 'entry' ? formatAmount(r.debit, c) : '') },
          { key: 'credit', title: 'Crédito', align: 'right', render: (r) => (r.kind === 'entry' ? formatAmount(r.credit, c) : '') },
          { key: 'balance', title: 'Saldo', align: 'right', render: (r) => <span className={r.kind === 'entry' ? '' : 'font-semibold'}>{formatAmount(r.balance, c)}</span> },
        ]}
      />
      {more.error ? <Notice kind="error">{errorMessage(more.error)}</Notice> : null}
      {last.nextCursor ? (
        <div className="mt-4">
          <Button busy={more.busy} onClick={() => more.run()}>Cargar más movimientos</Button>
        </div>
      ) : null}
    </>
  );
}

export function FinancialReportsScreen() {
  const base = useTenantApi();
  const { tenant } = useSession();
  const accounts = useLoad(() => api.get(`${base}/accounts`), [base]);
  const [kind, setKind] = useState('trial-balance');
  const [from, setFrom] = useState(yearStart());
  const [to, setTo] = useState(currentMonth());
  const [account, setAccount] = useState('');
  const [currency, setCurrency] = useState(tenant.currency);
  const [shown, setShown] = useState(null);

  const spec = REPORTS.find((r) => r.value === kind);
  const known = accounts.data?.items.find((a) => a.code === account);

  const run = useSubmit(async () => {
    const query = { currency, ...(spec.needs.includes('from') ? { from } : {}), to, ...(spec.needs.includes('account') ? { account } : {}) };
    const data = await api.get(`${base}/reports/${kind}?${new URLSearchParams(query)}`);
    setShown({ kind, query, data, key: Date.now() });
  });

  return (
    <>
      <PageHeader title="Informes" />
      <p className="mb-4 text-sm text-tinta">Salen de los saldos que cada asiento actualiza en su misma operación: no recorren el libro. Un período es un mes.</p>
      <form
        className="mb-6"
        onSubmit={(e) => {
          e.preventDefault();
          run.run();
        }}
      >
        <datalist id="cuentas-informe">
          {(accounts.data?.items ?? []).filter((a) => a.postable).map((a) => (
            <option key={a.code} value={a.code}>{a.name}</option>
          ))}
        </datalist>
        <div className="grid gap-x-4 sm:grid-cols-2 lg:grid-cols-4">
          <SelectField label="Informe" value={kind} onChange={(e) => { setKind(e.target.value); setShown(null); }} options={REPORTS.map((r) => ({ value: r.value, label: r.label }))} />
          {spec.needs.includes('account') ? (
            <TextField label="Cuenta" list="cuentas-informe" value={account} onChange={(e) => setAccount(e.target.value.replace(/\D/g, ''))} hint={known ? known.name : 'Código de la cuenta.'} required />
          ) : null}
          {spec.needs.includes('from') ? <TextField label="Desde el período" type="month" value={from} onChange={(e) => setFrom(e.target.value)} required /> : null}
          <TextField label={spec.needs.includes('from') ? 'Hasta el período' : 'Al cierre del período'} type="month" value={to} onChange={(e) => setTo(e.target.value)} required />
          <SelectField label="Moneda" value={currency} onChange={(e) => setCurrency(e.target.value)} options={Object.keys(CURRENCY_EXPONENT).map((c) => ({ value: c, label: c }))} />
        </div>
        <Button type="submit" variant="primary" busy={run.busy}>Generar informe</Button>
      </form>
      {run.error ? <Notice kind="error">{errorMessage(run.error)}</Notice> : null}
      {shown ? (
        <>
          {shown.data.balanced !== undefined ? <Notice kind={balanceNotice(shown.data).kind}>{balanceNotice(shown.data).text}</Notice> : null}
          {shown.kind === 'trial-balance' ? <TrialBalance report={shown.data} /> : null}
          {shown.kind === 'income-statement' ? <IncomeStatement report={shown.data} /> : null}
          {shown.kind === 'balance-sheet' ? <BalanceSheet report={shown.data} /> : null}
          {shown.kind === 'general-ledger' ? <GeneralLedger key={shown.key} query={shown.query} base={base} first={shown.data} /> : null}
        </>
      ) : null}
    </>
  );
}
