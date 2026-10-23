import { useMemo, useState } from 'react';
import { CostCenterSelect, useCostCenters } from '../components/CostCenterSelect.jsx';
import { Button, DataTable, Notice, PageHeader, SelectField, TextButton, TextField, errorMessage, useLoad, useSubmit } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { monthRange } from '../lib/books.js';
import { formatDay } from '../lib/format.js';
import { formatAmount } from '../lib/money.js';
import { MONTH_LABELS, SECTION_LABELS, blankBudgetLine, pctText, spreadYear, toForm, validateBudget, varianceTone, ytdRange } from '../lib/planning.js';
import { useSession, useTenantApi } from '../lib/session.jsx';

const today = () => new Date().toISOString().slice(0, 10);
const TONE = { good: 'text-verde', bad: 'text-rojo', neutral: 'text-tinta' };

// ------------------------------------------------------------ Flujo de efectivo

export function CashFlowScreen() {
  const base = useTenantApi();
  const { tenant } = useSession();
  const currency = tenant.currency;
  const [range, setRange] = useState(() => monthRange(today()));
  const [advanced, setAdvanced] = useState(false);
  const [prefixes, setPrefixes] = useState({ cash: '', investing: '', financing: '' });
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const money = (v) => formatAmount(v, currency);

  const run = useSubmit(async () => {
    setError(null);
    if (!range.from || !range.to || range.from > range.to) return setError('Elige las dos fechas; la inicial no puede ser posterior a la final.');
    const params = { from: range.from, to: range.to, currency, ...Object.fromEntries(Object.entries(prefixes).filter(([, v]) => v.trim())) };
    return setResult(await api.get(`${base}/reports/cash-flow?${new URLSearchParams(params)}`));
  });

  const columns = [
    { key: 'account', title: 'Concepto', render: (r) => (r.heading ? <strong>{r.title}</strong> : r.total ? <strong>{r.title}</strong> : `${r.code} · ${r.name ?? ''}`) },
    { key: 'amount', title: `Importe (${currency})`, align: 'right', render: (r) => (r.heading ? '' : r.total ? <strong>{money(r.amount)}</strong> : money(r.amount)) },
  ];
  const rows = result
    ? [
        ...Object.keys(SECTION_LABELS).flatMap((key) => [
          { key: `h-${key}`, heading: true, title: SECTION_LABELS[key] },
          ...result.sections[key].rows.map((r) => ({ key: `${key}-${r.code}`, ...r })),
          { key: `t-${key}`, total: true, title: `Efectivo neto de ${SECTION_LABELS[key].toLowerCase()}`, amount: result.sections[key].total },
        ]),
        { key: 'change', total: true, title: 'Aumento (disminución) neto del efectivo', amount: result.change },
        { key: 'opening', total: true, title: 'Efectivo al inicio', amount: result.opening },
        { key: 'closing', total: true, title: 'Efectivo al final', amount: result.closing },
      ]
    : [];

  return (
    <>
      <PageHeader title="Flujo de efectivo" />
      <p className="mb-4 text-sm text-tinta">De dónde vino y a dónde fue el dinero de caja y bancos en un rango. Cada movimiento de efectivo se explica por la cuenta del otro lado del asiento: ventas, compras y gastos son operación; equipos y propiedades, inversión; préstamos y patrimonio, financiación. Un traspaso entre cajas y bancos no aparece.</p>
      <div className="grid gap-x-4 sm:grid-cols-4">
        <TextField label="Desde" type="date" value={range.from} onChange={(e) => { setRange((r) => ({ ...r, from: e.target.value })); setResult(null); }} />
        <TextField label="Hasta" type="date" value={range.to} onChange={(e) => { setRange((r) => ({ ...r, to: e.target.value })); setResult(null); }} />
      </div>
      <p className="mb-3 text-sm">
        <TextButton onClick={() => setAdvanced(!advanced)}>{advanced ? 'Ocultar la clasificación de cuentas' : 'Cambiar la clasificación de cuentas'}</TextButton>
      </p>
      {advanced ? (
        <div className="grid gap-x-4 sm:grid-cols-3">
          <TextField label="Cuentas de efectivo (prefijos)" value={prefixes.cash} onChange={(e) => { setPrefixes((p) => ({ ...p, cash: e.target.value })); setResult(null); }} placeholder="11" hint="Separados por coma. Por omisión 11: caja y bancos." />
          <TextField label="Inversión (prefijos)" value={prefixes.investing} onChange={(e) => { setPrefixes((p) => ({ ...p, investing: e.target.value })); setResult(null); }} placeholder="12,15,16" hint="Por omisión 12, 15 y 16." />
          <TextField label="Financiación (prefijos)" value={prefixes.financing} onChange={(e) => { setPrefixes((p) => ({ ...p, financing: e.target.value })); setResult(null); }} placeholder="21" hint="Por omisión 21; el patrimonio siempre lo es." />
        </div>
      ) : null}
      {error ? <Notice kind="error">{error}</Notice> : null}
      {run.error ? <Notice kind="error">{errorMessage(run.error)}</Notice> : null}
      <Button variant="primary" busy={run.busy} onClick={() => run.run()}>Ver flujo de efectivo</Button>
      {result ? (
        <div className="mt-6">
          <p className="mb-2 text-sm text-tinta">
            Del {formatDay(result.from)} al {formatDay(result.to)}. Cuentas de efectivo: {result.accounts.length ? result.accounts.map((a) => a.code).join(', ') : 'ninguna con esos prefijos'}.
          </p>
          <DataTable caption="Estado de flujo de efectivo" columns={columns} rows={rows} rowKey={(r) => r.key} empty="No hay movimiento de efectivo." />
        </div>
      ) : null}
    </>
  );
}

// ------------------------------------------------------------------- Presupuesto

function BudgetEditor({ year, currency, canManage, resultAccounts, centers, onSaved }) {
  const base = useTenantApi();
  const saved = useLoad(() => api.get(`${base}/budgets/${year}`), [base, year]);
  const [lines, setLines] = useState(null);
  const [errors, setErrors] = useState([]);
  const [notice, setNotice] = useState(null);
  const codes = useMemo(() => new Set(resultAccounts.map((a) => a.code)), [resultAccounts]);
  const money = (v) => formatAmount(v, currency);
  const shown = lines ?? (saved.data ? [...toForm(saved.data.lines, (m) => formatAmount(m, currency)), blankBudgetLine()] : []);

  const edit = (updater) => setLines(updater(shown));
  const setMonth = (i, k, value) => edit((ls) => ls.map((l, n) => (n === i ? { ...l, months: l.months.map((m, j) => (j === k ? value : m)) } : l)));
  const setField = (i, field, value) => edit((ls) => ls.map((l, n) => (n === i ? { ...l, [field]: value } : l)));
  const save = useSubmit(async () => {
    setErrors([]);
    setNotice(null);
    const result = validateBudget(shown, currency, codes);
    if (!result.ok) return setErrors(result.errors);
    const response = await api.put(`${base}/budgets/${year}`, result.body);
    setLines(null);
    saved.reload();
    onSaved();
    return setNotice(`Presupuesto de ${year} guardado: ${response.lines.length} líneas.`);
  });
  const rowTotal = (l) => l.months.reduce((acc, m) => acc + (Number(m.replace(/\./g, '').replace(',', '.')) || 0), 0);
  const nameOf = (code) => resultAccounts.find((a) => a.code === code.trim())?.name;

  return (
    <>
      <datalist id="cuentas-presupuesto">
        {resultAccounts.map((a) => (
          <option key={a.code} value={a.code}>{a.name}</option>
        ))}
      </datalist>
      {notice ? <Notice kind="success">{notice}</Notice> : null}
      {errors.length ? (
        <Notice kind="error">
          {errors.map((m) => (
            <p key={m}>{m}</p>
          ))}
        </Notice>
      ) : null}
      {save.error ? <Notice kind="error">{errorMessage(save.error)}</Notice> : null}
      {saved.error ? <Notice kind="error">{errorMessage(saved.error)}</Notice> : null}
      <div className="relative overflow-x-auto">
        <table className="mb-2 w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-borde-fuerte text-left">
              <th scope="col" className="px-2 py-2 font-semibold">Cuenta</th>
              {centers.length ? <th scope="col" className="px-2 py-2 font-semibold">Centro</th> : null}
              {MONTH_LABELS.map((m) => (
                <th key={m} scope="col" className="px-1 py-2 text-right font-semibold">{m}</th>
              ))}
              <th scope="col" className="px-2 py-2 text-right font-semibold">Total del año</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((l, i) => (
              <tr key={i} className="border-b border-borde align-top">
                <td className="px-2 py-2">
                  <input
                    aria-label={`Cuenta de la línea ${i + 1}`}
                    list="cuentas-presupuesto"
                    value={l.accountId}
                    disabled={!canManage}
                    onChange={(e) => setField(i, 'accountId', e.target.value)}
                    className="w-28 rounded-sm border border-borde-fuerte bg-papel px-2 py-1.5 text-sm text-tinta focus:outline-2 focus:outline-azul"
                  />
                  <p className="mt-1 text-xs text-tinta-segundo">{nameOf(l.accountId) ?? ' '}</p>
                </td>
                {centers.length ? (
                  <td className="px-2 py-2">
                    <CostCenterSelect centers={centers} label={`Centro de costo de la línea ${i + 1}`} value={l.costCenter} onChange={(e) => setField(i, 'costCenter', e.target.value)} />
                  </td>
                ) : null}
                {l.months.map((m, k) => (
                  <td key={k} className="px-1 py-2">
                    <input
                      aria-label={`${MONTH_LABELS[k]} de la línea ${i + 1}`}
                      value={m}
                      disabled={!canManage}
                      inputMode="decimal"
                      onChange={(e) => setMonth(i, k, e.target.value)}
                      className="w-24 rounded-sm border border-borde-fuerte bg-papel px-1.5 py-1.5 text-right text-sm tabular-nums text-tinta focus:outline-2 focus:outline-azul"
                    />
                  </td>
                ))}
                <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-tinta">{money(Math.round(rowTotal(l) * 100))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {canManage ? (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <TextButton onClick={() => edit((ls) => [...ls, blankBudgetLine()])}>Agregar línea</TextButton>
          <Spread onSpread={(parts) => edit((ls) => spreadLast(ls, parts, currency))} currency={currency} />
        </div>
      ) : null}
      {canManage ? (
        <div className="mt-4">
          <Button variant="primary" busy={save.busy} onClick={() => save.run()}>Guardar presupuesto</Button>
          <p className="mt-1 text-sm text-tinta-segundo">Guardar reemplaza las líneas que aparecen. Para quitar una línea, déjala en ceros.</p>
        </div>
      ) : null}
    </>
  );
}

/** Pone el reparto mensual en la última línea que ya tiene cuenta. */
function spreadLast(lines, parts, currency) {
  const idx = lines.findLastIndex((x) => x.accountId.trim());
  return idx < 0 ? lines : lines.map((l, n) => (n === idx ? { ...l, months: parts.map((p) => formatAmount(p, currency)) } : l));
}

function Spread({ onSpread, currency }) {
  const [total, setTotal] = useState('');
  const [error, setError] = useState(null);
  return (
    <span className="flex flex-wrap items-center gap-2 text-sm text-tinta">
      <label htmlFor="repartir-anual">Repartir un total anual en la última línea con cuenta:</label>
      <input id="repartir-anual" value={total} onChange={(e) => { setTotal(e.target.value); setError(null); }} inputMode="decimal" className="w-32 rounded-sm border border-borde-fuerte bg-papel px-2 py-1 text-right text-sm tabular-nums text-tinta focus:outline-2 focus:outline-azul" />
      <TextButton
        onClick={() => {
          const parts = spreadYear(total, currency);
          if (parts === null) return setError('Total no válido.');
          return onSpread(parts);
        }}
      >
        Repartir en doce meses
      </TextButton>
      {error ? <span role="alert" className="font-semibold text-rojo">{error}</span> : null}
    </span>
  );
}

function Execution({ year, currency, centers, version }) {
  const base = useTenantApi();
  const [range, setRange] = useState(() => (String(year) === today().slice(0, 4) ? ytdRange(today()) : { from: `${year}-01`, to: `${year}-12` }));
  const [center, setCenter] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const money = (v) => formatAmount(v, currency);
  const run = useSubmit(async () => {
    setError(null);
    if (!/^\d{4}-\d{2}$/.test(range.from) || !/^\d{4}-\d{2}$/.test(range.to)) return setError('Escribe los meses como AAAA-MM.');
    if (range.from > range.to) return setError('El mes inicial no puede ser posterior al final.');
    if (range.from.slice(0, 4) !== range.to.slice(0, 4)) return setError('La ejecución se pide dentro de un mismo año.');
    return setResult(await api.get(`${base}/reports/budget-execution?${new URLSearchParams({ ...range, currency, ...(center ? { costCenter: center } : {}) })}`));
  });
  const columns = [
    { key: 'account', title: 'Cuenta', render: (r) => (r.total ? <strong>{r.title}</strong> : `${r.code} · ${r.name ?? ''}`) },
    { key: 'budget', title: 'Presupuesto', align: 'right', render: (r) => (r.total ? <strong>{money(r.budget)}</strong> : money(r.budget)) },
    { key: 'actual', title: 'Real', align: 'right', render: (r) => (r.total ? <strong>{money(r.actual)}</strong> : money(r.actual)) },
    { key: 'variance', title: 'Diferencia', align: 'right', render: (r) => <span className={TONE[varianceTone(r.type ?? 'income', r.variance)]}>{money(r.variance)}</span> },
    { key: 'pct', title: '%', align: 'right', render: (r) => (r.total ? '' : pctText(r.variancePct)) },
  ];
  const rows = result
    ? [
        ...result.rows,
        ...(result.rows.length
          ? [
              { code: 'TOTAL', total: true, title: 'Resultado (ingresos − costos − gastos)', type: 'income', budget: result.totals.budget.result, actual: result.totals.actual.result, variance: result.totals.actual.result - result.totals.budget.result },
            ]
          : []),
      ]
    : [];
  return (
    <>
      <h2 className="mb-2 mt-8 text-lg font-semibold text-tinta">Ejecución del presupuesto</h2>
      <p className="mb-3 text-sm text-tinta">Lo real del libro contra lo presupuestado, por cuenta. En ingresos, una diferencia positiva es buena; en costos y gastos, es un exceso.</p>
      <div className="grid gap-x-4 sm:grid-cols-4">
        <TextField key={`from-${version}`} label="Desde (AAAA-MM)" value={range.from} onChange={(e) => { setRange((r) => ({ ...r, from: e.target.value })); setResult(null); }} />
        <TextField label="Hasta (AAAA-MM)" value={range.to} onChange={(e) => { setRange((r) => ({ ...r, to: e.target.value })); setResult(null); }} />
        {centers.length ? <SelectField label="Centro de costo" value={center} onChange={(e) => { setCenter(e.target.value); setResult(null); }} options={[{ value: '', label: 'Toda la empresa' }, ...centers.map((c) => ({ value: c.code, label: `${c.code} · ${c.name}` }))]} /> : null}
      </div>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {run.error ? <Notice kind="error">{errorMessage(run.error)}</Notice> : null}
      <Button variant="primary" busy={run.busy} onClick={() => run.run()}>Ver ejecución</Button>
      {result ? (
        <div className="mt-4">
          <DataTable caption="Ejecución del presupuesto" columns={columns} rows={rows} rowKey={(r) => r.code} empty="No hay presupuesto ni movimiento en este rango." />
        </div>
      ) : null}
    </>
  );
}

export function BudgetScreen() {
  const base = useTenantApi();
  const { tenant, can } = useSession();
  const currency = tenant.currency;
  const centers = useCostCenters(base);
  const all = useLoad(() => api.get(`${base}/accounts?activeOnly=true`), [base]);
  const resultAccounts = useMemo(() => (all.data?.items ?? []).filter((a) => a.postable && ['income', 'cost', 'expense'].includes(a.type)), [all.data]);
  const [year, setYear] = useState(String(new Date().getUTCFullYear()));
  const [version, setVersion] = useState(0);
  const valid = /^\d{4}$/.test(year);

  return (
    <>
      <PageHeader title="Presupuesto" />
      <p className="mb-4 text-sm text-tinta">Cuánto esperas vender, costear y gastar cada mes, por cuenta y, si quieres, por centro de costo. Después compáralo con lo real en «Ejecución del presupuesto».</p>
      <div className="grid gap-x-4 sm:grid-cols-4">
        <TextField label="Año" value={year} onChange={(e) => setYear(e.target.value)} inputMode="numeric" maxLength={4} />
      </div>
      {valid ? <BudgetEditor key={`editor-${year}`} year={year} currency={currency} canManage={can('budgets:manage')} resultAccounts={resultAccounts} centers={centers} onSaved={() => setVersion((v) => v + 1)} /> : <Notice kind="error">Escribe el año con cuatro cifras.</Notice>}
      <Execution key={`execution-${year}`} year={year} currency={currency} centers={centers} version={version} />
    </>
  );
}
