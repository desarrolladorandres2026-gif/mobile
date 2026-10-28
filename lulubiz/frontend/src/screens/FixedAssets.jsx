import { useMemo, useState } from 'react';
import { CostCenterSelect, useCostCenters } from '../components/CostCenterSelect.jsx';
import { LoadNotice, Button, DataTable, Notice, PageHeader, SelectField, TextButton, TextField, errorMessage, useLoad, useSubmit } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { firstInstallment, validateAsset, validateDisposal } from '../lib/fixedAssets.js';
import { formatDay } from '../lib/format.js';
import { formatAmount } from '../lib/money.js';
import { useSession, useTenantApi } from '../lib/session.jsx';

const today = () => new Date().toISOString().slice(0, 10);
const STATUS = [
  { value: '', label: 'Todos' },
  { value: 'active', label: 'En uso' },
  { value: 'disposed', label: 'Dados de baja' },
];
const EMPTY = { code: '', name: '', description: '', acquisitionDate: today(), cost: '', salvageValue: '', usefulLifeMonths: '60', depreciationStart: '', costCenter: '', asset: '', accumulated: '', expense: '' };

function AssetForm({ accounts, onCreated, onCancel }) {
  const base = useTenantApi();
  const { tenant } = useSession();
  const currency = tenant.currency;
  const centers = useCostCenters(base);
  const [form, setForm] = useState(EMPTY);
  const [showErrors, setShowErrors] = useState(false);
  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));
  const result = validateAsset(form, currency);
  const err = (field) => (showErrors && !result.ok ? result.errors[field] : undefined);
  const assets = accounts.filter((a) => a.type === 'asset');
  const expenses = accounts.filter((a) => ['expense', 'cost'].includes(a.type));
  const nameOf = (code, list) => list.find((a) => a.code === code.trim())?.name;
  const preview = result.ok ? firstInstallment(result.body.cost, result.body.salvageValue ?? 0, result.body.usefulLifeMonths) : null;

  const submit = useSubmit(async () => {
    setShowErrors(true);
    if (!result.ok) return;
    onCreated(await api.post(`${base}/fixed-assets`, result.body));
  });

  return (
    <form
      className="mb-8 border-b border-borde pb-6"
      onSubmit={(e) => {
        e.preventDefault();
        submit.run();
      }}
    >
      <h2 className="mb-3 text-lg font-semibold text-tinta">Nuevo activo fijo</h2>
      {submit.error ? <Notice kind="error">{errorMessage(submit.error)}</Notice> : null}
      <datalist id="cuentas-activo">
        {assets.map((a) => (
          <option key={a.code} value={a.code}>{a.name}</option>
        ))}
      </datalist>
      <datalist id="cuentas-gasto-depreciacion">
        {expenses.map((a) => (
          <option key={a.code} value={a.code}>{a.name}</option>
        ))}
      </datalist>
      <div className="grid gap-x-4 sm:grid-cols-3">
        <TextField label="Código" value={form.code} onChange={set('code')} maxLength={20} error={err('code')} />
        <TextField className="sm:col-span-2" label="Nombre" value={form.name} onChange={set('name')} maxLength={200} error={err('name')} />
      </div>
      <TextField label="Descripción (opcional)" value={form.description} onChange={set('description')} maxLength={500} />
      <div className="grid gap-x-4 sm:grid-cols-4">
        <TextField label="Fecha de adquisición" type="date" value={form.acquisitionDate} onChange={set('acquisitionDate')} error={err('acquisitionDate')} />
        <TextField label={`Costo (${currency})`} value={form.cost} onChange={set('cost')} inputMode="decimal" error={err('cost')} />
        <TextField label={`Valor residual (${currency})`} value={form.salvageValue} onChange={set('salvageValue')} inputMode="decimal" error={err('salvageValue')} hint="Lo que valdrá al final. Vacío es 0." />
        <TextField label="Vida útil (meses)" value={form.usefulLifeMonths} onChange={set('usefulLifeMonths')} inputMode="numeric" error={err('usefulLifeMonths')} />
      </div>
      <div className="grid gap-x-4 sm:grid-cols-4">
        <TextField label="Empieza a depreciarse en (opcional)" value={form.depreciationStart} onChange={set('depreciationStart')} placeholder="AAAA-MM" error={err('depreciationStart')} hint="Sin mes, el de la adquisición." />
        <LoadNotice load={centers} what="los centros de costo" />
        {centers.length ? (
          <div className="mb-4">
            <p className="mb-1 text-sm font-semibold text-tinta">Centro de costo</p>
            <CostCenterSelect centers={centers} label="Centro de costo del activo" value={form.costCenter} onChange={set('costCenter')} />
          </div>
        ) : null}
      </div>
      <div className="grid gap-x-4 sm:grid-cols-3">
        <TextField label="Cuenta del activo" list="cuentas-activo" value={form.asset} onChange={set('asset')} error={err('asset')} hint={nameOf(form.asset, assets)} />
        <TextField label="Cuenta de depreciación acumulada" list="cuentas-activo" value={form.accumulated} onChange={set('accumulated')} error={err('accumulated')} hint={nameOf(form.accumulated, assets)} />
        <TextField label="Cuenta del gasto de depreciación" list="cuentas-gasto-depreciacion" value={form.expense} onChange={set('expense')} error={err('expense')} hint={nameOf(form.expense, expenses)} />
      </div>
      <p className="mb-3 text-sm text-tinta">
        Registrar el activo no hace ningún asiento: su costo entra al libro con la compra que lo trajo o con un asiento de saldos iniciales. {preview !== null ? `La cuota del primer mes sería de ${formatAmount(preview, currency)}.` : ''}
      </p>
      <Button type="submit" variant="primary" busy={submit.busy}>Registrar activo</Button>
      <Button className="ml-2" onClick={onCancel}>Cancelar</Button>
    </form>
  );
}

function DisposalForm({ asset, accounts, onDone, onCancel }) {
  const base = useTenantApi();
  const { tenant } = useSession();
  const currency = tenant.currency;
  const [form, setForm] = useState({ date: today(), proceeds: '', proceedsAccount: '', gainAccount: '', lossAccount: '' });
  const [errors, setErrors] = useState([]);
  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));
  const result = validateDisposal(form, asset.bookValue, currency);
  const submit = useSubmit(async () => {
    setErrors([]);
    if (!result.ok) return setErrors(result.errors);
    return onDone(await api.post(`${base}/fixed-assets/${asset._id}/dispose`, result.body));
  });
  const gain = result.difference > 0;
  const loss = result.difference < 0;
  return (
    <form
      className="my-2 max-w-3xl border-t border-borde pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit.run();
      }}
    >
      <h3 className="mb-2 font-semibold text-tinta">Dar de baja {asset.code}</h3>
      <p className="mb-3 text-sm text-tinta">Valor en libros: {formatAmount(asset.bookValue, currency)}. Sin precio de venta, todo el valor en libros va a pérdida. La depreciación tiene que estar al día hasta el mes de la baja.</p>
      {errors.length ? (
        <Notice kind="error">
          {errors.map((m) => (
            <p key={m}>{m}</p>
          ))}
        </Notice>
      ) : null}
      {submit.error ? <Notice kind="error">{errorMessage(submit.error)}</Notice> : null}
      <datalist id="cuentas-baja">
        {accounts.map((a) => (
          <option key={a.code} value={a.code}>{a.name}</option>
        ))}
      </datalist>
      <div className="grid gap-x-4 sm:grid-cols-3">
        <TextField label="Fecha de la baja" type="date" value={form.date} onChange={set('date')} />
        <TextField label={`Precio de venta (${currency})`} value={form.proceeds} onChange={set('proceeds')} inputMode="decimal" hint="Vacío si solo se retira." />
        <TextField label="Cuenta donde entra el dinero" list="cuentas-baja" value={form.proceedsAccount} onChange={set('proceedsAccount')} />
        {gain ? <TextField label="Cuenta de la utilidad" list="cuentas-baja" value={form.gainAccount} onChange={set('gainAccount')} hint={`Utilidad de ${formatAmount(result.difference, currency)}.`} /> : null}
        {loss ? <TextField label="Cuenta de la pérdida" list="cuentas-baja" value={form.lossAccount} onChange={set('lossAccount')} hint={`Pérdida de ${formatAmount(-result.difference, currency)}.`} /> : null}
      </div>
      <Button type="submit" variant="primary" busy={submit.busy}>Dar de baja</Button>
      <Button className="ml-2" onClick={onCancel}>Cancelar</Button>
    </form>
  );
}

function Schedule({ asset, currency }) {
  const columns = [
    { key: 'month', title: 'Mes', align: 'right', render: (r) => r.month },
    { key: 'period', title: 'Período', nowrap: true, render: (r) => r.period },
    { key: 'amount', title: `Cuota (${currency})`, align: 'right', render: (r) => formatAmount(r.amount, currency) },
    { key: 'accumulated', title: 'Acumulada', align: 'right', render: (r) => formatAmount(r.accumulated, currency) },
    { key: 'book', title: 'Valor en libros', align: 'right', render: (r) => formatAmount(r.bookValue, currency) },
    { key: 'posted', title: 'Estado', render: (r) => (r.posted ? 'Contabilizada' : 'Pendiente') },
  ];
  return <DataTable caption={`Calendario de depreciación de ${asset.code}`} columns={columns} rows={asset.schedule} rowKey={(r) => r.month} />;
}

function Detail({ asset: summary, currency, canManage, accounts, onChanged }) {
  const base = useTenantApi();
  const detail = useLoad(() => api.get(`${base}/fixed-assets/${summary._id}`), [base, summary._id, summary.depreciatedMonths, summary.status]);
  const [disposing, setDisposing] = useState(false);
  const asset = detail.data;
  if (detail.error) return <Notice kind="error">{errorMessage(detail.error)}</Notice>;
  if (!asset) return <p className="my-2 text-sm text-tinta">Cargando…</p>;
  return (
    <div className="my-2 text-sm text-tinta">
      <p className="mb-2">
        Adquirido el {formatDay(asset.acquisitionDate)} por {formatAmount(asset.cost, currency)}; residual {formatAmount(asset.salvageValue, currency)}; vida útil {asset.usefulLifeMonths} meses desde {asset.depreciationStart}. Cuentas: activo {asset.accounts.asset}, acumulada {asset.accounts.accumulated}, gasto {asset.accounts.expense}
        {asset.costCenter ? `, centro ${asset.costCenter}` : ''}.
      </p>
      {asset.description ? <p className="mb-2">{asset.description}</p> : null}
      {asset.disposal ? (
        <p className="mb-2 font-semibold">
          Dado de baja el {formatDay(asset.disposal.date)} ({asset.disposal.document}): precio {formatAmount(asset.disposal.proceeds, currency)}, valor en libros {formatAmount(asset.disposal.bookValue, currency)}, {asset.disposal.difference >= 0 ? 'utilidad' : 'pérdida'} de {formatAmount(Math.abs(asset.disposal.difference), currency)}.
        </p>
      ) : null}
      <Schedule asset={asset} currency={currency} />
      {canManage && asset.status === 'active' ? (
        disposing ? (
          <DisposalForm asset={asset} accounts={accounts} onCancel={() => setDisposing(false)} onDone={() => { setDisposing(false); onChanged(`Activo ${asset.code} dado de baja.`); }} />
        ) : (
          <div className="mt-3">
            <Button onClick={() => setDisposing(true)}>Dar de baja o vender</Button>
          </div>
        )
      ) : null}
    </div>
  );
}

function Reconciliation({ base, currency }) {
  const rec = useLoad(() => api.get(`${base}/fixed-assets/reconciliation`), [base]);
  const columns = [
    { key: 'account', title: 'Cuenta', render: (r) => `${r.code} · ${r.name ?? ''}` },
    { key: 'kind', title: 'Qué es', render: (r) => (r.kind === 'accumulated' ? 'Depreciación acumulada' : 'Costo de los activos') },
    { key: 'sub', title: `Suma de las fichas (${currency})`, align: 'right', render: (r) => formatAmount(r.subledger, currency) },
    { key: 'ledger', title: 'Saldo en el libro', align: 'right', render: (r) => formatAmount(r.ledger, currency) },
    { key: 'diff', title: 'Diferencia', align: 'right', render: (r) => formatAmount(r.difference, currency) },
  ];
  if (!rec.data) return null;
  return (
    <>
      <h2 className="mb-2 mt-8 text-lg font-semibold text-tinta">Conciliación con el libro</h2>
      <p className={`mb-2 text-sm font-semibold ${rec.data.ok ? 'text-verde' : 'text-rojo'}`}>
        {rec.data.lines.length === 0 ? 'No hay activos en uso.' : rec.data.ok ? 'Las fichas cuadran con el libro.' : 'Hay diferencias: falta llevar el costo del activo al libro, o hay asientos sobre estas cuentas que no vienen de la depreciación.'}
      </p>
      {rec.data.lines.length ? <DataTable caption="Conciliación de activos fijos con el libro" columns={columns} rows={rec.data.lines} rowKey={(r) => r.code} /> : null}
    </>
  );
}

export function FixedAssetsScreen() {
  const base = useTenantApi();
  const { tenant, can } = useSession();
  const currency = tenant.currency;
  const canManage = can('assets:manage');
  const all = useLoad(() => api.get(`${base}/accounts?activeOnly=true`), [base]);
  const accounts = useMemo(() => (all.data?.items ?? []).filter((a) => a.postable), [all.data]);
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState(null);
  const [notice, setNotice] = useState(null);
  const [version, setVersion] = useState(0);
  const [period, setPeriod] = useState(today().slice(0, 7));
  const list = useLoad(() => api.get(`${base}/fixed-assets${status ? `?status=${status}` : ''}`), [base, status]);
  const runs = useLoad(() => api.get(`${base}/fixed-assets/depreciation-runs?limit=12`), [base]);
  const depreciate = useSubmit(async () => {
    const result = await api.post(`${base}/fixed-assets/depreciation`, { period });
    setNotice(result.run ? `Depreciación de ${period} contabilizada en ${result.run.document}: ${formatAmount(result.total, currency)} en ${result.assets} ${result.assets === 1 ? 'activo' : 'activos'}.` : `No había nada que depreciar hasta ${period}.`);
    list.reload();
    runs.reload();
    setVersion((v) => v + 1);
  });
  const changed = (message) => {
    setNotice(message);
    list.reload();
    setVersion((v) => v + 1);
  };

  const columns = [
    { key: 'code', title: 'Código', nowrap: true, render: (a) => a.code },
    { key: 'name', title: 'Activo', render: (a) => a.name },
    { key: 'date', title: 'Adquirido', nowrap: true, render: (a) => formatDay(a.acquisitionDate) },
    { key: 'cost', title: `Costo (${currency})`, align: 'right', render: (a) => formatAmount(a.cost, currency) },
    { key: 'acc', title: 'Depreciación acumulada', align: 'right', render: (a) => formatAmount(a.depreciatedTotal, currency) },
    { key: 'book', title: 'Valor en libros', align: 'right', render: (a) => formatAmount(a.bookValue, currency) },
    { key: 'months', title: 'Meses', align: 'right', render: (a) => `${a.depreciatedMonths} de ${a.usefulLifeMonths}` },
    { key: 'status', title: 'Estado', render: (a) => (a.status === 'disposed' ? 'Dado de baja' : a.fullyDepreciated ? 'Depreciado del todo' : 'En uso') },
    { key: 'actions', title: 'Acciones', render: (a) => <TextButton onClick={() => setOpen(open === a._id ? null : a._id)}>{open === a._id ? 'Ocultar calendario' : 'Ver calendario'}</TextButton> },
  ];
  const runColumns = [
    { key: 'period', title: 'Período', nowrap: true, render: (r) => r.period },
    { key: 'doc', title: 'Asiento', nowrap: true, render: (r) => r.document },
    { key: 'assets', title: 'Activos', align: 'right', render: (r) => r.items.length },
    { key: 'total', title: `Total (${currency})`, align: 'right', render: (r) => formatAmount(r.total, currency) },
  ];

  return (
    <>
      <PageHeader title="Activos fijos">{canManage && !creating ? <Button variant="primary" onClick={() => { setCreating(true); setNotice(null); }}>Nuevo activo</Button> : null}</PageHeader>
      <p className="mb-4 text-sm text-tinta">Equipos, muebles y maquinaria que duran años. Cada mes se contabiliza su desgaste (depreciación en línea recta) en un solo asiento, y al venderlos o retirarlos se da de baja con su utilidad o pérdida.</p>
      {notice ? <Notice kind="success">{notice}</Notice> : null}
      {creating ? (
        <AssetForm
          accounts={accounts}
          onCancel={() => setCreating(false)}
          onCreated={(asset) => {
            setCreating(false);
            changed(`Activo ${asset.code} registrado. Cuota mensual de ${formatAmount(asset.nextAmount, currency)}.`);
          }}
        />
      ) : null}
      {canManage ? (
        <section className="mb-6 border-b border-borde pb-4">
          <h2 className="mb-2 text-lg font-semibold text-tinta">Depreciar</h2>
          <div className="grid items-end gap-x-4 sm:grid-cols-4">
            <TextField label="Hasta el período" value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="AAAA-MM" hint="Se ponen al día los meses que se deban." />
            <div className="mb-4">
              <Button variant="primary" busy={depreciate.busy} onClick={() => depreciate.run()}>Contabilizar depreciación</Button>
            </div>
          </div>
          {depreciate.error ? <Notice kind="error">{errorMessage(depreciate.error)}</Notice> : null}
        </section>
      ) : null}
      <div className="mb-4 grid gap-x-4 sm:grid-cols-3">
        <SelectField label="Estado" value={status} onChange={(e) => setStatus(e.target.value)} options={STATUS} />
      </div>
      {list.error ? <Notice kind="error">{errorMessage(list.error)}</Notice> : null}
      {list.data ? (
        <DataTable
          caption="Activos fijos"
          columns={columns}
          rows={list.data.items}
          rowKey={(a) => a._id}
          empty="Todavía no hay activos fijos."
          expandedRow={(a) => (open === a._id ? <Detail asset={a} currency={currency} canManage={canManage} accounts={accounts} onChanged={changed} /> : null)}
        />
      ) : null}
      {runs.data?.items.length ? (
        <>
          <h2 className="mb-2 mt-8 text-lg font-semibold text-tinta">Depreciaciones contabilizadas</h2>
          <DataTable caption="Depreciaciones contabilizadas" columns={runColumns} rows={runs.data.items} rowKey={(r) => r._id} />
        </>
      ) : null}
      <Reconciliation key={version} base={base} currency={currency} />
    </>
  );
}
