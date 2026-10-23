import { useState } from 'react';
import { ItemPicker } from '../components/ItemPicker.jsx';
import { PartyPicker } from '../components/PartyPicker.jsx';
import { CostCenterSelect, useCostCenters } from '../components/CostCenterSelect.jsx';
import { DeleteButton, Button, DataTable, Notice, PageHeader, SelectField, TextButton, TextField, errorMessage, useLoad, useSubmit } from '../components/ui.jsx';
import { api, newIdempotencyKey } from '../lib/api.js';
import { formatDay } from '../lib/format.js';
import { formatPercent } from '../lib/invoicing.js';
import { formatAmount, parseAmount } from '../lib/money.js';
import { PAYMENT_LABELS, cartLine, differenceLabel, linePreview, validateClose, validateSale } from '../lib/pos.js';
import { Link } from '../lib/router.jsx';
import { useSession, useTenantApi } from '../lib/session.jsx';

const today = () => new Date().toISOString().slice(0, 10);
const FALLBACK_RATES = [0, 500, 1900];
const cellInput = 'rounded-sm border bg-papel px-2 py-1.5 text-sm text-tinta focus:outline-2 focus:outline-azul';

// ---------------------------------------------------------------------------------------------- venta

function OpenShift({ register, onOpened }) {
  const base = useTenantApi();
  const { tenant } = useSession();
  const [cash, setCash] = useState('0');
  const open = useSubmit(async () => {
    const openingCash = parseAmount(cash, tenant.currency);
    if (openingCash === null) throw Object.assign(new Error('El efectivo inicial no es un importe válido. Ejemplo: 50.000'), { status: 0 });
    await api.post(`${base}/pos/registers/${register._id}/shifts`, { openingCash });
    onOpened();
  });
  return (
    <form
      className="max-w-md"
      onSubmit={(e) => {
        e.preventDefault();
        open.run();
      }}
    >
      <Notice kind="info" title={`La caja ${register.code} no tiene un turno abierto`}>
        Para vender hay que abrir un turno con el efectivo que hay en la caja al empezar.
      </Notice>
      {open.error ? <Notice kind="error">{errorMessage(open.error)}</Notice> : null}
      <TextField label={`Efectivo inicial (${tenant.currency})`} value={cash} onChange={(e) => setCash(e.target.value)} inputMode="decimal" />
      <Button type="submit" variant="primary" busy={open.busy}>
        Abrir turno
      </Button>
    </form>
  );
}

function CloseShift({ shift, onClosed, onCancel }) {
  const base = useTenantApi();
  const { tenant } = useSession();
  const currency = tenant.currency;
  const [counted, setCounted] = useState('');
  const [notes, setNotes] = useState('');
  const expectedCash = shift.openingCash + shift.cashTotal;
  const result = validateClose({ countedText: counted, expectedCash, currency });
  const [showErrors, setShowErrors] = useState(false);

  const close = useSubmit(async () => {
    setShowErrors(true);
    if (!result.ok) return;
    const outcome = await api.post(`${base}/pos/shifts/${shift._id}/close`, { countedCash: result.counted, date: today(), ...(notes.trim() ? { notes: notes.trim() } : {}) });
    onClosed(outcome.shift);
  });

  return (
    <form
      className="mb-6 max-w-2xl border-b border-borde pb-4"
      onSubmit={(e) => {
        e.preventDefault();
        close.run();
      }}
    >
      <h2 className="mb-2 text-lg font-semibold text-tinta">Cerrar el turno</h2>
      {close.error ? <Notice kind="error">{errorMessage(close.error)}</Notice> : null}
      <dl className="mb-3 grid max-w-sm grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm text-tinta">
        <dt>Efectivo inicial</dt>
        <dd className="text-right tabular-nums">{formatAmount(shift.openingCash, currency)}</dd>
        <dt>Cobrado en efectivo</dt>
        <dd className="text-right tabular-nums">{formatAmount(shift.cashTotal, currency)}</dd>
        <dt className="font-semibold">Efectivo que debe haber</dt>
        <dd className="text-right font-semibold tabular-nums">{formatAmount(expectedCash, currency)}</dd>
      </dl>
      <TextField label={`Efectivo contado (${currency})`} value={counted} onChange={(e) => setCounted(e.target.value)} inputMode="decimal" error={showErrors && !result.ok ? result.error : undefined} hint="Cuenta lo que hay en la caja y escríbelo." />
      {result.ok ? (
        <p className="mb-3 text-sm text-tinta">
          {differenceLabel(result.difference)}
          {result.difference !== 0 ? `: ${formatAmount(Math.abs(result.difference), currency)}. Se asienta en la cuenta de ${result.difference < 0 ? 'faltantes' : 'sobrantes'} de la caja.` : '.'}
        </p>
      ) : null}
      <TextField label="Notas (opcional)" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
      <Button type="submit" variant="primary" busy={close.busy}>
        Cerrar turno
      </Button>
      <Button className="ml-2" onClick={onCancel}>
        Cancelar
      </Button>
    </form>
  );
}

function SaleForm({ register, rates, onSold }) {
  const base = useTenantApi();
  const { tenant } = useSession();
  const currency = tenant.currency;
  const accepts = { card: Boolean(register.accounts.card), transfer: Boolean(register.accounts.transfer) };
  const defaultRate = rates.includes(1900) ? 1900 : rates[rates.length - 1];
  const [lines, setLines] = useState([]);
  const [pick, setPick] = useState({ text: '', item: null });
  const [pickError, setPickError] = useState(null);
  const [cardText, setCardText] = useState('');
  const [transferText, setTransferText] = useState('');
  const [tenderedText, setTenderedText] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const [key, setKey] = useState(newIdempotencyKey);

  const result = validateSale({ lines, cardText, transferText, tenderedText, currency, accepts });
  const setLine = (i, field) => (e) => setLines((ls) => ls.map((l, n) => (n === i ? { ...l, [field]: field === 'vatBps' ? Number(e.target.value) : e.target.value } : l)));

  const addItem = () => {
    if (!pick.item) {
      setPickError(pick.text.trim() ? 'Elige un código de la lista.' : 'Escribe el código o el nombre del artículo.');
      return;
    }
    setPickError(null);
    setLines((ls) => [...ls, cartLine({ item: pick.item, vatBps: defaultRate })]);
    setPick({ text: '', item: null });
  };

  const sell = useSubmit(async () => {
    setShowErrors(true);
    if (!result.ok) return;
    const body = { registerId: register._id, date: today(), ...(customerId ? { customerId } : {}), ...result.body };
    const outcome = await api.post(`${base}/pos/sales`, body, { 'idempotency-key': key });
    setKey(newIdempotencyKey());
    setLines([]);
    setCardText('');
    setTransferText('');
    setTenderedText('');
    setCustomerId('');
    setShowErrors(false);
    onSold(outcome.sale);
  });

  return (
    <>
      <form
        className="mb-4 grid items-start gap-x-4 sm:grid-cols-[minmax(0,24rem)_auto_auto]"
        onSubmit={(e) => {
          e.preventDefault();
          addItem();
        }}
      >
        <div>
          <p className="mb-1 text-sm font-semibold text-tinta">Artículo</p>
          <ItemPicker base={base} text={pick.text} item={pick.item} onChange={(text, item) => setPick({ text, item })} error={pickError ?? undefined} />
        </div>
        <div className="pt-6">
          <Button type="submit" variant="primary">
            Agregar
          </Button>
        </div>
        <div className="pt-6">
          <Button onClick={() => setLines((ls) => [...ls, cartLine({ vatBps: defaultRate })])}>Agregar concepto libre</Button>
        </div>
      </form>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          sell.run();
        }}
      >
        {sell.error ? <Notice kind="error">{errorMessage(sell.error)}</Notice> : null}
        <div className="relative overflow-x-auto">
          <table className="mb-2 w-full border-collapse text-sm">
            <caption className="sr-only">Venta en curso</caption>
            <thead>
              <tr className="border-b border-borde-fuerte text-left">
                <th scope="col" className="px-2 py-2 font-semibold">Descripción</th>
                <th scope="col" className="px-2 py-2 text-right font-semibold">Cantidad</th>
                <th scope="col" className="px-2 py-2 text-right font-semibold">Precio ({currency})</th>
                <th scope="col" className="px-2 py-2 font-semibold">IVA</th>
                <th scope="col" className="px-2 py-2 text-right font-semibold">Total</th>
                <th scope="col" className="px-2 py-2"><span className="sr-only">Acciones</span></th>
              </tr>
            </thead>
            <tbody>
              {lines.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-2 py-6 text-tinta">Agrega artículos para empezar la venta.</td>
                </tr>
              ) : (
                lines.map((line, i) => {
                  const e = (showErrors && result.errors.lines[i]) || {};
                  const preview = linePreview(line, currency);
                  return (
                    <tr key={line.key} className="border-b border-borde align-top">
                      <td className="px-2 py-2">
                        {line.item ? (
                          <>
                            <span>{line.description}</span>
                            <span className="block text-xs text-tinta">{line.item.sku}</span>
                          </>
                        ) : (
                          <>
                            <input aria-label={`Descripción de la línea ${i + 1}`} value={line.description} onChange={setLine(i, 'description')} maxLength={200} className={`${cellInput} w-full min-w-48 ${e.description ? 'border-rojo' : 'border-borde-fuerte'}`} />
                            {e.description ? <p role="alert" className="text-xs font-semibold text-rojo">{e.description}</p> : null}
                          </>
                        )}
                      </td>
                      <td className="px-2 py-2 text-right">
                        <input aria-label={`Cantidad de la línea ${i + 1}`} value={line.quantity} onChange={setLine(i, 'quantity')} inputMode="decimal" className={`${cellInput} w-24 text-right tabular-nums ${e.quantity ? 'border-rojo' : 'border-borde-fuerte'}`} />
                        {e.quantity ? <p role="alert" className="text-left text-xs font-semibold text-rojo">{e.quantity}</p> : null}
                      </td>
                      <td className="px-2 py-2 text-right">
                        {line.priceFromItem ? (
                          <span className="tabular-nums">{formatAmount(Number(line.unitPrice), currency)}</span>
                        ) : (
                          <>
                            <input aria-label={`Precio unitario de la línea ${i + 1}`} value={line.unitPrice} onChange={setLine(i, 'unitPrice')} inputMode="decimal" className={`${cellInput} w-32 text-right tabular-nums ${e.unitPrice ? 'border-rojo' : 'border-borde-fuerte'}`} />
                            {e.unitPrice ? <p role="alert" className="text-left text-xs font-semibold text-rojo">{e.unitPrice}</p> : null}
                          </>
                        )}
                      </td>
                      <td className="px-2 py-2">
                        {line.item ? (
                          formatPercent(line.vatBps)
                        ) : (
                          <select aria-label={`IVA de la línea ${i + 1}`} value={line.vatBps} onChange={setLine(i, 'vatBps')} className="rounded-sm border border-borde-fuerte bg-papel px-2 py-1.5 text-sm text-tinta focus:outline-2 focus:outline-azul">
                            {rates.map((r) => (
                              <option key={r} value={r}>{formatPercent(r)}</option>
                            ))}
                          </select>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">{preview ? formatAmount(preview.total, currency) : ''}</td>
                      <td className="px-2 py-2"><DeleteButton onClick={() => setLines((ls) => ls.filter((_, n) => n !== i))}>Quitar</DeleteButton></td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <dl className="mb-4 ml-auto grid max-w-sm grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm text-tinta">
          <dt>Subtotal</dt>
          <dd className="text-right tabular-nums">{formatAmount(result.totals.subtotal, currency)}</dd>
          {result.totals.taxByRate.map((r) => (
            <div key={r.vatBps} className="contents">
              <dt>IVA {formatPercent(r.vatBps)}</dt>
              <dd className="text-right tabular-nums">{formatAmount(r.tax, currency)}</dd>
            </div>
          ))}
          <dt className="font-semibold">Total a cobrar</dt>
          <dd className="text-right text-lg font-semibold tabular-nums">{formatAmount(result.totals.total, currency)}</dd>
        </dl>

        <h2 className="mb-2 text-lg font-semibold text-tinta">Cobro</h2>
        <div className="grid gap-x-4 sm:grid-cols-4">
          {accepts.card ? <TextField label={`${PAYMENT_LABELS.card} (${currency})`} value={cardText} onChange={(e) => setCardText(e.target.value)} inputMode="decimal" /> : null}
          {accepts.transfer ? <TextField label={`${PAYMENT_LABELS.transfer} (${currency})`} value={transferText} onChange={(e) => setTransferText(e.target.value)} inputMode="decimal" /> : null}
          <div>
            <p className="mb-1 text-sm font-semibold text-tinta">{PAYMENT_LABELS.cash} a cobrar</p>
            <p className="py-1.5 text-sm tabular-nums text-tinta">{formatAmount(result.cash, currency)}</p>
          </div>
          <TextField label="Efectivo recibido (opcional)" value={tenderedText} onChange={(e) => setTenderedText(e.target.value)} inputMode="decimal" hint={result.change > 0 ? `Cambio: ${formatAmount(result.change, currency)}` : 'Para calcular el cambio.'} />
        </div>
        <p className="mb-1 text-sm font-semibold text-tinta">Cliente (opcional)</p>
        <PartyPicker base={base} role="customer" value={customerId} onChange={setCustomerId} />
        <p className="mb-4 text-sm text-tinta">Sin cliente, la venta es a consumidor final.</p>

        {showErrors && result.errors.form.length ? (
          <Notice kind="error">
            {result.errors.form.map((m) => (
              <p key={m}>{m}</p>
            ))}
          </Notice>
        ) : null}
        <Button type="submit" variant="primary" busy={sell.busy}>
          Cobrar {result.totals.total > 0 ? `${formatAmount(result.totals.total, currency)} ${currency}` : ''}
        </Button>
        {lines.length ? <Button className="ml-2" onClick={() => setLines([])}>Vaciar</Button> : null}
      </form>
    </>
  );
}

export function PosScreen() {
  const base = useTenantApi();
  const { tenant, can } = useSession();
  const currency = tenant.currency;
  const registers = useLoad(() => api.get(`${base}/pos/registers`), [base]);
  const status = useLoad(() => api.get(`${base}/purchasing/status`).catch(() => null), [base]);
  const rates = status.data?.vatRatesBps ?? FALLBACK_RATES;
  const [registerId, setRegisterId] = useState('');
  const [closing, setClosing] = useState(false);
  const [notice, setNotice] = useState(null);

  const list = (registers.data?.items ?? []).filter((r) => r.active);
  const selected = list.find((r) => r._id === registerId) ?? list.find((r) => r.openShift) ?? list[0] ?? null;
  const shift = selected?.openShift ?? null;

  return (
    <>
      <PageHeader title="Venta de mostrador">
        {shift && !closing ? <Button onClick={() => { setClosing(true); setNotice(null); }}>Cerrar turno</Button> : null}
      </PageHeader>
      {registers.error ? <Notice kind="error">{errorMessage(registers.error)}</Notice> : null}
      {notice ? <Notice kind={notice.kind}>{notice.text}</Notice> : null}
      {registers.data && list.length === 0 ? (
        <Notice kind="info" title="No hay cajas">
          {can('pos:manage') ? (
            <>
              Crea la primera en <Link href="/app/cajas">Cajas</Link> para empezar a vender.
            </>
          ) : (
            'Pide a un administrador que cree una caja.'
          )}
        </Notice>
      ) : null}

      {list.length > 1 ? (
        <div className="mb-4 grid gap-x-4 sm:grid-cols-3">
          <SelectField
            label="Caja"
            value={selected?._id ?? ''}
            onChange={(e) => {
              setRegisterId(e.target.value);
              setClosing(false);
              setNotice(null);
            }}
            options={list.map((r) => ({ value: r._id, label: `${r.code} — ${r.name}${r.openShift ? '' : ' (sin turno)'}` }))}
          />
        </div>
      ) : null}

      {selected && !shift ? <OpenShift register={selected} onOpened={() => { setNotice(null); registers.reload(); }} /> : null}

      {selected && shift ? (
        <>
          <p className="mb-4 text-sm text-tinta">
            Caja {selected.code}, turno abierto desde {formatDay(shift.openedAt)}: {shift.salesCount} {shift.salesCount === 1 ? 'venta' : 'ventas'} por {formatAmount(shift.salesTotal, currency)} {currency}. Efectivo que debe haber:{' '}
            {formatAmount(shift.openingCash + shift.cashTotal, currency)}.
          </p>
          {closing ? (
            <CloseShift
              shift={shift}
              onCancel={() => setClosing(false)}
              onClosed={(closed) => {
                setClosing(false);
                setNotice({
                  kind: closed.difference === 0 ? 'success' : 'info',
                  text: `Turno cerrado. Esperado ${formatAmount(closed.expectedCash, currency)}, contado ${formatAmount(closed.countedCash, currency)}: ${differenceLabel(closed.difference).toLowerCase()}${closed.difference === 0 ? '' : ` de ${formatAmount(Math.abs(closed.difference), currency)}`}.`,
                });
                registers.reload();
              }}
            />
          ) : null}
          <SaleForm
            key={shift._id}
            register={selected}
            rates={rates}
            onSold={(sale) => {
              const change = sale.change ? ` Cambio: ${formatAmount(sale.change, currency)}.` : '';
              setNotice({ kind: 'success', text: `Venta ${sale.fullNumber} registrada por ${formatAmount(sale.totals.total, currency)} ${currency}.${change}` });
              registers.reload();
            }}
          />
        </>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------------------------- turnos y ventas

function ShiftSales({ shift, currency, canVoid, onChanged }) {
  const base = useTenantApi();
  const list = useLoad(() => api.get(`${base}/pos/sales?shiftId=${shift._id}&limit=50`), [base, shift._id]);
  const [confirming, setConfirming] = useState(null);
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState(null);
  const voidSale = useSubmit(async (sale) => {
    if (!reason.trim()) throw Object.assign(new Error('Escribe el motivo de la anulación.'), { status: 0 });
    await api.post(`${base}/pos/sales/${sale._id}/void`, { reason: reason.trim(), date: today() });
    setNotice(`Venta ${sale.fullNumber} anulada.`);
    setConfirming(null);
    setReason('');
    list.reload();
    onChanged();
  });
  const columns = [
    { key: 'number', title: 'Número', nowrap: true, render: (s) => s.fullNumber },
    { key: 'customer', title: 'Cliente', render: (s) => s.customer?.name ?? 'Consumidor final' },
    { key: 'payments', title: 'Pagos', render: (s) => s.payments.map((p) => `${PAYMENT_LABELS[p.method]} ${formatAmount(p.amount, currency)}`).join(' · ') },
    { key: 'total', title: `Total (${currency})`, align: 'right', render: (s) => formatAmount(s.totals.total, currency) },
    { key: 'status', title: 'Estado', render: (s) => (s.status === 'void' ? 'Anulada' : 'Vigente') },
    {
      key: 'actions',
      title: 'Acciones',
      render: (s) => {
        if (!canVoid || s.status !== 'posted' || shift.status !== 'open') return null;
        if (confirming === s._id) {
          return (
            <span className="flex flex-wrap items-center gap-3">
              <input aria-label={`Motivo de la anulación de ${s.fullNumber}`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder="Motivo" className="rounded-sm border border-borde-fuerte bg-papel px-2 py-1 text-sm text-tinta focus:outline-2 focus:outline-azul" />
              <TextButton danger onClick={() => voidSale.run(s)}>Sí, anular</TextButton>
              <TextButton onClick={() => { setConfirming(null); voidSale.clearError(); }}>Cancelar</TextButton>
            </span>
          );
        }
        return <TextButton onClick={() => { setConfirming(s._id); setReason(''); voidSale.clearError(); }}>Anular</TextButton>;
      },
    },
  ];
  return (
    <div className="my-2 text-sm text-tinta">
      {notice ? <Notice kind="success">{notice}</Notice> : null}
      {voidSale.error ? <Notice kind="error">{errorMessage(voidSale.error)}</Notice> : null}
      {list.error ? <Notice kind="error">{errorMessage(list.error)}</Notice> : null}
      {list.data ? <DataTable caption={`Ventas del turno de ${shift.registerCode}`} columns={columns} rows={list.data.items} rowKey={(s) => s._id} empty="Este turno no tiene ventas." /> : <p>Cargando ventas…</p>}
      {list.data?.nextCursor ? <p className="mt-2">Se muestran las últimas 50 ventas del turno.</p> : null}
    </div>
  );
}

export function PosShiftsScreen() {
  const base = useTenantApi();
  const { tenant, can } = useSession();
  const currency = tenant.currency;
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState(null);
  const [extra, setExtra] = useState([]);
  const [cursor, setCursor] = useState(undefined);
  const query = status ? `status=${status}` : '';
  const list = useLoad(() => api.get(`${base}/pos/shifts?${query}`), [base, query]);
  const items = [...(list.data?.items ?? []), ...extra];
  const next = cursor === undefined ? list.data?.nextCursor : cursor;
  const more = useSubmit(async () => {
    const page = await api.get(`${base}/pos/shifts?${query}${query ? '&' : ''}cursor=${next}`);
    setExtra((e) => [...e, ...page.items]);
    setCursor(page.nextCursor);
  });
  const reset = () => {
    setExtra([]);
    setCursor(undefined);
    list.reload();
  };

  const columns = [
    { key: 'register', title: 'Caja', nowrap: true, render: (s) => s.registerCode },
    { key: 'opened', title: 'Abierto', nowrap: true, render: (s) => formatDay(s.openedAt) },
    { key: 'status', title: 'Estado', render: (s) => (s.status === 'open' ? 'Abierto' : 'Cerrado') },
    { key: 'sales', title: 'Ventas', align: 'right', render: (s) => `${s.salesCount}${s.voidedCount ? ` (${s.voidedCount} anuladas)` : ''}` },
    { key: 'total', title: `Total (${currency})`, align: 'right', render: (s) => formatAmount(s.salesTotal, currency) },
    { key: 'cash', title: 'Efectivo', align: 'right', render: (s) => formatAmount(s.cashTotal, currency) },
    { key: 'card', title: 'Tarjeta', align: 'right', render: (s) => formatAmount(s.cardTotal, currency) },
    { key: 'transfer', title: 'Transferencia', align: 'right', render: (s) => formatAmount(s.transferTotal, currency) },
    { key: 'expected', title: 'Esperado', align: 'right', render: (s) => formatAmount(s.expectedCash, currency) },
    { key: 'counted', title: 'Contado', align: 'right', render: (s) => (s.status === 'closed' ? formatAmount(s.countedCash, currency) : '—') },
    { key: 'difference', title: 'Diferencia', align: 'right', render: (s) => (s.status === 'closed' ? (s.difference === 0 ? 'Cuadra' : `${differenceLabel(s.difference)} ${formatAmount(Math.abs(s.difference), currency)}`) : '—') },
    { key: 'actions', title: 'Acciones', render: (s) => <TextButton onClick={() => setOpen(open === s._id ? null : s._id)}>{open === s._id ? 'Ocultar ventas' : 'Ver ventas'}</TextButton> },
  ];

  return (
    <>
      <PageHeader title="Turnos y ventas" />
      <p className="mb-4 text-sm text-tinta">Cada turno de caja con lo vendido, cómo se cobró y cómo cerró. Un turno abierto permite anular sus ventas; uno cerrado ya no.</p>
      <div className="mb-4 grid gap-x-4 sm:grid-cols-3">
        <SelectField label="Estado" value={status} onChange={(e) => { setStatus(e.target.value); setExtra([]); setCursor(undefined); }} options={[{ value: '', label: 'Todos' }, { value: 'open', label: 'Abiertos' }, { value: 'closed', label: 'Cerrados' }]} />
      </div>
      {list.error ? <Notice kind="error">{errorMessage(list.error)}</Notice> : null}
      {list.loading && !list.data ? <p className="text-sm text-tinta">Cargando turnos…</p> : null}
      {list.data ? (
        <DataTable
          caption="Turnos de caja"
          columns={columns}
          rows={items}
          rowKey={(s) => s._id}
          empty="Todavía no hay turnos."
          expandedRow={(s) => (open === s._id ? <ShiftSales shift={s} currency={currency} canVoid={can('pos:void')} onChanged={reset} /> : null)}
        />
      ) : null}
      {more.error ? <Notice kind="error">{errorMessage(more.error)}</Notice> : null}
      {next ? (
        <div className="mt-4">
          <Button busy={more.busy} onClick={() => more.run()}>Cargar más turnos</Button>
        </div>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------------------------- cajas

const ACCOUNT_FIELDS = [
  ['cash', 'Cuenta de efectivo', 'Obligatoria. Un activo: caja general o caja menor.'],
  ['card', 'Cuenta de tarjeta (opcional)', 'Sin ella, la caja no recibe tarjeta.'],
  ['transfer', 'Cuenta de transferencia (opcional)', 'Sin ella, la caja no recibe transferencias.'],
  ['shortage', 'Cuenta de faltantes (opcional)', 'Un gasto: donde se asienta lo que falta al cerrar.'],
  ['surplus', 'Cuenta de sobrantes (opcional)', 'Un ingreso: donde se asienta lo que sobra al cerrar.'],
];

function RegisterForm({ register, onDone, onCancel }) {
  const base = useTenantApi();
  const editing = Boolean(register);
  const accounts = useLoad(() => api.get(`${base}/accounts?activeOnly=true`), [base]);
  const warehouses = useLoad(() => api.get(`${base}/warehouses`).catch(() => ({ items: [] })), [base]);
  const postable = (accounts.data?.items ?? []).filter((a) => a.postable);
  const [code, setCode] = useState(register?.code ?? '');
  const [name, setName] = useState(register?.name ?? '');
  const [warehouseId, setWarehouseId] = useState(register?.warehouseId ?? '');
  const centers = useCostCenters(base);
  const [costCenter, setCostCenter] = useState(register?.costCenter ?? '');
  const [fields, setFields] = useState(() => Object.fromEntries(ACCOUNT_FIELDS.map(([key]) => [key, register?.accounts?.[key] ?? ''])));
  const [error, setError] = useState(null);

  const save = useSubmit(async () => {
    setError(null);
    if (!editing && !code.trim()) return setError('Escribe el código de la caja.');
    if (!name.trim()) return setError('Escribe el nombre de la caja.');
    if (!fields.cash.trim()) return setError('La caja necesita su cuenta de efectivo.');
    const accountsBody = Object.fromEntries(Object.entries(fields).filter(([, v]) => v.trim()).map(([k, v]) => [k, v.trim()]));
    const saved = editing
      ? await api.patch(`${base}/pos/registers/${register._id}`, { name: name.trim(), accounts: accountsBody, costCenter, ...(warehouseId ? { warehouseId } : {}) })
      : await api.post(`${base}/pos/registers`, { code: code.trim(), name: name.trim(), accounts: accountsBody, ...(costCenter ? { costCenter } : {}), ...(warehouseId ? { warehouseId } : {}) });
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
      <h2 className="mb-3 text-lg font-semibold text-tinta">{editing ? `Editar la caja ${register.code}` : 'Nueva caja'}</h2>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {save.error ? <Notice kind="error">{errorMessage(save.error)}</Notice> : null}
      <datalist id="cuentas-caja">
        {postable.map((a) => (
          <option key={a.code} value={a.code}>
            {a.name}
          </option>
        ))}
      </datalist>
      <div className="grid gap-x-4 sm:grid-cols-3">
        <TextField label="Código" value={code} onChange={(e) => setCode(e.target.value)} maxLength={10} disabled={editing} hint={editing ? 'El código no se cambia.' : 'Prefijo de sus números: CAJA1-000001.'} />
        <TextField className="sm:col-span-2" label="Nombre" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
      </div>
      <div className="grid gap-x-4 sm:grid-cols-3">
        {ACCOUNT_FIELDS.map(([key, label, hint]) => (
          <TextField key={key} label={label} list="cuentas-caja" value={fields[key]} onChange={(e) => setFields((f) => ({ ...f, [key]: e.target.value }))} hint={hint} />
        ))}
        <SelectField
          label="Bodega de donde salen los artículos"
          value={warehouseId}
          onChange={(e) => setWarehouseId(e.target.value)}
          options={[{ value: '', label: 'Principal' }, ...(warehouses.data?.items ?? []).filter((w) => w.active && !w.isDefault).map((w) => ({ value: w._id, label: `${w.code} — ${w.name}` }))]}
        />
      </div>
      {centers.length || costCenter ? (
        <SelectField
          label="Centro de costo de la caja"
          value={costCenter}
          onChange={(e) => setCostCenter(e.target.value)}
          options={[{ value: '', label: 'Sin centro de costo' }, ...centers.map((c) => ({ value: c.code, label: `${c.code} · ${c.name}` }))]}
          hint="Sus ventas y su costo se asignan a este centro."
        />
      ) : null}
      <Button type="submit" variant="primary" busy={save.busy}>
        {editing ? 'Guardar cambios' : 'Crear caja'}
      </Button>
      <Button className="ml-2" onClick={onCancel}>
        Cancelar
      </Button>
    </form>
  );
}

export function PosRegistersScreen() {
  const base = useTenantApi();
  const list = useLoad(() => api.get(`${base}/pos/registers`), [base]);
  const [editing, setEditing] = useState(null); // null | 'new' | caja
  const [notice, setNotice] = useState(null);
  const toggle = useSubmit(async (register) => {
    await api.patch(`${base}/pos/registers/${register._id}`, { active: !register.active });
    setNotice(`Caja ${register.code} ${register.active ? 'desactivada' : 'activada'}.`);
    list.reload();
  });

  const columns = [
    { key: 'code', title: 'Código', nowrap: true, render: (r) => r.code },
    { key: 'name', title: 'Nombre', render: (r) => r.name },
    { key: 'accounts', title: 'Cuentas', render: (r) => Object.entries(r.accounts).map(([k, v]) => `${{ cash: 'efectivo', card: 'tarjeta', transfer: 'transferencia', shortage: 'faltantes', surplus: 'sobrantes' }[k]} ${v}`).join(' · ') },
    { key: 'status', title: 'Estado', render: (r) => `${r.active ? 'Activa' : 'Inactiva'}${r.openShift ? ' · turno abierto' : ''}` },
    {
      key: 'actions',
      title: 'Acciones',
      render: (r) => (
        <span className="flex flex-wrap gap-3">
          <TextButton onClick={() => { setEditing(r); setNotice(null); }}>Editar</TextButton>
          <TextButton danger={r.active} onClick={() => toggle.run(r)}>{r.active ? 'Desactivar' : 'Activar'}</TextButton>
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader title="Cajas">{!editing ? <Button variant="primary" onClick={() => { setEditing('new'); setNotice(null); }}>Nueva caja</Button> : null}</PageHeader>
      <p className="mb-4 text-sm text-tinta">Cada caja cobra en sus propias cuentas y lleva su numeración. Una caja con un turno abierto no cambia sus cuentas ni se desactiva.</p>
      {notice ? <Notice kind="success">{notice}</Notice> : null}
      {toggle.error ? <Notice kind="error">{errorMessage(toggle.error)}</Notice> : null}
      {editing ? (
        <RegisterForm
          register={editing === 'new' ? null : editing}
          onCancel={() => setEditing(null)}
          onDone={(saved, wasEditing) => {
            setEditing(null);
            setNotice(wasEditing ? `Caja ${saved.code} actualizada.` : `Caja ${saved.code} creada.`);
            list.reload();
          }}
        />
      ) : null}
      {list.error ? <Notice kind="error">{errorMessage(list.error)}</Notice> : null}
      {list.loading && !list.data ? <p className="text-sm text-tinta">Cargando cajas…</p> : null}
      {list.data ? <DataTable caption="Cajas" columns={columns} rows={list.data.items} rowKey={(r) => r._id} empty="Todavía no hay cajas." /> : null}
    </>
  );
}
