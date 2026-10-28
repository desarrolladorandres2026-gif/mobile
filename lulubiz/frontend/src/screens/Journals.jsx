import { useMemo, useState } from 'react';
import { CostCenterSelect, useCostCenters } from '../components/CostCenterSelect.jsx';
import { LoadNotice, DeleteButton, Button, DataTable, Notice, PageHeader, SelectField, TextButton, TextField, errorMessage, useLoad, useSubmit } from '../components/ui.jsx';
import { api, newIdempotencyKey } from '../lib/api.js';
import { formatDay } from '../lib/format.js';
import { formatAmount, parseAmount } from '../lib/money.js';
import { useSession, useTenantApi } from '../lib/session.jsx';

const DOC_TYPES = [
  { value: 'CC', label: 'CC · Comprobante contable' },
  { value: 'ND', label: 'ND · Nota débito' },
];

const today = () => new Date().toISOString().slice(0, 10);
const emptyLine = () => ({ accountId: '', debit: '', credit: '', description: '', costCenter: '' });

/** Valida el formulario completo y devuelve las líneas listas para enviar, o los errores por campo. */
export function validateJournal({ date, lines, currency, accountsByCode }) {
  const errors = { form: [], lines: [] };
  if (!date) errors.form.push('Elige la fecha del asiento.');
  const prepared = [];
  let debits = 0;
  let credits = 0;
  lines.forEach((line, i) => {
    const e = {};
    const blank = !line.accountId && !line.debit && !line.credit;
    errors.lines[i] = e;
    if (blank) return;
    if (!accountsByCode.has(line.accountId.trim())) e.accountId = 'Elige una cuenta que admita asientos.';
    const debit = parseAmount(line.debit, currency);
    const credit = parseAmount(line.credit, currency);
    if (debit === null) e.debit = 'Importe no válido. Ejemplo: 1.250.000,50';
    if (credit === null) e.credit = 'Importe no válido. Ejemplo: 1.250.000,50';
    if (debit !== null && credit !== null) {
      if (debit > 0 === credit > 0) e.debit = 'Escribe débito o crédito, no ambos ni ninguno.';
      else {
        debits += debit;
        credits += credit;
        prepared.push({ accountId: line.accountId.trim(), ...(debit ? { debit } : { credit }), ...(line.description.trim() ? { description: line.description.trim() } : {}), ...(line.costCenter ? { costCenter: line.costCenter } : {}) });
      }
    }
  });
  if (prepared.length < 2) errors.form.push('Un asiento necesita al menos dos líneas con importe.');
  if (debits !== credits) errors.form.push('El asiento no cuadra: los débitos y los créditos deben sumar lo mismo.');
  const hasLineErrors = errors.lines.some((e) => Object.keys(e).length);
  return { ok: !errors.form.length && !hasLineErrors, errors, prepared, debits, credits };
}

function JournalForm({ currency, accounts, onCreated, onCancel }) {
  const base = useTenantApi();
  const [date, setDate] = useState(today());
  const [docType, setDocType] = useState('CC');
  const [description, setDescription] = useState('');
  const [lines, setLines] = useState([emptyLine(), emptyLine()]);
  const [showErrors, setShowErrors] = useState(false);
  const [key, setKey] = useState(newIdempotencyKey);
  const centers = useCostCenters(base);

  const postable = useMemo(() => accounts.filter((a) => a.postable && a.active), [accounts]);
  const accountsByCode = useMemo(() => new Map(postable.map((a) => [a.code, a])), [postable]);
  const result = validateJournal({ date, lines, currency, accountsByCode });

  const submit = useSubmit(async () => {
    setShowErrors(true);
    if (!result.ok) return;
    const created = await api.post(
      `${base}/journals`,
      { docType, date: `${date}T12:00:00Z`, currency, ...(description.trim() ? { description: description.trim() } : {}), lines: result.prepared },
      { 'idempotency-key': key },
    );
    setKey(newIdempotencyKey());
    onCreated(created.journal);
  });

  const setLine = (i, field) => (e) => setLines((ls) => ls.map((l, n) => (n === i ? { ...l, [field]: e.target.value } : l)));
  const difference = result.debits - result.credits;

  return (
    <form
      className="mb-8 border-b border-borde pb-6"
      onSubmit={(e) => {
        e.preventDefault();
        submit.run();
      }}
    >
      <h2 className="mb-3 text-lg font-semibold text-tinta">Nuevo asiento</h2>
      {submit.error ? <Notice kind="error">{errorMessage(submit.error)}</Notice> : null}
      <div className="grid gap-x-4 sm:grid-cols-3">
        <TextField label="Fecha" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        <SelectField label="Tipo de documento" value={docType} onChange={(e) => setDocType(e.target.value)} options={DOC_TYPES} />
        <TextField label="Descripción" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
      </div>

      <datalist id="cuentas-movibles">
        {postable.map((a) => (
          <option key={a.code} value={a.code}>
            {a.name}
          </option>
        ))}
      </datalist>

      <LoadNotice load={centers} what="los centros de costo" />
      <div className="relative overflow-x-auto">
        <table className="mb-2 w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-borde-fuerte text-left">
              <th scope="col" className="px-2 py-2 font-semibold">Cuenta</th>
              <th scope="col" className="px-2 py-2 font-semibold">Detalle de la línea</th>
              {centers.length ? <th scope="col" className="px-2 py-2 font-semibold">Centro de costo</th> : null}
              <th scope="col" className="px-2 py-2 text-right font-semibold">Débito ({currency})</th>
              <th scope="col" className="px-2 py-2 text-right font-semibold">Crédito ({currency})</th>
              <th scope="col" className="px-2 py-2"><span className="sr-only">Acciones</span></th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line, i) => {
              const e = (showErrors && result.errors.lines[i]) || {};
              const account = accountsByCode.get(line.accountId.trim());
              return (
                <tr key={i} className="border-b border-borde align-top">
                  <td className="px-2 py-2">
                    <input
                      aria-label={`Cuenta de la línea ${i + 1}`}
                      list="cuentas-movibles"
                      value={line.accountId}
                      onChange={setLine(i, 'accountId')}
                      className={`w-32 rounded-sm border bg-papel px-2 py-1.5 text-sm focus:outline-2 focus:outline-azul ${e.accountId ? 'border-rojo' : 'border-borde-fuerte'}`}
                    />
                    <p className="mt-1 text-xs text-tinta-segundo">{account ? account.name : ' '}</p>
                    {e.accountId ? <p role="alert" className="text-xs font-semibold text-rojo">{e.accountId}</p> : null}
                  </td>
                  <td className="px-2 py-2">
                    <input
                      aria-label={`Detalle de la línea ${i + 1}`}
                      value={line.description}
                      onChange={setLine(i, 'description')}
                      className="w-full min-w-40 rounded-sm border border-borde-fuerte bg-papel px-2 py-1.5 text-sm focus:outline-2 focus:outline-azul"
                    />
                  </td>
                  {centers.length ? (
                    <td className="px-2 py-2">
                      <CostCenterSelect centers={centers} label={`Centro de costo de la línea ${i + 1}`} value={line.costCenter} onChange={setLine(i, 'costCenter')} />
                    </td>
                  ) : null}
                  {['debit', 'credit'].map((field) => (
                    <td key={field} className="px-2 py-2 text-right">
                      <input
                        aria-label={`${field === 'debit' ? 'Débito' : 'Crédito'} de la línea ${i + 1}`}
                        inputMode="decimal"
                        value={line[field]}
                        onChange={setLine(i, field)}
                        className={`w-36 rounded-sm border bg-papel px-2 py-1.5 text-right text-sm tabular-nums focus:outline-2 focus:outline-azul ${e[field] ? 'border-rojo' : 'border-borde-fuerte'}`}
                      />
                      {e[field] ? <p role="alert" className="text-left text-xs font-semibold text-rojo">{e[field]}</p> : null}
                    </td>
                  ))}
                  <td className="px-2 py-2">
                    {lines.length > 2 ? (
                      <DeleteButton onClick={() => setLines((ls) => ls.filter((_, n) => n !== i))}>Quitar</DeleteButton>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td className="px-2 py-2" colSpan={centers.length ? 3 : 2}>
                <TextButton onClick={() => setLines((ls) => [...ls, emptyLine()])}>Agregar línea</TextButton>
              </td>
              <td className="px-2 py-2 text-right font-semibold tabular-nums">{formatAmount(result.debits, currency)}</td>
              <td className="px-2 py-2 text-right font-semibold tabular-nums">{formatAmount(result.credits, currency)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>

      <p className={`mb-3 text-sm font-semibold ${difference === 0 && result.debits > 0 ? 'text-verde' : 'text-tinta'}`}>
        {result.debits === 0 && result.credits === 0
          ? 'Escribe los importes: los débitos y los créditos deben sumar lo mismo.'
          : difference === 0
            ? 'El asiento cuadra.'
            : `No cuadra: diferencia de ${formatAmount(Math.abs(difference), currency)} a favor de ${difference > 0 ? 'los débitos' : 'los créditos'}.`}
      </p>
      {showErrors && result.errors.form.length ? (
        <Notice kind="error">
          {result.errors.form.map((m) => (
            <p key={m}>{m}</p>
          ))}
        </Notice>
      ) : null}

      <Button type="submit" variant="primary" busy={submit.busy}>
        Registrar asiento
      </Button>
      <Button className="ml-2" onClick={onCancel}>
        Cancelar
      </Button>
    </form>
  );
}

export function JournalsScreen() {
  const base = useTenantApi();
  const { tenant, can } = useSession();
  const currency = tenant.currency;
  const [period, setPeriod] = useState('');
  const [docType, setDocType] = useState('');
  const [accountId, setAccountId] = useState('');
  const [creating, setCreating] = useState(false);
  const [extra, setExtra] = useState([]);
  const [cursor, setCursor] = useState(undefined);
  const [moreError, setMoreError] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [open, setOpen] = useState(null);
  const [confirming, setConfirming] = useState(null);
  const [notice, setNotice] = useState(null);

  const query = new URLSearchParams({ ...(period ? { period } : {}), ...(docType ? { docType } : {}), ...(accountId ? { accountId } : {}) }).toString();
  const list = useLoad(() => api.get(`${base}/journals?${query}`), [base, query]);
  const accounts = useLoad(() => api.get(`${base}/accounts?activeOnly=true`), [base]);

  const items = [...(list.data?.items ?? []), ...extra];
  const next = cursor === undefined ? list.data?.nextCursor : cursor;

  const reset = () => {
    setExtra([]);
    setCursor(undefined);
    setOpen(null);
  };

  const loadMore = async () => {
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await api.get(`${base}/journals?${query}${query ? '&' : ''}cursor=${next}`);
      setExtra((e) => [...e, ...page.items]);
      setCursor(page.nextCursor);
    } catch (error) {
      setMoreError(error);
    } finally {
      setLoadingMore(false);
    }
  };

  const reverse = useSubmit(async (journal) => {
    await api.post(`${base}/journals/${journal._id}/reverse`, {}, { 'idempotency-key': `reversion-${journal._id}` });
    setNotice(`El asiento ${journal.docType}-${journal.number} quedó revertido con un asiento nuevo de signo contrario.`);
    setConfirming(null);
    reset();
    list.reload();
  });

  const columns = [
    { key: 'number', title: 'Número', render: (j) => `${j.docType}-${j.number}` },
    { key: 'date', title: 'Fecha', nowrap: true, render: (j) => formatDay(j.date) },
    { key: 'description', title: 'Descripción', render: (j) => j.description ?? '' },
    { key: 'total', title: `Total (${currency})`, align: 'right', render: (j) => formatAmount(j.totalDebit, j.currency) },
    {
      key: 'state',
      title: 'Estado',
      render: (j) => (j.reversedByJournalId ? 'Revertido' : j.reversesJournalId ? 'Es una reversión' : 'Vigente'),
    },
    {
      key: 'actions',
      title: 'Acciones',
      render: (j) => (
        <span className="flex flex-wrap gap-3">
          <TextButton onClick={() => setOpen(open === j._id ? null : j._id)}>{open === j._id ? 'Ocultar líneas' : 'Ver líneas'}</TextButton>
          {can('journals:reverse') && !j.reversedByJournalId && !j.reversesJournalId && !j.source ? (
            confirming === j._id ? (
              <span className="flex gap-2">
                <TextButton danger onClick={() => reverse.run(j)}>Sí, revertir</TextButton>
                <TextButton onClick={() => setConfirming(null)}>Cancelar</TextButton>
              </span>
            ) : (
              <TextButton onClick={() => { setConfirming(j._id); reverse.clearError(); }}>Revertir</TextButton>
            )
          ) : null}
        </span>
      ),
    },
  ];

  const accountName = (code) => accounts.data?.items.find((a) => a.code === code)?.name ?? '';

  return (
    <>
      <PageHeader title="Asientos">
        {can('journals:post') && !creating ? (
          <Button variant="primary" onClick={() => { setCreating(true); setNotice(null); }}>
            Nuevo asiento
          </Button>
        ) : null}
      </PageHeader>

      {notice ? <Notice kind="success">{notice}</Notice> : null}
      {reverse.error ? <Notice kind="error">{errorMessage(reverse.error)}</Notice> : null}

      {creating && accounts.data ? (
        <JournalForm
          currency={currency}
          accounts={accounts.data.items}
          onCancel={() => setCreating(false)}
          onCreated={(journal) => {
            setCreating(false);
            setNotice(`Se registró el asiento ${journal.docType}-${journal.number}.`);
            reset();
            list.reload();
          }}
        />
      ) : null}

      {/* Mientras se elabora un documento la lista se oculta (sin perder filtros ni páginas cargadas). */}
      <div hidden={creating}>
      <div className="mb-4 grid gap-x-4 sm:grid-cols-3">
        <TextField label="Período" type="month" value={period} onChange={(e) => { setPeriod(e.target.value); reset(); }} />
        <SelectField
          label="Tipo"
          value={docType}
          onChange={(e) => { setDocType(e.target.value); reset(); }}
          options={[{ value: '', label: 'Todos' }, ...DOC_TYPES.map((t) => ({ value: t.value, label: t.value }))]}
        />
        <TextField label="Cuenta" value={accountId} onChange={(e) => { setAccountId(e.target.value.replace(/\D/g, '')); reset(); }} hint="Código de la cuenta." />
      </div>

      {list.error ? <Notice kind="error">{errorMessage(list.error)}</Notice> : null}
      {list.loading && !list.data ? <p className="text-sm text-tinta">Cargando asientos…</p> : null}
      {list.data ? (
        <DataTable
          caption="Asientos contables"
          columns={columns}
          rows={items}
          rowKey={(j) => j._id}
          empty="No hay asientos con estos filtros."
          expandedRow={(j) =>
            open === j._id ? (
              <div className="relative overflow-x-auto">
                <table className="mb-1 ml-4 text-sm">
                  <thead>
                    <tr className="text-left">
                      <th scope="col" className="pr-6 font-semibold">Cuenta</th>
                      <th scope="col" className="pr-6 font-semibold">Nombre</th>
                      <th scope="col" className="pr-6 text-right font-semibold">Débito</th>
                      <th scope="col" className="text-right font-semibold">Crédito</th>
                    </tr>
                  </thead>
                  <tbody>
                    {j.lines.map((l, n) => (
                      <tr key={n}>
                        <td className="pr-6">{l.accountId}</td>
                        <td className="pr-6">{accountName(l.accountId)}{l.description ? ` — ${l.description}` : ''}</td>
                        <td className="pr-6 text-right tabular-nums">{l.debit ? formatAmount(l.debit, j.currency) : ''}</td>
                        <td className="text-right tabular-nums">{l.credit ? formatAmount(l.credit, j.currency) : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null
          }
        />
      ) : null}

      {moreError ? <Notice kind="error">{errorMessage(moreError)}</Notice> : null}
      {next ? (
        <div className="mt-4">
          <Button busy={loadingMore} onClick={loadMore}>
            Cargar más asientos
          </Button>
        </div>
      ) : null}
      </div>
    </>
  );
}
