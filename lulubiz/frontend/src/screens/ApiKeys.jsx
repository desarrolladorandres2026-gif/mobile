import { useState } from 'react';
import { Button, DataTable, Notice, PageHeader, TextButton, TextField, errorMessage, useLoad, useSubmit } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { groupScopes, scopeLabel, validateKey } from '../lib/apiKeys.js';
import { formatDay } from '../lib/format.js';
import { useTenantApi } from '../lib/session.jsx';

const today = () => new Date().toISOString().slice(0, 10);

/** El token se muestra una sola vez: aquí, justo al crearla. */
function NewToken({ created, onDone }) {
  return (
    <div className="mb-8 border-b border-borde pb-6">
      <Notice kind="success" title={`Clave «${created.apiKey.name}» creada`}>
        Cópiala ahora y guárdala en el sistema que la va a usar. <strong>No se vuelve a mostrar</strong>: si se pierde, se revoca y se crea otra.
      </Notice>
      <label htmlFor="token-nuevo" className="mb-1 block text-sm font-semibold text-tinta">
        Clave de API
      </label>
      <input
        id="token-nuevo"
        readOnly
        value={created.token}
        onFocus={(e) => e.target.select()}
        className="mb-3 w-full max-w-3xl rounded-sm border border-borde-fuerte bg-papel px-2.5 py-1.5 text-sm text-tinta focus:outline-2 focus:outline-azul"
      />
      <p className="mb-3 text-sm text-tinta">Se usa en la cabecera <span>Authorization: Bearer …</span> de cada petición a la API.</p>
      <Button variant="primary" onClick={onDone}>
        Ya la guardé
      </Button>
    </div>
  );
}

function KeyForm({ onCreated, onCancel }) {
  const base = useTenantApi();
  const scopes = useLoad(() => api.get(`${base}/api-keys/scopes`), [base]);
  const [name, setName] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [chosen, setChosen] = useState([]);
  const [showErrors, setShowErrors] = useState(false);
  const result = validateKey({ name, scopes: chosen, expiresAt }, today());
  const groups = groupScopes(scopes.data?.scopes ?? []);
  const toggle = (scope) => setChosen((list) => (list.includes(scope) ? list.filter((s) => s !== scope) : [...list, scope]));

  const create = useSubmit(async () => {
    setShowErrors(true);
    if (!result.ok) return;
    onCreated(await api.post(`${base}/api-keys`, result.body));
  });

  return (
    <form
      className="mb-8 border-b border-borde pb-6"
      onSubmit={(e) => {
        e.preventDefault();
        create.run();
      }}
    >
      <h2 className="mb-3 text-lg font-semibold text-tinta">Nueva clave de API</h2>
      {create.error ? <Notice kind="error">{errorMessage(create.error)}</Notice> : null}
      {scopes.error ? <Notice kind="error">{errorMessage(scopes.error)}</Notice> : null}
      <div className="grid gap-x-4 sm:grid-cols-2">
        <TextField label="Nombre" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} error={showErrors ? result.errors.name : undefined} hint="Para qué se usa: «Tienda en línea», «Contador externo»…" />
        <TextField label="Vence el (opcional)" type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} error={showErrors ? result.errors.expiresAt : undefined} hint="Sin fecha, no vence; se revoca cuando haga falta." />
      </div>
      <fieldset className="mb-4">
        <legend className="mb-1 text-sm font-semibold text-tinta">Permisos</legend>
        <p className="mb-2 text-sm text-tinta">Da solo lo que el otro sistema necesita. Una clave nunca administra la empresa, sus miembros ni sus claves.</p>
        {showErrors && result.errors.scopes ? (
          <p role="alert" className="mb-2 text-sm font-semibold text-rojo">
            {result.errors.scopes}
          </p>
        ) : null}
        <div className="grid gap-x-8 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
          {groups.map((g) => (
            <div key={g.area}>
              <p className="mb-1 text-sm font-semibold text-tinta">{g.title}</p>
              {g.items.map((i) => (
                <label key={i.scope} className="mb-1 flex items-start gap-2 text-sm text-tinta">
                  <input type="checkbox" checked={chosen.includes(i.scope)} onChange={() => toggle(i.scope)} className="mt-0.5 size-4 accent-azul" />
                  {i.label}
                </label>
              ))}
            </div>
          ))}
        </div>
      </fieldset>
      <Button type="submit" variant="primary" busy={create.busy}>
        Crear clave
      </Button>
      <Button className="ml-2" onClick={onCancel}>
        Cancelar
      </Button>
    </form>
  );
}

export function ApiKeysScreen() {
  const base = useTenantApi();
  const list = useLoad(() => api.get(`${base}/api-keys`), [base]);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState(null);
  const [open, setOpen] = useState(null);
  const [confirming, setConfirming] = useState(null);
  const [notice, setNotice] = useState(null);
  const revoke = useSubmit(async (key) => {
    await api.post(`${base}/api-keys/${key._id}/revoke`);
    setNotice(`Clave «${key.name}» revocada: deja de servir de inmediato.`);
    setConfirming(null);
    list.reload();
  });

  const state = (k) => {
    if (k.revokedAt) return 'Revocada';
    if (k.expiresAt && k.expiresAt.slice(0, 10) < today()) return 'Vencida';
    return 'Activa';
  };
  const columns = [
    { key: 'name', title: 'Nombre', render: (k) => k.name },
    { key: 'prefix', title: 'Identificador', nowrap: true, render: (k) => <span>lbk_{k.prefix}_…</span> },
    { key: 'scopes', title: 'Permisos', render: (k) => `${k.scopes.length}` },
    { key: 'created', title: 'Creada', nowrap: true, render: (k) => formatDay(k.createdAt) },
    { key: 'used', title: 'Último uso', nowrap: true, render: (k) => (k.lastUsedAt ? formatDay(k.lastUsedAt) : 'Nunca') },
    { key: 'expires', title: 'Vence', nowrap: true, render: (k) => (k.expiresAt ? formatDay(k.expiresAt) : 'No vence') },
    { key: 'status', title: 'Estado', render: state },
    {
      key: 'actions',
      title: 'Acciones',
      render: (k) => {
        if (confirming === k._id) {
          return (
            <span className="flex flex-wrap gap-3">
              <TextButton danger onClick={() => revoke.run(k)}>Sí, revocar</TextButton>
              <TextButton onClick={() => setConfirming(null)}>Cancelar</TextButton>
            </span>
          );
        }
        return (
          <span className="flex flex-wrap gap-3">
            <TextButton onClick={() => setOpen(open === k._id ? null : k._id)}>{open === k._id ? 'Ocultar permisos' : 'Ver permisos'}</TextButton>
            {!k.revokedAt ? <TextButton danger onClick={() => { setConfirming(k._id); revoke.clearError(); }}>Revocar</TextButton> : null}
          </span>
        );
      },
    },
  ];

  return (
    <>
      <PageHeader title="Claves de API">
        {!creating && !created ? <Button variant="primary" onClick={() => { setCreating(true); setNotice(null); }}>Nueva clave</Button> : null}
      </PageHeader>
      <p className="mb-4 text-sm text-tinta">Permiten que otro sistema (una tienda en línea, un contador externo) use Lulubiz sin una persona delante. Cada clave tiene sus propios permisos, se puede revocar al instante y lo que hace queda en la auditoría a nombre de la clave.</p>
      {notice ? <Notice kind="success">{notice}</Notice> : null}
      {revoke.error ? <Notice kind="error">{errorMessage(revoke.error)}</Notice> : null}
      {created ? (
        <NewToken
          created={created}
          onDone={() => {
            setCreated(null);
            list.reload();
          }}
        />
      ) : null}
      {creating ? (
        <KeyForm
          onCancel={() => setCreating(false)}
          onCreated={(result) => {
            setCreating(false);
            setCreated(result);
          }}
        />
      ) : null}
      {list.error ? <Notice kind="error">{errorMessage(list.error)}</Notice> : null}
      {list.loading && !list.data ? <p className="text-sm text-tinta">Cargando claves…</p> : null}
      {list.data ? (
        <DataTable
          caption="Claves de API"
          columns={columns}
          rows={list.data.items}
          rowKey={(k) => k._id}
          empty="Todavía no hay claves."
          expandedRow={(k) =>
            open === k._id ? (
              <ul className="my-2 list-disc pl-6 text-sm text-tinta">
                {k.scopes.map((s) => (
                  <li key={s}>{scopeLabel(s)}</li>
                ))}
              </ul>
            ) : null
          }
        />
      ) : null}
    </>
  );
}
