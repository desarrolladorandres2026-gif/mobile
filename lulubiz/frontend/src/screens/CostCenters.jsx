import { useState } from 'react';
import { Button, DataTable, Notice, PageHeader, TextButton, TextField, errorMessage, useLoad, useSubmit } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { normalizeCenterCode } from '../lib/costCenters.js';
import { useSession, useTenantApi } from '../lib/session.jsx';

function CenterForm({ center, onDone, onCancel }) {
  const base = useTenantApi();
  const editing = Boolean(center);
  const [code, setCode] = useState(center?.code ?? '');
  const [name, setName] = useState(center?.name ?? '');
  const [error, setError] = useState(null);

  const save = useSubmit(async () => {
    setError(null);
    if (!editing && !code) return setError('Escribe el código del centro.');
    if (!name.trim()) return setError('Escribe el nombre del centro.');
    const saved = editing ? await api.patch(`${base}/cost-centers/${center.code}`, { name: name.trim() }) : await api.post(`${base}/cost-centers`, { code, name: name.trim() });
    return onDone(saved, editing);
  });

  return (
    <form
      className="mb-8 border-b border-borde pb-6"
      onSubmit={(e) => {
        e.preventDefault();
        save.run();
      }}
    >
      <h2 className="mb-3 text-lg font-semibold text-tinta">{editing ? `Editar el centro ${center.code}` : 'Nuevo centro de costo'}</h2>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {save.error ? <Notice kind="error">{errorMessage(save.error)}</Notice> : null}
      <div className="grid gap-x-4 sm:grid-cols-3">
        <TextField
          label="Código"
          value={code}
          onChange={(e) => setCode(normalizeCenterCode(e.target.value))}
          maxLength={10}
          disabled={editing}
          hint={editing ? 'El código no se cambia.' : 'Letras, números, guion y guion bajo; hasta 10.'}
        />
        <TextField className="sm:col-span-2" label="Nombre" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
      </div>
      <Button type="submit" variant="primary" busy={save.busy}>
        {editing ? 'Guardar cambios' : 'Crear centro'}
      </Button>
      <Button className="ml-2" onClick={onCancel}>
        Cancelar
      </Button>
    </form>
  );
}

export function CostCentersScreen() {
  const base = useTenantApi();
  const { can } = useSession();
  const list = useLoad(() => api.get(`${base}/cost-centers`), [base]);
  const [editing, setEditing] = useState(null); // null | 'new' | centro
  const [notice, setNotice] = useState(null);
  const toggle = useSubmit(async (center) => {
    await api.patch(`${base}/cost-centers/${center.code}`, { active: !center.active });
    setNotice(`Centro ${center.code} ${center.active ? 'desactivado' : 'activado'}.`);
    list.reload();
  });
  const manage = can('accounts:manage');

  const columns = [
    { key: 'code', title: 'Código', nowrap: true, render: (c) => c.code },
    { key: 'name', title: 'Nombre', render: (c) => c.name },
    { key: 'status', title: 'Estado', render: (c) => (c.active ? 'Activo' : 'Inactivo') },
    {
      key: 'actions',
      title: 'Acciones',
      render: (c) =>
        manage ? (
          <span className="flex flex-wrap gap-3">
            <TextButton onClick={() => { setEditing(c); setNotice(null); }}>Editar</TextButton>
            <TextButton danger={c.active} onClick={() => toggle.run(c)}>
              {c.active ? 'Desactivar' : 'Activar'}
            </TextButton>
          </span>
        ) : null,
    },
  ];

  return (
    <>
      <PageHeader title="Centros de costo">
        {manage && !editing ? (
          <Button variant="primary" onClick={() => { setEditing('new'); setNotice(null); }}>
            Nuevo centro
          </Button>
        ) : null}
      </PageHeader>
      <p className="mb-4 text-sm text-tinta">
        Un centro de costo es una sede, un proyecto o un área a la que se asignan ingresos y gastos. Se elige en cada línea de un asiento, una factura, una compra o una caja, y el informe «Resultado por centro de costo» (en Libros y estados de cuenta) reparte el estado de resultados entre ellos. Un centro desactivado deja de poder usarse, pero conserva su historia.
      </p>
      {notice ? <Notice kind="success">{notice}</Notice> : null}
      {toggle.error ? <Notice kind="error">{errorMessage(toggle.error)}</Notice> : null}
      {editing ? (
        <CenterForm
          center={editing === 'new' ? null : editing}
          onCancel={() => setEditing(null)}
          onDone={(saved, wasEditing) => {
            setEditing(null);
            setNotice(wasEditing ? `Centro ${saved.code} actualizado.` : `Centro ${saved.code} creado.`);
            list.reload();
          }}
        />
      ) : null}
      {list.error ? <Notice kind="error">{errorMessage(list.error)}</Notice> : null}
      {list.loading && !list.data ? <p className="text-sm text-tinta">Cargando centros de costo…</p> : null}
      {list.data ? <DataTable caption="Centros de costo" columns={columns} rows={list.data.items} rowKey={(c) => c.code} empty="Todavía no hay centros de costo." /> : null}
    </>
  );
}
