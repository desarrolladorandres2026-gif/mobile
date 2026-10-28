import { useState } from 'react';
import { ItemPicker } from '../components/ItemPicker.jsx';
import { PartyPicker } from '../components/PartyPicker.jsx';
import { CostCenterSelect, useCostCenters } from '../components/CostCenterSelect.jsx';
import { LoadNotice, DeleteButton, Button, DataTable, Notice, PageHeader, SelectField, TextButton, TextField, errorMessage, useLoad, useSubmit } from '../components/ui.jsx';
import { api, newIdempotencyKey } from '../lib/api.js';
import { formatDay } from '../lib/format.js';
import { computeLine, formatPercent, formatQuantity, parsePercent, parseQuantity } from '../lib/invoicing.js';
import { formatAmount, parseAmount } from '../lib/money.js';
import { validatePurchase, WITHHOLDING_BASES } from '../lib/purchases.js';
import { Link } from '../lib/router.jsx';
import { useSession, useTenantApi } from '../lib/session.jsx';

const today = () => new Date().toISOString().slice(0, 10);
const STATUS = { posted: 'Vigente', void: 'Anulada' };
const CREDIT = { partial: 'acreditada en parte', full: 'acreditada del todo' };

const blankLine = (vatBps) => ({ description: '', quantity: '1', unitPrice: '', discount: '', vatBps, accountId: '', itemText: '', item: null, costCenter: '' });
const blankWithholding = () => ({ name: '', accountId: '', basis: 'subtotal', rate: '' });

function usePurchasingStatus() {
  const base = useTenantApi();
  return useLoad(() => api.get(`${base}/purchasing/status`), [base]);
}

function SetupNotice({ status }) {
  if (!status || status.ready) return null;
  return (
    <Notice kind="info" title="Falta configurar las compras">
      Hace falta: {status.missing.join(' y ')}. Se configuran en <Link href="/app/facturacion">Facturación</Link>, en «Cuentas contables».
    </Notice>
  );
}

const cell = 'w-full rounded-sm border bg-papel px-2 py-1.5 text-sm text-tinta focus:outline-2 focus:outline-azul';

function PurchaseForm({ status, onCreated, onCancel }) {
  const base = useTenantApi();
  const { tenant } = useSession();
  const currency = tenant.currency;
  const rates = status.vatRatesBps;
  const defaultRate = rates.includes(1900) ? 1900 : rates[rates.length - 1];
  const [supplierId, setSupplierId] = useState('');
  const [supplierDocNumber, setSupplierDocNumber] = useState('');
  const [issueDate, setIssueDate] = useState(today());
  const [dueDate, setDueDate] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState([blankLine(defaultRate)]);
  const [withholdings, setWithholdings] = useState([]);
  const [warehouseId, setWarehouseId] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const [key, setKey] = useState(newIdempotencyKey);
  const accounts = useLoad(() => api.get(`${base}/accounts?activeOnly=true`), [base]);
  const centers = useCostCenters(base);
  // Quien no puede leer la configuración (otro rol) simplemente no ve la lista de predefinidas.
  const presets = useLoad(() => api.get(`${base}/invoicing/settings`).then((r) => r.settings?.withholdingPresets ?? []), [base]);
  const warehouses = useLoad(() => api.get(`${base}/warehouses`), [base]);
  const activeWarehouses = (warehouses.data?.items ?? []).filter((w) => w.active);
  const postable = (accounts.data?.items ?? []).filter((a) => a.postable);
  const expenseAccounts = postable.filter((a) => ['asset', 'expense', 'cost'].includes(a.type));
  const liabilityAccounts = postable.filter((a) => a.type === 'liability');

  const result = validatePurchase({ supplierId, supplierDocNumber, issueDate, dueDate, lines, withholdings, currency, warehouseId });
  const setLine = (i, field) => (e) => setLines((ls) => ls.map((l, n) => (n === i ? { ...l, [field]: field === 'vatBps' ? Number(e.target.value) : e.target.value } : l)));
  const pickItem = (i) => (itemText, item) =>
    setLines((ls) =>
      ls.map((l, n) => {
        if (n !== i) return l;
        const chosen = item && (!l.item || l.item._id !== item._id);
        return { ...l, itemText, item, ...(chosen && !l.description.trim() ? { description: item.name } : {}) };
      }),
    );
  const setWithholding = (i, field) => (e) => setWithholdings((ws) => ws.map((w, n) => (n === i ? { ...w, [field]: e.target.value } : w)));

  const submit = useSubmit(async () => {
    setShowErrors(true);
    if (!result.ok) return;
    const body = {
      supplierId,
      supplierDocNumber: supplierDocNumber.trim(),
      issueDate,
      ...(dueDate ? { dueDate } : {}),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
      lines: result.prepared,
      ...(result.withholdings.length ? { withholdings: result.withholdings.map(({ name, accountId, basis, rateBps }) => ({ name, accountId, basis, rateBps })) } : {}),
    };
    const outcome = await api.post(`${base}/purchases`, body, { 'idempotency-key': key });
    setKey(newIdempotencyKey());
    onCreated(outcome.purchase);
  });

  return (
    <form
      className="mb-8 border-b border-borde pb-6"
      onSubmit={(e) => {
        e.preventDefault();
        submit.run();
      }}
    >
      <h2 className="mb-3 text-lg font-semibold text-tinta">Registrar compra</h2>
      {submit.error ? <Notice kind="error">{errorMessage(submit.error)}</Notice> : null}
      <PartyPicker base={base} role="supplier" value={supplierId} onChange={setSupplierId} error={showErrors && !supplierId ? 'Elige el proveedor.' : undefined} />
      <div className="grid gap-x-4 sm:grid-cols-3">
        <TextField label="Número de la factura del proveedor" value={supplierDocNumber} onChange={(e) => setSupplierDocNumber(e.target.value)} maxLength={40} error={showErrors && !supplierDocNumber.trim() ? 'Escribe el número.' : undefined} />
        <TextField label="Fecha de la factura" type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} required />
        <TextField label="Vencimiento (opcional)" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} hint="Sin fecha, vence el mismo día." />
      </div>
      {activeWarehouses.length > 1 ? (
        <div className="grid gap-x-4 sm:grid-cols-3">
          <SelectField
            label="Bodega de destino de los artículos"
            value={warehouseId}
            onChange={(e) => setWarehouseId(e.target.value)}
            options={[{ value: '', label: 'Principal' }, ...activeWarehouses.filter((w) => !w.isDefault).map((w) => ({ value: w._id, label: `${w.code} — ${w.name}` }))]}
          />
        </div>
      ) : null}

      <datalist id="cuentas-compra">
        {expenseAccounts.map((a) => (
          <option key={a.code} value={a.code}>{a.name}</option>
        ))}
      </datalist>
      <datalist id="cuentas-retencion">
        {liabilityAccounts.map((a) => (
          <option key={a.code} value={a.code}>{a.name}</option>
        ))}
      </datalist>

      <LoadNotice load={centers} what="los centros de costo" />
      <LoadNotice load={warehouses} what="las bodegas" />
      <LoadNotice load={presets} what="las retenciones predefinidas" />
      <div className="relative overflow-x-auto">
        <table className="mb-2 w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-borde-fuerte text-left">
              <th scope="col" className="px-2 py-2 font-semibold">Artículo (opcional)</th>
              <th scope="col" className="px-2 py-2 font-semibold">Descripción</th>
              <th scope="col" className="px-2 py-2 text-right font-semibold">Cantidad</th>
              <th scope="col" className="px-2 py-2 text-right font-semibold">Precio ({currency})</th>
              <th scope="col" className="px-2 py-2 text-right font-semibold">Descuento %</th>
              <th scope="col" className="px-2 py-2 font-semibold">IVA</th>
              <th scope="col" className="px-2 py-2 font-semibold">Cuenta</th>
              {centers.length ? <th scope="col" className="px-2 py-2 font-semibold">Centro de costo</th> : null}
              <th scope="col" className="px-2 py-2 text-right font-semibold">Total</th>
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
              const field = (name, label, className = '', props = {}) => (
                <input aria-label={`${label} de la línea ${i + 1}`} value={line[name]} onChange={setLine(i, name)} className={`${cell} ${e[name] ? 'border-rojo' : 'border-borde-fuerte'} ${className}`} {...props} />
              );
              return (
                <tr key={i} className="border-b border-borde align-top">
                  <td className="px-2 py-2">
                    <ItemPicker base={base} label={`Artículo de la línea ${i + 1}`} className="w-40" text={line.itemText} item={line.item} onChange={pickItem(i)} error={e.item} showStock={false} />
                  </td>
                  <td className="px-2 py-2">
                    {field('description', 'Descripción', 'min-w-48', { maxLength: 200 })}
                    {e.description ? <p role="alert" className="text-xs font-semibold text-rojo">{e.description}</p> : null}
                  </td>
                  <td className="px-2 py-2 text-right">
                    {field('quantity', 'Cantidad', 'w-24 text-right tabular-nums', { inputMode: 'decimal' })}
                    {e.quantity ? <p role="alert" className="text-left text-xs font-semibold text-rojo">{e.quantity}</p> : null}
                  </td>
                  <td className="px-2 py-2 text-right">
                    {field('unitPrice', 'Precio unitario', 'w-36 text-right tabular-nums', { inputMode: 'decimal' })}
                    {e.unitPrice ? <p role="alert" className="text-left text-xs font-semibold text-rojo">{e.unitPrice}</p> : null}
                  </td>
                  <td className="px-2 py-2 text-right">
                    {field('discount', 'Descuento', 'w-20 text-right tabular-nums', { inputMode: 'decimal' })}
                    {e.discount ? <p role="alert" className="text-left text-xs font-semibold text-rojo">{e.discount}</p> : null}
                  </td>
                  <td className="px-2 py-2">
                    <select aria-label={`IVA de la línea ${i + 1}`} value={line.vatBps} onChange={setLine(i, 'vatBps')} className="rounded-sm border border-borde-fuerte bg-papel px-2 py-1.5 text-sm text-tinta focus:outline-2 focus:outline-azul">
                      {rates.map((r) => (
                        <option key={r} value={r}>{formatPercent(r)}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-2 py-2">
                    {line.item ? (
                      <p className="text-sm text-tinta">{line.item.inventoryAccount} (inventario)</p>
                    ) : (
                      <>
                        {field('accountId', 'Cuenta', 'w-28', { list: 'cuentas-compra' })}
                        {expenseAccounts.find((a) => a.code === line.accountId.trim()) ? <p className="max-w-28 text-xs text-tinta">{expenseAccounts.find((a) => a.code === line.accountId.trim()).name}</p> : null}
                        {e.accountId ? <p role="alert" className="text-xs font-semibold text-rojo">{e.accountId}</p> : null}
                      </>
                    )}
                  </td>
                  {centers.length ? (
                    <td className="px-2 py-2">
                      <CostCenterSelect centers={centers} label={`Centro de costo de la línea ${i + 1}`} value={line.costCenter} onChange={setLine(i, 'costCenter')} />
                    </td>
                  ) : null}
                  <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-tinta">{preview ? formatAmount(preview.total, currency) : ''}</td>
                  <td className="px-2 py-2">{lines.length > 1 ? <DeleteButton onClick={() => setLines((ls) => ls.filter((_, n) => n !== i))}>Quitar</DeleteButton> : null}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <TextButton onClick={() => setLines((ls) => [...ls, blankLine(defaultRate)])}>Agregar línea</TextButton>

      <h3 className="mb-1 mt-6 font-semibold text-tinta">Retenciones (opcional)</h3>
      <p className="mb-2 text-sm text-tinta">Lo que se le retiene al proveedor y se debe pagar a la autoridad tributaria. Reducen lo que se le paga a él.</p>
      {withholdings.length ? (
        <div className="relative overflow-x-auto">
          <table className="mb-2 w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-borde-fuerte text-left">
                <th scope="col" className="px-2 py-2 font-semibold">Nombre</th>
                <th scope="col" className="px-2 py-2 font-semibold">Cuenta por pagar</th>
                <th scope="col" className="px-2 py-2 font-semibold">Sobre</th>
                <th scope="col" className="px-2 py-2 text-right font-semibold">Tarifa %</th>
                <th scope="col" className="px-2 py-2 text-right font-semibold">Retención</th>
                <th scope="col" className="px-2 py-2"><span className="sr-only">Acciones</span></th>
              </tr>
            </thead>
            <tbody>
              {withholdings.map((w, i) => {
                const e = (showErrors && result.errors.withholdings[i]) || {};
                const prepared = result.withholdings.find((p) => p.name === w.name.trim() && p.accountId === w.accountId.trim() && p.basis === w.basis && parsePercent(w.rate) === p.rateBps);
                return (
                  <tr key={i} className="border-b border-borde align-top">
                    <td className="px-2 py-2">
                      <input aria-label={`Nombre de la retención ${i + 1}`} value={w.name} onChange={setWithholding(i, 'name')} maxLength={60} className={`${cell} min-w-40 ${e.name ? 'border-rojo' : 'border-borde-fuerte'}`} />
                      {e.name ? <p role="alert" className="text-xs font-semibold text-rojo">{e.name}</p> : null}
                    </td>
                    <td className="px-2 py-2">
                      <input aria-label={`Cuenta de la retención ${i + 1}`} list="cuentas-retencion" value={w.accountId} onChange={setWithholding(i, 'accountId')} className={`${cell} w-28 ${e.accountId ? 'border-rojo' : 'border-borde-fuerte'}`} />
                      {liabilityAccounts.find((a) => a.code === w.accountId.trim()) ? <p className="max-w-28 text-xs text-tinta">{liabilityAccounts.find((a) => a.code === w.accountId.trim()).name}</p> : null}
                      {e.accountId ? <p role="alert" className="text-xs font-semibold text-rojo">{e.accountId}</p> : null}
                    </td>
                    <td className="px-2 py-2">
                      <select aria-label={`Base de la retención ${i + 1}`} value={w.basis} onChange={setWithholding(i, 'basis')} className="rounded-sm border border-borde-fuerte bg-papel px-2 py-1.5 text-sm text-tinta focus:outline-2 focus:outline-azul">
                        {WITHHOLDING_BASES.map((b) => (
                          <option key={b.value} value={b.value}>{b.label}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-2 py-2 text-right">
                      <input aria-label={`Tarifa de la retención ${i + 1}`} inputMode="decimal" value={w.rate} onChange={setWithholding(i, 'rate')} className={`${cell} w-20 text-right tabular-nums ${e.rate ? 'border-rojo' : 'border-borde-fuerte'}`} />
                      {e.rate ? <p role="alert" className="text-left text-xs font-semibold text-rojo">{e.rate}</p> : null}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-tinta">{prepared ? formatAmount(prepared.amount, currency) : ''}</td>
                    <td className="px-2 py-2"><DeleteButton onClick={() => setWithholdings((ws) => ws.filter((_, n) => n !== i))}>Quitar</DeleteButton></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <TextButton onClick={() => setWithholdings((ws) => [...ws, blankWithholding()])}>Agregar retención</TextButton>
        {presets.data?.length ? (
          <label className="flex items-center gap-2 text-sm text-tinta">
            <span className="font-semibold">Predefinida</span>
            <select
              aria-label="Agregar retención predefinida"
              value=""
              onChange={(e) => {
                const chosen = presets.data[Number(e.target.value)];
                if (chosen) setWithholdings((ws) => [...ws, { name: chosen.name, accountId: chosen.accountId, basis: chosen.basis, rate: formatPercent(chosen.rateBps).replace(/\s*%/, '') }]);
              }}
              className="rounded-sm border border-borde-fuerte bg-papel px-2 py-1.5 text-sm text-tinta focus:outline-2 focus:outline-azul"
            >
              <option value="">Elige una…</option>
              {presets.data.map((p, i) => (
                <option key={p.name} value={i}>{p.name}</option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      <dl className="mb-4 mt-4 ml-auto grid max-w-sm grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm text-tinta">
        <dt>Subtotal</dt>
        <dd className="text-right tabular-nums">{formatAmount(result.totals.subtotal, currency)}</dd>
        {result.totals.taxByRate.map((r) => (
          <div key={r.vatBps} className="contents">
            <dt>IVA {formatPercent(r.vatBps)} sobre {formatAmount(r.base, currency)}</dt>
            <dd className="text-right tabular-nums">{formatAmount(r.tax, currency)}</dd>
          </div>
        ))}
        <dt>Total de la factura</dt>
        <dd className="text-right tabular-nums">{formatAmount(result.totals.total, currency)}</dd>
        {result.withholdings.map((w) => (
          <div key={`${w.name}-${w.accountId}`} className="contents">
            <dt>Menos {w.name}</dt>
            <dd className="text-right tabular-nums">{formatAmount(w.amount, currency)}</dd>
          </div>
        ))}
        <dt className="font-semibold">A pagar al proveedor</dt>
        <dd className="text-right text-base font-semibold tabular-nums">{formatAmount(result.payable, currency)}</dd>
      </dl>

      <TextField label="Notas (opcional)" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
      {showErrors && result.errors.form.length ? (
        <Notice kind="error">
          {result.errors.form.map((m) => (
            <p key={m}>{m}</p>
          ))}
        </Notice>
      ) : null}
      <Button type="submit" variant="primary" busy={submit.busy}>Registrar compra</Button>
      <Button className="ml-2" onClick={onCancel}>Cancelar</Button>
    </form>
  );
}

function SupplierNoteForm({ purchase, currency, onDone, onCancel }) {
  const base = useTenantApi();
  const [reason, setReason] = useState('');
  const [docNumber, setDocNumber] = useState('');
  const [issueDate, setIssueDate] = useState(today());
  const [mode, setMode] = useState('all');
  const [quantities, setQuantities] = useState(() => purchase.lines.map(() => ''));
  const [key, setKey] = useState(newIdempotencyKey);
  const remaining = purchase.lines.map((l, i) => l.quantity - purchase.credited.quantity[i]);

  const submit = useSubmit(async () => {
    if (!reason.trim()) throw Object.assign(new Error('Escribe el motivo de la nota.'), { status: 0 });
    if (!docNumber.trim()) throw Object.assign(new Error('Escribe el número de la nota del proveedor.'), { status: 0 });
    let body = { reason: reason.trim(), supplierDocNumber: docNumber.trim(), issueDate };
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
    const outcome = await api.post(`${base}/purchases/${purchase._id}/credit-notes`, body, { 'idempotency-key': key });
    setKey(newIdempotencyKey());
    onDone(outcome.note);
  });

  return (
    <form
      className="mt-3 max-w-3xl border-t border-borde pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit.run();
      }}
    >
      <h3 className="mb-2 font-semibold text-tinta">Nota de proveedor a la compra {purchase.fullNumber}</h3>
      {submit.error ? <Notice kind="error">{errorMessage(submit.error)}</Notice> : null}
      <div className="grid gap-x-4 sm:grid-cols-3">
        <TextField label="Motivo" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} hint="Devolución, descuento, error en precio…" />
        <TextField label="Número de la nota del proveedor" value={docNumber} onChange={(e) => setDocNumber(e.target.value)} maxLength={40} />
        <TextField label="Fecha de la nota" type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} required />
      </div>
      <SelectField
        label="Qué se acredita"
        value={mode}
        onChange={(e) => setMode(e.target.value)}
        options={[{ value: 'all', label: 'Todo lo que queda de la factura' }, { value: 'lines', label: 'Solo algunas cantidades' }]}
      />
      {mode === 'lines' ? (
        <div className="relative overflow-x-auto">
          <table className="mb-3 text-sm">
            <thead>
              <tr className="text-left">
                <th scope="col" className="pr-4 font-semibold">Línea</th>
                <th scope="col" className="pr-4 text-right font-semibold">Por acreditar</th>
                <th scope="col" className="font-semibold">Cantidad a acreditar</th>
              </tr>
            </thead>
            <tbody>
              {purchase.lines.map((l, i) => (
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
        </div>
      ) : null}
      <p className="mb-3 text-sm text-tinta">Saldo actual con el proveedor por esta factura: {formatAmount(purchase.balance, currency)}.</p>
      <Button type="submit" variant="primary" busy={submit.busy}>Registrar nota</Button>
      <Button className="ml-2" onClick={onCancel}>Cancelar</Button>
    </form>
  );
}

function DebitNoteForm({ purchase, rates, currency, onDone, onCancel }) {
  const base = useTenantApi();
  const centers = useCostCenters(base);
  const accounts = useLoad(() => api.get(`${base}/accounts?activeOnly=true`), [base]);
  const chargeAccounts = (accounts.data?.items ?? []).filter((a) => a.postable && ['asset', 'expense', 'cost'].includes(a.type));
  const defaultRate = rates.includes(0) ? 0 : rates[0];
  const [docNumber, setDocNumber] = useState('');
  const [issueDate, setIssueDate] = useState(today());
  const [dueDate, setDueDate] = useState('');
  const [line, setLine] = useState({ description: '', quantity: '1', unitPrice: '', discount: '', vatBps: defaultRate, accountId: '', itemText: '', item: null, costCenter: '' });
  const [showErrors, setShowErrors] = useState(false);
  const [key, setKey] = useState(newIdempotencyKey);
  const set = (field) => (e) => setLine((l) => ({ ...l, [field]: field === 'vatBps' ? Number(e.target.value) : e.target.value }));
  const result = validatePurchase({ supplierId: String(purchase.supplier.partyId), supplierDocNumber: docNumber, issueDate, dueDate, lines: [line], withholdings: [], currency });
  const lineErrors = (showErrors && result.errors.lines[0]) || {};

  const submit = useSubmit(async () => {
    setShowErrors(true);
    if (!result.ok) return;
    const outcome = await api.post(
      `${base}/purchases`,
      { kind: 'debit_note', relatedPurchaseId: purchase._id, supplierId: String(purchase.supplier.partyId), supplierDocNumber: docNumber.trim(), issueDate, ...(dueDate ? { dueDate } : {}), lines: result.prepared },
      { 'idempotency-key': key },
    );
    setKey(newIdempotencyKey());
    onDone(outcome.purchase);
  });

  return (
    <form
      className="mt-3 max-w-3xl border-t border-borde pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit.run();
      }}
    >
      <h3 className="mb-2 font-semibold text-tinta">Nota débito del proveedor a la compra {purchase.fullNumber}</h3>
      <p className="mb-3 text-sm text-tinta">Un cargo adicional que te hace el proveedor después de la factura: intereses de mora, ajuste de precio, flete. Aumenta lo que le debes y se paga como una factura. No mueve existencias.</p>
      {submit.error ? <Notice kind="error">{errorMessage(submit.error)}</Notice> : null}
      <datalist id="cuentas-nota-debito">
        {chargeAccounts.map((a) => (
          <option key={a.code} value={a.code}>{a.name}</option>
        ))}
      </datalist>
      <div className="grid gap-x-4 sm:grid-cols-3">
        <TextField label="Número de la nota del proveedor" value={docNumber} onChange={(e) => setDocNumber(e.target.value)} maxLength={40} error={showErrors && !docNumber.trim() ? 'Escribe el número.' : undefined} />
        <TextField label="Fecha de la nota" type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} required />
        <TextField label="Vencimiento (opcional)" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
      </div>
      <div className="grid gap-x-4 sm:grid-cols-3">
        <TextField className="sm:col-span-2" label="Concepto" value={line.description} onChange={set('description')} maxLength={200} error={lineErrors.description} hint="Por ejemplo: intereses de mora de octubre." />
        <TextField label={`Valor antes de IVA (${currency})`} value={line.unitPrice} onChange={set('unitPrice')} inputMode="decimal" error={lineErrors.unitPrice} />
        <TextField label="Cuenta del gasto, costo o activo" list="cuentas-nota-debito" value={line.accountId} onChange={set('accountId')} error={showErrors && lineErrors.accountId ? lineErrors.accountId : undefined} hint={chargeAccounts.find((a) => a.code === line.accountId.trim())?.name} />
        <SelectField label="IVA" value={line.vatBps} onChange={set('vatBps')} options={rates.map((r) => ({ value: r, label: formatPercent(r) }))} />
        <LoadNotice load={centers} what="los centros de costo" />
        {centers.length ? (
          <SelectField label="Centro de costo" value={line.costCenter} onChange={set('costCenter')} options={[{ value: '', label: 'Sin centro' }, ...centers.map((c) => ({ value: c.code, label: `${c.code} · ${c.name}` }))]} />
        ) : null}
      </div>
      <p className="mb-3 text-sm text-tinta">Total de la nota: {formatAmount(result.totals.total, currency)}.</p>
      {showErrors && result.errors.form.length ? (
        <Notice kind="error">
          {result.errors.form.map((m) => (
            <p key={m}>{m}</p>
          ))}
        </Notice>
      ) : null}
      <Button type="submit" variant="primary" busy={submit.busy}>Registrar nota débito</Button>
      <Button className="ml-2" onClick={onCancel}>Cancelar</Button>
    </form>
  );
}

function PurchaseDetail({ purchase, currency }) {
  return (
    <div className="my-2 text-sm text-tinta">
      <div className="relative overflow-x-auto">
        <table className="mb-3 w-full max-w-4xl border-collapse">
          <thead>
            <tr className="text-left">
              <th scope="col" className="pr-4 font-semibold">Descripción</th>
              <th scope="col" className="pr-4 text-right font-semibold">Cantidad</th>
              <th scope="col" className="pr-4 text-right font-semibold">Precio</th>
              <th scope="col" className="pr-4 text-right font-semibold">IVA</th>
              <th scope="col" className="pr-4 font-semibold">Cuenta</th>
              <th scope="col" className="text-right font-semibold">Total</th>
            </tr>
          </thead>
          <tbody>
            {purchase.lines.map((l, i) => (
              <tr key={i}>
                <td className="pr-4">{l.description}</td>
                <td className="pr-4 text-right tabular-nums">{formatQuantity(l.quantity)}</td>
                <td className="pr-4 text-right tabular-nums">{formatAmount(l.unitPrice, currency)}</td>
                <td className="pr-4 text-right tabular-nums">{formatPercent(l.vatBps)}</td>
                <td className="pr-4">{l.accountId}</td>
                <td className="text-right tabular-nums">{formatAmount(l.total, currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>Subtotal {formatAmount(purchase.totals.subtotal, currency)} · IVA {formatAmount(purchase.totals.tax, currency)} · Total {formatAmount(purchase.totals.total, currency)}</p>
      {purchase.withholdings.map((w) => (
        <p key={`${w.name}-${w.accountId}`}>{w.name}: {formatAmount(w.amount, currency)} ({formatPercent(w.rateBps)} del {w.basis === 'vat' ? 'IVA' : 'subtotal'}, cuenta {w.accountId})</p>
      ))}
      <p className="font-semibold">A pagar al proveedor {formatAmount(purchase.payable, currency)} · Pagado {formatAmount(purchase.paidTotal, currency)} · Falta {formatAmount(purchase.balance, currency)}</p>
      {purchase.relatedNumber ? <p>Nota débito sobre la compra {purchase.relatedNumber}.</p> : null}
      {purchase.notes ? <p>Notas: {purchase.notes}</p> : null}
    </div>
  );
}

export function PurchasesScreen() {
  const base = useTenantApi();
  const { tenant, can } = useSession();
  const currency = tenant.currency;
  const status = usePurchasingStatus();
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState(null);
  const [crediting, setCrediting] = useState(null);
  const [debiting, setDebiting] = useState(null);
  const [confirming, setConfirming] = useState(null);
  const [notice, setNotice] = useState(null);
  const [filter, setFilter] = useState('');
  const [extra, setExtra] = useState([]);
  const [cursor, setCursor] = useState(undefined);

  const query = filter ? `status=${filter}` : '';
  const list = useLoad(() => api.get(`${base}/purchases?${query}`), [base, query]);
  const items = [...(list.data?.items ?? []), ...extra];
  const next = cursor === undefined ? list.data?.nextCursor : cursor;
  const reset = () => {
    setExtra([]);
    setCursor(undefined);
    list.reload();
  };
  const more = useSubmit(async () => {
    const page = await api.get(`${base}/purchases?${query}${query ? '&' : ''}cursor=${next}`);
    setExtra((e) => [...e, ...page.items]);
    setCursor(page.nextCursor);
  });
  const act = useSubmit(async (purchase) => {
    await api.post(`${base}/purchases/${purchase._id}/void`);
    setNotice(`Compra ${purchase.fullNumber} anulada.`);
    setConfirming(null);
    reset();
  });

  const columns = [
    { key: 'number', title: 'Número', nowrap: true, render: (p) => p.fullNumber },
    { key: 'date', title: 'Fecha', nowrap: true, render: (p) => formatDay(p.issueDate) },
    { key: 'supplier', title: 'Proveedor', render: (p) => p.supplier.name },
    { key: 'doc', title: 'Factura del proveedor', nowrap: true, render: (p) => p.supplierDocNumber },
    { key: 'payable', title: `A pagar (${currency})`, align: 'right', render: (p) => formatAmount(p.payable, currency) },
    { key: 'balance', title: 'Falta pagar', align: 'right', render: (p) => (p.status === 'posted' ? formatAmount(p.balance, currency) : '—') },
    { key: 'status', title: 'Estado', render: (p) => `${STATUS[p.status]}${CREDIT[p.creditStatus] ? ` · ${CREDIT[p.creditStatus]}` : ''}` },
    {
      key: 'actions',
      title: 'Acciones',
      render: (p) => {
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
            <TextButton onClick={() => setOpen(open === p._id ? null : p._id)}>{open === p._id ? 'Ocultar detalle' : 'Ver detalle'}</TextButton>
            {can('purchases:create') && p.status === 'posted' && p.kind !== 'debit_note' ? (
              <TextButton onClick={() => { setOpen(p._id); setCrediting(null); setDebiting(debiting === p._id ? null : p._id); }}>Nota débito</TextButton>
            ) : null}
            {can('purchases:create') && p.status === 'posted' && p.kind !== 'debit_note' && p.creditStatus !== 'full' ? (
              <TextButton onClick={() => { setOpen(p._id); setDebiting(null); setCrediting(crediting === p._id ? null : p._id); }}>Acreditar</TextButton>
            ) : null}
            {can('purchases:void') && p.status === 'posted' && p.paidTotal === 0 && p.creditedTotal === 0 ? (
              <TextButton onClick={() => { setConfirming(p._id); act.clearError(); }}>Anular</TextButton>
            ) : null}
          </span>
        );
      },
    },
  ];

  return (
    <>
      <PageHeader title="Compras">
        {can('purchases:create') && status.data?.ready && !creating ? <Button variant="primary" onClick={() => { setCreating(true); setNotice(null); }}>Registrar compra</Button> : null}
      </PageHeader>
      <p className="mb-4 text-sm text-tinta">Facturas que te emiten tus proveedores. Cada una genera su asiento y queda por pagar hasta que se registre el pago desde Cuentas por pagar.</p>
      <SetupNotice status={status.data} />
      {notice ? <Notice kind="success">{notice}</Notice> : null}
      {act.error ? <Notice kind="error">{errorMessage(act.error)}</Notice> : null}
      {creating && status.data ? (
        <PurchaseForm
          status={status.data}
          onCancel={() => setCreating(false)}
          onCreated={(purchase) => {
            setCreating(false);
            setNotice(`Compra ${purchase.fullNumber} registrada: ${formatAmount(purchase.payable, purchase.currency)} por pagar a ${purchase.supplier.name}.`);
            reset();
          }}
        />
      ) : null}
      {/* Mientras se elabora un documento la lista se oculta (sin perder filtros ni páginas cargadas). */}
      <div hidden={creating}>
      <div className="mb-4 grid gap-x-4 sm:grid-cols-3">
        <SelectField
          label="Estado"
          value={filter}
          onChange={(e) => { setFilter(e.target.value); setExtra([]); setCursor(undefined); }}
          options={[{ value: '', label: 'Todas' }, { value: 'posted', label: 'Vigentes' }, { value: 'void', label: 'Anuladas' }]}
        />
      </div>
      {list.error ? <Notice kind="error">{errorMessage(list.error)}</Notice> : null}
      {list.loading && !list.data ? <p className="text-sm text-tinta">Cargando compras…</p> : null}
      {list.data ? (
        <DataTable
          caption="Compras"
          columns={columns}
          rows={items}
          rowKey={(p) => p._id}
          empty="No hay compras con este filtro."
          expandedRow={(p) =>
            open === p._id ? (
              <>
                <PurchaseDetail purchase={p} currency={currency} />
                {debiting === p._id && status.data ? (
                  <DebitNoteForm
                    purchase={p}
                    rates={status.data.vatRatesBps}
                    currency={currency}
                    onCancel={() => setDebiting(null)}
                    onDone={(note) => {
                      setDebiting(null);
                      setNotice(`Nota débito ${note.fullNumber} registrada: la deuda con el proveedor sube ${formatAmount(note.payable, note.currency)}.`);
                      reset();
                    }}
                  />
                ) : null}
                {crediting === p._id ? (
                  <SupplierNoteForm
                    purchase={p}
                    currency={currency}
                    onCancel={() => setCrediting(null)}
                    onDone={(note) => {
                      setCrediting(null);
                      setNotice(`Nota ${note.fullNumber} registrada: la deuda con el proveedor baja ${formatAmount(note.effect, note.currency)}.`);
                      reset();
                    }}
                  />
                ) : null}
              </>
            ) : null
          }
        />
      ) : null}
      {more.error ? <Notice kind="error">{errorMessage(more.error)}</Notice> : null}
      {next ? (
        <div className="mt-4">
          <Button busy={more.busy} onClick={() => more.run()}>Cargar más compras</Button>
        </div>
      ) : null}
      </div>
    </>
  );
}

export function SupplierNotesScreen() {
  const base = useTenantApi();
  const { can } = useSession();
  const [confirming, setConfirming] = useState(null);
  const [notice, setNotice] = useState(null);
  const [extra, setExtra] = useState([]);
  const [cursor, setCursor] = useState(undefined);
  const list = useLoad(() => api.get(`${base}/supplier-notes`), [base]);
  const items = [...(list.data?.items ?? []), ...extra];
  const next = cursor === undefined ? list.data?.nextCursor : cursor;
  const more = useSubmit(async () => {
    const page = await api.get(`${base}/supplier-notes?cursor=${next}`);
    setExtra((e) => [...e, ...page.items]);
    setCursor(page.nextCursor);
  });
  const act = useSubmit(async (note) => {
    await api.post(`${base}/supplier-notes/${note._id}/void`);
    setNotice(`Nota ${note.fullNumber} anulada: la deuda con el proveedor volvió a su valor.`);
    setConfirming(null);
    setExtra([]);
    setCursor(undefined);
    list.reload();
  });

  const columns = [
    { key: 'number', title: 'Número', nowrap: true, render: (n) => n.fullNumber },
    { key: 'date', title: 'Fecha', nowrap: true, render: (n) => formatDay(n.issueDate) },
    { key: 'supplier', title: 'Proveedor', render: (n) => n.supplier.name },
    { key: 'doc', title: 'Nota del proveedor', nowrap: true, render: (n) => n.supplierDocNumber },
    { key: 'purchase', title: 'Compra', nowrap: true, render: (n) => n.purchaseFullNumber },
    { key: 'reason', title: 'Motivo', render: (n) => n.reason },
    { key: 'total', title: 'Total', align: 'right', render: (n) => formatAmount(n.totals.total, n.currency) },
    { key: 'effect', title: 'Baja la deuda', align: 'right', render: (n) => formatAmount(n.effect, n.currency) },
    { key: 'status', title: 'Estado', render: (n) => (n.status === 'void' ? 'Anulada' : 'Vigente') },
    {
      key: 'actions',
      title: 'Acciones',
      render: (n) => {
        if (n.status !== 'posted' || !can('purchases:void')) return null;
        if (confirming === n._id) {
          return (
            <span className="flex gap-3">
              <TextButton danger onClick={() => act.run(n)}>Sí, anular</TextButton>
              <TextButton onClick={() => setConfirming(null)}>Cancelar</TextButton>
            </span>
          );
        }
        return <TextButton onClick={() => { setConfirming(n._id); act.clearError(); }}>Anular</TextButton>;
      },
    },
  ];

  return (
    <>
      <PageHeader title="Notas de proveedor" />
      <p className="mb-4 text-sm text-tinta">Devoluciones y descuentos que te hace un proveedor sobre una compra. Se registran desde la compra, con «Acreditar».</p>
      {notice ? <Notice kind="success">{notice}</Notice> : null}
      {act.error ? <Notice kind="error">{errorMessage(act.error)}</Notice> : null}
      {list.error ? <Notice kind="error">{errorMessage(list.error)}</Notice> : null}
      {list.loading && !list.data ? <p className="text-sm text-tinta">Cargando notas…</p> : null}
      {list.data ? <DataTable caption="Notas de proveedor" columns={columns} rows={items} rowKey={(n) => n._id} empty="Todavía no hay notas de proveedor." /> : null}
      {more.error ? <Notice kind="error">{errorMessage(more.error)}</Notice> : null}
      {next ? (
        <div className="mt-4">
          <Button busy={more.busy} onClick={() => more.run()}>Cargar más notas</Button>
        </div>
      ) : null}
    </>
  );
}
