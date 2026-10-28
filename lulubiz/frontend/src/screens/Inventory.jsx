import { useEffect, useState } from 'react';
import { ItemPicker } from '../components/ItemPicker.jsx';
import { Button, DataTable, LoadNotice, Notice, PageHeader, SearchField, SelectField, TextButton, TextField, errorMessage, useLoad, useSubmit } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { formatDay } from '../lib/format.js';
import { formatPercent, formatQuantity } from '../lib/invoicing.js';
import { ITEM_TYPES, MOVEMENT_TYPES, validateItem } from '../lib/inventory.js';
import { formatAmount } from '../lib/money.js';
import { useRouter } from '../lib/router.jsx';
import { useSession, useTenantApi } from '../lib/session.jsx';

const FALLBACK_RATES = [0, 500, 1900];

/** Cuentas activas que reciben asientos, para sugerir códigos al escribirlos. */
function useAccounts() {
  const base = useTenantApi();
  const accounts = useLoad(() => api.get(`${base}/accounts?activeOnly=true`), [base]);
  const postable = (accounts.data?.items ?? []).filter((a) => a.postable);
  const ofTypes = (...types) => postable.filter((a) => types.includes(a.type));
  return { assets: ofTypes('asset'), costs: ofTypes('cost', 'expense'), incomes: ofTypes('income'), all: postable };
}

function AccountList({ id, accounts }) {
  return (
    <datalist id={id}>
      {accounts.map((a) => (
        <option key={a.code} value={a.code}>
          {a.name}
        </option>
      ))}
    </datalist>
  );
}

const blankItem = () => ({ sku: '', name: '', type: 'goods', unit: 'UND', inventoryAccount: '', cogsAccount: '', incomeAccount: '', price: '', vatBps: '', minStock: '' });
const itemToForm = (item, currency) => ({
  sku: item.sku,
  name: item.name,
  type: item.type,
  unit: item.unit,
  inventoryAccount: item.inventoryAccount ?? '',
  cogsAccount: item.cogsAccount ?? '',
  incomeAccount: item.incomeAccount ?? '',
  price: item.price === undefined ? '' : formatAmount(item.price, currency),
  vatBps: item.vatBps === undefined ? '' : String(item.vatBps),
  minStock: item.minStock === undefined ? '' : formatQuantity(item.minStock),
});

function ItemForm({ item, onDone, onCancel }) {
  const base = useTenantApi();
  const { tenant } = useSession();
  const currency = tenant.currency;
  const editing = Boolean(item);
  const accounts = useAccounts();
  const status = useLoad(() => api.get(`${base}/purchasing/status`), [base]);
  const rates = status.data?.vatRatesBps ?? FALLBACK_RATES;
  const [form, setForm] = useState(() => (item ? itemToForm(item, currency) : blankItem()));
  const [showErrors, setShowErrors] = useState(false);
  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));
  const goods = form.type === 'goods';
  const result = validateItem({ ...form, currency }, { editing });
  const err = (field) => (showErrors ? result.errors[field] : undefined);

  const submit = useSubmit(async () => {
    setShowErrors(true);
    if (!result.ok) return;
    const saved = editing ? await api.patch(`${base}/items/${item._id}`, result.body) : await api.post(`${base}/items`, result.body);
    onDone(saved, editing);
  });

  return (
    <form
      className="mb-8 border-b border-borde pb-6"
      onSubmit={(e) => {
        e.preventDefault();
        submit.run();
      }}
    >
      <h2 className="mb-3 text-lg font-semibold text-tinta">{editing ? `Editar ${item.sku}` : 'Nuevo artículo'}</h2>
      {submit.error ? <Notice kind="error">{errorMessage(submit.error)}</Notice> : null}
      <LoadNotice load={status} what="las tarifas de IVA" />
      <AccountList id="cuentas-inventario" accounts={accounts.assets} />
      <AccountList id="cuentas-costo" accounts={accounts.costs} />
      <AccountList id="cuentas-ingreso-articulo" accounts={accounts.incomes} />
      <div className="grid gap-x-4 sm:grid-cols-3">
        <TextField label="Código" value={form.sku} onChange={set('sku')} maxLength={40} disabled={editing} error={err('sku')} hint={editing ? 'El código no se cambia.' : 'Letras, números, punto, guion.'} />
        <TextField className="sm:col-span-2" label="Nombre" value={form.name} onChange={set('name')} maxLength={200} error={err('name')} />
      </div>
      <div className="grid gap-x-4 sm:grid-cols-3">
        <SelectField label="Tipo" value={form.type} onChange={set('type')} options={ITEM_TYPES} disabled={editing} />
        <TextField label="Unidad" value={form.unit} onChange={set('unit')} maxLength={10} error={err('unit')} />
        {goods ? <TextField label="Mínimo de existencias (opcional)" value={form.minStock} onChange={set('minStock')} inputMode="decimal" error={err('minStock')} hint="Avisa cuando hay menos." /> : null}
      </div>
      {goods ? (
        <div className="grid gap-x-4 sm:grid-cols-2">
          <TextField label="Cuenta de inventario" list="cuentas-inventario" value={form.inventoryAccount} onChange={set('inventoryAccount')} disabled={editing} error={err('inventoryAccount')} hint={editing ? 'Con movimientos, no se cambia.' : 'Un activo: mercancías, materias primas…'} />
          <TextField label="Cuenta de costo de ventas" list="cuentas-costo" value={form.cogsAccount} onChange={set('cogsAccount')} disabled={editing} error={err('cogsAccount')} hint={editing ? 'Con movimientos, no se cambia.' : 'Donde se registra el costo de lo que se vende.'} />
        </div>
      ) : null}
      <div className="grid gap-x-4 sm:grid-cols-3">
        <TextField label="Cuenta de ingresos (opcional)" list="cuentas-ingreso-articulo" value={form.incomeAccount} onChange={set('incomeAccount')} error={err('incomeAccount')} hint="Si se deja vacía, la factura usa la cuenta de ventas." />
        <TextField label={`Precio de venta (${currency}, opcional)`} value={form.price} onChange={set('price')} inputMode="decimal" error={err('price')} />
        <SelectField
          label="IVA (opcional)"
          value={form.vatBps}
          onChange={set('vatBps')}
          options={[{ value: '', label: 'Sin definir' }, ...rates.map((r) => ({ value: String(r), label: formatPercent(r) }))]}
        />
      </div>
      <Button type="submit" variant="primary" busy={submit.busy}>
        {editing ? 'Guardar cambios' : 'Crear artículo'}
      </Button>
      <Button className="ml-2" onClick={onCancel}>
        Cancelar
      </Button>
    </form>
  );
}

export function ItemsScreen() {
  const base = useTenantApi();
  const { tenant, can } = useSession();
  const currency = tenant.currency;
  const { navigate } = useRouter();
  const [editing, setEditing] = useState(null); // null | 'new' | artículo
  const [notice, setNotice] = useState(null);
  const [search, setSearch] = useState(() => new URLSearchParams(window.location.search).get('q') ?? '');
  const [debounced, setDebounced] = useState(() => (new URLSearchParams(window.location.search).get('q') ?? '').trim());
  const [type, setType] = useState('');
  const [active, setActive] = useState('');
  const [extra, setExtra] = useState([]);
  const [cursor, setCursor] = useState(undefined);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const query = [debounced && `search=${encodeURIComponent(debounced)}`, type && `type=${type}`, active && `active=${active}`].filter(Boolean).join('&');
  const list = useLoad(() => api.get(`${base}/items?${query}`), [base, query]);
  const items = [...(list.data?.items ?? []), ...extra];
  const next = cursor === undefined ? list.data?.nextCursor : cursor;
  const reset = () => {
    setExtra([]);
    setCursor(undefined);
    list.reload();
  };
  const more = useSubmit(async () => {
    const page = await api.get(`${base}/items?${query}${query ? '&' : ''}cursor=${next}`);
    setExtra((e) => [...e, ...page.items]);
    setCursor(page.nextCursor);
  });
  const toggle = useSubmit(async (item) => {
    await api.patch(`${base}/items/${item._id}`, { active: !item.active });
    setNotice(`${item.sku} ${item.active ? 'desactivado' : 'activado'}.`);
    reset();
  });

  const columns = [
    { key: 'sku', title: 'Código', nowrap: true, render: (i) => i.sku },
    { key: 'name', title: 'Nombre', render: (i) => i.name },
    { key: 'type', title: 'Tipo', render: (i) => (i.type === 'goods' ? 'Bien' : 'Servicio') },
    { key: 'unit', title: 'Unidad', render: (i) => i.unit },
    { key: 'onHand', title: 'En existencia', align: 'right', render: (i) => (i.type === 'goods' ? formatQuantity(i.onHand) : '—') },
    { key: 'value', title: `Valor (${currency})`, align: 'right', render: (i) => (i.type === 'goods' ? formatAmount(i.stockValue, currency) : '—') },
    { key: 'price', title: `Precio (${currency})`, align: 'right', render: (i) => (i.price === undefined ? '—' : formatAmount(i.price, currency)) },
    { key: 'status', title: 'Estado', render: (i) => (i.active ? 'Activo' : 'Inactivo') },
    {
      key: 'actions',
      title: 'Acciones',
      render: (i) => (
        <span className="flex flex-wrap gap-3">
          {i.type === 'goods' ? <TextButton onClick={() => navigate(`/app/existencias?articulo=${i._id}`)}>Kardex</TextButton> : null}
          {can('inventory:manage') ? (
            <>
              <TextButton onClick={() => { setEditing(i); setNotice(null); }}>Editar</TextButton>
              <TextButton danger={i.active} onClick={() => toggle.run(i)}>{i.active ? 'Desactivar' : 'Activar'}</TextButton>
            </>
          ) : null}
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader title="Artículos">
        {can('inventory:manage') && !editing ? <Button variant="primary" onClick={() => { setEditing('new'); setNotice(null); }}>Nuevo artículo</Button> : null}
      </PageHeader>
      <p className="mb-4 text-sm text-tinta">Los bienes que compras y vendes. Un bien entra con cada compra, sale con cada venta y lleva su costo promedio; un servicio se vende sin existencias.</p>
      {notice ? <Notice kind="success">{notice}</Notice> : null}
      {toggle.error ? <Notice kind="error">{errorMessage(toggle.error)}</Notice> : null}
      {editing ? (
        <ItemForm
          item={editing === 'new' ? null : editing}
          onCancel={() => setEditing(null)}
          onDone={(saved, wasEditing) => {
            setEditing(null);
            setNotice(wasEditing ? `Artículo ${saved.sku} actualizado.` : `Artículo ${saved.sku} creado.`);
            reset();
          }}
        />
      ) : null}
      <div className="mb-4 grid gap-x-4 sm:grid-cols-3">
        <SearchField label="Buscar" value={search} onChange={(e) => { setSearch(e.target.value); setExtra([]); setCursor(undefined); }} hint="Por código o por nombre." />
        <SelectField label="Tipo" value={type} onChange={(e) => { setType(e.target.value); setExtra([]); setCursor(undefined); }} options={[{ value: '', label: 'Todos' }, { value: 'goods', label: 'Bienes' }, { value: 'service', label: 'Servicios' }]} />
        <SelectField label="Estado" value={active} onChange={(e) => { setActive(e.target.value); setExtra([]); setCursor(undefined); }} options={[{ value: '', label: 'Todos' }, { value: 'true', label: 'Activos' }, { value: 'false', label: 'Inactivos' }]} />
      </div>
      {list.error ? <Notice kind="error">{errorMessage(list.error)}</Notice> : null}
      {list.loading && !list.data ? <p className="text-sm text-tinta">Cargando artículos…</p> : null}
      {list.data ? <DataTable caption="Artículos" columns={columns} rows={items} rowKey={(i) => i._id} empty="No hay artículos con este filtro." /> : null}
      {more.error ? <Notice kind="error">{errorMessage(more.error)}</Notice> : null}
      {next ? (
        <div className="mt-4">
          <Button busy={more.busy} onClick={() => more.run()}>Cargar más artículos</Button>
        </div>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------------------------- existencias

function Warehouses({ warehouses, onChanged }) {
  const base = useTenantApi();
  const { can } = useSession();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [notice, setNotice] = useState(null);
  const create = useSubmit(async () => {
    if (!code.trim() || !name.trim()) throw Object.assign(new Error('Escribe el código y el nombre de la bodega.'), { status: 0 });
    const created = await api.post(`${base}/warehouses`, { code: code.trim(), name: name.trim() });
    setCode('');
    setName('');
    setNotice(`Bodega ${created.code} creada.`);
    onChanged();
  });
  const toggle = useSubmit(async (w) => {
    await api.post(`${base}/warehouses/${w._id}/active`, { active: !w.active });
    setNotice(`Bodega ${w.code} ${w.active ? 'desactivada' : 'activada'}.`);
    onChanged();
  });

  const columns = [
    { key: 'code', title: 'Código', nowrap: true, render: (w) => w.code },
    { key: 'name', title: 'Nombre', render: (w) => w.name },
    { key: 'status', title: 'Estado', render: (w) => `${w.active ? 'Activa' : 'Inactiva'}${w.isDefault ? ' · principal' : ''}` },
    {
      key: 'actions',
      title: 'Acciones',
      render: (w) => (can('inventory:manage') && !w.isDefault ? <TextButton danger={w.active} onClick={() => toggle.run(w)}>{w.active ? 'Desactivar' : 'Activar'}</TextButton> : null),
    },
  ];

  return (
    <section className="mt-10">
      <h2 className="mb-2 text-lg font-semibold text-tinta">Bodegas</h2>
      {notice ? <Notice kind="success">{notice}</Notice> : null}
      {toggle.error ? <Notice kind="error">{errorMessage(toggle.error)}</Notice> : null}
      <DataTable caption="Bodegas" columns={columns} rows={warehouses} rowKey={(w) => w._id} empty="Todavía no hay bodegas: la principal se crea con el primer movimiento." />
      {can('inventory:manage') ? (
        <form
          className="mt-4 max-w-2xl"
          onSubmit={(e) => {
            e.preventDefault();
            create.run();
          }}
        >
          <h3 className="mb-2 font-semibold text-tinta">Nueva bodega</h3>
          {create.error ? <Notice kind="error">{errorMessage(create.error)}</Notice> : null}
          <div className="grid gap-x-4 sm:grid-cols-3">
            <TextField label="Código" value={code} onChange={(e) => setCode(e.target.value)} maxLength={10} />
            <TextField className="sm:col-span-2" label="Nombre" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
          </div>
          <Button type="submit" busy={create.busy}>Crear bodega</Button>
        </form>
      ) : null}
    </section>
  );
}

function Kardex({ warehouses, preset }) {
  const base = useTenantApi();
  const { tenant } = useSession();
  const currency = tenant.currency;
  const [text, setText] = useState(preset?.sku ?? '');
  const [item, setItem] = useState(preset ?? null);
  const [warehouseId, setWarehouseId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [extra, setExtra] = useState([]);
  const [cursor, setCursor] = useState(undefined);
  const names = Object.fromEntries(warehouses.map((w) => [w._id, w.code]));

  const query = item ? [`itemId=${item._id}`, warehouseId && `warehouseId=${warehouseId}`, from && `from=${from}`, to && `to=${to}`].filter(Boolean).join('&') : '';
  const list = useLoad(() => (item ? api.get(`${base}/kardex?${query}`) : Promise.resolve(null)), [base, query]);
  const rows = [...(list.data?.items ?? []), ...extra];
  const next = cursor === undefined ? list.data?.nextCursor : cursor;
  const more = useSubmit(async () => {
    const page = await api.get(`${base}/kardex?${query}&cursor=${next}`);
    setExtra((e) => [...e, ...page.items]);
    setCursor(page.nextCursor);
  });
  const restart = () => {
    setExtra([]);
    setCursor(undefined);
  };

  const columns = [
    { key: 'date', title: 'Fecha', nowrap: true, render: (m) => formatDay(m.date) },
    { key: 'type', title: 'Movimiento', render: (m) => MOVEMENT_TYPES[m.type] ?? m.type },
    { key: 'warehouse', title: 'Bodega', render: (m) => names[m.warehouseId] ?? '' },
    { key: 'in', title: 'Entra', align: 'right', render: (m) => (m.quantity > 0 ? formatQuantity(m.quantity) : '') },
    { key: 'out', title: 'Sale', align: 'right', render: (m) => (m.quantity < 0 ? formatQuantity(-m.quantity) : '') },
    { key: 'value', title: `Valor (${currency})`, align: 'right', render: (m) => formatAmount(m.value, currency) },
    { key: 'balance', title: 'Saldo', align: 'right', render: (m) => formatQuantity(m.balanceQuantity) },
    { key: 'balanceValue', title: `Valor saldo (${currency})`, align: 'right', render: (m) => formatAmount(m.balanceValue, currency) },
  ];

  return (
    <section className="mt-10">
      <h2 className="mb-2 text-lg font-semibold text-tinta">Kardex</h2>
      <p className="mb-3 text-sm text-tinta">Todos los movimientos de un artículo, con el saldo en cantidad y valor que dejó cada uno.</p>
      <div className="grid gap-x-4 sm:grid-cols-4">
        <div>
          <p className="mb-1 text-sm font-semibold text-tinta">Artículo</p>
          <ItemPicker
            base={base}
            text={text}
            item={item}
            showStock={false}
            onChange={(t, i) => {
              setText(t);
              setItem(i);
              restart();
            }}
          />
        </div>
        <SelectField label="Bodega" value={warehouseId} onChange={(e) => { setWarehouseId(e.target.value); restart(); }} options={[{ value: '', label: 'Todas' }, ...warehouses.map((w) => ({ value: w._id, label: w.code }))]} />
        <TextField label="Desde" type="date" value={from} onChange={(e) => { setFrom(e.target.value); restart(); }} />
        <TextField label="Hasta" type="date" value={to} onChange={(e) => { setTo(e.target.value); restart(); }} />
      </div>
      {list.error ? <Notice kind="error">{errorMessage(list.error)}</Notice> : null}
      {item && list.data ? <DataTable caption={`Kardex de ${item.sku}`} columns={columns} rows={rows} rowKey={(m) => m._id} empty="Este artículo no tiene movimientos con este filtro." /> : null}
      {more.error ? <Notice kind="error">{errorMessage(more.error)}</Notice> : null}
      {next ? (
        <div className="mt-4">
          <Button busy={more.busy} onClick={() => more.run()}>Cargar más movimientos</Button>
        </div>
      ) : null}
    </section>
  );
}

export function StockScreen() {
  const base = useTenantApi();
  const { tenant } = useSession();
  const currency = tenant.currency;
  const { search } = useRouter();
  const presetId = new URLSearchParams(search).get('articulo');
  const [warehouseId, setWarehouseId] = useState('');
  const warehouses = useLoad(() => api.get(`${base}/warehouses`), [base]);
  const valuation = useLoad(() => api.get(`${base}/inventory/valuation${warehouseId ? `?warehouseId=${warehouseId}` : ''}`), [base, warehouseId]);
  const low = useLoad(() => api.get(`${base}/inventory/low-stock`), [base]);
  const preset = useLoad(() => (presetId && /^[a-f0-9]{24}$/.test(presetId) ? api.get(`${base}/items/${presetId}`) : Promise.resolve(null)), [base, presetId]);
  const list = warehouses.data?.items ?? [];

  const rowColumns = [
    { key: 'sku', title: 'Código', nowrap: true, render: (r) => r.sku },
    { key: 'name', title: 'Artículo', render: (r) => r.name },
    { key: 'warehouse', title: 'Bodega', render: (r) => r.warehouseCode },
    { key: 'quantity', title: 'Cantidad', align: 'right', render: (r) => `${formatQuantity(r.quantity)} ${r.unit}` },
    { key: 'cost', title: `Costo promedio (${currency})`, align: 'right', render: (r) => formatAmount(r.averageCost, currency) },
    { key: 'value', title: `Valor (${currency})`, align: 'right', render: (r) => formatAmount(r.value, currency) },
  ];
  const accountColumns = [
    { key: 'account', title: 'Cuenta', nowrap: true, render: (a) => a.account },
    { key: 'stock', title: `Valor de las existencias (${currency})`, align: 'right', render: (a) => formatAmount(a.stockValue, currency) },
    { key: 'ledger', title: `Saldo en el libro (${currency})`, align: 'right', render: (a) => formatAmount(a.ledgerBalance, currency) },
    {
      key: 'difference',
      title: 'Diferencia',
      align: 'right',
      render: (a) => (a.difference === 0 ? 'Cuadra' : `No cuadra: ${formatAmount(a.difference, currency)}`),
    },
  ];
  const lowColumns = [
    { key: 'sku', title: 'Código', nowrap: true, render: (i) => i.sku },
    { key: 'name', title: 'Artículo', render: (i) => i.name },
    { key: 'onHand', title: 'En existencia', align: 'right', render: (i) => `${formatQuantity(i.onHand)} ${i.unit}` },
    { key: 'min', title: 'Mínimo', align: 'right', render: (i) => `${formatQuantity(i.minStock)} ${i.unit}` },
  ];

  const data = valuation.data;
  const unbalanced = data?.accounts.some((a) => a.difference !== 0);

  return (
    <>
      <PageHeader title="Existencias" />
      <p className="mb-4 text-sm text-tinta">Lo que hay en cada bodega, a qué costo, y si el valor de las existencias coincide con el saldo contable de su cuenta de inventario.</p>
      {warehouses.error ? <Notice kind="error">{errorMessage(warehouses.error)}</Notice> : null}
      <LoadNotice load={preset} what="el artículo" forbidden />
      {valuation.error ? <Notice kind="error">{errorMessage(valuation.error)}</Notice> : null}
      {unbalanced ? <Notice kind="error" title="El inventario no cuadra con el libro">Revisa la tabla de cuadre: alguna cuenta de inventario tiene un saldo distinto al valor de sus existencias.</Notice> : null}

      <div className="mb-4 grid gap-x-4 sm:grid-cols-3">
        <SelectField label="Bodega" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} options={[{ value: '', label: 'Todas' }, ...list.map((w) => ({ value: w._id, label: `${w.code} — ${w.name}` }))]} />
      </div>
      {valuation.loading && !data ? <p className="text-sm text-tinta">Cargando existencias…</p> : null}
      {data ? (
        <>
          <DataTable caption="Valoración del inventario" columns={rowColumns} rows={data.rows} rowKey={(r) => `${r.itemId}-${r.warehouseId}`} empty="Todavía no hay existencias. Entran con una compra o con un ajuste." />
          {data.truncated ? <p className="mt-2 text-sm text-tinta">Se muestran los primeros {data.rows.length} renglones; filtra por bodega para ver el resto.</p> : null}
          <p className="mt-2 text-right text-sm font-semibold text-tinta">Valor total: {formatAmount(data.total, currency)} {currency}</p>
          <h2 className="mb-2 mt-8 text-lg font-semibold text-tinta">Cuadre con el libro</h2>
          <DataTable caption="Cuadre del inventario con el libro" columns={accountColumns} rows={data.accounts} rowKey={(a) => a.account} empty="Sin cuentas de inventario con existencias." />
        </>
      ) : null}

      <h2 className="mb-2 mt-8 text-lg font-semibold text-tinta">Por debajo del mínimo</h2>
      {low.error ? <Notice kind="error">{errorMessage(low.error)}</Notice> : null}
      {low.data ? <DataTable caption="Artículos por debajo del mínimo" columns={lowColumns} rows={low.data.items} rowKey={(i) => i._id} empty="Ningún artículo está por debajo de su mínimo." /> : null}

      {preset.loading && presetId ? null : <Kardex key={preset.data?._id ?? 'sin-articulo'} warehouses={list} preset={preset.data} />}
      <Warehouses warehouses={list} onChanged={warehouses.reload} />
    </>
  );
}
