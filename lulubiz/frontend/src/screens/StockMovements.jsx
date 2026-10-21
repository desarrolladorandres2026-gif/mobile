import { useState } from 'react';
import { ItemPicker } from '../components/ItemPicker.jsx';
import { Button, DataTable, Notice, PageHeader, SelectField, TextField, errorMessage, useLoad, useSubmit } from '../components/ui.jsx';
import { api, newIdempotencyKey } from '../lib/api.js';
import { formatDay } from '../lib/format.js';
import { formatQuantity } from '../lib/invoicing.js';
import { validateAdjustment, validateTransfer } from '../lib/inventory.js';
import { formatAmount } from '../lib/money.js';
import { useSession, useTenantApi } from '../lib/session.jsx';

const today = () => new Date().toISOString().slice(0, 10);

function AdjustmentForm({ warehouses, accounts, onDone, onCancel }) {
  const base = useTenantApi();
  const { tenant } = useSession();
  const currency = tenant.currency;
  const [form, setForm] = useState({ direction: 'in', warehouseId: '', date: today(), quantity: '', unitCost: '', counterAccount: '', reason: '' });
  const [pick, setPick] = useState({ text: '', item: null });
  const [showErrors, setShowErrors] = useState(false);
  const [key, setKey] = useState(newIdempotencyKey);
  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));
  const result = validateAdjustment({ ...form, itemId: pick.item?._id ?? '', currency });
  const err = (field) => (showErrors ? result.errors[field] : undefined);
  const incoming = form.direction === 'in';

  const submit = useSubmit(async () => {
    setShowErrors(true);
    if (!result.ok) return;
    const outcome = await api.post(`${base}/stock/adjustments`, result.body, { 'idempotency-key': key });
    setKey(newIdempotencyKey());
    onDone(outcome.doc);
  });

  return (
    <form
      className="mb-8 border-b border-borde pb-6"
      onSubmit={(e) => {
        e.preventDefault();
        submit.run();
      }}
    >
      <h2 className="mb-3 text-lg font-semibold text-tinta">Ajuste de existencias</h2>
      {submit.error ? <Notice kind="error">{errorMessage(submit.error)}</Notice> : null}
      <datalist id="cuentas-contrapartida">
        {accounts.map((a) => (
          <option key={a.code} value={a.code}>
            {a.name}
          </option>
        ))}
      </datalist>
      <div className="grid gap-x-4 sm:grid-cols-4">
        <SelectField label="Tipo de ajuste" value={form.direction} onChange={set('direction')} options={[{ value: 'in', label: 'Entrada' }, { value: 'out', label: 'Salida' }]} />
        <div className="sm:col-span-2">
          <p className="mb-1 text-sm font-semibold text-tinta">Artículo</p>
          <ItemPicker base={base} text={pick.text} item={pick.item} onChange={(text, item) => setPick({ text, item })} error={err('itemId')} />
        </div>
        <SelectField label="Bodega" value={form.warehouseId} onChange={set('warehouseId')} options={[{ value: '', label: 'Principal' }, ...warehouses.filter((w) => w.active && !w.isDefault).map((w) => ({ value: w._id, label: `${w.code} — ${w.name}` }))]} />
      </div>
      <div className="grid gap-x-4 sm:grid-cols-4">
        <TextField label="Fecha" type="date" value={form.date} onChange={set('date')} error={err('date')} />
        <TextField label="Cantidad" value={form.quantity} onChange={set('quantity')} inputMode="decimal" error={err('quantity')} />
        {incoming ? <TextField label={`Costo unitario (${currency})`} value={form.unitCost} onChange={set('unitCost')} inputMode="decimal" error={err('unitCost')} hint="Lo que cuesta cada unidad que entra." /> : <p className="self-center text-sm text-tinta">La salida cuesta el costo promedio del momento.</p>}
        <TextField
          label="Cuenta contrapartida"
          list="cuentas-contrapartida"
          value={form.counterAccount}
          onChange={set('counterAccount')}
          error={err('counterAccount')}
          hint={incoming ? 'Por ejemplo, capital o ganancia por sobrante.' : 'Por ejemplo, pérdida o gasto por faltante.'}
        />
      </div>
      <TextField label="Motivo" value={form.reason} onChange={set('reason')} maxLength={200} error={err('reason')} />
      <Button type="submit" variant="primary" busy={submit.busy}>
        Registrar ajuste
      </Button>
      <Button className="ml-2" onClick={onCancel}>
        Cancelar
      </Button>
    </form>
  );
}

function TransferForm({ warehouses, onDone, onCancel }) {
  const base = useTenantApi();
  const active = warehouses.filter((w) => w.active);
  const [form, setForm] = useState({ fromWarehouseId: '', toWarehouseId: '', date: today(), quantity: '', note: '' });
  const [pick, setPick] = useState({ text: '', item: null });
  const [showErrors, setShowErrors] = useState(false);
  const [key, setKey] = useState(newIdempotencyKey);
  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));
  const result = validateTransfer({ ...form, itemId: pick.item?._id ?? '' });
  const err = (field) => (showErrors ? result.errors[field] : undefined);
  const options = [{ value: '', label: 'Elige una bodega' }, ...active.map((w) => ({ value: w._id, label: `${w.code} — ${w.name}` }))];

  const submit = useSubmit(async () => {
    setShowErrors(true);
    if (!result.ok) return;
    const outcome = await api.post(`${base}/stock/transfers`, result.body, { 'idempotency-key': key });
    setKey(newIdempotencyKey());
    onDone(outcome.doc);
  });

  return (
    <form
      className="mb-8 border-b border-borde pb-6"
      onSubmit={(e) => {
        e.preventDefault();
        submit.run();
      }}
    >
      <h2 className="mb-3 text-lg font-semibold text-tinta">Traspaso entre bodegas</h2>
      {active.length < 2 ? <Notice kind="info">Un traspaso necesita al menos dos bodegas activas. Crea la segunda en Existencias.</Notice> : null}
      {submit.error ? <Notice kind="error">{errorMessage(submit.error)}</Notice> : null}
      <div className="grid gap-x-4 sm:grid-cols-3">
        <div>
          <p className="mb-1 text-sm font-semibold text-tinta">Artículo</p>
          <ItemPicker base={base} text={pick.text} item={pick.item} onChange={(text, item) => setPick({ text, item })} error={err('itemId')} showStock={false} />
        </div>
        <SelectField label="Bodega de origen" value={form.fromWarehouseId} onChange={set('fromWarehouseId')} options={options} error={err('fromWarehouseId')} />
        <SelectField label="Bodega de destino" value={form.toWarehouseId} onChange={set('toWarehouseId')} options={options} error={err('toWarehouseId')} />
      </div>
      <div className="grid gap-x-4 sm:grid-cols-3">
        <TextField label="Fecha" type="date" value={form.date} onChange={set('date')} error={err('date')} />
        <TextField label="Cantidad" value={form.quantity} onChange={set('quantity')} inputMode="decimal" error={err('quantity')} hint="Sale al costo promedio de la bodega de origen." />
        <TextField label="Nota (opcional)" value={form.note} onChange={set('note')} maxLength={200} />
      </div>
      <Button type="submit" variant="primary" busy={submit.busy}>
        Registrar traspaso
      </Button>
      <Button className="ml-2" onClick={onCancel}>
        Cancelar
      </Button>
    </form>
  );
}

export function StockMovementsScreen() {
  const base = useTenantApi();
  const { tenant, can } = useSession();
  const currency = tenant.currency;
  const [mode, setMode] = useState(null); // null | 'adjustment' | 'transfer'
  const [notice, setNotice] = useState(null);
  const [kind, setKind] = useState('');
  const [extra, setExtra] = useState([]);
  const [cursor, setCursor] = useState(undefined);
  const warehouses = useLoad(() => api.get(`${base}/warehouses`), [base]);
  const accountList = useLoad(() => api.get(`${base}/accounts?activeOnly=true`), [base]);
  const query = kind ? `kind=${kind}` : '';
  const list = useLoad(() => api.get(`${base}/stock/documents?${query}`), [base, query]);
  const docs = [...(list.data?.items ?? []), ...extra];
  const next = cursor === undefined ? list.data?.nextCursor : cursor;
  const codes = Object.fromEntries((warehouses.data?.items ?? []).map((w) => [w._id, w.code]));
  const postable = (accountList.data?.items ?? []).filter((a) => a.postable);
  const reset = () => {
    setExtra([]);
    setCursor(undefined);
    list.reload();
    warehouses.reload();
  };
  const more = useSubmit(async () => {
    const page = await api.get(`${base}/stock/documents?${query}${query ? '&' : ''}cursor=${next}`);
    setExtra((e) => [...e, ...page.items]);
    setCursor(page.nextCursor);
  });

  const columns = [
    { key: 'number', title: 'Número', nowrap: true, render: (d) => d.fullNumber },
    { key: 'date', title: 'Fecha', nowrap: true, render: (d) => formatDay(d.date) },
    { key: 'kind', title: 'Tipo', render: (d) => (d.kind === 'transfer' ? 'Traspaso' : d.direction === 'in' ? 'Ajuste de entrada' : 'Ajuste de salida') },
    { key: 'sku', title: 'Artículo', nowrap: true, render: (d) => d.sku },
    { key: 'where', title: 'Bodega', render: (d) => (d.kind === 'transfer' ? `${codes[d.fromWarehouseId] ?? ''} → ${codes[d.toWarehouseId] ?? ''}` : (codes[d.warehouseId] ?? '')) },
    { key: 'quantity', title: 'Cantidad', align: 'right', render: (d) => formatQuantity(d.quantity) },
    { key: 'value', title: `Valor (${currency})`, align: 'right', render: (d) => formatAmount(d.value, currency) },
    { key: 'reason', title: 'Motivo', render: (d) => d.reason ?? d.note ?? '' },
  ];

  return (
    <>
      <PageHeader title="Ajustes y traspasos">
        {can('inventory:adjust') && !mode ? (
          <>
            <Button variant="primary" onClick={() => { setMode('adjustment'); setNotice(null); }}>Ajuste de existencias</Button>
            <Button onClick={() => { setMode('transfer'); setNotice(null); }}>Traspaso entre bodegas</Button>
          </>
        ) : null}
      </PageHeader>
      <p className="mb-4 text-sm text-tinta">Un ajuste corrige las existencias (saldos iniciales, sobrantes, faltantes, daños) y deja su asiento. Un traspaso mueve mercancía entre bodegas sin cambiar su valor.</p>
      {notice ? <Notice kind="success">{notice}</Notice> : null}
      {mode === 'adjustment' ? (
        <AdjustmentForm
          warehouses={warehouses.data?.items ?? []}
          accounts={postable}
          onCancel={() => setMode(null)}
          onDone={(doc) => {
            setMode(null);
            setNotice(`${doc.fullNumber} registrado: ${doc.direction === 'in' ? 'entran' : 'salen'} ${formatQuantity(doc.quantity)} de ${doc.sku} por ${formatAmount(doc.value, currency)} ${currency}.`);
            reset();
          }}
        />
      ) : null}
      {mode === 'transfer' ? (
        <TransferForm
          warehouses={warehouses.data?.items ?? []}
          onCancel={() => setMode(null)}
          onDone={(doc) => {
            setMode(null);
            setNotice(`${doc.fullNumber} registrado: ${formatQuantity(doc.quantity)} de ${doc.sku} pasan de ${codes[doc.fromWarehouseId]} a ${codes[doc.toWarehouseId]}.`);
            reset();
          }}
        />
      ) : null}
      <div className="mb-4 grid gap-x-4 sm:grid-cols-3">
        <SelectField
          label="Tipo"
          value={kind}
          onChange={(e) => {
            setKind(e.target.value);
            setExtra([]);
            setCursor(undefined);
          }}
          options={[{ value: '', label: 'Todos' }, { value: 'adjustment', label: 'Ajustes' }, { value: 'transfer', label: 'Traspasos' }]}
        />
      </div>
      {list.error ? <Notice kind="error">{errorMessage(list.error)}</Notice> : null}
      {list.loading && !list.data ? <p className="text-sm text-tinta">Cargando movimientos…</p> : null}
      {list.data ? <DataTable caption="Ajustes y traspasos" columns={columns} rows={docs} rowKey={(d) => d._id} empty="Todavía no hay ajustes ni traspasos." /> : null}
      {more.error ? <Notice kind="error">{errorMessage(more.error)}</Notice> : null}
      {next ? (
        <div className="mt-4">
          <Button busy={more.busy} onClick={() => more.run()}>Cargar más</Button>
        </div>
      ) : null}
    </>
  );
}
