import { useState } from 'react';
import { useCostCenters } from '../components/CostCenterSelect.jsx';
import { DocLinesEditor, DocTotals } from '../components/DocLinesEditor.jsx';
import { PartyPicker } from '../components/PartyPicker.jsx';
import { Button, DataTable, Notice, PageHeader, SelectField, TextButton, TextField, errorMessage, useLoad, useSubmit } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { FREQUENCIES, ORDER_STATUS, QUOTE_STATUS, addDays, blankLine, runSummary, validateDocLines, validateRecurring } from '../lib/commercial.js';
import { formatDay } from '../lib/format.js';
import { formatPercent, formatQuantity } from '../lib/invoicing.js';
import { formatAmount } from '../lib/money.js';
import { Link } from '../lib/router.jsx';
import { useSession, useTenantApi } from '../lib/session.jsx';
import { useInvoicingStatus } from './Invoices.jsx';

const today = () => new Date().toISOString().slice(0, 10);
const FREQUENCY_LABEL = Object.fromEntries(FREQUENCIES.map((f) => [f.value, f.label]));
const PAYMENT = [{ value: 'cash', label: 'Contado' }, { value: 'credit', label: 'Crédito' }];

/** Cuentas que reciben asientos y centros de costo activos: lo que necesitan las tablas de líneas. */
function useLineData(base) {
  const accounts = useLoad(() => api.get(`${base}/accounts?activeOnly=true`), [base]);
  return { accounts: (accounts.data?.items ?? []).filter((a) => a.postable), centers: useCostCenters(base) };
}

const ratesOf = (status) => status?.vatRatesBps ?? [0, 1900];
const defaultRateOf = (rates) => (rates.includes(1900) ? 1900 : rates[rates.length - 1]);

function Errors({ messages }) {
  return messages.length ? (
    <Notice kind="error">
      {messages.map((m) => (
        <p key={m}>{m}</p>
      ))}
    </Notice>
  ) : null;
}

function LinesReadOnly({ lines, currency }) {
  return (
    <div className="relative overflow-x-auto">
      <table className="mb-3 w-full max-w-4xl border-collapse text-sm text-tinta">
        <thead>
          <tr className="text-left">
            <th scope="col" className="pr-4 font-semibold">Descripción</th>
            <th scope="col" className="pr-4 text-right font-semibold">Cantidad</th>
            <th scope="col" className="pr-4 text-right font-semibold">Precio</th>
            <th scope="col" className="pr-4 text-right font-semibold">IVA</th>
            <th scope="col" className="text-right font-semibold">Total</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td className="pr-4">{l.description}{l.costCenter ? ` · ${l.costCenter}` : ''}</td>
              <td className="pr-4 text-right tabular-nums">{formatQuantity(l.quantity)}</td>
              <td className="pr-4 text-right tabular-nums">{formatAmount(l.unitPrice, currency)}</td>
              <td className="pr-4 text-right tabular-nums">{formatPercent(l.vatBps)}</td>
              <td className="text-right tabular-nums">{formatAmount(l.total, currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- Cotizaciones

function QuoteForm({ rates, onCreated, onCancel }) {
  const base = useTenantApi();
  const { tenant } = useSession();
  const currency = tenant.currency;
  const { accounts, centers } = useLineData(base);
  const defaultRate = defaultRateOf(rates);
  const [customerId, setCustomerId] = useState('');
  const [issueDate, setIssueDate] = useState(today());
  const [validUntil, setValidUntil] = useState(addDays(today(), 15));
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState([blankLine(defaultRate)]);
  const [showErrors, setShowErrors] = useState(false);
  const result = validateDocLines(lines, { currency });
  const form = [...(showErrors && !customerId ? ['Elige el cliente.'] : []), ...(validUntil < issueDate ? ['La vigencia no puede ser anterior a la cotización.'] : []), ...(showErrors ? result.errors.form : [])];

  const submit = useSubmit(async () => {
    setShowErrors(true);
    if (!customerId || validUntil < issueDate || !result.ok) return;
    onCreated(await api.post(`${base}/quotes`, { customerId, issueDate, validUntil, ...(notes.trim() ? { notes: notes.trim() } : {}), lines: result.prepared }));
  });

  return (
    <form
      className="mb-8 border-b border-borde pb-6"
      onSubmit={(e) => {
        e.preventDefault();
        submit.run();
      }}
    >
      <h2 className="mb-3 text-lg font-semibold text-tinta">Nueva cotización</h2>
      {submit.error ? <Notice kind="error">{errorMessage(submit.error)}</Notice> : null}
      <PartyPicker base={base} role="customer" value={customerId} onChange={setCustomerId} error={showErrors && !customerId ? 'Elige el cliente.' : undefined} />
      <div className="grid gap-x-4 sm:grid-cols-3">
        <TextField label="Fecha de la cotización" type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} required />
        <TextField label="Válida hasta" type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} required />
      </div>
      <DocLinesEditor base={base} lines={lines} setLines={setLines} rates={rates} currency={currency} errors={result.errors.lines} showErrors={showErrors} accounts={accounts} centers={centers} defaultRate={defaultRate} />
      <DocTotals totals={result.totals} currency={currency} />
      <TextField label="Notas para el cliente (opcional)" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
      <Errors messages={form} />
      <Button type="submit" variant="primary" busy={submit.busy}>Crear cotización</Button>
      <Button className="ml-2" onClick={onCancel}>Cancelar</Button>
    </form>
  );
}

function InvoiceQuoteForm({ quote, onDone, onCancel }) {
  const base = useTenantApi();
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [issueDate, setIssueDate] = useState(today());
  const [dueDate, setDueDate] = useState(addDays(today(), 30));
  const [error, setError] = useState(null);
  const submit = useSubmit(async () => {
    setError(null);
    if (paymentMethod === 'credit' && dueDate < issueDate) return setError('El vencimiento no puede ser anterior a la emisión.');
    const result = await api.post(`${base}/quotes/${quote._id}/invoice`, { paymentMethod, issueDate, ...(paymentMethod === 'credit' ? { dueDate } : {}) });
    return onDone(result);
  });
  return (
    <form
      className="my-2 max-w-3xl border-t border-borde pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit.run();
      }}
    >
      <h3 className="mb-2 font-semibold text-tinta">Facturar la cotización {quote.fullNumber}</h3>
      <p className="mb-3 text-sm text-tinta">Se emite una factura electrónica con estas mismas líneas. La cotización no reserva existencias ni precio: al facturar valen las reglas de la factura.</p>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {submit.error ? <Notice kind="error">{errorMessage(submit.error)}</Notice> : null}
      <div className="grid gap-x-4 sm:grid-cols-3">
        <SelectField label="Forma de pago" value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)} options={PAYMENT} />
        <TextField label="Fecha de emisión" type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} />
        {paymentMethod === 'credit' ? <TextField label="Vencimiento" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /> : null}
      </div>
      <Button type="submit" variant="primary" busy={submit.busy}>Emitir factura</Button>
      <Button className="ml-2" onClick={onCancel}>Cancelar</Button>
    </form>
  );
}

export function QuotesScreen() {
  const base = useTenantApi();
  const { tenant, can } = useSession();
  const currency = tenant.currency;
  const status = useInvoicingStatus();
  const rates = ratesOf(status.data);
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState(null);
  const [invoicing, setInvoicing] = useState(null);
  const [notice, setNotice] = useState(null);
  const [filter, setFilter] = useState('');
  const list = useLoad(() => api.get(`${base}/quotes${filter ? `?status=${filter}` : ''}`), [base, filter]);
  const act = useSubmit(async (quote, action, done) => {
    await api.post(`${base}/quotes/${quote._id}/${action}`);
    setNotice(`Cotización ${quote.fullNumber} ${done}.`);
    list.reload();
  });
  const canIssue = can('invoices:issue');

  const label = (q) => {
    if (q.status === 'open' && q.expired) return 'Vencida';
    if (q.status === 'invoiced') return `Facturada ${q.invoiceNumber ?? ''}`.trim();
    return QUOTE_STATUS[q.status];
  };
  const columns = [
    { key: 'number', title: 'Número', nowrap: true, render: (q) => q.fullNumber },
    { key: 'date', title: 'Fecha', nowrap: true, render: (q) => formatDay(q.issueDate) },
    { key: 'customer', title: 'Cliente', render: (q) => q.customer.name },
    { key: 'until', title: 'Válida hasta', nowrap: true, render: (q) => formatDay(q.validUntil) },
    { key: 'total', title: `Total (${currency})`, align: 'right', render: (q) => formatAmount(q.totals.total, currency) },
    { key: 'status', title: 'Estado', render: label },
    {
      key: 'actions',
      title: 'Acciones',
      render: (q) => {
        const live = ['open', 'accepted', 'rejected'].includes(q.status) && !q.expired;
        return (
          <span className="flex flex-wrap gap-3">
            <TextButton onClick={() => setOpen(open === q._id ? null : q._id)}>{open === q._id ? 'Ocultar detalle' : 'Ver detalle'}</TextButton>
            {canIssue && live && q.status === 'open' ? <TextButton onClick={() => act.run(q, 'accept', 'aceptada')}>Aceptar</TextButton> : null}
            {canIssue && live && q.status === 'open' ? <TextButton onClick={() => act.run(q, 'reject', 'rechazada')}>Rechazar</TextButton> : null}
            {canIssue && live && q.status !== 'rejected' ? <TextButton onClick={() => { setOpen(q._id); setInvoicing(invoicing === q._id ? null : q._id); }}>Facturar</TextButton> : null}
            {canIssue && (live || (q.status === 'open' && q.expired)) ? <TextButton danger onClick={() => act.run(q, 'void', 'anulada')}>Anular</TextButton> : null}
          </span>
        );
      },
    },
  ];

  return (
    <>
      <PageHeader title="Cotizaciones">{canIssue && !creating ? <Button variant="primary" onClick={() => { setCreating(true); setNotice(null); }}>Nueva cotización</Button> : null}</PageHeader>
      <p className="mb-4 text-sm text-tinta">Ofertas a tus clientes, con vigencia. No generan contabilidad ni reservan existencias: cuando el cliente acepta, se convierten en factura con un clic.</p>
      {notice ? <Notice kind="success">{notice}</Notice> : null}
      {act.error ? <Notice kind="error">{errorMessage(act.error)}</Notice> : null}
      {creating ? (
        <QuoteForm
          rates={rates}
          onCancel={() => setCreating(false)}
          onCreated={(quote) => {
            setCreating(false);
            setNotice(`Cotización ${quote.fullNumber} creada por ${formatAmount(quote.totals.total, quote.currency)}.`);
            list.reload();
          }}
        />
      ) : null}
      <div className="mb-4 grid gap-x-4 sm:grid-cols-3">
        <SelectField label="Estado" value={filter} onChange={(e) => setFilter(e.target.value)} options={[{ value: '', label: 'Todas' }, ...Object.entries(QUOTE_STATUS).map(([value, text]) => ({ value, label: text }))]} />
      </div>
      {list.error ? <Notice kind="error">{errorMessage(list.error)}</Notice> : null}
      {list.data ? (
        <DataTable
          caption="Cotizaciones"
          columns={columns}
          rows={list.data.items}
          rowKey={(q) => q._id}
          empty="No hay cotizaciones con este filtro."
          expandedRow={(q) =>
            open === q._id ? (
              <div className="my-2">
                <LinesReadOnly lines={q.lines} currency={currency} />
                <p className="text-sm text-tinta">Subtotal {formatAmount(q.totals.subtotal, currency)} · IVA {formatAmount(q.totals.tax, currency)} · Total {formatAmount(q.totals.total, currency)}</p>
                {q.notes ? <p className="text-sm text-tinta">Notas: {q.notes}</p> : null}
                {invoicing === q._id ? (
                  <InvoiceQuoteForm
                    quote={q}
                    onCancel={() => setInvoicing(null)}
                    onDone={(result) => {
                      setInvoicing(null);
                      setNotice(result.pending ? `La factura de ${q.fullNumber} quedó pendiente del proveedor de facturación.` : `Factura ${result.invoice.fullNumber} emitida desde ${q.fullNumber}.`);
                      list.reload();
                    }}
                  />
                ) : null}
              </div>
            ) : null
          }
        />
      ) : null}
      {status.data && !status.data.ready ? <p className="mt-4 text-sm text-tinta">Para facturar una cotización hay que terminar la <Link href="/app/facturacion">configuración de Facturación</Link>.</p> : null}
    </>
  );
}

// --------------------------------------------------------------- Órdenes de compra

function OrderForm({ rates, onCreated, onCancel }) {
  const base = useTenantApi();
  const { tenant } = useSession();
  const currency = tenant.currency;
  const { accounts, centers } = useLineData(base);
  const defaultRate = defaultRateOf(rates);
  const [supplierId, setSupplierId] = useState('');
  const [issueDate, setIssueDate] = useState(today());
  const [expectedDate, setExpectedDate] = useState(addDays(today(), 7));
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState([blankLine(defaultRate)]);
  const [showErrors, setShowErrors] = useState(false);
  const result = validateDocLines(lines, { currency, requireAccount: true });
  const form = [...(showErrors && !supplierId ? ['Elige el proveedor.'] : []), ...(expectedDate && expectedDate < issueDate ? ['La fecha esperada no puede ser anterior a la orden.'] : []), ...(showErrors ? result.errors.form : [])];

  const submit = useSubmit(async () => {
    setShowErrors(true);
    if (!supplierId || (expectedDate && expectedDate < issueDate) || !result.ok) return;
    onCreated(await api.post(`${base}/purchase-orders`, { supplierId, issueDate, ...(expectedDate ? { expectedDate } : {}), ...(notes.trim() ? { notes: notes.trim() } : {}), lines: result.prepared }));
  });

  return (
    <form
      className="mb-8 border-b border-borde pb-6"
      onSubmit={(e) => {
        e.preventDefault();
        submit.run();
      }}
    >
      <h2 className="mb-3 text-lg font-semibold text-tinta">Nueva orden de compra</h2>
      {submit.error ? <Notice kind="error">{errorMessage(submit.error)}</Notice> : null}
      <PartyPicker base={base} role="supplier" value={supplierId} onChange={setSupplierId} error={showErrors && !supplierId ? 'Elige el proveedor.' : undefined} />
      <div className="grid gap-x-4 sm:grid-cols-3">
        <TextField label="Fecha de la orden" type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} required />
        <TextField label="Entrega esperada (opcional)" type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} />
      </div>
      <DocLinesEditor base={base} lines={lines} setLines={setLines} rates={rates} currency={currency} errors={result.errors.lines} showErrors={showErrors} accountMode="expense" accounts={accounts} centers={centers} defaultRate={defaultRate} />
      <DocTotals totals={result.totals} currency={currency} />
      <TextField label="Notas (opcional)" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
      <Errors messages={form} />
      <Button type="submit" variant="primary" busy={submit.busy}>Crear orden</Button>
      <Button className="ml-2" onClick={onCancel}>Cancelar</Button>
    </form>
  );
}

function ReceiveOrderForm({ order, onDone, onCancel }) {
  const base = useTenantApi();
  const [docNumber, setDocNumber] = useState('');
  const [issueDate, setIssueDate] = useState(today());
  const [dueDate, setDueDate] = useState('');
  const [error, setError] = useState(null);
  const submit = useSubmit(async () => {
    setError(null);
    if (!docNumber.trim()) return setError('Escribe el número de la factura del proveedor.');
    const result = await api.post(`${base}/purchase-orders/${order._id}/receive`, { supplierDocNumber: docNumber.trim(), issueDate, ...(dueDate ? { dueDate } : {}) });
    return onDone(result);
  });
  return (
    <form
      className="my-2 max-w-3xl border-t border-borde pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit.run();
      }}
    >
      <h3 className="mb-2 font-semibold text-tinta">Recibir la orden {order.fullNumber}</h3>
      <p className="mb-3 text-sm text-tinta">Registra la factura de compra con estas líneas, por el pedido completo. Si el proveedor entregó o facturó distinto, registra la compra directamente.</p>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {submit.error ? <Notice kind="error">{errorMessage(submit.error)}</Notice> : null}
      <div className="grid gap-x-4 sm:grid-cols-3">
        <TextField label="Número de la factura del proveedor" value={docNumber} onChange={(e) => setDocNumber(e.target.value)} maxLength={40} />
        <TextField label="Fecha de la factura" type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} />
        <TextField label="Vencimiento (opcional)" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
      </div>
      <Button type="submit" variant="primary" busy={submit.busy}>Registrar la compra</Button>
      <Button className="ml-2" onClick={onCancel}>Cancelar</Button>
    </form>
  );
}

export function PurchaseOrdersScreen() {
  const base = useTenantApi();
  const { tenant, can } = useSession();
  const currency = tenant.currency;
  const status = useLoad(() => api.get(`${base}/purchasing/status`), [base]);
  const rates = ratesOf(status.data);
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState(null);
  const [receiving, setReceiving] = useState(null);
  const [notice, setNotice] = useState(null);
  const [filter, setFilter] = useState('');
  const list = useLoad(() => api.get(`${base}/purchase-orders${filter ? `?status=${filter}` : ''}`), [base, filter]);
  const voidOrder = useSubmit(async (order) => {
    await api.post(`${base}/purchase-orders/${order._id}/void`);
    setNotice(`Orden ${order.fullNumber} anulada.`);
    list.reload();
  });
  const canCreate = can('purchases:create');

  const columns = [
    { key: 'number', title: 'Número', nowrap: true, render: (o) => o.fullNumber },
    { key: 'date', title: 'Fecha', nowrap: true, render: (o) => formatDay(o.issueDate) },
    { key: 'supplier', title: 'Proveedor', render: (o) => o.supplier.name },
    { key: 'expected', title: 'Entrega esperada', nowrap: true, render: (o) => (o.expectedDate ? formatDay(o.expectedDate) : '—') },
    { key: 'total', title: `Total (${currency})`, align: 'right', render: (o) => formatAmount(o.totals.total, currency) },
    { key: 'status', title: 'Estado', render: (o) => (o.status === 'received' ? `Recibida ${o.purchaseNumber ?? ''}`.trim() : ORDER_STATUS[o.status]) },
    {
      key: 'actions',
      title: 'Acciones',
      render: (o) => (
        <span className="flex flex-wrap gap-3">
          <TextButton onClick={() => setOpen(open === o._id ? null : o._id)}>{open === o._id ? 'Ocultar detalle' : 'Ver detalle'}</TextButton>
          {canCreate && o.status === 'open' ? <TextButton onClick={() => { setOpen(o._id); setReceiving(receiving === o._id ? null : o._id); }}>Recibir</TextButton> : null}
          {can('purchases:void') && o.status === 'open' ? <TextButton danger onClick={() => voidOrder.run(o)}>Anular</TextButton> : null}
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader title="Órdenes de compra">{canCreate && !creating ? <Button variant="primary" onClick={() => { setCreating(true); setNotice(null); }}>Nueva orden</Button> : null}</PageHeader>
      <p className="mb-4 text-sm text-tinta">Pedidos a tus proveedores. No generan contabilidad: cuando llega la factura del proveedor, la orden se recibe y se convierte en la factura de compra.</p>
      {notice ? <Notice kind="success">{notice}</Notice> : null}
      {voidOrder.error ? <Notice kind="error">{errorMessage(voidOrder.error)}</Notice> : null}
      {creating ? (
        <OrderForm
          rates={rates}
          onCancel={() => setCreating(false)}
          onCreated={(order) => {
            setCreating(false);
            setNotice(`Orden ${order.fullNumber} creada por ${formatAmount(order.totals.total, order.currency)}.`);
            list.reload();
          }}
        />
      ) : null}
      <div className="mb-4 grid gap-x-4 sm:grid-cols-3">
        <SelectField label="Estado" value={filter} onChange={(e) => setFilter(e.target.value)} options={[{ value: '', label: 'Todas' }, ...Object.entries(ORDER_STATUS).map(([value, text]) => ({ value, label: text }))]} />
      </div>
      {list.error ? <Notice kind="error">{errorMessage(list.error)}</Notice> : null}
      {list.data ? (
        <DataTable
          caption="Órdenes de compra"
          columns={columns}
          rows={list.data.items}
          rowKey={(o) => o._id}
          empty="No hay órdenes con este filtro."
          expandedRow={(o) =>
            open === o._id ? (
              <div className="my-2">
                <LinesReadOnly lines={o.lines} currency={currency} />
                <p className="text-sm text-tinta">Subtotal {formatAmount(o.totals.subtotal, currency)} · IVA {formatAmount(o.totals.tax, currency)} · Total {formatAmount(o.totals.total, currency)}</p>
                {o.notes ? <p className="text-sm text-tinta">Notas: {o.notes}</p> : null}
                {receiving === o._id ? (
                  <ReceiveOrderForm
                    order={o}
                    onCancel={() => setReceiving(null)}
                    onDone={(result) => {
                      setReceiving(null);
                      setNotice(`Compra ${result.purchase.fullNumber} registrada desde ${o.fullNumber}: ${formatAmount(result.purchase.payable, result.purchase.currency)} por pagar.`);
                      list.reload();
                    }}
                  />
                ) : null}
              </div>
            ) : null
          }
        />
      ) : null}
    </>
  );
}

// ------------------------------------------------------------ Facturas recurrentes

function RecurringForm({ rates, onCreated, onCancel }) {
  const base = useTenantApi();
  const { tenant } = useSession();
  const currency = tenant.currency;
  const { accounts, centers } = useLineData(base);
  const defaultRate = defaultRateOf(rates);
  const [form, setForm] = useState({ name: '', customerId: '', frequency: 'monthly', startDate: today(), endDate: '', paymentMethod: 'credit', dueDays: '30', notes: '' });
  const [lines, setLines] = useState([blankLine(defaultRate)]);
  const [showErrors, setShowErrors] = useState(false);
  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));
  const template = validateRecurring(form);
  const result = validateDocLines(lines, { currency });

  const submit = useSubmit(async () => {
    setShowErrors(true);
    if (!template.ok || !result.ok) return;
    onCreated(await api.post(`${base}/recurring-invoices`, { ...template.body, lines: result.prepared }));
  });

  return (
    <form
      className="mb-8 border-b border-borde pb-6"
      onSubmit={(e) => {
        e.preventDefault();
        submit.run();
      }}
    >
      <h2 className="mb-3 text-lg font-semibold text-tinta">Nueva factura recurrente</h2>
      {submit.error ? <Notice kind="error">{errorMessage(submit.error)}</Notice> : null}
      <div className="grid gap-x-4 sm:grid-cols-3">
        <TextField className="sm:col-span-2" label="Nombre de la plantilla" value={form.name} onChange={set('name')} maxLength={100} hint="Por ejemplo: Mantenimiento mensual de Droguería Los Andes." />
      </div>
      <PartyPicker base={base} role="customer" value={form.customerId} onChange={(id) => setForm((f) => ({ ...f, customerId: id }))} error={showErrors && !form.customerId ? 'Elige el cliente.' : undefined} />
      <div className="grid gap-x-4 sm:grid-cols-4">
        <SelectField label="Frecuencia" value={form.frequency} onChange={set('frequency')} options={FREQUENCIES} />
        <TextField label="Primera factura" type="date" value={form.startDate} onChange={set('startDate')} />
        <TextField label="Hasta (opcional)" type="date" value={form.endDate} onChange={set('endDate')} />
        <SelectField label="Forma de pago" value={form.paymentMethod} onChange={set('paymentMethod')} options={PAYMENT} />
        {form.paymentMethod === 'credit' ? <TextField label="Días de plazo" value={form.dueDays} onChange={set('dueDays')} inputMode="numeric" /> : null}
      </div>
      <DocLinesEditor base={base} lines={lines} setLines={setLines} rates={rates} currency={currency} errors={result.errors.lines} showErrors={showErrors} accountMode="income" accounts={accounts} centers={centers} defaultRate={defaultRate} />
      <DocTotals totals={result.totals} currency={currency} totalLabel="Total de cada factura" />
      <TextField label="Notas (opcional)" value={form.notes} onChange={set('notes')} maxLength={500} />
      {showErrors ? <Errors messages={[...(template.ok ? [] : template.errors), ...result.errors.form]} /> : null}
      <Button type="submit" variant="primary" busy={submit.busy}>Crear plantilla</Button>
      <Button className="ml-2" onClick={onCancel}>Cancelar</Button>
    </form>
  );
}

export function RecurringScreen() {
  const base = useTenantApi();
  const { tenant, can } = useSession();
  const currency = tenant.currency;
  const status = useInvoicingStatus();
  const rates = ratesOf(status.data);
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState(null);
  const [notice, setNotice] = useState(null);
  const [outcome, setOutcome] = useState(null);
  const list = useLoad(() => api.get(`${base}/recurring-invoices`), [base]);
  const canIssue = can('invoices:issue');
  const run = useSubmit(async (templateId) => {
    const result = await api.post(`${base}/recurring-invoices/run`, templateId ? { templateId } : {});
    setOutcome(result);
    setNotice(runSummary(result));
    list.reload();
  });
  const toggle = useSubmit(async (template) => {
    await api.patch(`${base}/recurring-invoices/${template._id}`, { active: !template.active });
    setNotice(`Plantilla «${template.name}» ${template.active ? 'pausada' : 'reanudada'}.`);
    list.reload();
  });
  const skip = useSubmit(async (template) => {
    await api.post(`${base}/recurring-invoices/${template._id}/skip`);
    setNotice(`Se saltó el período ${formatDay(template.nextDate)} de «${template.name}».`);
    list.reload();
  });
  const due = (t) => t.active && t.nextDate.slice(0, 10) <= today();

  const columns = [
    { key: 'name', title: 'Plantilla', render: (t) => t.name },
    { key: 'customer', title: 'Cliente', render: (t) => t.customer.name },
    { key: 'frequency', title: 'Frecuencia', render: (t) => FREQUENCY_LABEL[t.frequency] },
    { key: 'total', title: `Cada factura (${currency})`, align: 'right', render: (t) => formatAmount(t.totals.total, currency) },
    { key: 'next', title: 'Próxima', nowrap: true, render: (t) => (t.active ? `${formatDay(t.nextDate)}${due(t) ? ' · vencida' : ''}` : '—') },
    { key: 'last', title: 'Última', nowrap: true, render: (t) => (t.lastRun ? `${formatDay(t.lastRun.date)} · ${t.lastRun.number ?? 'pendiente'}` : '—') },
    { key: 'status', title: 'Estado', render: (t) => (t.lastError ? `Con error: ${t.lastError.message}` : t.active ? 'Activa' : t.finishedAt ? 'Terminada' : 'Pausada') },
    {
      key: 'actions',
      title: 'Acciones',
      render: (t) => (
        <span className="flex flex-wrap gap-3">
          <TextButton onClick={() => setOpen(open === t._id ? null : t._id)}>{open === t._id ? 'Ocultar detalle' : 'Ver detalle'}</TextButton>
          {canIssue && due(t) ? <TextButton onClick={() => run.run(t._id)}>Generar ahora</TextButton> : null}
          {canIssue && t.active ? <TextButton onClick={() => skip.run(t)}>Saltar período</TextButton> : null}
          {canIssue && !t.finishedAt ? <TextButton danger={t.active} onClick={() => toggle.run(t)}>{t.active ? 'Pausar' : 'Reanudar'}</TextButton> : null}
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader title="Facturas recurrentes">
        {canIssue ? <Button busy={run.busy} onClick={() => run.run()}>Generar las vencidas</Button> : null}
        {canIssue && !creating ? <Button variant="primary" onClick={() => { setCreating(true); setNotice(null); }}>Nueva plantilla</Button> : null}
      </PageHeader>
      <p className="mb-4 text-sm text-tinta">Plantillas para cobrar lo mismo cada semana, mes, trimestre o año. Las facturas se emiten cuando las generas aquí o con la tarea programada del servidor; repetirlo no emite dos veces el mismo período.</p>
      {notice ? <Notice kind={outcome?.failed.length ? 'error' : 'success'}>{notice}</Notice> : null}
      {outcome?.failed.map((f) => (
        <Notice key={`${f.templateId}-${f.date}`} kind="error" title={`${f.name}: no se pudo emitir la del ${formatDay(f.date)}`}>
          {f.message}. Corrígelo y vuelve a generar, o salta el período.
        </Notice>
      ))}
      {[run, toggle, skip].map((s, i) => (s.error ? <Notice key={i} kind="error">{errorMessage(s.error)}</Notice> : null))}
      {creating ? (
        <RecurringForm
          rates={rates}
          onCancel={() => setCreating(false)}
          onCreated={(t) => {
            setCreating(false);
            setOutcome(null);
            setNotice(`Plantilla «${t.name}» creada: la primera factura sale el ${formatDay(t.nextDate)}.`);
            list.reload();
          }}
        />
      ) : null}
      {list.error ? <Notice kind="error">{errorMessage(list.error)}</Notice> : null}
      {list.data ? (
        <DataTable
          caption="Facturas recurrentes"
          columns={columns}
          rows={list.data.items}
          rowKey={(t) => t._id}
          empty="Todavía no hay plantillas."
          expandedRow={(t) =>
            open === t._id ? (
              <div className="my-2">
                <LinesReadOnly lines={t.lines} currency={currency} />
                <p className="text-sm text-tinta">
                  {t.paymentMethod === 'credit' ? `A crédito, ${t.dueDays} días de plazo` : 'De contado'} · {t.runCount} {t.runCount === 1 ? 'factura emitida' : 'facturas emitidas'}
                  {t.endDate ? ` · hasta el ${formatDay(t.endDate)}` : ''}
                </p>
                {t.notes ? <p className="text-sm text-tinta">Notas: {t.notes}</p> : null}
              </div>
            ) : null
          }
        />
      ) : null}
    </>
  );
}
