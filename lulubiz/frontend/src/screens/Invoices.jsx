import { useState } from 'react';
import { Button, DataTable, Notice, PageHeader, SelectField, TextButton, TextField, errorMessage, useLoad, useSubmit } from '../components/ui.jsx';
import { PartyPicker } from '../components/PartyPicker.jsx';
import { api, newIdempotencyKey } from '../lib/api.js';
import { formatDay } from '../lib/format.js';
import { computeLine, computeTotals, formatPercent, formatQuantity, parsePercent, parseQuantity } from '../lib/invoicing.js';
import { formatAmount, parseAmount } from '../lib/money.js';
import { Link } from '../lib/router.jsx';
import { useSession, useTenantApi } from '../lib/session.jsx';

const STATUS_LABELS = { issued: 'Emitida', pending_provider: 'Pendiente de envío', rejected: 'Rechazada' };
const CREDIT_LABELS = { partial: 'Acreditada en parte', full: 'Acreditada del todo' };
const today = () => new Date().toISOString().slice(0, 10);

/** Estado de facturación de la empresa: si hay proveedor, si es el simulador y qué falta por configurar. */
export function useInvoicingStatus() {
  const base = useTenantApi();
  return useLoad(() => api.get(`${base}/invoicing/status`), [base]);
}

/** Aviso permanente cuando los documentos no tienen validez ante la autoridad tributaria. */
export function SandboxNotice({ status }) {
  if (!status?.sandbox) return null;
  return (
    <Notice kind="error" title="Modo de pruebas: estos documentos no tienen validez ante la DIAN">
      Se emiten con un proveedor simulado. Sirven para probar el flujo, no para facturar de verdad.
    </Notice>
  );
}

function SetupNotice({ status }) {
  if (!status) return null;
  if (!status.configured) {
    return (
      <Notice kind="error" title="La facturación electrónica no está configurada">
        Este servidor no tiene un proveedor de facturación electrónica conectado. Mientras tanto no se pueden emitir facturas.
      </Notice>
    );
  }
  if (!status.ready) {
    return (
      <Notice kind="info" title="Falta configurar la facturación">
        <p className="mb-1">Antes de emitir hace falta: {status.missing.join(', ')}.</p>
        <Link href="/app/facturacion">Ir a la configuración</Link>
      </Notice>
    );
  }
  return null;
}

/** Texto de lo que pasó al emitir, según la respuesta del servidor. */
export function outcomeNotice(result, kindLabel) {
  const doc = result.invoice ?? result.note;
  const label = `${kindLabel} ${doc.fullNumber}`;
  if (result.rejected || doc.status === 'rejected') {
    return { kind: 'error', text: `${label} fue rechazada por el proveedor: ${doc.rejection?.message ?? 'sin detalle'}.` };
  }
  if (result.pending || doc.status === 'pending_provider') {
    return { kind: 'info', text: `El proveedor no respondió. ${label} quedó pendiente de envío: usa «Reintentar envío» en unos minutos. No se contabilizó.` };
  }
  if (doc.accounting?.status === 'pending') {
    return { kind: 'info', text: `${label} quedó emitida, pero falta contabilizarla: ${doc.accounting.error ?? 'no se pudo registrar el asiento'}. Corrígelo y usa «Contabilizar».` };
  }
  return { kind: 'success', text: `${label} emitida y contabilizada.${doc.provider?.sandbox ? ' (Modo de pruebas: sin validez ante la DIAN.)' : ''}` };
}

/** Validación del formulario de factura: devuelve errores por campo, las líneas listas para enviar y la vista previa de importes. */
export function validateInvoice({ customerId, issueDate, paymentMethod, dueDate, lines, currency }) {
  const errors = { form: [], lines: [] };
  if (!customerId) errors.form.push('Elige el cliente.');
  if (!issueDate) errors.form.push('Elige la fecha de emisión.');
  if (paymentMethod === 'credit' && !dueDate) errors.form.push('Una venta a crédito necesita fecha de vencimiento.');
  if (dueDate && issueDate && dueDate < issueDate) errors.form.push('El vencimiento no puede ser anterior a la emisión.');

  const prepared = [];
  const computed = [];
  lines.forEach((line, i) => {
    const e = {};
    errors.lines[i] = e;
    const blank = !line.description.trim() && !line.unitPrice.trim() && line.quantity.trim() === '1';
    if (blank) return;
    if (!line.description.trim()) e.description = 'Escribe qué se vende.';
    const quantity = parseQuantity(line.quantity);
    if (quantity === null) e.quantity = 'Cantidad no válida (hasta 3 decimales).';
    const unitPrice = parseAmount(line.unitPrice, currency);
    if (unitPrice === null || line.unitPrice.trim() === '') e.unitPrice = 'Precio no válido. Ejemplo: 1.250.000,50';
    const discountBps = parsePercent(line.discount);
    if (discountBps === null) e.discount = 'Descuento entre 0 y 100.';
    if (line.accountId.trim() && !/^\d{1,12}$/.test(line.accountId.trim())) e.accountId = 'Código de cuenta numérico.';
    if (Object.keys(e).length) return;
    const result = computeLine({ quantity, unitPrice, discountBps, vatBps: line.vatBps });
    if (!result) {
      e.unitPrice = 'El importe es demasiado grande.';
      return;
    }
    computed.push({ vatBps: line.vatBps, ...result });
    prepared.push({
      description: line.description.trim(),
      quantity,
      unitPrice,
      ...(discountBps ? { discountBps } : {}),
      vatBps: line.vatBps,
      ...(line.accountId.trim() ? { accountId: line.accountId.trim() } : {}),
      _preview: result,
    });
  });
  if (prepared.length === 0) errors.form.push('Agrega al menos una línea.');
  const totals = computeTotals(computed);
  if (prepared.length && totals.total <= 0) errors.form.push('El total debe ser mayor que cero.');
  const hasLineErrors = errors.lines.some((e) => Object.keys(e).length);
  return { ok: !errors.form.length && !hasLineErrors, errors, prepared, totals };
}

const blankLine = (vatBps) => ({ description: '', quantity: '1', unitPrice: '', discount: '', vatBps, accountId: '' });

function InvoiceForm({ status, onCreated, onCancel }) {
  const base = useTenantApi();
  const { tenant } = useSession();
  const currency = tenant.currency;
  const rates = status.vatRatesBps;
  const defaultRate = rates.includes(1900) ? 1900 : rates[rates.length - 1];
  const [customerId, setCustomerId] = useState('');
  const [issueDate, setIssueDate] = useState(today());
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [dueDate, setDueDate] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState([blankLine(defaultRate)]);
  const [showErrors, setShowErrors] = useState(false);
  const [key, setKey] = useState(newIdempotencyKey);
  const accounts = useLoad(() => api.get(`${base}/accounts?activeOnly=true`), [base]);
  const postable = (accounts.data?.items ?? []).filter((a) => a.postable);

  const result = validateInvoice({ customerId, issueDate, paymentMethod, dueDate, lines, currency });
  const setLine = (i, field) => (e) => setLines((ls) => ls.map((l, n) => (n === i ? { ...l, [field]: field === 'vatBps' ? Number(e.target.value) : e.target.value } : l)));

  const submit = useSubmit(async () => {
    setShowErrors(true);
    if (!result.ok) return;
    const body = {
      customerId,
      issueDate,
      paymentMethod,
      ...(paymentMethod === 'credit' ? { dueDate } : dueDate ? { dueDate } : {}),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
      lines: result.prepared.map(({ _preview, ...line }) => line),
    };
    const outcome = await api.post(`${base}/invoices`, body, { 'idempotency-key': key });
    setKey(newIdempotencyKey());
    onCreated(outcome);
  });

  return (
    <form
      className="mb-8 border-b border-borde pb-6"
      onSubmit={(e) => {
        e.preventDefault();
        submit.run();
      }}
    >
      <h2 className="mb-3 text-lg font-semibold text-tinta">Nueva factura</h2>
      {submit.error ? <Notice kind="error">{errorMessage(submit.error)}</Notice> : null}
      <PartyPicker base={base} role="customer" value={customerId} onChange={setCustomerId} error={showErrors && !customerId ? 'Elige el cliente.' : undefined} />
      <div className="grid gap-x-4 sm:grid-cols-3">
        <TextField label="Fecha de emisión" type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} required />
        <SelectField label="Forma de pago" value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)} options={[{ value: 'cash', label: 'Contado' }, { value: 'credit', label: 'Crédito' }]} />
        <TextField label={paymentMethod === 'credit' ? 'Vencimiento' : 'Vencimiento (opcional)'} type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
      </div>

      <datalist id="cuentas-ingreso">
        {postable.map((a) => (
          <option key={a.code} value={a.code}>{a.name}</option>
        ))}
      </datalist>

      <div className="relative overflow-x-auto">
        <table className="mb-2 w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-borde-fuerte text-left">
              <th scope="col" className="px-2 py-2 font-semibold">Descripción</th>
              <th scope="col" className="px-2 py-2 text-right font-semibold">Cantidad</th>
              <th scope="col" className="px-2 py-2 text-right font-semibold">Precio unitario ({currency})</th>
              <th scope="col" className="px-2 py-2 text-right font-semibold">Descuento %</th>
              <th scope="col" className="px-2 py-2 font-semibold">IVA</th>
              <th scope="col" className="px-2 py-2 font-semibold">Cuenta de ingreso</th>
              <th scope="col" className="px-2 py-2 text-right font-semibold">Total de la línea</th>
              <th scope="col" className="px-2 py-2"><span className="sr-only">Acciones</span></th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line, i) => {
              const e = (showErrors && result.errors.lines[i]) || {};
              const quantity = parseQuantity(line.quantity);
              const unit = parseAmount(line.unitPrice, currency);
              const discount = parsePercent(line.discount);
              const preview = quantity !== null && unit !== null && discount !== null && line.unitPrice.trim() ? computeLine({ quantity, unitPrice: unit, discountBps: discount, vatBps: line.vatBps }) : null;
              const field = (name, label, extra = {}) => (
                <input
                  aria-label={`${label} de la línea ${i + 1}`}
                  value={line[name]}
                  onChange={setLine(i, name)}
                  className={`w-full rounded-sm border bg-papel px-2 py-1.5 text-sm text-tinta focus:outline-2 focus:outline-azul ${e[name] ? 'border-rojo' : 'border-borde-fuerte'} ${extra.className ?? ''}`}
                  {...extra.props}
                />
              );
              return (
                <tr key={i} className="border-b border-borde align-top">
                  <td className="px-2 py-2">
                    {field('description', 'Descripción', { className: 'min-w-48', props: { maxLength: 200 } })}
                    {e.description ? <p role="alert" className="text-xs font-semibold text-rojo">{e.description}</p> : null}
                  </td>
                  <td className="px-2 py-2 text-right">
                    {field('quantity', 'Cantidad', { className: 'w-24 text-right tabular-nums', props: { inputMode: 'decimal' } })}
                    {e.quantity ? <p role="alert" className="text-left text-xs font-semibold text-rojo">{e.quantity}</p> : null}
                  </td>
                  <td className="px-2 py-2 text-right">
                    {field('unitPrice', 'Precio unitario', { className: 'w-36 text-right tabular-nums', props: { inputMode: 'decimal' } })}
                    {e.unitPrice ? <p role="alert" className="text-left text-xs font-semibold text-rojo">{e.unitPrice}</p> : null}
                  </td>
                  <td className="px-2 py-2 text-right">
                    {field('discount', 'Descuento', { className: 'w-20 text-right tabular-nums', props: { inputMode: 'decimal' } })}
                    {e.discount ? <p role="alert" className="text-left text-xs font-semibold text-rojo">{e.discount}</p> : null}
                  </td>
                  <td className="px-2 py-2">
                    <select
                      aria-label={`IVA de la línea ${i + 1}`}
                      value={line.vatBps}
                      onChange={setLine(i, 'vatBps')}
                      className="rounded-sm border border-borde-fuerte bg-papel px-2 py-1.5 text-sm text-tinta focus:outline-2 focus:outline-azul"
                    >
                      {rates.map((r) => (
                        <option key={r} value={r}>{formatPercent(r)}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-2 py-2">
                    {field('accountId', 'Cuenta de ingreso', { className: 'w-28', props: { list: 'cuentas-ingreso' } })}
                    {e.accountId ? <p role="alert" className="text-xs font-semibold text-rojo">{e.accountId}</p> : null}
                  </td>
                  <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-tinta">{preview ? formatAmount(preview.total, currency) : ''}</td>
                  <td className="px-2 py-2">
                    {lines.length > 1 ? <TextButton danger onClick={() => setLines((ls) => ls.filter((_, n) => n !== i))}>Quitar</TextButton> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <TextButton onClick={() => setLines((ls) => [...ls, blankLine(defaultRate)])}>Agregar línea</TextButton>

      <dl className="mb-4 mt-4 ml-auto grid max-w-sm grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm text-tinta">
        <dt>Subtotal</dt>
        <dd className="text-right tabular-nums">{formatAmount(result.totals.subtotal, currency)}</dd>
        {result.totals.taxByRate.map((r) => (
          <div key={r.vatBps} className="contents">
            <dt>IVA {formatPercent(r.vatBps)} sobre {formatAmount(r.base, currency)}</dt>
            <dd className="text-right tabular-nums">{formatAmount(r.tax, currency)}</dd>
          </div>
        ))}
        <dt className="font-semibold">Total a cobrar</dt>
        <dd className="text-right text-base font-semibold tabular-nums">{formatAmount(result.totals.total, currency)}</dd>
      </dl>

      <TextField label="Notas (opcional)" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
      {showErrors && result.errors.form.length ? (
        <Notice kind="error">
          {result.errors.form.map((m) => (
            <p key={m}>{m}</p>
          ))}
        </Notice>
      ) : null}
      <Button type="submit" variant="primary" busy={submit.busy}>
        Emitir factura
      </Button>
      <Button className="ml-2" onClick={onCancel}>
        Cancelar
      </Button>
    </form>
  );
}

function CreditNoteForm({ invoice, status, currency, onDone, onCancel }) {
  const base = useTenantApi();
  const [reasonCode, setReasonCode] = useState(status.creditNoteReasons[0].code);
  const [mode, setMode] = useState('all');
  const [quantities, setQuantities] = useState(() => invoice.lines.map(() => ''));
  const [issueDate, setIssueDate] = useState(today());
  const [key, setKey] = useState(newIdempotencyKey);
  const remaining = invoice.lines.map((l, i) => l.quantity - invoice.credited.quantity[i]);

  const submit = useSubmit(async () => {
    let body = { reasonCode, issueDate };
    if (mode === 'all') body = { ...body, all: true };
    else {
      const chosen = [];
      for (const [i, text] of quantities.entries()) {
        if (!text.trim()) continue;
        const quantity = parseQuantity(text);
        if (quantity === null) throw Object.assign(new Error(`Línea ${i + 1}: cantidad no válida.`), { status: 0 });
        if (quantity > remaining[i]) throw Object.assign(new Error(`Línea ${i + 1}: solo quedan ${formatQuantity(remaining[i])} por acreditar.`), { status: 0 });
        chosen.push({ lineIndex: i, quantity });
      }
      if (!chosen.length) throw Object.assign(new Error('Indica la cantidad que se acredita en al menos una línea.'), { status: 0 });
      body = { ...body, lines: chosen };
    }
    const outcome = await api.post(`${base}/invoices/${invoice._id}/credit-notes`, body, { 'idempotency-key': key });
    setKey(newIdempotencyKey());
    onDone(outcome);
  });

  return (
    <form
      className="mt-3 max-w-3xl border-t border-borde pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit.run();
      }}
    >
      <h3 className="mb-2 font-semibold text-tinta">Nota crédito a la factura {invoice.fullNumber}</h3>
      {submit.error ? <Notice kind="error">{errorMessage(submit.error)}</Notice> : null}
      <div className="grid gap-x-4 sm:grid-cols-2">
        <SelectField label="Motivo" value={reasonCode} onChange={(e) => setReasonCode(e.target.value)} options={status.creditNoteReasons.map((r) => ({ value: r.code, label: r.label }))} />
        <TextField label="Fecha de la nota" type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} required />
      </div>
      <SelectField
        label="Qué se acredita"
        value={mode}
        onChange={(e) => setMode(e.target.value)}
        options={[{ value: 'all', label: 'Todo lo que queda de la factura' }, { value: 'lines', label: 'Solo algunas cantidades' }]}
      />
      {mode === 'lines' ? (
        <table className="mb-3 text-sm">
          <thead>
            <tr className="text-left">
              <th scope="col" className="pr-4 font-semibold">Línea</th>
              <th scope="col" className="pr-4 text-right font-semibold">Por acreditar</th>
              <th scope="col" className="font-semibold">Cantidad a acreditar</th>
            </tr>
          </thead>
          <tbody>
            {invoice.lines.map((l, i) => (
              <tr key={i}>
                <td className="pr-4">{l.description}</td>
                <td className="pr-4 text-right tabular-nums">{formatQuantity(remaining[i])}</td>
                <td>
                  <input
                    aria-label={`Cantidad a acreditar de la línea ${i + 1}`}
                    value={quantities[i]}
                    disabled={remaining[i] === 0}
                    onChange={(e) => setQuantities((qs) => qs.map((q, n) => (n === i ? e.target.value : q)))}
                    className="w-28 rounded-sm border border-borde-fuerte bg-papel px-2 py-1 text-right text-sm tabular-nums text-tinta focus:outline-2 focus:outline-azul"
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="mb-3 text-sm text-tinta">
          Se acredita lo que falte de {invoice.fullNumber}: hasta {formatAmount(invoice.totals.total - invoice.creditedTotal, currency)}.
        </p>
      )}
      <Button type="submit" variant="primary" busy={submit.busy}>
        Emitir nota crédito
      </Button>
      <Button className="ml-2" onClick={onCancel}>
        Cancelar
      </Button>
    </form>
  );
}

function InvoiceDetail({ invoice, currency }) {
  return (
    <div className="mb-2 ml-4 mt-1 max-w-4xl text-sm text-tinta">
      <table className="mb-3 w-full">
        <thead>
          <tr className="text-left">
            <th scope="col" className="pr-4 font-semibold">Descripción</th>
            <th scope="col" className="pr-4 text-right font-semibold">Cantidad</th>
            <th scope="col" className="pr-4 text-right font-semibold">Precio</th>
            <th scope="col" className="pr-4 text-right font-semibold">Descuento</th>
            <th scope="col" className="pr-4 text-right font-semibold">IVA</th>
            <th scope="col" className="pr-4 text-right font-semibold">Neto</th>
            <th scope="col" className="text-right font-semibold">Total</th>
          </tr>
        </thead>
        <tbody>
          {invoice.lines.map((l, i) => (
            <tr key={i}>
              <td className="pr-4">{l.description}</td>
              <td className="pr-4 text-right tabular-nums">{formatQuantity(l.quantity)}</td>
              <td className="pr-4 text-right tabular-nums">{formatAmount(l.unitPrice, currency)}</td>
              <td className="pr-4 text-right tabular-nums">{l.discountBps ? formatPercent(l.discountBps) : ''}</td>
              <td className="pr-4 text-right tabular-nums">{formatPercent(l.vatBps)}</td>
              <td className="pr-4 text-right tabular-nums">{formatAmount(l.net, currency)}</td>
              <td className="text-right tabular-nums">{formatAmount(l.total, currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="mb-3 grid max-w-sm grid-cols-[1fr_auto] gap-x-6">
        <dt>Subtotal</dt>
        <dd className="text-right tabular-nums">{formatAmount(invoice.totals.subtotal, currency)}</dd>
        {invoice.totals.taxByRate.map((r) => (
          <div key={r.vatBps} className="contents">
            <dt>IVA {formatPercent(r.vatBps)}</dt>
            <dd className="text-right tabular-nums">{formatAmount(r.tax, currency)}</dd>
          </div>
        ))}
        <dt className="font-semibold">Total</dt>
        <dd className="text-right font-semibold tabular-nums">{formatAmount(invoice.totals.total, currency)}</dd>
        {invoice.creditedTotal ? (
          <>
            <dt>Acreditado</dt>
            <dd className="text-right tabular-nums">{formatAmount(invoice.creditedTotal, currency)}</dd>
          </>
        ) : null}
      </dl>
      <p>Resolución {invoice.resolution.number}, rango {invoice.resolution.from} a {invoice.resolution.to}.</p>
      {invoice.cufe ? <p className="break-all">Código de validación (CUFE): <span className="font-semibold">{invoice.cufe}</span></p> : null}
      {invoice.provider ? <p>Proveedor: {invoice.provider.name}{invoice.provider.sandbox ? ' (simulado: sin validez ante la DIAN)' : ''}.</p> : null}
      {invoice.rejection ? <p className="font-semibold text-rojo">Rechazo: {invoice.rejection.message}</p> : null}
      {invoice.accounting?.status === 'pending' && invoice.status === 'issued' ? (
        <p className="font-semibold text-rojo">Sin contabilizar: {invoice.accounting.error}</p>
      ) : null}
      {invoice.notes ? <p>Notas: {invoice.notes}</p> : null}
    </div>
  );
}

export function InvoicesScreen() {
  const base = useTenantApi();
  const { tenant, can } = useSession();
  const currency = tenant.currency;
  const status = useInvoicingStatus();
  const [filter, setFilter] = useState('');
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState(null);
  const [crediting, setCrediting] = useState(null);
  const [notice, setNotice] = useState(null);
  const [extra, setExtra] = useState([]);
  const [cursor, setCursor] = useState(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState(null);

  const query = filter ? `status=${filter}` : '';
  const list = useLoad(() => api.get(`${base}/invoices?${query}`), [base, query]);
  const items = [...(list.data?.items ?? []), ...extra];
  const next = cursor === undefined ? list.data?.nextCursor : cursor;

  const reset = () => {
    setExtra([]);
    setCursor(undefined);
    list.reload();
  };

  const loadMore = async () => {
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await api.get(`${base}/invoices?${query}${query ? '&' : ''}cursor=${next}`);
      setExtra((e) => [...e, ...page.items]);
      setCursor(page.nextCursor);
    } catch (error) {
      setMoreError(error);
    } finally {
      setLoadingMore(false);
    }
  };

  const act = useSubmit(async (invoice, action) => {
    const result = await api.post(`${base}/invoices/${invoice._id}/${action}`);
    setNotice(outcomeNotice(result, 'La factura'));
    reset();
  });

  const columns = [
    { key: 'number', title: 'Número', nowrap: true, render: (i) => i.fullNumber },
    { key: 'date', title: 'Fecha', nowrap: true, render: (i) => formatDay(i.issueDate) },
    { key: 'customer', title: 'Cliente', render: (i) => i.customer.name },
    { key: 'total', title: `Total (${currency})`, align: 'right', render: (i) => formatAmount(i.totals.total, currency) },
    { key: 'balance', title: 'Por cobrar', align: 'right', render: (i) => (i.status === 'issued' && i.collectible ? formatAmount(i.balance, currency) : '—') },
    {
      key: 'status',
      title: 'Estado',
      render: (i) => (
        <span>
          {STATUS_LABELS[i.status]}
          {i.provider?.sandbox ? ' · pruebas' : ''}
          {i.status === 'issued' && i.accounting?.status === 'pending' ? ' · sin contabilizar' : ''}
          {CREDIT_LABELS[i.creditStatus] ? ` · ${CREDIT_LABELS[i.creditStatus].toLowerCase()}` : ''}
        </span>
      ),
    },
    {
      key: 'actions',
      title: 'Acciones',
      render: (i) => (
        <span className="flex flex-wrap gap-3">
          <TextButton onClick={() => setOpen(open === i._id ? null : i._id)}>{open === i._id ? 'Ocultar detalle' : 'Ver detalle'}</TextButton>
          {can('invoices:issue') && i.status !== 'issued' ? <TextButton onClick={() => act.run(i, 'sync')}>Reintentar envío</TextButton> : null}
          {can('invoices:issue') && i.status === 'issued' && i.accounting?.status === 'pending' ? <TextButton onClick={() => act.run(i, 'account')}>Contabilizar</TextButton> : null}
          {can('invoices:issue') && status.data?.ready && i.status === 'issued' && i.creditStatus !== 'full' ? (
            <TextButton onClick={() => { setOpen(i._id); setCrediting(crediting === i._id ? null : i._id); }}>Acreditar</TextButton>
          ) : null}
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader title="Facturas">
        {can('invoices:issue') && status.data?.ready && !creating ? (
          <Button variant="primary" onClick={() => { setCreating(true); setNotice(null); }}>
            Nueva factura
          </Button>
        ) : null}
      </PageHeader>

      <SandboxNotice status={status.data} />
      <SetupNotice status={status.data} />
      {notice ? <Notice kind={notice.kind}>{notice.text}</Notice> : null}
      {act.error ? <Notice kind="error">{errorMessage(act.error)}</Notice> : null}

      {creating && status.data ? (
        <InvoiceForm
          status={status.data}
          onCancel={() => setCreating(false)}
          onCreated={(outcome) => {
            setCreating(false);
            setNotice(outcomeNotice(outcome, 'La factura'));
            reset();
          }}
        />
      ) : null}

      <div className="mb-4 grid gap-x-4 sm:grid-cols-3">
        <SelectField
          label="Estado"
          value={filter}
          onChange={(e) => { setFilter(e.target.value); setExtra([]); setCursor(undefined); }}
          options={[{ value: '', label: 'Todas' }, { value: 'issued', label: 'Emitidas' }, { value: 'pending_provider', label: 'Pendientes de envío' }, { value: 'rejected', label: 'Rechazadas' }]}
        />
      </div>

      {list.error ? <Notice kind="error">{errorMessage(list.error)}</Notice> : null}
      {list.loading && !list.data ? <p className="text-sm text-tinta">Cargando facturas…</p> : null}
      {list.data ? (
        <DataTable
          caption="Facturas"
          columns={columns}
          rows={items}
          rowKey={(i) => i._id}
          empty="No hay facturas con este filtro."
          expandedRow={(i) =>
            open === i._id ? (
              <>
                <InvoiceDetail invoice={i} currency={currency} />
                {crediting === i._id && status.data ? (
                  <CreditNoteForm
                    invoice={i}
                    status={status.data}
                    currency={currency}
                    onCancel={() => setCrediting(null)}
                    onDone={(outcome) => {
                      setCrediting(null);
                      setNotice(outcomeNotice(outcome, 'La nota crédito'));
                      reset();
                    }}
                  />
                ) : null}
              </>
            ) : null
          }
        />
      ) : null}
      {moreError ? <Notice kind="error">{errorMessage(moreError)}</Notice> : null}
      {next ? (
        <div className="mt-4">
          <Button busy={loadingMore} onClick={loadMore}>Cargar más facturas</Button>
        </div>
      ) : null}
    </>
  );
}

export function CreditNotesScreen() {
  const base = useTenantApi();
  const { tenant, can } = useSession();
  const currency = tenant.currency;
  const status = useInvoicingStatus();
  const list = useLoad(() => api.get(`${base}/credit-notes?limit=50`), [base]);
  const [notice, setNotice] = useState(null);

  const act = useSubmit(async (note, action) => {
    const result = await api.post(`${base}/credit-notes/${note._id}/${action}`);
    setNotice(outcomeNotice(result.note ? result : { note: result.note ?? result }, 'La nota crédito'));
    list.reload();
  });

  const columns = [
    { key: 'number', title: 'Número', nowrap: true, render: (n) => n.fullNumber },
    { key: 'date', title: 'Fecha', nowrap: true, render: (n) => formatDay(n.issueDate) },
    { key: 'invoice', title: 'Factura', nowrap: true, render: (n) => n.invoiceFullNumber },
    { key: 'customer', title: 'Cliente', render: (n) => n.customer.name },
    { key: 'reason', title: 'Motivo', render: (n) => n.reasonText },
    { key: 'total', title: `Total (${currency})`, align: 'right', render: (n) => formatAmount(n.totals.total, currency) },
    {
      key: 'status',
      title: 'Estado',
      render: (n) => (
        <span>
          {STATUS_LABELS[n.status]}
          {n.provider?.sandbox ? ' · pruebas' : ''}
          {n.status === 'issued' && n.accounting?.status === 'pending' ? ' · sin contabilizar' : ''}
        </span>
      ),
    },
    {
      key: 'actions',
      title: 'Acciones',
      render: (n) =>
        can('invoices:issue') ? (
          <span className="flex gap-3">
            {n.status === 'pending_provider' ? <TextButton onClick={() => act.run(n, 'sync')}>Reintentar envío</TextButton> : null}
            {n.status === 'issued' && n.accounting?.status === 'pending' ? <TextButton onClick={() => act.run(n, 'account')}>Contabilizar</TextButton> : null}
          </span>
        ) : null,
    },
  ];

  return (
    <>
      <PageHeader title="Notas crédito" />
      <SandboxNotice status={status.data} />
      <p className="mb-4 text-sm text-tinta">Las notas crédito se emiten desde la factura que corrigen: usa «Acreditar» en la lista de facturas.</p>
      {notice ? <Notice kind={notice.kind}>{notice.text}</Notice> : null}
      {act.error ? <Notice kind="error">{errorMessage(act.error)}</Notice> : null}
      {list.error ? <Notice kind="error">{errorMessage(list.error)}</Notice> : null}
      {list.loading && !list.data ? <p className="text-sm text-tinta">Cargando notas crédito…</p> : null}
      {list.data ? <DataTable caption="Notas crédito" columns={columns} rows={list.data.items} rowKey={(n) => n._id} empty="Todavía no hay notas crédito." /> : null}
    </>
  );
}
