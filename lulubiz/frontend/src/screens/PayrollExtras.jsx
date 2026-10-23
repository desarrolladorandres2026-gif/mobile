import { useState } from 'react';
import { Button, DataTable, Notice, PageHeader, SelectField, TextButton, TextField, errorMessage, useLoad, useSubmit } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { formatDay } from '../lib/format.js';
import { formatAmount } from '../lib/money.js';
import { BENEFIT_KINDS, PROVISION_LABELS, defaultBenefitLabel, validateBenefitLabel } from '../lib/payroll.js';
import { useSession, useTenantApi } from '../lib/session.jsx';

const today = () => new Date().toISOString().slice(0, 10);

// -------------------------------------------------------------------- Desprendible

/** El desprendible de pago de un empleado en una corrida, listo para imprimir. */
export function Payslip({ runId, employeeId, onClose }) {
  const base = useTenantApi();
  const slip = useLoad(() => api.get(`${base}/payroll/runs/${runId}/payslips/${employeeId}`), [base, runId, employeeId]);
  const data = slip.data;
  if (slip.error) return <Notice kind="error">{errorMessage(slip.error)}</Notice>;
  if (!data) return <p className="my-2 text-sm text-tinta">Cargando…</p>;
  const money = (v) => formatAmount(v, data.currency);
  const lines = (title, rows, total, totalLabel) => (
    <div className="mb-3">
      <h4 className="mb-1 font-semibold">{title}</h4>
      <ul>
        {rows.map((r) => (
          <li key={r.label} className="flex justify-between gap-6">
            <span>{r.label}</span>
            <span className="tabular-nums">{money(r.amount)}</span>
          </li>
        ))}
      </ul>
      <p className="flex justify-between gap-6 border-t border-borde pt-1 font-semibold">
        <span>{totalLabel}</span>
        <span className="tabular-nums">{money(total)}</span>
      </p>
    </div>
  );
  return (
    <section aria-label={`Desprendible de pago de ${data.employee.name}`} className="my-3 max-w-xl border border-borde-fuerte p-4 text-sm text-tinta">
      <h3 className="text-base font-semibold">{data.company}</h3>
      <p className="mb-3">
        Desprendible de pago · {data.period} · {data.document}
        {data.status === 'void' ? ' · ANULADA' : ''}
      </p>
      <p className="mb-3">
        {data.employee.name} — {data.employee.documentType} {data.employee.documentNumber}. Salario base {money(data.employee.baseSalary)}. Días trabajados: {data.days}.
      </p>
      {lines('Devengado', data.earnings, data.gross, 'Total devengado')}
      {lines('Deducciones', data.deductions, data.totalDeductions, 'Total deducciones')}
      <p className="flex justify-between gap-6 border-t border-borde-fuerte pt-2 text-base font-semibold">
        <span>Neto a pagar</span>
        <span className="tabular-nums">{money(data.net)}</span>
      </p>
      <p className="mt-2 text-tinta-segundo">{data.paid ? `Pagado el ${formatDay(data.paid)}.` : 'Pendiente de pago.'}</p>
      <div className="mt-3 flex gap-3">
        <Button onClick={() => window.print()}>Imprimir</Button>
        <Button onClick={onClose}>Cerrar</Button>
      </div>
    </section>
  );
}

// -------------------------------------------------------------------- Prestaciones

function BenefitPay({ benefit, onDone, onCancel }) {
  const base = useTenantApi();
  const [date, setDate] = useState(today());
  const [account, setAccount] = useState('');
  const [error, setError] = useState(null);
  const all = useLoad(() => api.get(`${base}/accounts?activeOnly=true`), [base]);
  const banks = (all.data?.items ?? []).filter((a) => a.postable && a.type === 'asset');
  const submit = useSubmit(async () => {
    setError(null);
    if (!/^\d{1,12}$/.test(account.trim())) return setError('Indica la cuenta de caja o bancos de donde sale el dinero.');
    return onDone(await api.post(`${base}/payroll/benefits/${benefit._id}/pay`, { date, account: account.trim() }));
  });
  return (
    <form
      className="my-2 max-w-3xl border-t border-borde pt-2"
      onSubmit={(e) => {
        e.preventDefault();
        submit.run();
      }}
    >
      {error ? <Notice kind="error">{error}</Notice> : null}
      {submit.error ? <Notice kind="error">{errorMessage(submit.error)}</Notice> : null}
      <datalist id="cuentas-pago-prestacion">
        {banks.map((a) => (
          <option key={a.code} value={a.code}>{a.name}</option>
        ))}
      </datalist>
      <div className="grid gap-x-4 sm:grid-cols-3">
        <TextField label="Fecha del pago" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <TextField label="Cuenta de caja o bancos" list="cuentas-pago-prestacion" value={account} onChange={(e) => setAccount(e.target.value)} hint={banks.find((a) => a.code === account.trim())?.name} />
      </div>
      <Button type="submit" variant="primary" busy={submit.busy}>Registrar el pago</Button>
      <Button className="ml-2" onClick={onCancel}>Cancelar</Button>
    </form>
  );
}

export function BenefitsScreen() {
  const base = useTenantApi();
  const { tenant, can } = useSession();
  const currency = tenant.currency;
  const manage = can('payroll:manage');
  const money = (v) => formatAmount(v, currency);
  const [kind, setKind] = useState('prima');
  const [label, setLabel] = useState(defaultBenefitLabel('prima', today()));
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [paying, setPaying] = useState(null);
  const [open, setOpen] = useState(null);
  const list = useLoad(() => api.get(`${base}/payroll/benefits`), [base]);

  const calculate = useSubmit(async () => {
    const problem = validateBenefitLabel(kind, label);
    if (problem) return setError(problem);
    setError(null);
    return setPreview(await api.post(`${base}/payroll/benefits/preview`, { kind, label: label.trim() }));
  });
  const settle = useSubmit(async () => {
    const result = await api.post(`${base}/payroll/benefits`, { kind, label: label.trim() });
    setPreview(null);
    setNotice(`Liquidación ${result.benefit.document} registrada: ${money(result.benefit.total)} por pagar.`);
    list.reload();
  });

  const itemColumns = [
    { key: 'name', title: 'Empleado', render: (i) => i.name },
    { key: 'months', title: 'Meses', align: 'right', render: (i) => i.months },
    { key: 'base', title: 'Base', align: 'right', render: (i) => money(i.base) },
    { key: 'amount', title: kind === 'prima' ? 'Prima' : 'Cesantías', align: 'right', render: (i) => money(i.amount) },
    { key: 'accrued', title: 'Provisionado', align: 'right', render: (i) => money(i.accrued) },
    ...(kind === 'cesantias' ? [{ key: 'interest', title: 'Intereses', align: 'right', render: (i) => money(i.interest) }] : []),
    { key: 'adj', title: 'Diferencia al gasto', align: 'right', render: (i) => money(i.adjustment + (i.interestAdjustment ?? 0)) },
  ];
  const historyColumns = [
    { key: 'kind', title: 'Prestación', render: (b) => (b.kind === 'prima' ? 'Prima de servicios' : 'Cesantías e intereses') },
    { key: 'label', title: 'Período', nowrap: true, render: (b) => b.label },
    { key: 'doc', title: 'Asiento', nowrap: true, render: (b) => b.document },
    { key: 'emp', title: 'Empleados', align: 'right', render: (b) => b.totals.employees },
    { key: 'total', title: `Por pagar (${currency})`, align: 'right', render: (b) => money(b.total) },
    { key: 'status', title: 'Estado', render: (b) => (b.payment ? `Pagada el ${formatDay(b.payment.date)}` : 'Pendiente de pago') },
    { key: 'actions', title: 'Acciones', render: (b) => (manage && !b.payment ? <TextButton onClick={() => setPaying(paying === b._id ? null : b._id)}>Pagar</TextButton> : <TextButton onClick={() => setOpen(open === b._id ? null : b._id)}>{open === b._id ? 'Ocultar' : 'Ver empleados'}</TextButton>) },
  ];

  return (
    <>
      <PageHeader title="Prestaciones sociales" />
      <p className="mb-4 text-sm text-tinta">La prima (junio y diciembre) y las cesantías con sus intereses (una vez al año). Se calculan con las nóminas del período y se comparan con lo que la nómina ya provisionó mes a mes; la diferencia va al gasto.</p>
      {notice ? <Notice kind="success">{notice}</Notice> : null}
      {manage ? (
        <section className="mb-8 border-b border-borde pb-6">
          <div className="grid gap-x-4 sm:grid-cols-4">
            <SelectField label="Prestación" value={kind} onChange={(e) => { setKind(e.target.value); setLabel(defaultBenefitLabel(e.target.value, today())); setPreview(null); }} options={BENEFIT_KINDS} />
            <TextField label={kind === 'prima' ? 'Semestre (AAAA-1 o AAAA-2)' : 'Año (AAAA)'} value={label} onChange={(e) => { setLabel(e.target.value); setPreview(null); }} maxLength={6} />
          </div>
          {error ? <Notice kind="error">{error}</Notice> : null}
          {calculate.error ? <Notice kind="error">{errorMessage(calculate.error)}</Notice> : null}
          {settle.error ? <Notice kind="error">{errorMessage(settle.error)}</Notice> : null}
          <Button variant="primary" busy={calculate.busy} onClick={() => calculate.run()}>Calcular</Button>
          {preview ? (
            <div className="mt-6">
              {preview.monthsCovered < preview.monthsInWindow ? (
                <Notice kind="info">
                  Hay nóminas liquidadas de {preview.monthsCovered} de los {preview.monthsInWindow} meses del período. La liquidación solo cubre esos meses: si faltan, liquida primero las nóminas.
                </Notice>
              ) : null}
              <DataTable caption="Vista previa de la liquidación" columns={itemColumns} rows={preview.items} rowKey={(i) => String(i.employeeId)} empty="No hay nóminas liquidadas en ese período." />
              {preview.items.length ? (
                <>
                  <p className="my-3 text-sm font-semibold text-tinta">
                    Total por pagar: <span className="tabular-nums">{money(preview.totals.amount + (preview.totals.interest ?? 0))}</span> a {preview.totals.employees} {preview.totals.employees === 1 ? 'empleado' : 'empleados'}.
                  </p>
                  <Button variant="primary" busy={settle.busy} onClick={() => settle.run()}>Liquidar y contabilizar</Button>
                </>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}
      <h2 className="mb-2 text-lg font-semibold text-tinta">Liquidaciones hechas</h2>
      {list.error ? <Notice kind="error">{errorMessage(list.error)}</Notice> : null}
      {list.data ? (
        <DataTable
          caption="Liquidaciones de prestaciones"
          columns={historyColumns}
          rows={list.data.items}
          rowKey={(b) => b._id}
          empty="Todavía no se ha liquidado ninguna prestación."
          expandedRow={(b) =>
            paying === b._id ? (
              <BenefitPay benefit={b} onCancel={() => setPaying(null)} onDone={() => { setPaying(null); setNotice(`Pago de ${b.document} registrado.`); list.reload(); }} />
            ) : open === b._id ? (
              <BenefitEmployees benefit={b} money={money} />
            ) : null
          }
        />
      ) : null}
    </>
  );
}

function BenefitEmployees({ benefit, money }) {
  const base = useTenantApi();
  const detail = useLoad(() => api.get(`${base}/payroll/benefits/${benefit._id}`), [base, benefit._id]);
  if (!detail.data) return <p className="my-2 text-sm text-tinta">Cargando…</p>;
  return (
    <DataTable
      caption={`Empleados de ${benefit.document}`}
      columns={[
        { key: 'name', title: 'Empleado', render: (i) => i.name },
        { key: 'amount', title: 'Valor', align: 'right', render: (i) => money(i.amount + (i.interest ?? 0)) },
      ]}
      rows={detail.data.items}
      rowKey={(i) => String(i.employeeId)}
    />
  );
}

// ---------------------------------------------------------------------- Reportes

export function PayrollReportsScreen() {
  const base = useTenantApi();
  const { tenant } = useSession();
  const currency = tenant.currency;
  const money = (v) => formatAmount(v, currency);
  const year = String(new Date().getUTCFullYear());
  const [range, setRange] = useState({ from: `${year}-01`, to: today().slice(0, 7) });
  const [contrib, setContrib] = useState(null);
  const [error, setError] = useState(null);
  const provisions = useLoad(() => api.get(`${base}/payroll/reports/provisions`), [base]);
  const run = useSubmit(async () => {
    if (!/^\d{4}-\d{2}$/.test(range.from) || !/^\d{4}-\d{2}$/.test(range.to) || range.from > range.to) return setError('Escribe los dos meses como AAAA-MM; el inicial no puede ser posterior al final.');
    setError(null);
    return setContrib(await api.get(`${base}/payroll/reports/contributions?${new URLSearchParams(range)}`));
  });

  const contribColumns = [
    { key: 'period', title: 'Mes', nowrap: true, render: (r) => r.period },
    { key: 'name', title: 'Empleado', render: (r) => r.name },
    { key: 'ibc', title: 'Base de cotización', align: 'right', render: (r) => money(r.ibc) },
    { key: 'health', title: 'Salud', align: 'right', render: (r) => money(r.employeeHealth + r.employerHealth) },
    { key: 'pension', title: 'Pensión y solidaridad', align: 'right', render: (r) => money(r.employeePension + r.solidarity + r.employerPension) },
    { key: 'arl', title: 'ARL', align: 'right', render: (r) => money(r.arl) },
    { key: 'caja', title: 'Caja', align: 'right', render: (r) => money(r.caja) },
    { key: 'sena', title: 'SENA e ICBF', align: 'right', render: (r) => money(r.sena + r.icbf) },
  ];
  const monthColumns = [
    { key: 'period', title: 'Mes', nowrap: true, render: (m) => m.period },
    { key: 'emp', title: 'Empleados', align: 'right', render: (m) => m.employees },
    { key: 'ibc', title: 'Base de cotización', align: 'right', render: (m) => money(m.ibc) },
    { key: 'health', title: 'Salud', align: 'right', render: (m) => money(m.health) },
    { key: 'pension', title: 'Pensión y solidaridad', align: 'right', render: (m) => money(m.pension) },
    { key: 'arl', title: 'ARL', align: 'right', render: (m) => money(m.arl) },
    { key: 'caja', title: 'Caja', align: 'right', render: (m) => money(m.caja) },
    { key: 'sena', title: 'SENA e ICBF', align: 'right', render: (m) => money(m.sena + m.icbf) },
  ];
  const provisionColumns = [
    { key: 'name', title: 'Provisión', render: (l) => `${PROVISION_LABELS[l.key]} · ${l.account}` },
    { key: 'prov', title: 'Provisionado', align: 'right', render: (l) => money(l.provisioned) },
    { key: 'settled', title: 'Ya liquidado', align: 'right', render: (l) => money(l.settled) },
    { key: 'out', title: 'Pendiente', align: 'right', render: (l) => money(l.outstanding) },
    { key: 'ledger', title: 'Saldo en el libro', align: 'right', render: (l) => money(l.ledger) },
    { key: 'diff', title: 'Diferencia', align: 'right', render: (l) => money(l.difference) },
  ];

  return (
    <>
      <PageHeader title="Reportes de nómina" />
      <h2 className="mb-2 text-lg font-semibold text-tinta">Aportes a la seguridad social y parafiscales</h2>
      <p className="mb-3 text-sm text-tinta">Por mes y por empleado, desde las nóminas liquidadas. Sirve de base para preparar la planilla integrada de aportes (PILA); este programa no la presenta.</p>
      <div className="grid gap-x-4 sm:grid-cols-4">
        <TextField label="Desde (AAAA-MM)" value={range.from} onChange={(e) => { setRange((r) => ({ ...r, from: e.target.value })); setContrib(null); }} />
        <TextField label="Hasta (AAAA-MM)" value={range.to} onChange={(e) => { setRange((r) => ({ ...r, to: e.target.value })); setContrib(null); }} />
      </div>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {run.error ? <Notice kind="error">{errorMessage(run.error)}</Notice> : null}
      <Button variant="primary" busy={run.busy} onClick={() => run.run()}>Ver aportes</Button>
      {contrib ? (
        <div className="mt-4">
          <DataTable caption="Aportes por mes" columns={monthColumns} rows={contrib.months} rowKey={(m) => m.period} empty="No hay nóminas liquidadas en este rango." />
          {contrib.rows.length ? (
            <>
              <h3 className="mb-1 mt-6 font-semibold text-tinta">Detalle por empleado</h3>
              <DataTable caption="Aportes por empleado" columns={contribColumns} rows={contrib.rows} rowKey={(r) => `${r.period}-${r.employeeId}`} />
            </>
          ) : null}
        </div>
      ) : null}

      <h2 className="mb-2 mt-10 text-lg font-semibold text-tinta">Provisiones de prestaciones</h2>
      <p className="mb-3 text-sm text-tinta">Lo que las nóminas han provisionado, lo ya liquidado y lo pendiente, contra el saldo de cada cuenta en el libro.</p>
      {provisions.error ? <Notice kind="error">{errorMessage(provisions.error)}</Notice> : null}
      {provisions.data ? (
        <>
          <p className={`mb-2 text-sm font-semibold ${provisions.data.ok ? 'text-verde' : 'text-rojo'}`}>{provisions.data.ok ? 'Las provisiones cuadran con el libro.' : 'Hay diferencias con el libro: revisa los asientos manuales sobre estas cuentas.'}</p>
          <DataTable caption="Provisiones de nómina" columns={provisionColumns} rows={provisions.data.lines} rowKey={(l) => l.key} />
        </>
      ) : null}
    </>
  );
}
