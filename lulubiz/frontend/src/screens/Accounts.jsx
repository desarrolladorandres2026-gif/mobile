import { useMemo, useState } from 'react';
import { Button, DataTable, Notice, PageHeader, SelectField, TextButton, TextField, errorMessage, useLoad, useSubmit } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { useSession, useTenantApi } from '../lib/session.jsx';

export const TYPE_LABELS = {
  asset: 'Activo',
  liability: 'Pasivo',
  equity: 'Patrimonio',
  income: 'Ingreso',
  expense: 'Gasto',
  cost: 'Costo',
  memo: 'Cuenta de orden',
};

const TYPE_OPTIONS = Object.entries(TYPE_LABELS).map(([value, label]) => ({ value, label }));

function AccountForm({ accounts, onCreated, onCancel }) {
  const base = useTenantApi();
  const [form, setForm] = useState({ code: '', name: '', type: 'asset', nature: 'debit', parentCode: '', postable: true });
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const parents = accounts.filter((a) => !a.postable && a.type === form.type);

  const submit = useSubmit(async () => {
    const body = {
      code: form.code.trim(),
      name: form.name.trim(),
      type: form.type,
      postable: form.postable,
      ...(form.type === 'memo' ? { nature: form.nature } : {}),
      ...(form.parentCode ? { parentCode: form.parentCode } : {}),
    };
    const created = await api.post(`${base}/accounts`, body);
    onCreated(created);
  });

  return (
    <form
      className="mb-8 border-b border-borde pb-6"
      onSubmit={(e) => {
        e.preventDefault();
        submit.run();
      }}
    >
      <h2 className="mb-3 text-lg font-semibold text-tinta">Nueva cuenta</h2>
      {submit.error ? <Notice kind="error">{errorMessage(submit.error)}</Notice> : null}
      <div className="grid gap-x-4 sm:grid-cols-2">
        <TextField label="Código" value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.replace(/\D/g, '') }))} maxLength={12} hint="Solo números, hasta 12 dígitos." required />
        <TextField label="Nombre" value={form.name} onChange={set('name')} maxLength={200} required />
        <SelectField label="Tipo" value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value, parentCode: '' }))} options={TYPE_OPTIONS} />
        {form.type === 'memo' ? (
          <SelectField label="Naturaleza" value={form.nature} onChange={set('nature')} options={[{ value: 'debit', label: 'Débito' }, { value: 'credit', label: 'Crédito' }]} />
        ) : null}
        <SelectField
          label="Cuenta superior"
          value={form.parentCode}
          onChange={set('parentCode')}
          options={[{ value: '', label: 'Ninguna (cuenta de primer nivel)' }, ...parents.map((p) => ({ value: p.code, label: `${p.code} · ${p.name}` }))]}
          hint="Solo cuentas de agrupación del mismo tipo; el código debe empezar por el de la cuenta superior."
        />
      </div>
      <label className="mb-4 flex items-center gap-2 text-sm text-tinta">
        <input type="checkbox" checked={form.postable} onChange={set('postable')} className="size-4 accent-azul" />
        Admite asientos (desmárcalo si la cuenta solo agrupa a otras)
      </label>
      <Button type="submit" variant="primary" busy={submit.busy}>
        Crear cuenta
      </Button>
      <Button className="ml-2" onClick={onCancel}>
        Cancelar
      </Button>
    </form>
  );
}

export function AccountsScreen() {
  const base = useTenantApi();
  const { tenant, can } = useSession();
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState(null);
  const [confirmSeed, setConfirmSeed] = useState(false);
  const list = useLoad(() => api.get(`${base}/accounts`), [base]);

  const rows = useMemo(() => {
    const items = list.data?.items ?? [];
    const byCode = new Map(items.map((a) => [a.code, a]));
    const depth = (a) => (a.parentCode && byCode.has(a.parentCode) ? 1 + depth(byCode.get(a.parentCode)) : 0);
    return items.map((a) => ({ ...a, depth: depth(a) }));
  }, [list.data]);

  const seed = useSubmit(async () => {
    const result = await api.post(`${base}/accounts/seed`);
    setConfirmSeed(false);
    setNotice(
      result.created
        ? `Se crearon ${result.created} cuentas. ${result.draft ? 'Es un borrador: lo debe validar tu contador antes de usarlo en producción.' : ''}`
        : 'El plan ya estaba completo: no se creó nada.',
    );
    list.reload();
  });

  const [confirmingDeactivate, setConfirmingDeactivate] = useState(null);
  const toggle = useSubmit(async (account) => {
    await api.post(`${base}/accounts/${account.code}/${account.active ? 'deactivate' : 'activate'}`);
    setConfirmingDeactivate(null);
    list.reload();
  });

  const columns = [
    { key: 'code', title: 'Código', render: (a) => <span style={{ paddingLeft: `${a.depth * 1.25}rem` }} className="tabular-nums">{a.code}</span> },
    { key: 'name', title: 'Nombre', render: (a) => <span className={a.postable ? '' : 'font-semibold'}>{a.name}</span> },
    { key: 'type', title: 'Tipo', render: (a) => TYPE_LABELS[a.type] ?? a.type },
    { key: 'nature', title: 'Naturaleza', render: (a) => (a.nature === 'debit' ? 'Débito' : 'Crédito') },
    { key: 'postable', title: 'Admite asientos', render: (a) => (a.postable ? 'Sí' : 'No, agrupa') },
    { key: 'active', title: 'Estado', render: (a) => (a.active ? 'Activa' : 'Inactiva') },
    {
      key: 'actions',
      title: 'Acciones',
      render: (a) => {
        if (!can('accounts:manage')) return null;
        if (!a.active) return <TextButton onClick={() => toggle.run(a)}>Reactivar</TextButton>;
        return confirmingDeactivate === a.code ? (
          <span className="flex gap-3">
            <TextButton danger onClick={() => toggle.run(a)}>Sí, desactivar</TextButton>
            <TextButton onClick={() => setConfirmingDeactivate(null)}>Cancelar</TextButton>
          </span>
        ) : (
          <TextButton onClick={() => { setConfirmingDeactivate(a.code); toggle.clearError(); }}>Desactivar</TextButton>
        );
      },
    },
  ];

  return (
    <>
      <PageHeader title="Plan de cuentas">
        {can('accounts:manage') && tenant.country === 'CO' && !confirmSeed ? (
          <Button onClick={() => setConfirmSeed(true)}>Cargar el plan de Colombia</Button>
        ) : null}
        {can('accounts:manage') && !creating ? (
          <Button variant="primary" onClick={() => { setCreating(true); setNotice(null); }}>
            Nueva cuenta
          </Button>
        ) : null}
      </PageHeader>

      {confirmSeed ? (
        <Notice kind="info" title="¿Cargar el plan de cuentas inicial de Colombia?">
          <p className="mb-2">
            Crea las clases y los grupos principales. Es un borrador: cada empresa agrega sus cuentas y subcuentas, y tu contador debe validarlo antes de usarlo en producción. Si ya existen, no se duplican.
          </p>
          <Button variant="primary" busy={seed.busy} onClick={seed.run}>Sí, cargar el plan</Button>
          <Button className="ml-2" onClick={() => setConfirmSeed(false)}>Cancelar</Button>
        </Notice>
      ) : null}
      {seed.error ? <Notice kind="error">{errorMessage(seed.error)}</Notice> : null}
      {toggle.error ? <Notice kind="error">{errorMessage(toggle.error)}</Notice> : null}
      {notice ? <Notice kind="success">{notice}</Notice> : null}

      {creating && list.data ? (
        <AccountForm
          accounts={list.data.items}
          onCancel={() => setCreating(false)}
          onCreated={(a) => {
            setCreating(false);
            setNotice(`Se creó la cuenta ${a.code} · ${a.name}.`);
            list.reload();
          }}
        />
      ) : null}

      {list.error ? <Notice kind="error">{errorMessage(list.error)}</Notice> : null}
      {list.loading && !list.data ? <p className="text-sm text-tinta">Cargando el plan de cuentas…</p> : null}
      {list.data ? <DataTable caption="Plan de cuentas" columns={columns} rows={rows} rowKey={(a) => a.code} rowMeta={(a) => ({ depth: a.depth, kind: a.postable ? undefined : 'group' })} empty="Todavía no hay cuentas. Carga el plan inicial o crea la primera." /> : null}
    </>
  );
}
