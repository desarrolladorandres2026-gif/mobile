import { useMemo, useState } from 'react';
import { Button, DataTable, Notice, PageHeader, TextButton, TextField, errorMessage, useLoad, useSubmit } from '../components/ui.jsx';
import { PartyPicker } from '../components/PartyPicker.jsx';
import { api } from '../lib/api.js';
import { formatDay } from '../lib/format.js';
import { formatPercent } from '../lib/invoicing.js';
import { formatAmount, parseAmount } from '../lib/money.js';
import { useSession, useTenantApi } from '../lib/session.jsx';
import { currentBimester, formatPerMil, parseAccountList, parsePerMil, validateVatClose, vatVerdict } from '../lib/taxes.js';

const today = () => new Date().toISOString().slice(0, 10);

function Section({ title, hint, children }) {
  return (
    <section className="mb-10">
      <h2 className="mb-1 text-lg font-semibold text-tinta">{title}</h2>
      {hint ? <p className="mb-3 text-sm text-tinta">{hint}</p> : null}
      {children}
    </section>
  );
}

function RangeFields({ range, setRange, onChange }) {
  return (
    <div className="grid gap-x-4 sm:grid-cols-4">
      <TextField label="Desde" type="date" value={range.from} onChange={(e) => { setRange((r) => ({ ...r, from: e.target.value })); onChange(); }} />
      <TextField label="Hasta" type="date" value={range.to} onChange={(e) => { setRange((r) => ({ ...r, to: e.target.value })); onChange(); }} />
    </div>
  );
}

// -------------------------------------------------------------------------- IVA

function RateTable({ title, side, currency }) {
  const money = (v) => formatAmount(v, currency);
  const rows = [...side.rates.map((r) => ({ key: String(r.vatBps), label: `Tarifa ${formatPercent(r.vatBps)}`, base: r.base, tax: r.tax })), { key: 'total', label: 'Total', total: true, base: side.base, tax: side.tax }];
  return (
    <DataTable
      caption={title}
      empty="Sin documentos en este rango."
      rows={side.rates.length ? rows : []}
      rowKey={(r) => r.key}
      columns={[
        { key: 'label', title, render: (r) => (r.total ? <strong>{r.label}</strong> : r.label) },
        { key: 'base', title: 'Base', align: 'right', render: (r) => (r.total ? <strong>{money(r.base)}</strong> : money(r.base)) },
        { key: 'tax', title: 'IVA', align: 'right', render: (r) => (r.total ? <strong>{money(r.tax)}</strong> : money(r.tax)) },
      ]}
    />
  );
}

function LedgerCheck({ label, side, currency }) {
  if (!side.account) return <p className="text-sm text-tinta">{label}: la cuenta no está configurada en Facturación.</p>;
  const ok = side.difference === 0;
  return (
    <p className={`text-sm ${ok ? 'text-verde' : 'text-rojo'} font-semibold`}>
      {label} (cuenta {side.account} · {side.name}): libro {formatAmount(side.amount, currency)}.{' '}
      {ok ? 'Cuadra con los documentos.' : `Diferencia de ${formatAmount(side.difference, currency)} contra los documentos: hay asientos manuales sobre la cuenta o documentos anteriores a su configuración.`}
    </p>
  );
}

function VatCloseForm({ range, currency, onDone }) {
  const base = useTenantApi();
  const preview = useLoad(() => api.get(`${base}/taxes/vat-close/preview?${new URLSearchParams({ ...range, currency })}`), [base, range.from, range.to, currency]);
  const [accounts, setAccounts] = useState({ dueAccount: '', creditAccount: '' });
  const [errors, setErrors] = useState([]);
  const all = useLoad(() => api.get(`${base}/accounts?activeOnly=true`), [base]);
  const postable = useMemo(() => (all.data?.items ?? []).filter((a) => a.postable), [all.data]);
  const money = (v) => formatAmount(v, currency);
  const data = preview.data;
  const save = useSubmit(async () => {
    const built = validateVatClose({ ...range, ...accounts }, data.net);
    if (!built.ok) return setErrors(built.errors);
    setErrors([]);
    return onDone(await api.post(`${base}/taxes/vat-closes`, { ...built.body, currency }));
  });
  if (preview.error) return <Notice kind="error">{errorMessage(preview.error)}</Notice>;
  if (!data) return <p className="text-sm text-tinta">Calculando…</p>;
  const verdict = vatVerdict(data.net);
  return (
    <div>
      <datalist id="cuentas-cierre-iva">
        {postable.map((a) => (
          <option key={a.code} value={a.code}>{a.name}</option>
        ))}
      </datalist>
      <dl className="mb-3 grid max-w-lg grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm text-tinta">
        <dt>IVA generado en el libro</dt>
        <dd className="text-right tabular-nums">{money(data.generated)}</dd>
        <dt>IVA descontable en el libro</dt>
        <dd className="text-right tabular-nums">{money(data.deductible)}</dd>
        <dt className="font-semibold">{verdict.text}</dt>
        <dd className="text-right font-semibold tabular-nums">{money(Math.abs(data.net))}</dd>
      </dl>
      {data.overlap ? <Notice kind="info">Este rango ya está cubierto por el cierre {data.overlap.document} ({formatDay(data.overlap.from)} a {formatDay(data.overlap.to)}). Anúlalo para volver a cerrar.</Notice> : null}
      {errors.length ? (
        <Notice kind="error">
          {errors.map((m) => (
            <p key={m}>{m}</p>
          ))}
        </Notice>
      ) : null}
      {save.error ? <Notice kind="error">{errorMessage(save.error)}</Notice> : null}
      {!data.overlap ? (
        <>
          <div className="grid gap-x-4 sm:grid-cols-3">
            {data.net > 0 ? <TextField label="Cuenta de IVA por pagar a la DIAN" list="cuentas-cierre-iva" value={accounts.dueAccount} onChange={(e) => setAccounts((a) => ({ ...a, dueAccount: e.target.value }))} hint={postable.find((a) => a.code === accounts.dueAccount.trim())?.name} /> : null}
            {data.net < 0 ? <TextField label="Cuenta de saldo a favor de IVA" list="cuentas-cierre-iva" value={accounts.creditAccount} onChange={(e) => setAccounts((a) => ({ ...a, creditAccount: e.target.value }))} hint={postable.find((a) => a.code === accounts.creditAccount.trim())?.name} /> : null}
          </div>
          <Button variant="primary" busy={save.busy} onClick={() => save.run()}>Cerrar el IVA del rango</Button>
        </>
      ) : null}
    </div>
  );
}

function VatSection({ currency, canClose }) {
  const base = useTenantApi();
  const [range, setRange] = useState(() => currentBimester(today()));
  const [result, setResult] = useState(null);
  const [closing, setClosing] = useState(false);
  const [notice, setNotice] = useState(null);
  const closes = useLoad(() => api.get(`${base}/taxes/vat-closes`), [base]);
  const run = useSubmit(async () => {
    setClosing(false);
    setResult(await api.get(`${base}/reports/vat?${new URLSearchParams({ ...range, currency })}`));
  });
  const voidClose = useSubmit(async (c) => {
    await api.post(`${base}/taxes/vat-closes/${c._id}/void`);
    setNotice(`Cierre ${c.document} anulado.`);
    closes.reload();
  });
  const money = (v) => formatAmount(v, currency);
  const verdict = result ? vatVerdict(result.net) : null;
  const closeColumns = [
    { key: 'doc', title: 'Asiento', nowrap: true, render: (c) => c.document },
    { key: 'range', title: 'Rango', nowrap: true, render: (c) => `${formatDay(c.from)} a ${formatDay(c.to)}` },
    { key: 'net', title: `Resultado (${currency})`, align: 'right', render: (c) => `${c.result === 'payable' ? 'Por pagar' : c.result === 'credit' ? 'A favor' : 'En cero'} ${money(Math.abs(c.net))}` },
    { key: 'status', title: 'Estado', render: (c) => (c.status === 'void' ? 'Anulado' : 'Vigente') },
    { key: 'actions', title: 'Acciones', render: (c) => (canClose && c.status === 'posted' ? <TextButton danger onClick={() => voidClose.run(c)}>Anular</TextButton> : null) },
  ];
  return (
    <Section title="IVA" hint="Lo generado en ventas y lo descontable en compras, por tarifa, con las notas restadas. Sale de los documentos y se compara con el libro. La fecha de cada documento es la de emisión.">
      <RangeFields range={range} setRange={setRange} onChange={() => setResult(null)} />
      {run.error ? <Notice kind="error">{errorMessage(run.error)}</Notice> : null}
      <Button variant="primary" busy={run.busy} onClick={() => run.run()}>Ver IVA</Button>
      {result ? (
        <div className="mt-6">
          <RateTable title="IVA generado" side={result.generated} currency={currency} />
          <p className="mb-6 mt-1 text-sm text-tinta">
            {result.generated.documents.invoices} facturas, {result.generated.documents.posSales} ventas de mostrador y {result.generated.documents.creditNotes} notas crédito.
          </p>
          <RateTable title="IVA descontable" side={result.deductible} currency={currency} />
          <p className="mb-4 mt-1 text-sm text-tinta">
            {result.deductible.documents.purchases} compras (con notas débito) y {result.deductible.documents.supplierNotes} notas de proveedor.
          </p>
          <p className="mb-3 text-base font-semibold text-tinta">
            {verdict.text}: <span className="tabular-nums">{money(Math.abs(result.net))}</span>
          </p>
          <LedgerCheck label="Generado" side={result.ledger.generated} currency={currency} />
          <LedgerCheck label="Descontable" side={result.ledger.deductible} currency={currency} />
          {canClose ? (
            <div className="mt-4">
              {closing ? <VatCloseForm range={range} currency={currency} onDone={(r) => { setClosing(false); setNotice(`Cierre ${r.close.document} registrado.`); closes.reload(); }} /> : <Button onClick={() => setClosing(true)}>Cerrar el IVA de este rango</Button>}
            </div>
          ) : null}
        </div>
      ) : null}
      {notice ? <div className="mt-4"><Notice kind="success">{notice}</Notice></div> : null}
      {voidClose.error ? <Notice kind="error">{errorMessage(voidClose.error)}</Notice> : null}
      <h3 className="mb-2 mt-8 font-semibold text-tinta">Cierres de IVA</h3>
      {closes.data ? <DataTable caption="Cierres de IVA" columns={closeColumns} rows={closes.data.items} rowKey={(c) => c._id} empty="Todavía no se ha cerrado ningún rango." /> : null}
    </Section>
  );
}

// ------------------------------------------------------------------ Retenciones

function Certificate({ data, currency }) {
  const money = (v) => formatAmount(v, currency);
  return (
    <section aria-label={`Certificado de retenciones de ${data.supplier.name}`} className="my-3 max-w-2xl border border-borde-fuerte p-4 text-sm text-tinta">
      <h3 className="text-base font-semibold">Certificado de retenciones · año {data.year}</h3>
      <p className="mb-2">
        {data.issuer?.name}, NIT {data.issuer?.taxId}
        {data.issuer?.checkDigit !== null && data.issuer?.checkDigit !== undefined ? `-${data.issuer.checkDigit}` : ''}, certifica que practicó a {data.supplier.name} ({data.supplier.taxIdType} {data.supplier.taxId}) las siguientes retenciones:
      </p>
      <DataTable
        caption="Retenciones del certificado"
        empty="No hubo retenciones en este año."
        columns={[
          { key: 'name', title: 'Concepto', render: (c) => c.name },
          { key: 'rate', title: 'Tarifa', align: 'right', render: (c) => formatPercent(c.rateBps) },
          { key: 'base', title: 'Base', align: 'right', render: (c) => money(c.base) },
          { key: 'amount', title: 'Valor retenido', align: 'right', render: (c) => money(c.amount) },
        ]}
        rows={data.concepts}
        rowKey={(c) => `${c.accountId}-${c.name}`}
      />
      <p className="mt-2 font-semibold">Total retenido: {money(data.totals.amount)}</p>
      <p className="mt-2 text-tinta-segundo">Expedido el {formatDay(data.issuedOn)}.</p>
      <div className="mt-3">
        <Button onClick={() => window.print()}>Imprimir</Button>
      </div>
    </section>
  );
}

function WithholdingsSection({ currency }) {
  const base = useTenantApi();
  const year = new Date().getUTCFullYear();
  const [range, setRange] = useState({ from: `${year}-01-01`, to: today() });
  const [result, setResult] = useState(null);
  const [supplierId, setSupplierId] = useState('');
  const [certYear, setCertYear] = useState(String(year));
  const [cert, setCert] = useState(null);
  const [error, setError] = useState(null);
  const money = (v) => formatAmount(v, currency);
  const run = useSubmit(async () => {
    const params = new URLSearchParams({ ...range, currency });
    const [practiced, suffered] = await Promise.all([api.get(`${base}/reports/withholdings?${params}`), api.get(`${base}/reports/withholdings-suffered?${params}`)]);
    setResult({ ...practiced, suffered });
  });
  const certify = useSubmit(async () => {
    if (!supplierId) return setError('Elige el proveedor.');
    if (!/^\d{4}$/.test(certYear)) return setError('Escribe el año con cuatro cifras.');
    setError(null);
    return setCert(await api.get(`${base}/reports/withholding-certificate?${new URLSearchParams({ supplierId, year: certYear, currency })}`));
  });
  return (
    <Section title="Retenciones practicadas" hint="Lo que se retuvo a los proveedores en las compras, por concepto y por proveedor, menos lo que devolvieron las notas de proveedor. La retención de nómina está en los reportes de nómina.">
      <RangeFields range={range} setRange={setRange} onChange={() => setResult(null)} />
      {run.error ? <Notice kind="error">{errorMessage(run.error)}</Notice> : null}
      <Button variant="primary" busy={run.busy} onClick={() => run.run()}>Ver retenciones</Button>
      {result ? (
        <div className="mt-6">
          <DataTable
            caption="Retenciones por concepto"
            empty="No hubo retenciones en este rango."
            columns={[
              { key: 'concept', title: 'Concepto', render: (c) => `${c.name} · cuenta ${c.accountId}` },
              { key: 'rate', title: 'Tarifa', align: 'right', render: (c) => formatPercent(c.rateBps) },
              { key: 'base', title: 'Base', align: 'right', render: (c) => money(c.base) },
              { key: 'amount', title: 'Retenido', align: 'right', render: (c) => money(c.amount) },
            ]}
            rows={result.concepts}
            rowKey={(c) => `${c.accountId}-${c.name}-${c.rateBps}`}
          />
          <h3 className="mb-1 mt-4 font-semibold text-tinta">Por proveedor</h3>
          <DataTable
            caption="Retenciones por proveedor"
            empty="Sin retenciones."
            columns={[
              { key: 'name', title: 'Proveedor', render: (s) => `${s.name} — ${s.taxIdType} ${s.taxId}` },
              { key: 'base', title: 'Base', align: 'right', render: (s) => money(s.base) },
              { key: 'amount', title: 'Retenido', align: 'right', render: (s) => money(s.amount) },
            ]}
            rows={result.suppliers}
            rowKey={(s) => String(s.partyId)}
          />
          <p className="mt-2 text-sm font-semibold text-tinta">Total retenido: <span className="tabular-nums">{money(result.totals.amount)}</span></p>
          <h3 className="mb-1 mt-6 font-semibold text-tinta">Retenciones que te practicaron los clientes</h3>
          <p className="mb-2 text-sm text-tinta">Lo que tus clientes descontaron al pagarte (recibos de caja vigentes): es un impuesto a favor.</p>
          <DataTable
            caption="Retenciones practicadas por los clientes"
            empty="Ningún cliente te practicó retenciones en este rango."
            columns={[
              { key: 'concept', title: 'Concepto', render: (c) => `${c.name} · cuenta ${c.accountId}` },
              { key: 'amount', title: 'Valor', align: 'right', render: (c) => money(c.amount) },
            ]}
            rows={result.suffered.concepts}
            rowKey={(c) => `${c.accountId}-${c.name}`}
          />
          {result.suffered.customers.length ? <p className="mt-2 text-sm text-tinta">Por cliente: {result.suffered.customers.map((c) => `${c.name} ${money(c.amount)}`).join(' · ')}. Total {money(result.suffered.total)}.</p> : null}
        </div>
      ) : null}
      <h3 className="mb-2 mt-8 font-semibold text-tinta">Certificado de retenciones de un proveedor</h3>
      <PartyPicker base={base} role="supplier" value={supplierId} onChange={(id) => { setSupplierId(id); setCert(null); }} />
      <div className="grid gap-x-4 sm:grid-cols-4">
        <TextField label="Año" value={certYear} onChange={(e) => { setCertYear(e.target.value); setCert(null); }} maxLength={4} inputMode="numeric" />
      </div>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {certify.error ? <Notice kind="error">{errorMessage(certify.error)}</Notice> : null}
      <Button busy={certify.busy} onClick={() => certify.run()}>Ver certificado</Button>
      {cert ? <Certificate data={cert} currency={currency} /> : null}
    </Section>
  );
}

function IcaSection({ currency }) {
  const base = useTenantApi();
  const year = new Date().getUTCFullYear();
  const [range, setRange] = useState({ from: `${year}-01-01`, to: today() });
  const [rate, setRate] = useState('');
  const [excluded, setExcluded] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const money = (v) => formatAmount(v, currency);
  const run = useSubmit(async () => {
    const ratePpm = parsePerMil(rate);
    if (ratePpm === null) return setError('Escribe la tarifa por mil, entre 0 y 100 (por ejemplo 9,66).');
    const list = parseAccountList(excluded);
    if (list === null) return setError('Las cuentas excluidas son códigos numéricos separados por coma.');
    setError(null);
    const params = new URLSearchParams({ ...range, currency, ratePpm: String(ratePpm), ...(list.length ? { excludeAccounts: list.join(',') } : {}) });
    return setResult(await api.get(`${base}/reports/ica?${params}`));
  });
  return (
    <Section title="ICA" hint="Impuesto de industria y comercio: la base es el ingreso neto del libro (las devoluciones ya restan) sin las cuentas que excluyas, como los ingresos no operacionales. La tarifa cambia por municipio y actividad: la pones tú, tomada del acuerdo municipal. La retención de ICA practicada a proveedores sale en Retenciones.">
      <RangeFields range={range} setRange={setRange} onChange={() => setResult(null)} />
      <div className="grid gap-x-4 sm:grid-cols-4">
        <TextField label="Tarifa por mil" value={rate} onChange={(e) => { setRate(e.target.value); setResult(null); }} inputMode="decimal" hint="Por ejemplo 9,66" />
        <div className="sm:col-span-2">
          <TextField label="Cuentas de ingreso excluidas" value={excluded} onChange={(e) => { setExcluded(e.target.value); setResult(null); }} hint="Códigos separados por coma; opcional" />
        </div>
      </div>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {run.error ? <Notice kind="error">{errorMessage(run.error)}</Notice> : null}
      <Button variant="primary" busy={run.busy} onClick={() => run.run()}>Calcular el ICA</Button>
      {result ? (
        <div className="mt-6">
          <DataTable
            caption="Ingresos del rango"
            empty="No hubo ingresos en este rango."
            columns={[
              { key: 'account', title: 'Cuenta', render: (l) => `${l.account} · ${l.name}` },
              { key: 'amount', title: 'Ingreso neto', align: 'right', render: (l) => money(l.amount) },
              { key: 'excluded', title: 'Base', render: (l) => (l.excluded ? 'Excluida' : 'Gravada') },
            ]}
            rows={result.lines}
            rowKey={(l) => l.account}
          />
          <dl className="mt-3 grid max-w-lg grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm text-tinta">
            <dt>Ingresos del libro</dt>
            <dd className="text-right tabular-nums">{money(result.total)}</dd>
            <dt>Excluidos</dt>
            <dd className="text-right tabular-nums">{money(result.excludedTotal)}</dd>
            <dt>Base gravable</dt>
            <dd className="text-right tabular-nums">{money(result.base)}</dd>
            <dt className="font-semibold">ICA a {formatPerMil(result.ratePpm)} por mil</dt>
            <dd className="text-right font-semibold tabular-nums">{money(result.ica)}</dd>
          </dl>
          {result.base < 0 ? <p className="mt-2 text-sm text-tinta">Hubo más devoluciones que ventas: la base es negativa y el ICA se muestra en cero. Este informe no calcula saldos a favor.</p> : null}
        </div>
      ) : null}
    </Section>
  );
}

function PartyTable({ caption, rows, columns, empty }) {
  return <DataTable caption={caption} empty={empty} columns={columns} rows={rows} rowKey={(r) => String(r.partyId)} />;
}

function ExogenaSection({ currency }) {
  const base = useTenantApi();
  const [year, setYear] = useState(String(new Date().getUTCFullYear() - 1));
  const [min, setMin] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const money = (v) => formatAmount(v, currency);
  const run = useSubmit(async () => {
    if (!/^[0-9]{4}$/.test(year)) return setError('Escribe el año con cuatro cifras.');
    const minAmount = min.trim() === '' ? 0 : parseAmount(min, currency);
    if (minAmount === null || minAmount < 0) return setError('El tope mínimo no es un valor válido.');
    setError(null);
    return setResult(await api.get(`${base}/reports/exogena?${new URLSearchParams({ year, currency, minAmount: String(minAmount) })}`));
  });
  const who = (r) => `${r.name} — ${r.taxIdType} ${r.taxId}`;
  const withBase = [
    { key: 'who', title: 'Tercero', render: who },
    { key: 'base', title: 'Base', align: 'right', render: (r) => money(r.base) },
    { key: 'tax', title: 'IVA', align: 'right', render: (r) => money(r.tax) },
  ];
  const withAmount = [
    { key: 'who', title: 'Tercero', render: who },
    { key: 'amount', title: 'Retenido', align: 'right', render: (r) => money(r.amount) },
  ];
  return (
    <Section title="Información exógena" hint="La base por tercero de un año: ingresos, compras y gastos, y retenciones, netos de las notas. Los formatos y los topes los fija la DIAN cada año: el tope que escribas solo oculta a los terceros por debajo de él; los totales no cambian. No presenta nada a la DIAN.">
      <div className="grid gap-x-4 sm:grid-cols-4">
        <TextField label="Año" value={year} onChange={(e) => { setYear(e.target.value); setResult(null); }} maxLength={4} inputMode="numeric" />
        <TextField label="Tope mínimo por tercero" value={min} onChange={(e) => { setMin(e.target.value); setResult(null); }} inputMode="decimal" hint="Opcional" />
      </div>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {run.error ? <Notice kind="error">{errorMessage(run.error)}</Notice> : null}
      <Button variant="primary" busy={run.busy} onClick={() => run.run()}>Ver la base de exógena</Button>
      {result ? (
        <div className="mt-6">
          <PartyTable caption="Ingresos por cliente" empty="Sin ingresos con terceros." rows={result.income.parties} columns={withBase} />
          <p className="mb-4 mt-2 text-sm text-tinta">Ventas de mostrador (sin tercero): {money(result.income.counterOfSale)}. Ingresos totales: <span className="font-semibold tabular-nums">{money(result.income.total)}</span>.</p>
          <PartyTable caption="Compras y gastos por proveedor" empty="Sin compras." rows={result.costs.parties} columns={withBase} />
          <p className="mb-4 mt-2 text-sm text-tinta">Total de compras y gastos: <span className="font-semibold tabular-nums">{money(result.costs.total)}</span>.</p>
          <PartyTable caption="Retenciones practicadas a proveedores" empty="Sin retenciones." rows={result.withheldFromSuppliers.parties} columns={withAmount} />
          <p className="mb-4 mt-2 text-sm text-tinta">Total retenido: <span className="font-semibold tabular-nums">{money(result.withheldFromSuppliers.total)}</span>.</p>
          <PartyTable caption="Retenciones que te practicaron los clientes" empty="Sin retenciones." rows={result.withheldByCustomers.parties} columns={withAmount} />
          <p className="mt-2 text-sm text-tinta">Total: <span className="font-semibold tabular-nums">{money(result.withheldByCustomers.total)}</span>.</p>
        </div>
      ) : null}
    </Section>
  );
}

export function TaxesScreen() {
  const { tenant, can } = useSession();
  return (
    <>
      <PageHeader title="Impuestos" />
      <VatSection currency={tenant.currency} canClose={can('taxes:manage')} />
      <WithholdingsSection currency={tenant.currency} />
      <IcaSection currency={tenant.currency} />
      <ExogenaSection currency={tenant.currency} />
    </>
  );
}
