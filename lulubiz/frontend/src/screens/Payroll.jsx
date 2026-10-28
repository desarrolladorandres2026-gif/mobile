import { useMemo, useState } from 'react';
import { CostCenterSelect, useCostCenters } from '../components/CostCenterSelect.jsx';
import { LoadNotice, Button, DataTable, Notice, PageHeader, SelectField, TextButton, TextField, errorMessage, useLoad, useSubmit } from '../components/ui.jsx';
import { api, newIdempotencyKey } from '../lib/api.js';
import { formatDay } from '../lib/format.js';
import { formatAmount, parseAmount } from '../lib/money.js';
import { ACCOUNT_GROUPS, ARL_LEVELS, CONTRACTS, DOC_TYPES, SALARY_TYPES, blankEmployee, blankNovelty, obligationsOf, parseNovelties, previousMonth, validateEmployee, validateYearParams } from '../lib/payroll.js';
import { useSession, useTenantApi } from '../lib/session.jsx';
import { Payslip } from './PayrollExtras.jsx';

const today = () => new Date().toISOString().slice(0, 10);
const DRAFT = 'Es un cálculo base que debe validar tu contador antes de usarlo en producción: la retención en la fuente usa el procedimiento simplificado (sin dependientes ni deducciones adicionales) y se puede reemplazar por empleado.';

// ------------------------------------------------------------- Parámetros y cuentas

function YearParams({ config, onSaved }) {
  const base = useTenantApi();
  const { tenant } = useSession();
  const currency = tenant.currency;
  const [year, setYear] = useState(String(new Date().getUTCFullYear()));
  const saved = config.years?.[year];
  const [form, setForm] = useState(null);
  const shown = form ?? {
    smmlv: saved ? formatAmount(saved.smmlv, currency) : '',
    transportAid: saved ? formatAmount(saved.transportAid, currency) : '',
    uvt: saved ? formatAmount(saved.uvt, currency) : '',
    exonerated: saved?.exonerated !== false,
    withholding: saved?.withholding !== false,
  };
  const [errors, setErrors] = useState({});
  const [notice, setNotice] = useState(null);
  const set = (field) => (e) => setForm({ ...shown, [field]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const save = useSubmit(async () => {
    setNotice(null);
    if (!/^\d{4}$/.test(year)) return setErrors({ year: 'Escribe el año con cuatro cifras.' });
    const result = validateYearParams(shown, currency);
    if (!result.ok) return setErrors(result.errors);
    setErrors({});
    await api.put(`${base}/payroll/config/years/${year}`, result.body);
    setForm(null);
    onSaved();
    return setNotice(`Parámetros de ${year} guardados.`);
  });

  return (
    <section className="mb-8">
      <h2 className="mb-2 text-lg font-semibold text-tinta">Parámetros del año</h2>
      <p className="mb-3 text-sm text-tinta">Son los valores que fija el Gobierno cada año; no vienen en el programa. Las tarifas de ley (salud 4 %, pensión 4 %, caja 4 %, prima 8,33 %…) ya están cargadas. {DRAFT}</p>
      {notice ? <Notice kind="success">{notice}</Notice> : null}
      {save.error ? <Notice kind="error">{errorMessage(save.error)}</Notice> : null}
      <div className="grid gap-x-4 sm:grid-cols-4">
        <TextField label="Año" value={year} onChange={(e) => { setYear(e.target.value); setForm(null); }} maxLength={4} inputMode="numeric" error={errors.year} />
        <TextField label={`Salario mínimo mensual (${currency})`} value={shown.smmlv} onChange={set('smmlv')} inputMode="decimal" error={errors.smmlv} />
        <TextField label={`Auxilio de transporte (${currency})`} value={shown.transportAid} onChange={set('transportAid')} inputMode="decimal" error={errors.transportAid} />
        <TextField label={`Valor de la UVT (${currency})`} value={shown.uvt} onChange={set('uvt')} inputMode="decimal" error={errors.uvt} />
      </div>
      <label className="mb-2 flex items-center gap-2 text-sm text-tinta">
        <input type="checkbox" checked={shown.exonerated} onChange={set('exonerated')} className="size-4 accent-azul" />
        La empresa está exonerada de salud, SENA e ICBF para quienes ganan menos de 10 salarios mínimos
      </label>
      <label className="mb-4 flex items-center gap-2 text-sm text-tinta">
        <input type="checkbox" checked={shown.withholding} onChange={set('withholding')} className="size-4 accent-azul" />
        Calcular la retención en la fuente por salarios
      </label>
      <Button variant="primary" busy={save.busy} onClick={() => save.run()}>Guardar parámetros</Button>
    </section>
  );
}

function AccountsForm({ config, accounts, onSaved }) {
  const base = useTenantApi();
  const [form, setForm] = useState(null);
  const shown = form ?? Object.fromEntries(ACCOUNT_GROUPS.flatMap((g) => g.fields.map(([key, , suggested]) => [key, config.accounts?.[key] ?? suggested])));
  const [notice, setNotice] = useState(null);
  const save = useSubmit(async () => {
    setNotice(null);
    await api.put(`${base}/payroll/config/accounts`, { accounts: shown });
    setForm(null);
    onSaved();
    setNotice('Cuentas de nómina guardadas.');
  });
  const nameOf = (code) => accounts.find((a) => a.code === code.trim())?.name;
  const missing = Object.keys(config.requiredAccounts ?? {}).filter((k) => !config.accounts?.[k]).length;

  return (
    <section className="mb-8">
      <h2 className="mb-2 text-lg font-semibold text-tinta">Cuentas contables</h2>
      <p className="mb-3 text-sm text-tinta">Las cuentas donde se asienta la nómina. Se sugieren las del plan único colombiano; tienen que existir en tu plan de cuentas. {missing ? `Faltan por guardar ${missing}.` : 'Todas están guardadas.'}</p>
      {notice ? <Notice kind="success">{notice}</Notice> : null}
      {save.error ? <Notice kind="error">{errorMessage(save.error)}</Notice> : null}
      <datalist id="cuentas-nomina">
        {accounts.map((a) => (
          <option key={a.code} value={a.code}>{a.name}</option>
        ))}
      </datalist>
      {ACCOUNT_GROUPS.map((group) => (
        <div key={group.title} className="mb-3">
          <h3 className="mb-1 font-semibold text-tinta">{group.title}</h3>
          <div className="grid gap-x-4 sm:grid-cols-3">
            {group.fields.map(([key, label]) => (
              <TextField key={key} label={label} list="cuentas-nomina" value={shown[key]} onChange={(e) => setForm({ ...shown, [key]: e.target.value })} hint={nameOf(shown[key]) ?? 'No existe en tu plan de cuentas.'} />
            ))}
          </div>
        </div>
      ))}
      <Button variant="primary" busy={save.busy} onClick={() => save.run()}>Guardar cuentas</Button>
    </section>
  );
}

export function PayrollSettingsScreen() {
  const base = useTenantApi();
  const { can } = useSession();
  const config = useLoad(() => api.get(`${base}/payroll/config`), [base]);
  const all = useLoad(() => api.get(`${base}/accounts?activeOnly=true`), [base]);
  const accounts = useMemo(() => (all.data?.items ?? []).filter((a) => a.postable), [all.data]);
  return (
    <>
      <PageHeader title="Parámetros de nómina" />
      {config.error ? <Notice kind="error">{errorMessage(config.error)}</Notice> : null}
      {config.data && can('payroll:manage') ? (
        <>
          <YearParams config={config.data} onSaved={config.reload} />
          <AccountsForm config={config.data} accounts={accounts} onSaved={config.reload} />
        </>
      ) : null}
      {config.data && !can('payroll:manage') ? <p className="text-sm text-tinta">Solo quien administra la nómina cambia los parámetros.</p> : null}
    </>
  );
}

// ----------------------------------------------------------------------- Empleados

function EmployeeForm({ onCreated, onCancel }) {
  const base = useTenantApi();
  const { tenant } = useSession();
  const currency = tenant.currency;
  const centers = useCostCenters(base);
  const [form, setForm] = useState(blankEmployee());
  const [showErrors, setShowErrors] = useState(false);
  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const result = validateEmployee(form, currency);
  const err = (field) => (showErrors && !result.ok ? result.errors[field] : undefined);
  const submit = useSubmit(async () => {
    setShowErrors(true);
    if (!result.ok) return;
    onCreated(await api.post(`${base}/payroll/employees`, result.body));
  });
  return (
    <form
      className="mb-8 border-b border-borde pb-6"
      onSubmit={(e) => {
        e.preventDefault();
        submit.run();
      }}
    >
      <h2 className="mb-3 text-lg font-semibold text-tinta">Nuevo empleado</h2>
      {submit.error ? <Notice kind="error">{errorMessage(submit.error)}</Notice> : null}
      <div className="grid gap-x-4 sm:grid-cols-4">
        <SelectField label="Tipo de documento" value={form.documentType} onChange={set('documentType')} options={DOC_TYPES} />
        <TextField label="Número de documento" value={form.documentNumber} onChange={set('documentNumber')} maxLength={20} error={err('documentNumber')} />
        <TextField className="sm:col-span-2" label="Nombre completo" value={form.name} onChange={set('name')} maxLength={200} error={err('name')} />
      </div>
      <div className="grid gap-x-4 sm:grid-cols-4">
        <TextField label="Fecha de ingreso" type="date" value={form.hireDate} onChange={set('hireDate')} error={err('hireDate')} />
        <TextField label={`Salario mensual (${currency})`} value={form.baseSalary} onChange={set('baseSalary')} inputMode="decimal" error={err('baseSalary')} />
        <SelectField label="Tipo de salario" value={form.salaryType} onChange={set('salaryType')} options={SALARY_TYPES} />
        <SelectField label="Contrato" value={form.contractType} onChange={set('contractType')} options={CONTRACTS} />
      </div>
      <div className="grid gap-x-4 sm:grid-cols-4">
        <SelectField label="Riesgo de ARL" value={form.arlRiskLevel} onChange={set('arlRiskLevel')} options={ARL_LEVELS} />
        <TextField label="Cargo (opcional)" value={form.position} onChange={set('position')} maxLength={100} />
        <TextField label="Correo (opcional)" value={form.email} onChange={set('email')} maxLength={200} error={err('email')} />
        <LoadNotice load={centers} what="los centros de costo" />
        {centers.length ? (
          <div className="mb-4">
            <p className="mb-1 text-sm font-semibold text-tinta">Centro de costo</p>
            <CostCenterSelect centers={centers} label="Centro de costo del empleado" value={form.costCenter} onChange={set('costCenter')} />
          </div>
        ) : null}
      </div>
      <label className="mb-4 flex items-center gap-2 text-sm text-tinta">
        <input type="checkbox" checked={form.transportAid} onChange={set('transportAid')} className="size-4 accent-azul" />
        Recibe auxilio de transporte cuando su salario lo permite (hasta dos salarios mínimos)
      </label>
      <Button type="submit" variant="primary" busy={submit.busy}>Registrar empleado</Button>
      <Button className="ml-2" onClick={onCancel}>Cancelar</Button>
    </form>
  );
}

function SalaryEditor({ employee, currency, onDone, onCancel }) {
  const base = useTenantApi();
  const [salary, setSalary] = useState(formatAmount(employee.baseSalary, currency));
  const save = useSubmit(async () => {
    const value = parseAmount(salary, currency);
    if (!salary.trim() || value === null || value <= 0) throw new Error('Salario no válido.');
    onDone(await api.patch(`${base}/payroll/employees/${employee._id}`, { baseSalary: value }));
  });
  return (
    <span className="flex flex-wrap items-center gap-2">
      <input aria-label={`Nuevo salario de ${employee.name}`} value={salary} onChange={(e) => setSalary(e.target.value)} inputMode="decimal" className="w-36 rounded-sm border border-borde-fuerte bg-papel px-2 py-1 text-right text-sm tabular-nums text-tinta focus:outline-2 focus:outline-azul" />
      <Button variant="primary" busy={save.busy} onClick={() => save.run()}>Guardar</Button>
      <TextButton onClick={onCancel}>Cancelar</TextButton>
      {save.error ? <span role="alert" className="text-xs font-semibold text-rojo">{errorMessage(save.error)}</span> : null}
    </span>
  );
}

export function EmployeesScreen() {
  const base = useTenantApi();
  const { tenant, can } = useSession();
  const currency = tenant.currency;
  const manage = can('payroll:manage');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(null);
  const [notice, setNotice] = useState(null);
  const list = useLoad(() => api.get(`${base}/payroll/employees?limit=50`), [base]);
  const toggle = useSubmit(async (employee) => {
    await api.patch(`${base}/payroll/employees/${employee._id}`, { active: !employee.active });
    setNotice(`${employee.name} ${employee.active ? 'quedó inactivo: ya no entra en las nóminas nuevas' : 'quedó activo'}.`);
    list.reload();
  });
  const columns = [
    { key: 'name', title: 'Empleado', render: (e) => e.name },
    { key: 'doc', title: 'Documento', nowrap: true, render: (e) => `${e.documentType} ${e.documentNumber}` },
    { key: 'hire', title: 'Ingreso', nowrap: true, render: (e) => formatDay(e.hireDate) },
    { key: 'contract', title: 'Contrato', render: (e) => `${CONTRACTS.find((c) => c.value === e.contractType)?.label}${e.salaryType === 'integral' ? ' · integral' : ''}` },
    {
      key: 'salary',
      title: `Salario (${currency})`,
      align: 'right',
      render: (e) =>
        editing === e._id ? (
          <SalaryEditor employee={e} currency={currency} onCancel={() => setEditing(null)} onDone={() => { setEditing(null); setNotice(`Salario de ${e.name} actualizado. Rige para las nóminas que liquides desde ahora.`); list.reload(); }} />
        ) : (
          formatAmount(e.baseSalary, currency)
        ),
    },
    { key: 'status', title: 'Estado', render: (e) => (e.active ? 'Activo' : 'Inactivo') },
    {
      key: 'actions',
      title: 'Acciones',
      render: (e) =>
        manage ? (
          <span className="flex flex-wrap gap-3">
            <TextButton onClick={() => setEditing(e._id)}>Cambiar salario</TextButton>
            <TextButton danger={e.active} onClick={() => toggle.run(e)}>{e.active ? 'Desactivar' : 'Activar'}</TextButton>
          </span>
        ) : null,
    },
  ];
  return (
    <>
      <PageHeader title="Empleados">{manage && !creating ? <Button variant="primary" onClick={() => { setCreating(true); setNotice(null); }}>Nuevo empleado</Button> : null}</PageHeader>
      <p className="mb-4 text-sm text-tinta">Las personas a las que les liquidas nómina. Los datos de los empleados y sus salarios solo los ve quien administra la contabilidad.</p>
      {notice ? <Notice kind="success">{notice}</Notice> : null}
      {toggle.error ? <Notice kind="error">{errorMessage(toggle.error)}</Notice> : null}
      {creating ? (
        <EmployeeForm
          onCancel={() => setCreating(false)}
          onCreated={(e) => {
            setCreating(false);
            setNotice(`Empleado ${e.name} registrado.`);
            list.reload();
          }}
        />
      ) : null}
      {list.error ? <Notice kind="error">{errorMessage(list.error)}</Notice> : null}
      {list.data ? <DataTable caption="Empleados" columns={columns} rows={list.data.items} rowKey={(e) => e._id} empty="Todavía no hay empleados." /> : null}
    </>
  );
}

// ------------------------------------------------------------------------ Nómina

function PayForm({ run, kind, onDone, onCancel }) {
  const base = useTenantApi();
  const [date, setDate] = useState(today());
  const [account, setAccount] = useState('');
  const all = useLoad(() => api.get(`${base}/accounts?activeOnly=true`), [base]);
  const banks = (all.data?.items ?? []).filter((a) => a.postable && a.type === 'asset');
  const [error, setError] = useState(null);
  const submit = useSubmit(async () => {
    setError(null);
    if (!/^\d{1,12}$/.test(account.trim())) return setError('Indica la cuenta de caja o bancos de donde sale el dinero.');
    return onDone(await api.post(`${base}/payroll/runs/${run._id}/${kind === 'net' ? 'pay' : 'pay-contributions'}`, { date, account: account.trim() }));
  });
  return (
    <form
      className="my-2 max-w-3xl border-t border-borde pt-2"
      onSubmit={(e) => {
        e.preventDefault();
        submit.run();
      }}
    >
      <h3 className="mb-2 font-semibold text-tinta">{kind === 'net' ? 'Pagar la nómina' : 'Pagar los aportes'} de {run.period}</h3>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {submit.error ? <Notice kind="error">{errorMessage(submit.error)}</Notice> : null}
      <datalist id="cuentas-pago-nomina">
        {banks.map((a) => (
          <option key={a.code} value={a.code}>{a.name}</option>
        ))}
      </datalist>
      <div className="grid gap-x-4 sm:grid-cols-3">
        <TextField label="Fecha del pago" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <TextField label="Cuenta de caja o bancos" list="cuentas-pago-nomina" value={account} onChange={(e) => setAccount(e.target.value)} hint={banks.find((a) => a.code === account.trim())?.name} />
      </div>
      <Button type="submit" variant="primary" busy={submit.busy}>Registrar el pago</Button>
      <Button className="ml-2" onClick={onCancel}>Cancelar</Button>
    </form>
  );
}

function RunDetail({ run, currency, manage, onChanged }) {
  const base = useTenantApi();
  const [paying, setPaying] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [slip, setSlip] = useState(null);
  const money = (v) => formatAmount(v, currency);
  const detail = useLoad(() => api.get(`${base}/payroll/runs/${run._id}`), [base, run._id, run.status, run.payment, run.contributionsPayment]);
  const voidRun = useSubmit(async () => {
    await api.post(`${base}/payroll/runs/${run._id}/void`);
    setConfirming(false);
    onChanged(`Nómina de ${run.period} anulada.`);
  });
  const data = detail.data;
  if (!data) return detail.error ? <Notice kind="error">{errorMessage(detail.error)}</Notice> : <p className="my-2 text-sm text-tinta">Cargando…</p>;
  const itemColumns = [
    { key: 'name', title: 'Empleado', render: (i) => i.name },
    { key: 'days', title: 'Días', align: 'right', render: (i) => i.days },
    { key: 'gross', title: 'Devengado', align: 'right', render: (i) => money(i.gross) },
    { key: 'ded', title: 'Deducciones', align: 'right', render: (i) => money(i.deductions) },
    { key: 'net', title: 'Neto', align: 'right', render: (i) => money(i.net) },
    { key: 'er', title: 'Aportes del empleador', align: 'right', render: (i) => money(i.employerTotal) },
    { key: 'pr', title: 'Provisiones', align: 'right', render: (i) => money(i.provisionsTotal) },
    { key: 'slip', title: 'Desprendible', render: (i) => <TextButton onClick={() => setSlip(slip === String(i.employeeId) ? null : String(i.employeeId))}>{slip === String(i.employeeId) ? 'Ocultar' : 'Ver'}</TextButton> },
  ];
  const obligations = obligationsOf(data.totals);
  const settled = (field) => (data[field] ? `Pagado el ${formatDay(data[field].date)} (${data[field].document})` : 'Pendiente de pago');
  return (
    <div className="my-2 text-sm text-tinta">
      <DataTable caption={`Nómina de ${run.period}`} columns={itemColumns} rows={data.items} rowKey={(i) => String(i.employeeId)} />
      {slip ? <Payslip runId={run._id} employeeId={slip} onClose={() => setSlip(null)} /> : null}
      <h3 className="mb-1 mt-4 font-semibold">Obligaciones de esta nómina</h3>
      <ul className="mb-3">
        {obligations.map((o) => (
          <li key={o.key}>
            {o.label}: <span className="tabular-nums">{money(o.amount)}</span>
          </li>
        ))}
      </ul>
      <p>Salarios: {settled('payment')}. Aportes: {settled('contributionsPayment')}.</p>
      {manage && data.status === 'posted' ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {!data.payment ? <Button onClick={() => setPaying(paying === 'net' ? null : 'net')}>Pagar la nómina</Button> : null}
          {!data.contributionsPayment ? <Button onClick={() => setPaying(paying === 'contrib' ? null : 'contrib')}>Pagar los aportes</Button> : null}
          {!data.payment && !data.contributionsPayment ? (
            confirming ? (
              <>
                <Button variant="danger" busy={voidRun.busy} onClick={() => voidRun.run()}>Sí, anular la nómina</Button>
                <Button onClick={() => setConfirming(false)}>Cancelar</Button>
              </>
            ) : (
              <Button onClick={() => setConfirming(true)}>Anular</Button>
            )
          ) : null}
        </div>
      ) : null}
      {voidRun.error ? <div className="mt-2"><Notice kind="error">{errorMessage(voidRun.error)}</Notice></div> : null}
      {paying ? (
        <PayForm
          run={data}
          kind={paying}
          onCancel={() => setPaying(null)}
          onDone={() => {
            setPaying(null);
            onChanged(paying === 'net' ? `Nómina de ${run.period} pagada.` : `Aportes de ${run.period} pagados.`);
          }}
        />
      ) : null}
    </div>
  );
}

export function PayrollRunsScreen() {
  const base = useTenantApi();
  const { tenant, can } = useSession();
  const currency = tenant.currency;
  const manage = can('payroll:manage');
  const money = (v) => formatAmount(v, currency);
  const [period, setPeriod] = useState(previousMonth(today()));
  const employees = useLoad(() => api.get(`${base}/payroll/employees?active=true&limit=50`), [base]);
  const runs = useLoad(() => api.get(`${base}/payroll/runs`), [base]);
  const [novelties, setNovelties] = useState({});
  const [preview, setPreview] = useState(null);
  const [errors, setErrors] = useState([]);
  const [notice, setNotice] = useState(null);
  const [open, setOpen] = useState(null);
  const [key, setKey] = useState(newIdempotencyKey);
  const rows = (employees.data?.items ?? []).map((e) => ({ ...blankNovelty(e), ...(novelties[e._id] ?? {}) }));
  const setField = (employee, field, value) => {
    setNovelties((n) => ({ ...n, [employee._id]: { ...blankNovelty(employee), ...(n[employee._id] ?? {}), [field]: value } }));
    setPreview(null);
  };

  const body = () => {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return { ok: false, errors: ['Escribe el mes como AAAA-MM.'] };
    const parsed = parseNovelties(rows, currency);
    return parsed.ok ? { ok: true, body: { period, ...(parsed.novelties.length ? { novelties: parsed.novelties } : {}) } } : parsed;
  };
  const calculate = useSubmit(async () => {
    const built = body();
    if (!built.ok) return setErrors(built.errors);
    setErrors([]);
    return setPreview(await api.post(`${base}/payroll/preview`, built.body));
  });
  const post = useSubmit(async () => {
    const built = body();
    if (!built.ok) return setErrors(built.errors);
    setErrors([]);
    const result = await api.post(`${base}/payroll/runs`, built.body, { 'idempotency-key': key });
    setKey(newIdempotencyKey());
    setPreview(null);
    setNovelties({});
    setNotice(`Nómina de ${period} liquidada y contabilizada en ${result.run.document}: ${money(result.run.totals.net)} netos por pagar a ${result.run.totals.employees} ${result.run.totals.employees === 1 ? 'empleado' : 'empleados'}.`);
    return runs.reload();
  });

  const inputClass = 'rounded-sm border border-borde-fuerte bg-papel px-1.5 py-1 text-right text-sm tabular-nums text-tinta focus:outline-2 focus:outline-azul';
  const previewColumns = [
    { key: 'name', title: 'Empleado', render: (i) => i.name },
    { key: 'days', title: 'Días', align: 'right', render: (i) => i.days },
    { key: 'gross', title: 'Devengado', align: 'right', render: (i) => money(i.gross) },
    { key: 'health', title: 'Salud y pensión', align: 'right', render: (i) => money(i.employee.health + i.employee.pension + i.employee.solidarity) },
    { key: 'wh', title: 'Retención', align: 'right', render: (i) => money(i.employee.withholding) },
    { key: 'net', title: 'Neto', align: 'right', render: (i) => money(i.net) },
    { key: 'er', title: 'Aportes del empleador', align: 'right', render: (i) => money(i.employerTotal) },
    { key: 'pr', title: 'Provisiones', align: 'right', render: (i) => money(i.provisionsTotal) },
  ];
  const runColumns = [
    { key: 'period', title: 'Período', nowrap: true, render: (r) => r.period },
    { key: 'doc', title: 'Asiento', nowrap: true, render: (r) => r.document },
    { key: 'emp', title: 'Empleados', align: 'right', render: (r) => r.totals.employees },
    { key: 'net', title: `Neto (${currency})`, align: 'right', render: (r) => money(r.totals.net) },
    { key: 'status', title: 'Estado', render: (r) => (r.status === 'void' ? 'Anulada' : `${r.payment ? 'Salarios pagados' : 'Salarios por pagar'} · ${r.contributionsPayment ? 'aportes pagados' : 'aportes por pagar'}`) },
    { key: 'actions', title: 'Acciones', render: (r) => <TextButton onClick={() => setOpen(open === r._id ? null : r._id)}>{open === r._id ? 'Ocultar detalle' : 'Ver detalle'}</TextButton> },
  ];

  return (
    <>
      <PageHeader title="Nómina" />
      <p className="mb-4 text-sm text-tinta">Liquida el mes de todos los empleados activos: devengado, aportes, retención y provisiones. {DRAFT}</p>
      {notice ? <Notice kind="success">{notice}</Notice> : null}
      {manage ? (
        <section className="mb-8 border-b border-borde pb-6">
          <h2 className="mb-2 text-lg font-semibold text-tinta">Liquidar un mes</h2>
          <div className="grid gap-x-4 sm:grid-cols-4">
            <TextField label="Mes (AAAA-MM)" value={period} onChange={(e) => { setPeriod(e.target.value); setPreview(null); }} maxLength={7} />
          </div>
          <h3 className="mb-1 font-semibold text-tinta">Novedades del mes (opcional)</h3>
          <p className="mb-2 text-sm text-tinta">Días trabajados si no fueron los del mes, extras salariales (horas extras, comisiones: cotizan), extras no salariales (bonos), otras deducciones (préstamos, embargos) y una retención fija que reemplaza el cálculo.</p>
          <div className="relative overflow-x-auto">
            <table className="mb-3 w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-borde-fuerte text-left">
                  <th scope="col" className="px-2 py-2 font-semibold">Empleado</th>
                  <th scope="col" className="px-2 py-2 text-right font-semibold">Días</th>
                  <th scope="col" className="px-2 py-2 text-right font-semibold">Extras salariales</th>
                  <th scope="col" className="px-2 py-2 text-right font-semibold">Extras no salariales</th>
                  <th scope="col" className="px-2 py-2 text-right font-semibold">Otras deducciones</th>
                  <th scope="col" className="px-2 py-2 text-right font-semibold">Retención fija</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.employeeId} className="border-b border-borde align-top">
                    <td className="px-2 py-2">{r.name}</td>
                    {[['daysWorked', 'Días', 'w-16'], ['salaryExtras', 'Extras salariales', 'w-28'], ['nonSalaryExtras', 'Extras no salariales', 'w-28'], ['otherDeductions', 'Otras deducciones', 'w-28'], ['withholding', 'Retención fija', 'w-28']].map(([field, label, cls]) => (
                      <td key={field} className="px-2 py-2 text-right">
                        <input aria-label={`${label} de ${r.name}`} value={r[field]} inputMode="decimal" onChange={(e) => setField({ _id: r.employeeId, name: r.name }, field, e.target.value)} className={`${cls} ${inputClass}`} />
                      </td>
                    ))}
                  </tr>
                ))}
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-2 py-4 text-tinta-segundo">No hay empleados activos. Regístralos en Empleados.</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          {errors.length ? (
            <Notice kind="error">
              {errors.map((m) => (
                <p key={m}>{m}</p>
              ))}
            </Notice>
          ) : null}
          {calculate.error ? <Notice kind="error">{errorMessage(calculate.error)}</Notice> : null}
          {post.error ? <Notice kind="error">{errorMessage(post.error)}</Notice> : null}
          <Button variant="primary" busy={calculate.busy} onClick={() => calculate.run()}>Calcular</Button>
          {preview ? (
            <div className="mt-6">
              {preview.problems.length ? (
                <Notice kind="error" title="Hay empleados con problemas">
                  {preview.problems.map((p) => (
                    <p key={String(p.employeeId)}>{p.message}</p>
                  ))}
                </Notice>
              ) : null}
              <DataTable caption="Vista previa de la nómina" columns={previewColumns} rows={preview.items} rowKey={(i) => String(i.employeeId)} empty="No hay empleados vinculados en ese mes." />
              {preview.items.length ? (
                <dl className="mb-4 ml-auto mt-3 grid max-w-md grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm text-tinta">
                  <dt>Devengado</dt>
                  <dd className="text-right tabular-nums">{money(preview.totals.gross)}</dd>
                  <dt>Deducciones de los empleados</dt>
                  <dd className="text-right tabular-nums">{money(preview.totals.deductions)}</dd>
                  <dt className="font-semibold">Neto a pagar</dt>
                  <dd className="text-right font-semibold tabular-nums">{money(preview.totals.net)}</dd>
                  <dt>Aportes del empleador</dt>
                  <dd className="text-right tabular-nums">{money(preview.totals.employerTotal)}</dd>
                  <dt>Provisiones (cesantías, intereses, prima, vacaciones)</dt>
                  <dd className="text-right tabular-nums">{money(preview.totals.provisionsTotal)}</dd>
                </dl>
              ) : null}
              {preview.items.length && !preview.problems.length ? (
                <Button variant="primary" busy={post.busy} onClick={() => post.run()}>Liquidar y contabilizar</Button>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}
      <h2 className="mb-2 text-lg font-semibold text-tinta">Nóminas liquidadas</h2>
      {runs.error ? <Notice kind="error">{errorMessage(runs.error)}</Notice> : null}
      {runs.data ? (
        <DataTable
          caption="Nóminas liquidadas"
          columns={runColumns}
          rows={runs.data.items}
          rowKey={(r) => r._id}
          empty="Todavía no se ha liquidado ninguna nómina."
          expandedRow={(r) =>
            open === r._id ? (
              <RunDetail
                run={r}
                currency={currency}
                manage={manage}
                onChanged={(message) => {
                  setNotice(message);
                  runs.reload();
                }}
              />
            ) : null
          }
        />
      ) : null}
    </>
  );
}
