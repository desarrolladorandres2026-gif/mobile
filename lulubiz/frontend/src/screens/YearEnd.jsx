import { useState } from 'react';
import { Button, DataTable, Notice, PageHeader, SelectField, TextButton, TextField, errorMessage, useLoad, useSubmit } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { formatDay } from '../lib/format.js';
import { formatAmount } from '../lib/money.js';
import { resultLabel, validateYearClose, yearOptions } from '../lib/yearEnd.js';
import { useSession, useTenantApi } from '../lib/session.jsx';

const TYPE_LABELS = { income: 'Ingreso', cost: 'Costo', expense: 'Gasto' };
const today = () => new Date().toISOString().slice(0, 10);

export function YearEndScreen() {
  const base = useTenantApi();
  const { tenant, can } = useSession();
  const canClose = can('periods:manage');
  const canReopen = can('periods:reopen');
  const years = yearOptions(today());
  const [year, setYear] = useState(years[1]);
  const [currency, setCurrency] = useState(tenant.currency);
  const [profitAccount, setProfitAccount] = useState('');
  const [lossAccount, setLossAccount] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const [confirmReopen, setConfirmReopen] = useState(false);
  const [notice, setNotice] = useState(null);

  const preview = useLoad(() => api.get(`${base}/year-end/preview?year=${year}&currency=${currency.trim().toUpperCase()}`), [base, year, currency]);
  const closed = useLoad(() => api.get(`${base}/year-end`), [base]);
  const accounts = useLoad(() => (canClose ? api.get(`${base}/accounts?activeOnly=true`) : Promise.resolve(null)), [base, canClose]);
  const equity = (accounts.data?.items ?? []).filter((a) => a.postable && a.type === 'equity');
  const result = validateYearClose({ year, currency, profitAccount, lossAccount });
  const data = preview.data;
  const reload = () => {
    preview.reload();
    closed.reload();
  };

  const close = useSubmit(async () => {
    setShowErrors(true);
    if (!result.ok) return;
    const outcome = await api.post(`${base}/year-end/close`, result.body);
    const extra = outcome.pendingCurrencies.length
      ? ` Los períodos del año siguen abiertos hasta cerrar también el ejercicio en ${outcome.pendingCurrencies.join(', ')}.`
      : ' Los doce períodos del año quedaron cerrados.';
    setNotice({ kind: 'success', text: `Ejercicio ${year} cerrado: ${resultLabel(outcome.journal.source.result).toLowerCase()} de ${formatAmount(Math.abs(outcome.journal.source.result), currency)} ${currency}.${extra}` });
    reload();
  });
  const reopen = useSubmit(async () => {
    const outcome = await api.post(`${base}/year-end/reopen`, { year, currency: currency.trim().toUpperCase() });
    setConfirmReopen(false);
    setNotice({ kind: 'success', text: `Ejercicio ${year} reabierto: se reversó el asiento de cierre${outcome.periodsReopened.length ? ' y se reabrieron sus períodos' : ''}.` });
    reload();
  });

  const lineColumns = [
    { key: 'code', title: 'Cuenta', nowrap: true, render: (l) => l.code },
    { key: 'name', title: 'Nombre', render: (l) => l.name },
    { key: 'type', title: 'Tipo', render: (l) => TYPE_LABELS[l.type] },
    { key: 'net', title: `Saldo del año (${currency})`, align: 'right', render: (l) => formatAmount(l.type === 'income' ? 0 - l.net : l.net, currency) },
  ];
  const closedColumns = [
    { key: 'year', title: 'Ejercicio', render: (c) => c.year },
    { key: 'currency', title: 'Moneda', render: (c) => c.currency },
    { key: 'result', title: 'Resultado', align: 'right', render: (c) => `${resultLabel(c.result)} ${formatAmount(Math.abs(c.result), c.currency)}` },
    { key: 'number', title: 'Asiento', nowrap: true, render: (c) => `CA${c.number}` },
    { key: 'at', title: 'Cerrado', nowrap: true, render: (c) => formatDay(c.closedAt) },
  ];

  return (
    <>
      <PageHeader title="Cierre de ejercicio" />
      <p className="mb-4 text-sm text-tinta">
        Al terminar el año, los ingresos, costos y gastos se llevan a cero y su diferencia pasa al patrimonio como utilidad o pérdida del ejercicio. El año siguiente empieza de cero. Se cierra un año a la vez, en orden, y con él se cierran sus doce períodos.
      </p>
      {notice ? <Notice kind={notice.kind}>{notice.text}</Notice> : null}
      <div className="mb-4 grid gap-x-4 sm:grid-cols-4">
        <SelectField label="Ejercicio" value={year} onChange={(e) => { setYear(Number(e.target.value)); setNotice(null); setConfirmReopen(false); }} options={years.map((y) => ({ value: y, label: String(y) }))} />
        <TextField label="Moneda" value={currency} onChange={(e) => { setCurrency(e.target.value.toUpperCase()); setNotice(null); }} maxLength={3} error={showErrors ? result.errors.currency : undefined} />
      </div>

      {preview.error ? <Notice kind="error">{errorMessage(preview.error)}</Notice> : null}
      {preview.loading && !data ? <p className="text-sm text-tinta">Calculando el ejercicio…</p> : null}
      {data ? (
        <>
          {data.closed ? (
            <Notice kind="success" title={`El ejercicio ${data.year} está cerrado`}>
              Cerrado el {formatDay(data.closed.closedAt)}. Sus períodos no admiten asientos; para corregir algo hay que reabrir el ejercicio.
            </Notice>
          ) : null}
          {!data.closed && data.blockers.length ? (
            <Notice kind="info" title="Todavía no se puede cerrar">
              {data.blockers.map((b) => (
                <p key={b}>{b[0].toUpperCase() + b.slice(1)}.</p>
              ))}
            </Notice>
          ) : null}
          <DataTable caption={`Cuentas de resultados de ${data.year}`} columns={lineColumns} rows={data.lines} rowKey={(l) => l.code} empty="Este ejercicio no tiene movimiento de ingresos, costos ni gastos." />
          <dl className="mb-6 ml-auto mt-3 grid max-w-sm grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm text-tinta">
            <dt>Ingresos</dt>
            <dd className="text-right tabular-nums">{formatAmount(data.totals.income, currency)}</dd>
            <dt>Costos</dt>
            <dd className="text-right tabular-nums">{formatAmount(data.totals.cost, currency)}</dd>
            <dt>Gastos</dt>
            <dd className="text-right tabular-nums">{formatAmount(data.totals.expense, currency)}</dd>
            <dt className="font-semibold">{resultLabel(data.totals.result)} del ejercicio</dt>
            <dd className="text-right text-base font-semibold tabular-nums">{formatAmount(Math.abs(data.totals.result), currency)}</dd>
          </dl>

          {!data.closed && canClose ? (
            <form
              className="mb-8 max-w-3xl border-t border-borde pt-4"
              onSubmit={(e) => {
                e.preventDefault();
                close.run();
              }}
            >
              <h2 className="mb-2 text-lg font-semibold text-tinta">Cerrar el ejercicio {data.year}</h2>
              {close.error ? <Notice kind="error">{errorMessage(close.error)}</Notice> : null}
              <datalist id="cuentas-patrimonio">
                {equity.map((a) => (
                  <option key={a.code} value={a.code}>
                    {a.name}
                  </option>
                ))}
              </datalist>
              <div className="grid gap-x-4 sm:grid-cols-2">
                <TextField label="Cuenta de la utilidad del ejercicio" list="cuentas-patrimonio" value={profitAccount} onChange={(e) => setProfitAccount(e.target.value)} error={showErrors ? result.errors.profitAccount : undefined} hint="Una cuenta de patrimonio, por ejemplo 3605." />
                <TextField label="Cuenta de la pérdida del ejercicio (opcional)" list="cuentas-patrimonio" value={lossAccount} onChange={(e) => setLossAccount(e.target.value)} error={showErrors ? result.errors.lossAccount : undefined} hint="Si se deja vacía, usa la de la utilidad." />
              </div>
              <Button type="submit" variant="primary" busy={close.busy}>
                Cerrar el ejercicio {data.year}
              </Button>
            </form>
          ) : null}

          {data.closed && canReopen ? (
            <div className="mb-8 max-w-3xl border-t border-borde pt-4">
              <h2 className="mb-2 text-lg font-semibold text-tinta">Reabrir el ejercicio</h2>
              <p className="mb-3 text-sm text-tinta">Reversa el asiento de cierre y reabre los períodos que cerró. Solo se puede si no hay un ejercicio posterior cerrado.</p>
              {reopen.error ? <Notice kind="error">{errorMessage(reopen.error)}</Notice> : null}
              {confirmReopen ? (
                <span className="flex flex-wrap gap-3">
                  <TextButton danger onClick={() => reopen.run()}>Sí, reabrir el ejercicio {data.year}</TextButton>
                  <TextButton onClick={() => setConfirmReopen(false)}>Cancelar</TextButton>
                </span>
              ) : (
                <Button onClick={() => { setConfirmReopen(true); reopen.clearError(); }}>Reabrir el ejercicio {data.year}</Button>
              )}
            </div>
          ) : null}
        </>
      ) : null}

      <h2 className="mb-2 mt-6 text-lg font-semibold text-tinta">Ejercicios cerrados</h2>
      {closed.error ? <Notice kind="error">{errorMessage(closed.error)}</Notice> : null}
      {closed.data ? <DataTable caption="Ejercicios cerrados" columns={closedColumns} rows={closed.data.items} rowKey={(c) => `${c.year}-${c.currency}`} empty="Todavía no se ha cerrado ningún ejercicio." /> : null}
    </>
  );
}
