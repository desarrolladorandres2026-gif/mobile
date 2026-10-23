import { useState } from 'react';
import { Button, DataTable, Notice, PageHeader, SelectField, TextButton, TextField, errorMessage, useLoad, useSubmit } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { formatDay } from '../lib/format.js';
import { formatAmount, parseAmount } from '../lib/money.js';
import { useSession, useTenantApi } from '../lib/session.jsx';

const today = () => new Date().toISOString().slice(0, 10);

/** Arma el cuerpo de la liquidación de contrato, o los errores. Los días de vacaciones admiten dos decimales. */
export function buildTermination(form, currency) {
  const errors = [];
  if (!form.employeeId) errors.push('Elige el empleado.');
  if (!form.endDate) errors.push('Elige la fecha de retiro.');
  const days = form.vacationDays.trim() === '' ? 0 : Number(form.vacationDays.replace(',', '.'));
  if (!Number.isFinite(days) || days < 0 || days > 400) errors.push('Los días de vacaciones pendientes van de 0 a 400.');
  const severance = parseAmount(form.severance, currency);
  if (severance === null || severance < 0) errors.push('Indemnización no válida.');
  const withholding = parseAmount(form.withholding, currency);
  if (withholding === null || withholding < 0) errors.push('Retención no válida.');
  if (errors.length) return { ok: false, errors };
  return { ok: true, body: { employeeId: form.employeeId, endDate: form.endDate, vacationDaysPending: days, ...(severance ? { severance } : {}), ...(withholding ? { withholding } : {}) } };
}

function PayTermination({ termination, onDone, onCancel }) {
  const base = useTenantApi();
  const [date, setDate] = useState(today());
  const [account, setAccount] = useState('');
  const [error, setError] = useState(null);
  const all = useLoad(() => api.get(`${base}/accounts?activeOnly=true`), [base]);
  const banks = (all.data?.items ?? []).filter((a) => a.postable && a.type === 'asset');
  const submit = useSubmit(async () => {
    setError(null);
    if (!/^\d{1,12}$/.test(account.trim())) return setError('Indica la cuenta de caja o bancos de donde sale el dinero.');
    return onDone(await api.post(`${base}/payroll/terminations/${termination._id}/pay`, { date, account: account.trim() }));
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
      <datalist id="cuentas-pago-liquidacion">
        {banks.map((a) => (
          <option key={a.code} value={a.code}>{a.name}</option>
        ))}
      </datalist>
      <div className="grid gap-x-4 sm:grid-cols-3">
        <TextField label="Fecha del pago" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <TextField label="Cuenta de caja o bancos" list="cuentas-pago-liquidacion" value={account} onChange={(e) => setAccount(e.target.value)} hint={banks.find((a) => a.code === account.trim())?.name} />
      </div>
      <Button type="submit" variant="primary" busy={submit.busy}>Registrar el pago</Button>
      <Button className="ml-2" onClick={onCancel}>Cancelar</Button>
    </form>
  );
}

export function TerminationsScreen() {
  const base = useTenantApi();
  const { tenant, can } = useSession();
  const currency = tenant.currency;
  const manage = can('payroll:manage');
  const money = (v) => formatAmount(v, currency);
  const employees = useLoad(() => api.get(`${base}/payroll/employees?active=true&limit=50`), [base]);
  const list = useLoad(() => api.get(`${base}/payroll/terminations`), [base]);
  const [form, setForm] = useState({ employeeId: '', endDate: today(), vacationDays: '', severance: '', withholding: '' });
  const [preview, setPreview] = useState(null);
  const [errors, setErrors] = useState([]);
  const [notice, setNotice] = useState(null);
  const [paying, setPaying] = useState(null);
  const [confirming, setConfirming] = useState(null);
  const set = (field) => (e) => {
    setForm((f) => ({ ...f, [field]: e.target.value }));
    setPreview(null);
  };

  const calculate = useSubmit(async () => {
    const built = buildTermination(form, currency);
    if (!built.ok) return setErrors(built.errors);
    setErrors([]);
    return setPreview(await api.post(`${base}/payroll/terminations/preview`, built.body));
  });
  const settle = useSubmit(async () => {
    const built = buildTermination(form, currency);
    if (!built.ok) return setErrors(built.errors);
    const result = await api.post(`${base}/payroll/terminations`, built.body);
    setPreview(null);
    setForm((f) => ({ ...f, employeeId: '', vacationDays: '', severance: '', withholding: '' }));
    setNotice(`Liquidación ${result.termination.document} registrada para ${result.termination.employee.name}: ${money(result.termination.net)} por pagar. El empleado quedó inactivo.`);
    employees.reload();
    list.reload();
  });
  const voidIt = useSubmit(async (t) => {
    await api.post(`${base}/payroll/terminations/${t._id}/void`);
    setConfirming(null);
    setNotice(`Liquidación ${t.document} anulada; ${t.employee.name} volvió a estar activo.`);
    employees.reload();
    list.reload();
  });

  const lineRows = preview
    ? [
        { key: 'prima', label: 'Prima de servicios del semestre', ...preview.lines.prima },
        { key: 'cesantias', label: 'Cesantías del año', ...preview.lines.cesantias },
        { key: 'interest', label: 'Intereses sobre cesantías', ...preview.lines.interest },
        { key: 'vacations', label: `Vacaciones pendientes (${preview.lines.vacations.days} días)`, ...preview.lines.vacations },
        { key: 'severance', label: 'Indemnización', ...preview.lines.severance },
      ].filter((r) => r.amount > 0 || r.skipped)
    : [];
  const previewColumns = [
    { key: 'label', title: 'Concepto', render: (r) => (r.skipped ? `${r.label} (ya liquidada)` : r.label) },
    { key: 'amount', title: 'Valor', align: 'right', render: (r) => money(r.amount) },
    { key: 'accrued', title: 'Provisionado', align: 'right', render: (r) => (r.accrued === undefined ? '' : money(r.accrued)) },
  ];
  const columns = [
    { key: 'emp', title: 'Empleado', render: (t) => t.employee.name },
    { key: 'end', title: 'Retiro', nowrap: true, render: (t) => formatDay(t.endDate) },
    { key: 'doc', title: 'Asiento', nowrap: true, render: (t) => t.document },
    { key: 'net', title: `Neto (${currency})`, align: 'right', render: (t) => money(t.net) },
    { key: 'status', title: 'Estado', render: (t) => (t.status === 'void' ? 'Anulada' : t.payment ? `Pagada el ${formatDay(t.payment.date)}` : 'Pendiente de pago') },
    {
      key: 'actions',
      title: 'Acciones',
      render: (t) =>
        manage && t.status === 'posted' && !t.payment ? (
          confirming === t._id ? (
            <span className="flex gap-3">
              <TextButton danger onClick={() => voidIt.run(t)}>Sí, anular</TextButton>
              <TextButton onClick={() => setConfirming(null)}>Cancelar</TextButton>
            </span>
          ) : (
            <span className="flex gap-3">
              <TextButton onClick={() => setPaying(paying === t._id ? null : t._id)}>Pagar</TextButton>
              <TextButton danger onClick={() => setConfirming(t._id)}>Anular</TextButton>
            </span>
          )
        ) : null,
    },
  ];

  return (
    <>
      <PageHeader title="Liquidación de contrato" />
      <p className="mb-4 text-sm text-tinta">Lo que se le debe a quien se retira: prima del semestre, cesantías e intereses del año, vacaciones pendientes y, si la hay, la indemnización. Primero debe estar liquidada la nómina del mes del retiro. Al liquidar, el empleado queda inactivo. La indemnización y la retención sobre la liquidación las escribes tú: el programa no las calcula.</p>
      {notice ? <Notice kind="success">{notice}</Notice> : null}
      {manage ? (
        <section className="mb-8 border-b border-borde pb-6">
          <div className="grid gap-x-4 sm:grid-cols-4">
            <SelectField label="Empleado" value={form.employeeId} onChange={set('employeeId')} options={[{ value: '', label: 'Elige el empleado' }, ...(employees.data?.items ?? []).map((e) => ({ value: e._id, label: e.name }))]} />
            <TextField label="Fecha de retiro" type="date" value={form.endDate} onChange={set('endDate')} />
            <TextField label="Días de vacaciones pendientes" value={form.vacationDays} onChange={set('vacationDays')} inputMode="decimal" hint="Los que no ha disfrutado." />
          </div>
          <div className="grid gap-x-4 sm:grid-cols-4">
            <TextField label={`Indemnización (${currency})`} value={form.severance} onChange={set('severance')} inputMode="decimal" hint="Vacío si no hay." />
            <TextField label={`Retención en la fuente (${currency})`} value={form.withholding} onChange={set('withholding')} inputMode="decimal" hint="La que apliques a la liquidación." />
          </div>
          {errors.length ? (
            <Notice kind="error">
              {errors.map((m) => (
                <p key={m}>{m}</p>
              ))}
            </Notice>
          ) : null}
          {calculate.error ? <Notice kind="error">{errorMessage(calculate.error)}</Notice> : null}
          {settle.error ? <Notice kind="error">{errorMessage(settle.error)}</Notice> : null}
          <Button variant="primary" busy={calculate.busy} onClick={() => calculate.run()}>Calcular</Button>
          {preview ? (
            <div className="mt-6">
              <DataTable caption={`Liquidación de ${preview.employee.name}`} columns={previewColumns} rows={lineRows} rowKey={(r) => r.key} />
              <dl className="mb-4 ml-auto mt-3 grid max-w-sm grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm text-tinta">
                <dt>Total de la liquidación</dt>
                <dd className="text-right tabular-nums">{money(preview.gross)}</dd>
                <dt>Retención en la fuente</dt>
                <dd className="text-right tabular-nums">{money(preview.withholding)}</dd>
                <dt className="font-semibold">Neto a pagar</dt>
                <dd className="text-right font-semibold tabular-nums">{money(preview.net)}</dd>
              </dl>
              <Button variant="primary" busy={settle.busy} onClick={() => settle.run()}>Liquidar y contabilizar</Button>
            </div>
          ) : null}
        </section>
      ) : null}
      <h2 className="mb-2 text-lg font-semibold text-tinta">Liquidaciones hechas</h2>
      {voidIt.error ? <Notice kind="error">{errorMessage(voidIt.error)}</Notice> : null}
      {list.error ? <Notice kind="error">{errorMessage(list.error)}</Notice> : null}
      {list.data ? (
        <DataTable
          caption="Liquidaciones de contrato"
          columns={columns}
          rows={list.data.items}
          rowKey={(t) => t._id}
          empty="Todavía no se ha liquidado ningún contrato."
          expandedRow={(t) => (paying === t._id ? <PayTermination termination={t} onCancel={() => setPaying(null)} onDone={() => { setPaying(null); setNotice(`Pago de ${t.document} registrado.`); list.reload(); }} /> : null)}
        />
      ) : null}
    </>
  );
}
