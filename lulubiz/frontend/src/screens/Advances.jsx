import { useState } from 'react';
import { PartyPicker } from '../components/PartyPicker.jsx';
import { Button, DataTable, Notice, PageHeader, SelectField, TextButton, TextField, errorMessage, useLoad, useSubmit } from '../components/ui.jsx';
import { api, newIdempotencyKey } from '../lib/api.js';
import { suggestAllocations, validateAdvance, validateApplication } from '../lib/advances.js';
import { formatDay } from '../lib/format.js';
import { formatAmount } from '../lib/money.js';
import { useSession, useTenantApi } from '../lib/session.jsx';

const today = () => new Date().toISOString().slice(0, 10);

const COPY = {
  customer: {
    title: 'Anticipos de clientes',
    path: 'customer-advances',
    party: 'Cliente',
    partyRole: 'customer',
    intro: 'Dinero que un cliente entrega antes de que exista la factura. Queda como saldo a su favor y se aplica a sus facturas cuando se emitan.',
    create: 'Registrar anticipo',
    docs: 'receivables/open',
    docLabel: 'Facturas con saldo',
    accountHint: 'Caja o bancos donde entra el dinero.',
    write: 'receipts:create',
    void: 'receipts:void',
    settings: 'la cuenta de anticipos de clientes',
  },
  supplier: {
    title: 'Anticipos a proveedores',
    path: 'supplier-advances',
    party: 'Proveedor',
    partyRole: 'supplier',
    intro: 'Dinero que se entrega a un proveedor antes de recibir su factura. Queda como saldo a nuestro favor y se aplica a sus compras cuando se registren.',
    create: 'Registrar anticipo',
    docs: 'payables/open',
    docLabel: 'Compras con saldo',
    accountHint: 'Caja o bancos de donde sale el dinero.',
    write: 'payments:create',
    void: 'payments:void',
    settings: 'la cuenta de anticipos a proveedores',
  },
};

function AdvanceForm({ kind, onDone, onCancel }) {
  const base = useTenantApi();
  const { tenant } = useSession();
  const copy = COPY[kind];
  const currency = tenant.currency;
  const accounts = useLoad(() => api.get(`${base}/accounts?activeOnly=true`), [base]);
  const assets = (accounts.data?.items ?? []).filter((a) => a.postable && a.type === 'asset');
  const [form, setForm] = useState({ partyId: '', date: today(), amount: '', account: '', notes: '' });
  const [showErrors, setShowErrors] = useState(false);
  const [key, setKey] = useState(newIdempotencyKey);
  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));
  const result = validateAdvance({ ...form, currency }, { customer: kind === 'customer' });
  const err = (field) => (showErrors ? result.errors[field] : undefined);

  const submit = useSubmit(async () => {
    setShowErrors(true);
    if (!result.ok) return;
    const outcome = await api.post(`${base}/${copy.path}`, { ...result.body, ...(form.notes.trim() ? { notes: form.notes.trim() } : {}) }, { 'idempotency-key': key });
    setKey(newIdempotencyKey());
    onDone(outcome.advance);
  });

  return (
    <form
      className="mb-8 border-b border-borde pb-6"
      onSubmit={(e) => {
        e.preventDefault();
        submit.run();
      }}
    >
      <h2 className="mb-3 text-lg font-semibold text-tinta">{copy.create}</h2>
      {submit.error ? (
        <Notice kind="error">
          {errorMessage(submit.error)}
          {submit.error.code === 'SETTINGS_INCOMPLETE' ? ' Se configura en Facturación, en «Cuentas contables».' : ''}
        </Notice>
      ) : null}
      <PartyPicker base={base} role={copy.partyRole} value={form.partyId} onChange={(id) => setForm((f) => ({ ...f, partyId: id }))} error={err('partyId')} />
      <datalist id="cuentas-anticipo">
        {assets.map((a) => (
          <option key={a.code} value={a.code}>
            {a.name}
          </option>
        ))}
      </datalist>
      <div className="grid gap-x-4 sm:grid-cols-3">
        <TextField label="Fecha" type="date" value={form.date} onChange={set('date')} error={err('date')} />
        <TextField label={`Importe (${currency})`} value={form.amount} onChange={set('amount')} inputMode="decimal" error={err('amount')} />
        <TextField label="Cuenta de caja o bancos" list="cuentas-anticipo" value={form.account} onChange={set('account')} error={err('account')} hint={assets.find((a) => a.code === form.account.trim())?.name ?? copy.accountHint} />
      </div>
      <TextField label="Notas (opcional)" value={form.notes} onChange={set('notes')} maxLength={500} />
      <Button type="submit" variant="primary" busy={submit.busy}>
        {copy.create}
      </Button>
      <Button className="ml-2" onClick={onCancel}>
        Cancelar
      </Button>
    </form>
  );
}

function ApplyForm({ kind, advance, onDone, onCancel }) {
  const base = useTenantApi();
  const { tenant } = useSession();
  const copy = COPY[kind];
  const currency = advance.currency ?? tenant.currency;
  const open = useLoad(() => api.get(`${base}/${copy.docs}?partyId=${advance.partyId}&currency=${currency}`), [base, advance.partyId, currency]);
  const documents = open.data?.items ?? [];
  const [date, setDate] = useState(today());
  const [amounts, setAmounts] = useState({});
  const [showErrors, setShowErrors] = useState(false);
  const [key, setKey] = useState(newIdempotencyKey);
  const result = validateApplication({ date, amounts, documents, available: advance.balance, currency });

  const submit = useSubmit(async () => {
    setShowErrors(true);
    if (!result.ok) return;
    const outcome = await api.post(`${base}/${copy.path}/${advance._id}/applications`, result.body, { 'idempotency-key': key });
    setKey(newIdempotencyKey());
    onDone(outcome.application);
  });

  const columns = [
    { key: 'number', title: 'Documento', nowrap: true, render: (d) => d.fullNumber },
    { key: 'due', title: 'Vence', nowrap: true, render: (d) => (d.dueDate ? formatDay(d.dueDate) : '') },
    { key: 'balance', title: `Saldo (${currency})`, align: 'right', render: (d) => formatAmount(d.balance, currency) },
    {
      key: 'apply',
      title: 'Aplicar',
      render: (d) => (
        <>
          <input
            aria-label={`Aplicar a ${d.fullNumber}`}
            value={amounts[d._id] ?? ''}
            onChange={(e) => setAmounts((a) => ({ ...a, [d._id]: e.target.value }))}
            inputMode="decimal"
            className={`w-32 rounded-sm border bg-papel px-2 py-1 text-right text-sm tabular-nums text-tinta focus:outline-2 focus:outline-azul ${showErrors && result.errors.documents[d._id] ? 'border-rojo' : 'border-borde-fuerte'}`}
          />
          {showErrors && result.errors.documents[d._id] ? <p role="alert" className="text-xs font-semibold text-rojo">{result.errors.documents[d._id]}</p> : null}
        </>
      ),
    },
  ];

  return (
    <form
      className="my-3 max-w-3xl border-t border-borde pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit.run();
      }}
    >
      <h3 className="mb-2 font-semibold text-tinta">Aplicar el anticipo {advance.fullNumber}</h3>
      <p className="mb-3 text-sm text-tinta">
        Disponible: {formatAmount(advance.balance, currency)} {currency}. Aplicarlo baja lo que {kind === 'customer' ? 'debe el cliente' : 'se le debe al proveedor'} sin que entre ni salga dinero.
      </p>
      {submit.error ? <Notice kind="error">{errorMessage(submit.error)}</Notice> : null}
      {open.error ? <Notice kind="error">{errorMessage(open.error)}</Notice> : null}
      <div className="grid gap-x-4 sm:grid-cols-3">
        <TextField label="Fecha de la aplicación" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </div>
      <DataTable caption={copy.docLabel} columns={columns} rows={documents} rowKey={(d) => d._id} empty={`No hay ${copy.docLabel.toLowerCase()} de este ${copy.party.toLowerCase()}.`} />
      {documents.length ? (
        <p className="mb-3 mt-2 text-sm text-tinta">
          <TextButton onClick={() => setAmounts(suggestAllocations(advance.balance, documents, currency))}>Repartir lo disponible</TextButton>
          {' · '}Se aplican {formatAmount(result.total, currency)}; queda {formatAmount(Math.max(result.remaining, 0), currency)} por aplicar.
        </p>
      ) : null}
      {showErrors && result.errors.form.length ? (
        <Notice kind="error">
          {result.errors.form.map((m) => (
            <p key={m}>{m}</p>
          ))}
        </Notice>
      ) : null}
      <Button type="submit" variant="primary" busy={submit.busy}>
        Aplicar anticipo
      </Button>
      <Button className="ml-2" onClick={onCancel}>
        Cancelar
      </Button>
    </form>
  );
}

function Detail({ kind, advance, canWrite, canVoid, onChanged }) {
  const base = useTenantApi();
  const { tenant } = useSession();
  const copy = COPY[kind];
  const currency = advance.currency ?? tenant.currency;
  const detail = useLoad(() => api.get(`${base}/${copy.path}/${advance._id}`), [base, advance._id, advance.balance, advance.status]);
  const [applying, setApplying] = useState(false);
  const [confirming, setConfirming] = useState(null);
  const undo = useSubmit(async (application) => {
    await api.post(`${base}/${copy.path}/applications/${application._id}/void`);
    setConfirming(null);
    detail.reload();
    onChanged();
  });
  const applications = detail.data?.applications ?? [];
  const columns = [
    { key: 'number', title: 'Aplicación', nowrap: true, render: (a) => a.fullNumber },
    { key: 'date', title: 'Fecha', nowrap: true, render: (a) => formatDay(a.date) },
    { key: 'docs', title: 'A', render: (a) => a.allocations.map((x) => `${x.fullNumber} ${formatAmount(x.amount, currency)}`).join(' · ') },
    { key: 'total', title: `Total (${currency})`, align: 'right', render: (a) => formatAmount(a.total, currency) },
    { key: 'status', title: 'Estado', render: (a) => (a.status === 'void' ? 'Anulada' : 'Vigente') },
    {
      key: 'actions',
      title: 'Acciones',
      render: (a) => {
        if (a.status !== 'posted' || !canVoid) return null;
        if (confirming === a._id) {
          return (
            <span className="flex gap-3">
              <TextButton danger onClick={() => undo.run(a)}>Sí, anular</TextButton>
              <TextButton onClick={() => setConfirming(null)}>Cancelar</TextButton>
            </span>
          );
        }
        return <TextButton onClick={() => { setConfirming(a._id); undo.clearError(); }}>Anular aplicación</TextButton>;
      },
    },
  ];
  return (
    <div className="my-2 text-sm text-tinta">
      {advance.notes ? <p className="mb-2">Notas: {advance.notes}</p> : null}
      {undo.error ? <Notice kind="error">{errorMessage(undo.error)}</Notice> : null}
      {canWrite && advance.status === 'posted' && advance.balance > 0 && !applying ? <Button onClick={() => setApplying(true)}>Aplicar a {kind === 'customer' ? 'facturas' : 'compras'}</Button> : null}
      {applying ? (
        <ApplyForm
          kind={kind}
          advance={advance}
          onCancel={() => setApplying(false)}
          onDone={() => {
            setApplying(false);
            detail.reload();
            onChanged();
          }}
        />
      ) : null}
      <DataTable caption="Aplicaciones del anticipo" columns={columns} rows={applications} rowKey={(a) => a._id} empty="Este anticipo todavía no se ha aplicado." />
    </div>
  );
}

function AdvancesScreen({ kind }) {
  const base = useTenantApi();
  const { tenant, can } = useSession();
  const copy = COPY[kind];
  const currency = tenant.currency;
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState(null);
  const [filter, setFilter] = useState('all');
  const [open, setOpen] = useState(null);
  const [confirming, setConfirming] = useState(null);
  const [extra, setExtra] = useState([]);
  const [cursor, setCursor] = useState(undefined);
  const query = filter === 'open' ? 'open=true' : filter === 'void' ? 'status=void' : '';
  const list = useLoad(() => api.get(`${base}/${copy.path}?${query}`), [base, copy.path, query]);
  const items = [...(list.data?.items ?? []), ...extra];
  const next = cursor === undefined ? list.data?.nextCursor : cursor;
  const reset = () => {
    setExtra([]);
    setCursor(undefined);
    list.reload();
  };
  const more = useSubmit(async () => {
    const page = await api.get(`${base}/${copy.path}?${query}${query ? '&' : ''}cursor=${next}`);
    setExtra((e) => [...e, ...page.items]);
    setCursor(page.nextCursor);
  });
  const voidAdvance = useSubmit(async (advance) => {
    await api.post(`${base}/${copy.path}/${advance._id}/void`);
    setNotice(`Anticipo ${advance.fullNumber} anulado.`);
    setConfirming(null);
    reset();
  });

  const columns = [
    { key: 'number', title: 'Número', nowrap: true, render: (a) => a.fullNumber },
    { key: 'date', title: 'Fecha', nowrap: true, render: (a) => formatDay(a.date) },
    { key: 'party', title: copy.party, render: (a) => a.party.name },
    { key: 'amount', title: `Importe (${currency})`, align: 'right', render: (a) => formatAmount(a.amount, a.currency) },
    { key: 'applied', title: 'Aplicado', align: 'right', render: (a) => formatAmount(a.applied, a.currency) },
    { key: 'balance', title: 'Disponible', align: 'right', render: (a) => formatAmount(a.balance, a.currency) },
    { key: 'status', title: 'Estado', render: (a) => (a.status === 'void' ? 'Anulado' : a.balance === 0 ? 'Aplicado del todo' : a.applied > 0 ? 'Aplicado en parte' : 'Sin aplicar') },
    {
      key: 'actions',
      title: 'Acciones',
      render: (a) => {
        if (confirming === a._id) {
          return (
            <span className="flex gap-3">
              <TextButton danger onClick={() => voidAdvance.run(a)}>Sí, anular</TextButton>
              <TextButton onClick={() => setConfirming(null)}>Cancelar</TextButton>
            </span>
          );
        }
        return (
          <span className="flex flex-wrap gap-3">
            <TextButton onClick={() => setOpen(open === a._id ? null : a._id)}>{open === a._id ? 'Ocultar' : 'Ver y aplicar'}</TextButton>
            {can(copy.void) && a.status === 'posted' && a.applied === 0 ? <TextButton danger onClick={() => { setConfirming(a._id); voidAdvance.clearError(); }}>Anular</TextButton> : null}
          </span>
        );
      },
    },
  ];

  return (
    <>
      <PageHeader title={copy.title}>{can(copy.write) && !creating ? <Button variant="primary" onClick={() => { setCreating(true); setNotice(null); }}>{copy.create}</Button> : null}</PageHeader>
      <p className="mb-4 text-sm text-tinta">{copy.intro}</p>
      {notice ? <Notice kind="success">{notice}</Notice> : null}
      {voidAdvance.error ? <Notice kind="error">{errorMessage(voidAdvance.error)}</Notice> : null}
      {creating ? (
        <AdvanceForm
          kind={kind}
          onCancel={() => setCreating(false)}
          onDone={(advance) => {
            setCreating(false);
            setNotice(`Anticipo ${advance.fullNumber} registrado por ${formatAmount(advance.amount, advance.currency)} ${advance.currency} de ${advance.party.name}.`);
            reset();
          }}
        />
      ) : null}
      <div className="mb-4 grid gap-x-4 sm:grid-cols-3">
        <SelectField label="Mostrar" value={filter} onChange={(e) => { setFilter(e.target.value); setExtra([]); setCursor(undefined); }} options={[{ value: 'all', label: 'Todos' }, { value: 'open', label: 'Con saldo por aplicar' }, { value: 'void', label: 'Anulados' }]} />
      </div>
      {list.error ? <Notice kind="error">{errorMessage(list.error)}</Notice> : null}
      {list.loading && !list.data ? <p className="text-sm text-tinta">Cargando anticipos…</p> : null}
      {list.data ? (
        <DataTable
          caption={copy.title}
          columns={columns}
          rows={items}
          rowKey={(a) => a._id}
          empty="No hay anticipos con este filtro."
          expandedRow={(a) => (open === a._id ? <Detail kind={kind} advance={a} canWrite={can(copy.write)} canVoid={can(copy.void)} onChanged={reset} /> : null)}
        />
      ) : null}
      {more.error ? <Notice kind="error">{errorMessage(more.error)}</Notice> : null}
      {next ? (
        <div className="mt-4">
          <Button busy={more.busy} onClick={() => more.run()}>Cargar más anticipos</Button>
        </div>
      ) : null}
    </>
  );
}

export const CustomerAdvancesScreen = () => <AdvancesScreen kind="customer" />;
export const SupplierAdvancesScreen = () => <AdvancesScreen kind="supplier" />;
