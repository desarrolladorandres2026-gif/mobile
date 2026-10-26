import { useState } from 'react';
import { PartyPicker } from '../components/PartyPicker.jsx';
import { Button, DataTable, ExportInfo, Notice, PageHeader, TextButton, TextField, errorMessage, useLoad, useSubmit } from '../components/ui.jsx';
import { api, newIdempotencyKey } from '../lib/api.js';
import { formatDay, todayText } from '../lib/format.js';
import { formatAmount } from '../lib/money.js';
import { AGING_COLUMNS, amountText, validatePayment } from '../lib/payables.js';
import { useSession, useTenantApi } from '../lib/session.jsx';

const today = () => new Date().toISOString().slice(0, 10);

function PaymentForm({ initial, onDone, onCancel }) {
  const base = useTenantApi();
  const { tenant } = useSession();
  const currency = tenant.currency;
  const accounts = useLoad(() => api.get(`${base}/accounts`), [base]);
  const [partyId, setPartyId] = useState(initial?._id ?? '');
  const [date, setDate] = useState(today());
  const [paymentAccount, setPaymentAccount] = useState('');
  const [notes, setNotes] = useState('');
  const [amounts, setAmounts] = useState({});
  const [showErrors, setShowErrors] = useState(false);
  const [key, setKey] = useState(newIdempotencyKey);

  const open = useLoad(() => (partyId ? api.get(`${base}/payables/open?partyId=${partyId}&currency=${currency}`) : Promise.resolve({ items: [] })), [base, partyId, currency]);
  const purchases = open.data?.items ?? [];
  const result = validatePayment({ partyId, date, paymentAccount, purchases, amounts, currency });
  const postable = (accounts.data?.items ?? []).filter((a) => a.postable && a.type === 'asset');
  const known = postable.find((a) => a.code === paymentAccount);

  const submit = useSubmit(async () => {
    setShowErrors(true);
    if (!result.ok) return;
    const outcome = await api.post(
      `${base}/payments`,
      { partyId, date, paymentAccount, allocations: result.allocations, ...(notes.trim() ? { notes: notes.trim() } : {}) },
      { 'idempotency-key': key },
    );
    setKey(newIdempotencyKey());
    onDone(outcome.payment);
  });

  return (
    <form
      className="mb-8 border-b border-borde pb-6"
      onSubmit={(e) => {
        e.preventDefault();
        submit.run();
      }}
    >
      <h2 className="mb-3 text-lg font-semibold text-tinta">Registrar pago</h2>
      {submit.error ? <Notice kind="error">{errorMessage(submit.error)}</Notice> : null}
      <PartyPicker
        base={base}
        role="supplier"
        value={partyId}
        initial={initial}
        onChange={(id) => {
          setPartyId(id);
          setAmounts({});
        }}
        error={showErrors && !partyId ? 'Elige el proveedor.' : undefined}
      />
      <datalist id="cuentas-pago">
        {postable.map((a) => (
          <option key={a.code} value={a.code}>{a.name}</option>
        ))}
      </datalist>
      <div className="grid gap-x-4 sm:grid-cols-3">
        <TextField label="Fecha del pago" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        <TextField
          label="Cuenta de caja o bancos"
          list="cuentas-pago"
          value={paymentAccount}
          onChange={(e) => setPaymentAccount(e.target.value.replace(/\D/g, ''))}
          hint={known ? known.name : 'Código de la cuenta de donde sale el dinero.'}
          error={showErrors && !/^\d{1,12}$/.test(paymentAccount) ? 'Indica la cuenta.' : undefined}
        />
        <TextField label="Notas (opcional)" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
      </div>

      {open.error ? <Notice kind="error">{errorMessage(open.error)}</Notice> : null}
      {partyId && open.data && purchases.length === 0 ? <p className="mb-4 text-sm text-tinta">Este proveedor no tiene facturas con saldo por pagar.</p> : null}
      {purchases.length ? (
        <DataTable
          caption="Facturas por pagar al proveedor"
          rows={purchases}
          rowKey={(p) => p._id}
          columns={[
            { key: 'number', title: 'Compra', nowrap: true, render: (p) => `${p.fullNumber} · ${p.supplierDocNumber}` },
            { key: 'due', title: 'Vence', nowrap: true, render: (p) => (p.dueDate ? formatDay(p.dueDate) : '—') },
            { key: 'payable', title: `A pagar (${currency})`, align: 'right', render: (p) => formatAmount(p.payable, currency) },
            { key: 'paid', title: 'Pagado', align: 'right', render: (p) => formatAmount(p.paid, currency) },
            { key: 'balance', title: 'Saldo', align: 'right', render: (p) => <strong>{formatAmount(p.balance, currency)}</strong> },
            {
              key: 'amount',
              title: 'Pagar ahora',
              align: 'right',
              render: (p) => (
                <span className="flex items-start justify-end gap-3">
                  <TextButton onClick={() => setAmounts((a) => ({ ...a, [p._id]: amountText(p.balance, currency) }))}>Todo</TextButton>
                  <span>
                    <input
                      aria-label={`Importe a pagar de la compra ${p.fullNumber}`}
                      value={amounts[p._id] ?? ''}
                      onChange={(e) => setAmounts((a) => ({ ...a, [p._id]: e.target.value }))}
                      className="w-36 rounded-sm border border-borde-fuerte bg-papel px-2 py-1 text-right text-sm tabular-nums text-tinta focus:outline-2 focus:outline-azul"
                    />
                    {result.errors.rows[p._id] ? <span className="block text-xs font-semibold text-rojo">{result.errors.rows[p._id]}</span> : null}
                  </span>
                </span>
              ),
            },
          ]}
        />
      ) : null}

      <p className="my-3 text-sm font-semibold text-tinta">Total del pago: {formatAmount(result.total, currency)}</p>
      {showErrors && result.errors.form.length ? (
        <Notice kind="error">
          {result.errors.form.map((m) => (
            <p key={m}>{m}</p>
          ))}
        </Notice>
      ) : null}
      <Button type="submit" variant="primary" busy={submit.busy}>Registrar pago</Button>
      <Button className="ml-2" onClick={onCancel}>Cancelar</Button>
    </form>
  );
}

export function PayablesScreen() {
  const base = useTenantApi();
  const { tenant, can } = useSession();
  const currency = tenant.currency;
  const aging = useLoad(() => api.get(`${base}/payables/aging?currency=${currency}`), [base, currency]);
  const [form, setForm] = useState(null);
  const [notice, setNotice] = useState(null);
  const data = aging.data;

  const rows = data ? [...data.rows, ...(data.rows.length ? [{ partyId: 'TOTAL', isTotal: true }] : [])] : [];
  const money = (r, key) => (r.isTotal ? <strong>{formatAmount(data.totals[key], currency)}</strong> : formatAmount(r[key], currency));

  return (
    <>
      <PageHeader title="Cuentas por pagar">
        {can('payments:create') && !form ? <Button variant="primary" onClick={() => { setForm({}); setNotice(null); }}>Registrar pago</Button> : null}
      </PageHeader>
      <p className="mb-4 text-sm text-tinta">Lo que se les debe hoy a los proveedores, por antigüedad desde el vencimiento de cada factura.</p>
      {notice ? <Notice kind="success">{notice}</Notice> : null}
      {form ? (
        <PaymentForm
          key={form.initial?._id ?? 'nuevo'}
          initial={form.initial}
          onCancel={() => setForm(null)}
          onDone={(payment) => {
            setForm(null);
            setNotice(`Comprobante ${payment.fullNumber} registrado por ${formatAmount(payment.total, payment.currency)}.`);
            aging.reload();
          }}
        />
      ) : null}
      {aging.error ? <Notice kind="error">{errorMessage(aging.error)}</Notice> : null}
      {aging.loading && !data ? <p className="text-sm text-tinta">Cargando cuentas por pagar…</p> : null}
      {data ? (
        <ExportInfo filters={[['Corte', todayText()]]}>
          <DataTable
            caption="Cuentas por pagar por edades"
            empty="No hay saldos por pagar."
            rows={rows}
            rowKey={(r) => r.partyId}
            rowMeta={(r) => (r.isTotal ? { kind: 'total' } : null)}
            columns={[
              { key: 'supplier', title: 'Proveedor', render: (r) => (r.isTotal ? <strong>Total</strong> : `${r.name} · ${r.taxId}`) },
              ...AGING_COLUMNS.map(([key, title]) => ({ key, title, align: 'right', render: (r) => money(r, key) })),
              { key: 'total', title: `Total (${currency})`, align: 'right', render: (r) => <strong>{formatAmount(r.isTotal ? data.totals.total : r.total, currency)}</strong> },
              {
                key: 'actions',
                title: 'Acciones',
                render: (r) =>
                  r.isTotal || !can('payments:create') ? null : (
                    <TextButton onClick={() => { setForm({ initial: { _id: String(r.partyId), name: r.name, taxId: r.taxId } }); setNotice(null); }}>Pagar</TextButton>
                  ),
              },
            ]}
          />
          {data.truncated ? <p className="mt-3 text-sm text-tinta">Se muestran los {data.rows.length} proveedores con más saldo de {data.suppliers}. Los totales incluyen a todos.</p> : null}
        </ExportInfo>
      ) : null}
    </>
  );
}

export function PaymentsScreen() {
  const base = useTenantApi();
  const { can } = useSession();
  const [filter, setFilter] = useState('');
  const [confirming, setConfirming] = useState(null);
  const [notice, setNotice] = useState(null);
  const [extra, setExtra] = useState([]);
  const [cursor, setCursor] = useState(undefined);
  const [open, setOpen] = useState(null);
  const query = filter ? `status=${filter}` : '';
  const list = useLoad(() => api.get(`${base}/payments?${query}`), [base, query]);
  const items = [...(list.data?.items ?? []), ...extra];
  const next = cursor === undefined ? list.data?.nextCursor : cursor;

  const reset = () => {
    setExtra([]);
    setCursor(undefined);
    list.reload();
  };
  const more = useSubmit(async () => {
    const page = await api.get(`${base}/payments?${query}${query ? '&' : ''}cursor=${next}`);
    setExtra((e) => [...e, ...page.items]);
    setCursor(page.nextCursor);
  });
  const act = useSubmit(async (payment) => {
    await api.post(`${base}/payments/${payment._id}/void`);
    setNotice(`Comprobante ${payment.fullNumber} anulado: la deuda volvió a sus facturas.`);
    setConfirming(null);
    reset();
  });

  const columns = [
    { key: 'number', title: 'Número', nowrap: true, render: (p) => p.fullNumber },
    { key: 'date', title: 'Fecha', nowrap: true, render: (p) => formatDay(p.date) },
    { key: 'party', title: 'Proveedor', render: (p) => p.party.name },
    { key: 'purchases', title: 'Compras', render: (p) => p.allocations.map((a) => a.purchaseFullNumber).join(', ') },
    { key: 'total', title: 'Total', align: 'right', render: (p) => formatAmount(p.total, p.currency) },
    { key: 'status', title: 'Estado', render: (p) => (p.status === 'void' ? 'Anulado' : 'Vigente') },
    {
      key: 'actions',
      title: 'Acciones',
      render: (p) => {
        const detail = <TextButton onClick={() => setOpen(open === p._id ? null : p._id)}>{open === p._id ? 'Ocultar detalle' : 'Ver detalle'}</TextButton>;
        if (p.status !== 'posted' || !can('payments:void')) return detail;
        if (confirming === p._id) {
          return (
            <span className="flex flex-wrap gap-3">
              <TextButton danger onClick={() => act.run(p)}>Sí, anular</TextButton>
              <TextButton onClick={() => setConfirming(null)}>Cancelar</TextButton>
            </span>
          );
        }
        return (
          <span className="flex flex-wrap gap-3">
            {detail}
            <TextButton onClick={() => { setConfirming(p._id); act.clearError(); }}>Anular</TextButton>
          </span>
        );
      },
    },
  ];

  return (
    <>
      <PageHeader title="Pagos a proveedores" />
      <p className="mb-4 text-sm text-tinta">Un comprobante de egreso aplica el dinero que sale a las facturas de un proveedor. Anularlo reversa su asiento y devuelve la deuda a las facturas. Los pagos se registran desde Cuentas por pagar.</p>
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
      {list.loading && !list.data ? <p className="text-sm text-tinta">Cargando pagos…</p> : null}
      {list.data ? (
        <DataTable
          caption="Pagos a proveedores"
          columns={columns}
          rows={items}
          rowKey={(p) => p._id}
          empty="No hay pagos con este filtro."
          expandedRow={(p) =>
            open === p._id ? (
              <p className="text-sm text-tinta">
                Cuenta de caja o bancos {p.paymentAccount}. {p.notes ? `Notas: ${p.notes}. ` : ''}
                {p.allocations.map((a) => `${a.purchaseFullNumber} (${a.supplierDocNumber}): ${formatAmount(a.amount, p.currency)}`).join(' · ')}
              </p>
            ) : null
          }
        />
      ) : null}
      {more.error ? <Notice kind="error">{errorMessage(more.error)}</Notice> : null}
      {next ? (
        <div className="mt-4">
          <Button busy={more.busy} onClick={() => more.run()}>Cargar más pagos</Button>
        </div>
      ) : null}
    </>
  );
}
