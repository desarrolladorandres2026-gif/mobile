import { useState } from 'react';
import { ViewButton, Button, DataTable, ExportInfo, Notice, PageHeader, SelectField, TextButton, TextField, errorMessage, useLoad, useSubmit } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { formatDay } from '../lib/format.js';
import { monthLabel } from '../lib/home.js';
import { CURRENCY_EXPONENT, formatAmount } from '../lib/money.js';
import { useSession, useTenantApi } from '../lib/session.jsx';

const DEBIT_TYPES = new Set(['asset', 'expense', 'cost']);
const currentMonth = () => new Date().toISOString().slice(0, 7);

export function BalancesScreen() {
  const base = useTenantApi();
  const { tenant } = useSession();
  const accounts = useLoad(() => api.get(`${base}/accounts`), [base]);
  const [account, setAccount] = useState('');
  const [period, setPeriod] = useState(currentMonth());
  const [currency, setCurrency] = useState(tenant.currency);
  const [result, setResult] = useState(null);

  const known = accounts.data?.items.find((a) => a.code === account);
  const query = useSubmit(async () => {
    const data = await api.get(`${base}/balances?account=${account}&period=${period}&currency=${currency}`);
    setResult({ ...data, account, period, currency, nature: known?.nature, name: known?.name });
  });

  const nature = result?.nature ?? (known && DEBIT_TYPES.has(known.type) ? 'debit' : 'credit');
  const balance = result ? (nature === 'debit' ? result.debit - result.credit : result.credit - result.debit) : 0;

  return (
    <>
      <PageHeader title="Saldos" />
      <p className="mb-4 text-sm text-tinta">Consulta el saldo de una cuenta en un período. Los saldos se actualizan con cada asiento, en la misma operación.</p>
      <form
        className="mb-6"
        onSubmit={(e) => {
          e.preventDefault();
          query.run();
        }}
      >
        <datalist id="todas-las-cuentas">
          {(accounts.data?.items ?? []).filter((a) => a.postable).map((a) => (
            <option key={a.code} value={a.code}>{a.name}</option>
          ))}
        </datalist>
        <div className="grid gap-x-4 sm:grid-cols-3">
          <TextField label="Cuenta" list="todas-las-cuentas" value={account} onChange={(e) => setAccount(e.target.value.replace(/\D/g, ''))} hint={known ? known.name : 'Código de la cuenta.'} required />
          <TextField label="Período" type="month" value={period} onChange={(e) => setPeriod(e.target.value)} required />
          <SelectField label="Moneda" value={currency} onChange={(e) => setCurrency(e.target.value)} options={Object.keys(CURRENCY_EXPONENT).map((c) => ({ value: c, label: c }))} />
        </div>
        <ViewButton type="submit" busy={query.busy}>Consultar saldo</ViewButton>
      </form>
      {query.error ? <Notice kind="error">{errorMessage(query.error)}</Notice> : null}
      {result ? (
        <ExportInfo period={monthLabel(result.period)} currency={result.currency}>
        <DataTable
          caption="Saldo de la cuenta"
          columns={[
            { key: 'account', title: 'Cuenta', render: () => `${result.account}${result.name ? ` · ${result.name}` : ''}` },
            { key: 'period', title: 'Período', render: () => result.period },
            { key: 'debit', title: 'Débitos', align: 'right', render: () => formatAmount(result.debit, result.currency) },
            { key: 'credit', title: 'Créditos', align: 'right', render: () => formatAmount(result.credit, result.currency) },
            { key: 'balance', title: `Saldo ${nature === 'debit' ? 'deudor' : 'acreedor'}`, align: 'right', render: () => <strong>{formatAmount(balance, result.currency)}</strong> },
          ]}
          rows={[result]}
          rowKey={() => 'saldo'}
        />
        </ExportInfo>
      ) : null}
    </>
  );
}

export function PeriodsScreen() {
  const base = useTenantApi();
  const { can } = useSession();
  const list = useLoad(() => api.get(`${base}/periods`), [base]);
  const [confirming, setConfirming] = useState(null); // { period, action }
  const [other, setOther] = useState('');
  const [notice, setNotice] = useState(null);

  const act = useSubmit(async (period, action) => {
    await api.post(`${base}/periods/${period}/${action}`);
    setNotice(action === 'close' ? `El período ${period} quedó cerrado: ya no admite asientos ni reversiones.` : `El período ${period} se reabrió.`);
    setConfirming(null);
    setOther('');
    list.reload();
  });

  const rows = list.data?.items ?? [];
  const columns = [
    { key: 'period', title: 'Período', render: (p) => <span className="tabular-nums">{p.period}</span> },
    { key: 'status', title: 'Estado', render: (p) => (p.status === 'closed' ? 'Cerrado' : 'Abierto') },
    { key: 'when', title: 'Cierre', nowrap: true, render: (p) => (p.status === 'closed' && p.closedAt ? formatDay(p.closedAt) : '') },
    {
      key: 'actions',
      title: 'Acciones',
      render: (p) => {
        const action = p.status === 'closed' ? 'reopen' : 'close';
        const allowed = can(action === 'close' ? 'periods:manage' : 'periods:reopen');
        if (!allowed) return null;
        if (confirming?.period === p.period) {
          return (
            <span className="flex gap-3">
              <TextButton danger onClick={() => act.run(p.period, action)}>{action === 'close' ? 'Sí, cerrar' : 'Sí, reabrir'}</TextButton>
              <TextButton onClick={() => setConfirming(null)}>Cancelar</TextButton>
            </span>
          );
        }
        return <TextButton onClick={() => { setConfirming({ period: p.period }); act.clearError(); }}>{action === 'close' ? 'Cerrar' : 'Reabrir'}</TextButton>;
      },
    },
  ];

  return (
    <>
      <PageHeader title="Períodos contables" />
      <p className="mb-4 text-sm text-tinta">Un período cerrado rechaza asientos y reversiones con fecha en él. Reabrirlo lo permite de nuevo y queda en la auditoría.</p>
      {notice ? <Notice kind="success">{notice}</Notice> : null}
      {act.error ? <Notice kind="error">{errorMessage(act.error)}</Notice> : null}
      {list.error ? <Notice kind="error">{errorMessage(list.error)}</Notice> : null}
      {list.loading && !list.data ? <p className="text-sm text-tinta">Cargando períodos…</p> : null}
      {list.data ? <DataTable caption="Períodos" columns={columns} rows={rows} rowKey={(p) => p.period} empty="Todavía no hay períodos: aparecen con el primer asiento." /> : null}

      {can('periods:manage') ? (
        <form
          className="mt-8 border-t border-borde pt-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (other) act.run(other, 'close');
          }}
        >
          <h2 className="mb-3 text-lg font-semibold text-tinta">Cerrar otro período</h2>
          <div className="grid gap-x-4 sm:grid-cols-3">
            <TextField label="Período" type="month" value={other} onChange={(e) => setOther(e.target.value)} required />
          </div>
          <Button type="submit" variant="danger" busy={act.busy}>Cerrar período</Button>
        </form>
      ) : null}
    </>
  );
}
