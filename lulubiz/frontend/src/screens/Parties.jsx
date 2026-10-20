import { useEffect, useState } from 'react';
import { Button, DataTable, Notice, PageHeader, SelectField, TextButton, TextField, errorMessage, useLoad, useSubmit } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { nitCheckDigit, taxIdTypesFor } from '../lib/nit.js';
import { useSession, useTenantApi } from '../lib/session.jsx';

const ROLE_LABELS = { customer: 'Cliente', supplier: 'Proveedor' };

/** "890.903.938-8" para un NIT; "CC 1075123456" para el resto. */
export function formatTaxId(party) {
  const grouped = party.taxId.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return party.taxIdType === 'NIT' ? `NIT ${grouped}-${party.checkDigit}` : `${party.taxIdType} ${party.taxId}`;
}

const blank = (country) => ({
  name: '',
  roles: ['customer'],
  taxIdType: taxIdTypesFor(country)[0].value,
  taxId: '',
  email: '',
  phone: '',
  line: '',
  city: '',
  region: '',
});

function PartyForm({ country, party, onSaved, onCancel }) {
  const base = useTenantApi();
  const editing = Boolean(party);
  const [form, setForm] = useState(() =>
    editing
      ? { ...blank(country), name: party.name, roles: party.roles, taxIdType: party.taxIdType, taxId: party.taxId, email: party.email ?? '', phone: party.phone ?? '', line: party.address?.line ?? '', city: party.address?.city ?? '', region: party.address?.region ?? '' }
      : blank(country),
  );
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const toggleRole = (role) => setForm((f) => ({ ...f, roles: f.roles.includes(role) ? f.roles.filter((r) => r !== role) : [...f.roles, role] }));
  const isNit = form.taxIdType === 'NIT';
  const checkDigit = isNit && form.taxId ? nitCheckDigit(form.taxId.replace(/\./g, '')) : null;

  const submit = useSubmit(async () => {
    const contact = {
      ...(form.email.trim() ? { email: form.email.trim() } : {}),
      ...(form.phone.trim() ? { phone: form.phone.trim() } : {}),
      ...(form.line || form.city || form.region ? { address: { line: form.line, city: form.city, region: form.region } } : {}),
    };
    if (editing) {
      const saved = await api.patch(`${base}/parties/${party._id}`, { name: form.name.trim(), roles: form.roles, ...contact });
      onSaved(saved, 'actualizado');
    } else {
      const saved = await api.post(`${base}/parties`, {
        name: form.name.trim(),
        roles: form.roles,
        taxIdType: form.taxIdType,
        taxId: form.taxId.replace(/[.\s]/g, ''),
        ...(isNit ? { checkDigit } : {}),
        ...contact,
      });
      onSaved(saved, 'creado');
    }
  });

  return (
    <form
      className="mb-8 border-b border-borde pb-6"
      onSubmit={(e) => {
        e.preventDefault();
        submit.run();
      }}
    >
      <h2 className="mb-3 text-lg font-semibold text-tinta">{editing ? `Editar ${party.name}` : 'Nuevo tercero'}</h2>
      {submit.error ? <Notice kind="error">{errorMessage(submit.error)}</Notice> : null}
      <div className="grid gap-x-4 sm:grid-cols-2">
        <TextField label="Nombre o razón social" value={form.name} onChange={set('name')} maxLength={200} required />
        <fieldset className="mb-4">
          <legend className="mb-1 text-sm font-semibold text-tinta">Es</legend>
          <div className="flex gap-4 py-1.5">
            {Object.entries(ROLE_LABELS).map(([role, label]) => (
              <label key={role} className="flex items-center gap-2 text-sm text-tinta">
                <input type="checkbox" checked={form.roles.includes(role)} onChange={() => toggleRole(role)} className="size-4 accent-azul" />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
        <SelectField label="Tipo de documento" value={form.taxIdType} onChange={set('taxIdType')} options={taxIdTypesFor(country)} disabled={editing} />
        <div className="grid grid-cols-[1fr_6rem] gap-x-3">
          <TextField label="Número de documento" value={form.taxId} onChange={set('taxId')} disabled={editing} maxLength={30} required hint={editing ? 'La identificación no se edita.' : undefined} />
          {isNit ? (
            <TextField label="Dígito" value={checkDigit ?? ''} readOnly hint="Se calcula solo." />
          ) : null}
        </div>
        <TextField label="Correo electrónico" type="email" value={form.email} onChange={set('email')} />
        <TextField label="Teléfono" value={form.phone} onChange={set('phone')} maxLength={30} />
        <TextField label="Dirección" value={form.line} onChange={set('line')} />
        <div className="grid grid-cols-2 gap-x-3">
          <TextField label="Ciudad" value={form.city} onChange={set('city')} />
          <TextField label="Departamento o región" value={form.region} onChange={set('region')} />
        </div>
      </div>
      <Button type="submit" variant="primary" busy={submit.busy}>
        {editing ? 'Guardar cambios' : 'Crear tercero'}
      </Button>
      <Button className="ml-2" onClick={onCancel}>
        Cancelar
      </Button>
    </form>
  );
}

export function PartiesScreen() {
  const base = useTenantApi();
  const { tenant, can } = useSession();
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [role, setRole] = useState('');
  const [activeOnly, setActiveOnly] = useState(false);
  const [form, setForm] = useState(null); // null | 'new' | party
  const [notice, setNotice] = useState(null);
  const [extra, setExtra] = useState([]);
  const [cursor, setCursor] = useState(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const query = new URLSearchParams({ ...(debounced ? { search: debounced } : {}), ...(role ? { role } : {}), ...(activeOnly ? { activeOnly: 'true' } : {}) }).toString();
  const list = useLoad(() => api.get(`${base}/parties?${query}`), [base, query]);
  const items = [...(list.data?.items ?? []), ...extra];
  const next = cursor === undefined ? list.data?.nextCursor : cursor;

  useEffect(() => {
    setExtra([]);
    setCursor(undefined);
  }, [query]);

  const loadMore = async () => {
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await api.get(`${base}/parties?${query}${query ? '&' : ''}cursor=${next}`);
      setExtra((e) => [...e, ...page.items]);
      setCursor(page.nextCursor);
    } catch (error) {
      setMoreError(error);
    } finally {
      setLoadingMore(false);
    }
  };

  const toggle = useSubmit(async (party) => {
    await api.post(`${base}/parties/${party._id}/active`, { active: !party.active });
    setExtra([]);
    setCursor(undefined);
    list.reload();
  });

  const columns = [
    { key: 'name', title: 'Nombre' },
    { key: 'taxId', title: 'Documento', render: (p) => <span className="tabular-nums">{formatTaxId(p)}</span> },
    { key: 'roles', title: 'Es', render: (p) => p.roles.map((r) => ROLE_LABELS[r]).join(' y ') },
    { key: 'email', title: 'Correo', render: (p) => p.email ?? '' },
    { key: 'phone', title: 'Teléfono', render: (p) => p.phone ?? '' },
    { key: 'active', title: 'Estado', render: (p) => (p.active ? 'Activo' : 'Inactivo') },
    {
      key: 'actions',
      title: 'Acciones',
      render: (p) =>
        can('parties:manage') ? (
          <span className="flex gap-3">
            <TextButton onClick={() => { setForm(p); setNotice(null); }}>Editar</TextButton>
            <TextButton onClick={() => toggle.run(p)}>{p.active ? 'Desactivar' : 'Activar'}</TextButton>
          </span>
        ) : null,
    },
  ];

  return (
    <>
      <PageHeader title="Terceros">
        {can('parties:manage') && !form ? (
          <Button variant="primary" onClick={() => { setForm('new'); setNotice(null); }}>
            Nuevo tercero
          </Button>
        ) : null}
      </PageHeader>

      {notice ? <Notice kind="success">{notice}</Notice> : null}
      {toggle.error ? <Notice kind="error">{errorMessage(toggle.error)}</Notice> : null}

      {form ? (
        <PartyForm
          key={form === 'new' ? 'new' : form._id}
          country={tenant.country}
          party={form === 'new' ? null : form}
          onCancel={() => setForm(null)}
          onSaved={(saved, verb) => {
            setForm(null);
            setNotice(`Tercero ${verb}: ${saved.name}.`);
            setExtra([]);
            setCursor(undefined);
            list.reload();
          }}
        />
      ) : null}

      <div className="mb-4 grid gap-x-4 sm:grid-cols-3">
        <TextField label="Buscar" value={search} onChange={(e) => setSearch(e.target.value)} hint="Por nombre o por número de documento." />
        <SelectField label="Mostrar" value={role} onChange={(e) => setRole(e.target.value)} options={[{ value: '', label: 'Clientes y proveedores' }, { value: 'customer', label: 'Solo clientes' }, { value: 'supplier', label: 'Solo proveedores' }]} />
        <label className="mb-4 flex items-center gap-2 pt-7 text-sm text-tinta">
          <input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} className="size-4 accent-azul" />
          Solo activos
        </label>
      </div>

      {list.error ? <Notice kind="error">{errorMessage(list.error)}</Notice> : null}
      {list.loading && !list.data ? <p className="text-sm text-tinta">Cargando terceros…</p> : null}
      {list.data ? <DataTable caption="Terceros" columns={columns} rows={items} rowKey={(p) => p._id} empty="No hay terceros con estos filtros." /> : null}
      {moreError ? <Notice kind="error">{errorMessage(moreError)}</Notice> : null}
      {next ? (
        <div className="mt-4">
          <Button busy={loadingMore} onClick={loadMore}>
            Cargar más terceros
          </Button>
        </div>
      ) : null}
    </>
  );
}
