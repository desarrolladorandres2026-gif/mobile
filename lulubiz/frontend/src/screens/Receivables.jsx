import { useState } from 'react';
import { PartyPicker } from '../components/PartyPicker.jsx';
import { Button, DataTable, Notice, PageHeader, TextButton, TextField, errorMessage, useLoad, useSubmit } from '../components/ui.jsx';
import { api, newIdempotencyKey } from '../lib/api.js';
import { formatDay } from '../lib/format.js';
import { formatAmount } from '../lib/money.js';
import { AGING_COLUMNS, amountText, validateReceipt } from '../lib/receivables.js';
import { useSession, useTenantApi } from '../lib/session.jsx';

const today = () => new Date().toISOString().slice(0, 10);

function ReceiptForm({ initial, onDone, onCancel }) {
  const base = useTenantApi();
  const { tenant } = useSession();
  const currency = tenant.currency;
  const accounts = useLoad(() => api.get(`${base}/accounts`), [base]);
  const [partyId, setPartyId] = useState(initial?._id ?? '');
  const [date, setDate] = useState(today());
  const [depositAccount, setDepositAccount] = useState('');
  const [notes, setNotes] = useState('');
  const [amounts, setAmounts] = useState({});
  const [showErrors, setShowErrors] = useState(false);
  const [key, setKey] = useState(newIdempotencyKey);

  const open = useLoad(() => (partyId ? api.get(`${base}/receivables/open?partyId=${partyId}&currency=${currency}`) : Promise.resolve({ items: [] })), [base, partyId, currency]);
  const invoices = open.data?.items ?? [];
  const result = validateReceipt({ partyId, date, depositAccount, invoices, amounts, currency });
  const postable = (accounts.data?.items ?? []).filter((a) => a.postable && a.type === 'asset');
  const known = postable.find((a) => a.code === depositAccount);

  const submit = useSubmit(async () => {
    setShowErrors(true);
    if (!result.ok) return;
    const outcome = await api.post(
      `${base}/receipts`,
      { partyId, date, depositAccount, allocations: result.allocations, ...(notes.trim() ? { notes: notes.trim() } : {}) },
      { 'idempotency-key': key },
    );
    setKey(newIdempotencyKey());
    onDone(outcome.receipt);
  });

  return (
    <form
      className="mb-8 border-b border-borde pb-6"
      onSubmit={(e) => {
        e.preventDefault();
        submit.run();
      }}
    >
      <h2 className="mb-3 text-lg font-semibold text-tinta">Registrar cobro</h2>
      {submit.error ? <Notice kind="error">{errorMessage(submit.error)}</Notice> : null}
      <PartyPicker
        base={base}
        role="customer"
        value={partyId}
        initial={initial}
        onChange={(id) => {
          setPartyId(id);
          setAmounts({});
        }}
        error={showErrors && !partyId ? 'Elige el cliente.' : undefined}
      />
      <datalist id="cuentas-caja">
        {postable.map((a) => (
          <option key={a.code} value={a.code}>{a.name}</option>
        ))}
      </datalist>
      <div className="grid gap-x-4 sm:grid-cols-3">
        <TextField label="Fecha del cobro" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        <TextField
          label="Cuenta de caja o bancos"
          list="cuentas-caja"
          value={depositAccount}
          onChange={(e) => setDepositAccount(e.target.value.replace(/\D/g, ''))}
          hint={known ? known.name : 'Código de la cuenta donde entra el dinero.'}
          error={showErrors && !/^\d{1,12}$/.test(depositAccount) ? 'Indica la cuenta.' : undefined}
        />
        <TextField label="Notas (opcional)" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
      </div>

      {open.error ? <Notice kind="error">{errorMessage(open.error)}</Notice> : null}
      {partyId && open.data && invoices.length === 0 ? <p className="mb-4 text-sm text-tinta">Este cliente no tiene facturas con saldo por cobrar.</p> : null}
      {invoices.length ? (
        <DataTable
          caption="Facturas por cobrar del cliente"
          rows={invoices}
          rowKey={(i) => i._id}
          columns={[
            { key: 'number', title: 'Factura', nowrap: true, render: (i) => i.fullNumber },
            { key: 'due', title: 'Vence', nowrap: true, render: (i) => (i.dueDate ? formatDay(i.dueDate) : '—') },
            { key: 'total', title: `Total (${currency})`, align: 'right', render: (i) => formatAmount(i.total, currency) },
            { key: 'paid', title: 'Cobrado', align: 'right', render: (i) => formatAmount(i.paid, currency) },
            { key: 'balance', title: 'Saldo', align: 'right', render: (i) => <strong>{formatAmount(i.balance, currency)}</strong> },
            {
              key: 'amount',
              title: 'Cobrar ahora',
              align: 'right',
              render: (i) => (
                <span className="flex items-start justify-end gap-3">
                  <TextButton onClick={() => setAmounts((a) => ({ ...a, [i._id]: amountText(i.balance, currency) }))}>Todo</TextButton>
                  <span>
                    <input
                      aria-label={`Importe a cobrar de la factura ${i.fullNumber}`}
                      value={amounts[i._id] ?? ''}
                      onChange={(e) => setAmounts((a) => ({ ...a, [i._id]: e.target.value }))}
                      className="w-36 rounded-sm border border-borde-fuerte bg-papel px-2 py-1 text-right text-sm tabular-nums text-tinta focus:outline-2 focus:outline-azul"
                    />
                    {result.errors.rows[i._id] ? <span className="block text-xs font-semibold text-rojo">{result.errors.rows[i._id]}</span> : null}
                  </span>
                </span>
              ),
            },
          ]}
        />
      ) : null}

      <p className="my-3 text-sm font-semibold text-tinta">Total del recibo: {formatAmount(result.total, currency)}</p>
      {showErrors && result.errors.form.length ? (
        <Notice kind="error">
          {result.errors.form.map((m) => (
            <p key={m}>{m}</p>
          ))}
        </Notice>
      ) : null}
      <Button type="submit" variant="primary" busy={submit.busy}>Registrar cobro</Button>
      <Button className="ml-2" onClick={onCancel}>Cancelar</Button>
    </form>
  );
}

export function ReceivablesScreen() {
  const base = useTenantApi();
  const { tenant, can } = useSession();
  const currency = tenant.currency;
  const aging = useLoad(() => api.get(`${base}/receivables/aging?currency=${currency}`), [base, currency]);
  const [form, setForm] = useState(null); // { initial? }
  const [notice, setNotice] = useState(null);
  const data = aging.data;

  const rows = data ? [...data.rows, ...(data.rows.length ? [{ partyId: 'TOTAL', total: true }] : [])] : [];
  const money = (r, key) => (r.total === true ? <strong>{formatAmount(data.totals[key], currency)}</strong> : formatAmount(r[key], currency));

  return (
    <>
      <PageHeader title="Cartera">
        {can('receipts:create') && !form ? <Button variant="primary" onClick={() => { setForm({}); setNotice(null); }}>Registrar cobro</Button> : null}
      </PageHeader>
      <p className="mb-4 text-sm text-tinta">Lo que los clientes deben hoy, por antigüedad desde el vencimiento de cada factura (o desde su emisión si no tiene vencimiento).</p>
      {notice ? <Notice kind="success">{notice}</Notice> : null}
      {form ? (
        <ReceiptForm
          key={form.initial?._id ?? 'nuevo'}
          initial={form.initial}
          onCancel={() => setForm(null)}
          onDone={(receipt) => {
            setForm(null);
            setNotice(`Recibo ${receipt.fullNumber} registrado por ${formatAmount(receipt.total, receipt.currency)}.`);
            aging.reload();
          }}
        />
      ) : null}
      {aging.error ? <Notice kind="error">{errorMessage(aging.error)}</Notice> : null}
      {aging.loading && !data ? <p className="text-sm text-tinta">Cargando cartera…</p> : null}
      {data ? (
        <>
          <DataTable
            caption="Cartera por edades"
            empty="No hay saldos por cobrar."
            rows={rows}
            rowKey={(r) => r.partyId}
            columns={[
              { key: 'customer', title: 'Cliente', render: (r) => (r.total === true ? <strong>Total</strong> : `${r.name} · ${r.taxId}`) },
              ...AGING_COLUMNS.map(([key, title]) => ({ key, title, align: 'right', render: (r) => money(r, key) })),
              { key: 'total', title: `Total (${currency})`, align: 'right', render: (r) => (r.total === true ? <strong>{formatAmount(data.totals.total, currency)}</strong> : <strong>{formatAmount(r.total, currency)}</strong>) },
              {
                key: 'actions',
                title: 'Acciones',
                render: (r) =>
                  r.total === true || !can('receipts:create') ? null : (
                    <TextButton onClick={() => { setForm({ initial: { _id: String(r.partyId), name: r.name, taxId: r.taxId } }); setNotice(null); }}>Cobrar</TextButton>
                  ),
              },
            ]}
          />
          {data.truncated ? <p className="mt-3 text-sm text-tinta">Se muestran los {data.rows.length} clientes con más saldo de {data.customers}. Los totales incluyen a todos.</p> : null}
        </>
      ) : null}
    </>
  );
}

export function ReceiptsScreen() {
  const base = useTenantApi();
  const { can } = useSession();
  const [filter, setFilter] = useState('');
  const [confirming, setConfirming] = useState(null);
  const [notice, setNotice] = useState(null);
  const [extra, setExtra] = useState([]);
  const [cursor, setCursor] = useState(undefined);
  const [open, setOpen] = useState(null);
  const query = filter ? `status=${filter}` : '';
  const list = useLoad(() => api.get(`${base}/receipts?${query}`), [base, query]);
  const items = [...(list.data?.items ?? []), ...extra];
  const next = cursor === undefined ? list.data?.nextCursor : cursor;

  const reset = () => {
    setExtra([]);
    setCursor(undefined);
    list.reload();
  };
  const more = useSubmit(async () => {
    const page = await api.get(`${base}/receipts?${query}${query ? '&' : ''}cursor=${next}`);
    setExtra((e) => [...e, ...page.items]);
    setCursor(page.nextCursor);
  });
  const act = useSubmit(async (receipt) => {
    await api.post(`${base}/receipts/${receipt._id}/void`);
    setNotice(`Recibo ${receipt.fullNumber} anulado: el saldo volvió a sus facturas.`);
    setConfirming(null);
    reset();
  });

  const columns = [
    { key: 'number', title: 'Número', nowrap: true, render: (r) => r.fullNumber },
    { key: 'date', title: 'Fecha', nowrap: true, render: (r) => formatDay(r.date) },
    { key: 'party', title: 'Cliente', render: (r) => r.party.name },
    { key: 'invoices', title: 'Facturas', render: (r) => r.allocations.map((a) => a.invoiceFullNumber).join(', ') },
    { key: 'total', title: 'Total', align: 'right', render: (r) => formatAmount(r.total, r.currency) },
    { key: 'status', title: 'Estado', render: (r) => (r.status === 'void' ? 'Anulado' : 'Vigente') },
    {
      key: 'actions',
      title: 'Acciones',
      render: (r) => {
        const detail = <TextButton onClick={() => setOpen(open === r._id ? null : r._id)}>{open === r._id ? 'Ocultar detalle' : 'Ver detalle'}</TextButton>;
        if (r.status !== 'posted' || !can('receipts:void')) return detail;
        if (confirming === r._id) {
          return (
            <span className="flex flex-wrap gap-3">
              <TextButton danger onClick={() => act.run(r)}>Sí, anular</TextButton>
              <TextButton onClick={() => setConfirming(null)}>Cancelar</TextButton>
            </span>
          );
        }
        return (
          <span className="flex flex-wrap gap-3">
            {detail}
            <TextButton onClick={() => { setConfirming(r._id); act.clearError(); }}>Anular</TextButton>
          </span>
        );
      },
    },
  ];

  return (
    <>
      <PageHeader title="Recibos de caja" />
      <p className="mb-4 text-sm text-tinta">Un recibo aplica el dinero recibido a las facturas de un cliente. Anularlo reversa su asiento y devuelve el saldo a las facturas. Los cobros se registran desde Cartera.</p>
      {notice ? <Notice kind="success">{notice}</Notice> : null}
      {act.error ? <Notice kind="error">{errorMessage(act.error)}</Notice> : null}
      <div className="mb-4 grid gap-x-4 sm:grid-cols-3">
        <label className="block text-sm font-semibold text-tinta">
          Estado
          <select
            value={filter}
            onChange={(e) => { setFilter(e.target.value); setExtra([]); setCursor(undefined); }}
            className="mt-1 block w-full rounded-sm border border-borde-fuerte bg-papel px-2.5 py-1.5 text-sm font-normal text-tinta focus:outline-2 focus:outline-azul"
          >
            <option value="">Todos</option>
            <option value="posted">Vigentes</option>
            <option value="void">Anulados</option>
          </select>
        </label>
      </div>
      {list.error ? <Notice kind="error">{errorMessage(list.error)}</Notice> : null}
      {list.loading && !list.data ? <p className="text-sm text-tinta">Cargando recibos…</p> : null}
      {list.data ? (
        <DataTable
          caption="Recibos de caja"
          columns={columns}
          rows={items}
          rowKey={(r) => r._id}
          empty="No hay recibos con este filtro."
          expandedRow={(r) =>
            open === r._id ? (
              <p className="text-sm text-tinta">
                Cuenta de caja o bancos {r.depositAccount}. {r.notes ? `Notas: ${r.notes}. ` : ''}
                {r.allocations.map((a) => `${a.invoiceFullNumber}: ${formatAmount(a.amount, r.currency)}`).join(' · ')}
              </p>
            ) : null
          }
        />
      ) : null}
      {more.error ? <Notice kind="error">{errorMessage(more.error)}</Notice> : null}
      {next ? (
        <div className="mt-4">
          <Button busy={more.busy} onClick={() => more.run()}>Cargar más recibos</Button>
        </div>
      ) : null}
    </>
  );
}
