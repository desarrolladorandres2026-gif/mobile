import { useMemo, useState } from 'react';
import { Button, DataTable, Notice, PageHeader, SelectField, TextButton, TextField, errorMessage, useLoad, useSubmit } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { CHUNK, DECIMALS, chunk, differenceText, parseSignedAmount, parseStatement } from '../lib/bank.js';
import { monthRange } from '../lib/books.js';
import { CsvError, parseCsv } from '../lib/csv.js';
import { formatDay } from '../lib/format.js';
import { formatAmount } from '../lib/money.js';
import { useSession, useTenantApi } from '../lib/session.jsx';

const today = () => new Date().toISOString().slice(0, 10);
const SHOWN = 8;
const STATUS = [
  { value: 'all', label: 'Todas' },
  { value: 'open', label: 'Sin conciliar' },
  { value: 'matched', label: 'Conciliadas' },
];

function ImportPanel({ base, account, currency, onDone, onCancel }) {
  const [text, setText] = useState('');
  const [decimal, setDecimal] = useState('comma');
  const [review, setReview] = useState(null);
  const [error, setError] = useState(null);
  const [outcome, setOutcome] = useState(null);

  const check = () => {
    setOutcome(null);
    setError(null);
    try {
      const { header, rows } = parseCsv(text);
      setReview(parseStatement(header, rows, { currency, decimal }));
    } catch (e) {
      setReview(null);
      setError(e instanceof CsvError ? e.message : 'No se pudo leer el archivo.');
    }
  };

  const send = useSubmit(async () => {
    let created = 0;
    let skipped = 0;
    for (const lines of chunk(review.lines, CHUNK)) {
      const result = await api.post(`${base}/bank/lines`, { account, currency, lines });
      created += result.created;
      skipped += result.skipped;
    }
    setOutcome({ created, skipped });
    setReview(null);
    onDone();
  });

  return (
    <section className="mb-8 border-b border-borde pb-6">
      <h2 className="mb-2 text-lg font-semibold text-tinta">Cargar el extracto</h2>
      <p className="mb-3 text-sm text-tinta">
        Un CSV con encabezado y las columnas fecha, detalle y valor (con signo: negativo es dinero que sale), o fecha, detalle y dos columnas de entra y sale. Para el banco, débito o cargo es lo que sale y crédito o abono lo que entra. Volver a cargar el mismo extracto no duplica nada.
      </p>
      <div className="mb-3">
        <label htmlFor="extracto-csv" className="mb-1 block text-sm font-semibold text-tinta">Archivo CSV del extracto</label>
        <input
          id="extracto-csv"
          type="file"
          accept=".csv,.txt,text/csv"
          onChange={async (e) => {
            setReview(null);
            setOutcome(null);
            const file = e.target.files?.[0];
            if (file) setText(await file.text());
          }}
          className="text-sm text-tinta"
        />
      </div>
      <label htmlFor="extracto-texto" className="mb-1 block text-sm font-semibold text-tinta">O pega el contenido</label>
      <textarea
        id="extracto-texto"
        value={text}
        onChange={(e) => { setText(e.target.value); setReview(null); setOutcome(null); }}
        rows={5}
        className="mb-3 w-full rounded-sm border border-borde-fuerte bg-papel px-2.5 py-1.5 text-sm text-tinta focus:outline-2 focus:outline-azul"
      />
      <div className="grid gap-x-4 sm:grid-cols-3">
        <SelectField label="Formato de los importes" value={decimal} onChange={(e) => { setDecimal(e.target.value); setReview(null); }} options={DECIMALS} />
      </div>
      <Button variant="primary" onClick={check}>Revisar extracto</Button>
      <Button className="ml-2" onClick={onCancel}>Cerrar</Button>

      {error ? <div className="mt-3"><Notice kind="error">{error}</Notice></div> : null}
      {send.error ? <div className="mt-3"><Notice kind="error">{errorMessage(send.error)}</Notice></div> : null}
      {outcome ? <div className="mt-3"><Notice kind="success">Se cargaron {outcome.created} líneas nuevas{outcome.skipped ? ` y se saltaron ${outcome.skipped} que ya estaban` : ''}.</Notice></div> : null}
      {review ? (
        <div className="mt-4">
          {review.missing.length ? (
            <Notice kind="error" title="Faltan columnas">El archivo no trae: {review.missing.join(', ')}.</Notice>
          ) : (
            <>
              <p className="mb-2 text-sm text-tinta">
                {review.lines.length} {review.lines.length === 1 ? 'línea lista' : 'líneas listas'}{review.errors.length ? ` y ${review.errors.length} con problemas, que se omiten` : ''}.
              </p>
              {review.errors.length ? (
                <DataTable
                  caption="Filas con problemas"
                  columns={[{ key: 'line', title: 'Fila', align: 'right', render: (r) => r.line }, { key: 'message', title: 'Problema', render: (r) => r.message }]}
                  rows={review.errors.slice(0, SHOWN)}
                  rowKey={(r) => r.line}
                />
              ) : null}
              {review.lines.length ? (
                <div className="mt-3">
                  <Button variant="primary" busy={send.busy} onClick={() => send.run()}>
                    Cargar {review.lines.length} {review.lines.length === 1 ? 'línea' : 'líneas'}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}

function Candidates({ base, line, currency, manage, onMatched }) {
  const found = useLoad(() => api.get(`${base}/bank/lines/${line._id}/candidates`), [base, line._id]);
  const match = useSubmit(async (c) => {
    await api.post(`${base}/bank/matches`, { bankLineId: line._id, journalId: c.journalId, lineIndex: c.lineIndex });
    onMatched();
  });
  const items = found.data?.items ?? [];
  const columns = [
    { key: 'date', title: 'Fecha', nowrap: true, render: (c) => formatDay(c.date) },
    { key: 'document', title: 'Asiento', nowrap: true, render: (c) => c.document },
    { key: 'description', title: 'Detalle', render: (c) => c.description },
    { key: 'amount', title: `Importe (${currency})`, align: 'right', render: (c) => formatAmount(c.amount, currency) },
    { key: 'action', title: 'Acción', render: (c) => (manage ? <TextButton onClick={() => match.run(c)}>Conciliar con este</TextButton> : null) },
  ];
  return (
    <div className="my-2 max-w-4xl border-t border-borde pt-2">
      <h3 className="mb-2 font-semibold text-tinta">Líneas del libro con el mismo importe, a ±10 días</h3>
      {match.error ? <Notice kind="error">{errorMessage(match.error)}</Notice> : null}
      {found.error ? <Notice kind="error">{errorMessage(found.error)}</Notice> : null}
      {found.data ? <DataTable caption="Candidatas del libro" columns={columns} rows={items} rowKey={(c) => `${c.journalId}-${c.lineIndex}`} empty="No hay ninguna en el libro. Si el banco cobró algo que no tienes registrado, contabilízalo desde la línea del extracto." /> : null}
    </div>
  );
}

function BookForm({ base, line, accounts, onDone, onCancel }) {
  const [counter, setCounter] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState(null);
  const submit = useSubmit(async () => {
    setError(null);
    if (!counter.trim()) return setError('Elige la cuenta contra la que se contabiliza.');
    await api.post(`${base}/bank/lines/${line._id}/book`, { counterAccount: counter.trim(), ...(description.trim() ? { description: description.trim() } : {}) });
    return onDone();
  });
  const name = accounts.find((a) => a.code === counter.trim())?.name;
  return (
    <form
      className="my-2 max-w-3xl border-t border-borde pt-2"
      onSubmit={(e) => {
        e.preventDefault();
        submit.run();
      }}
    >
      <h3 className="mb-2 font-semibold text-tinta">Contabilizar «{line.description}»</h3>
      <p className="mb-2 text-sm text-tinta">Crea el asiento CB en la fecha del extracto: {line.amount < 0 ? 'sale del banco contra la cuenta que elijas' : 'entra al banco contra la cuenta que elijas'}, y deja la línea conciliada.</p>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {submit.error ? <Notice kind="error">{errorMessage(submit.error)}</Notice> : null}
      <div className="grid gap-x-4 sm:grid-cols-2">
        <TextField label={line.amount < 0 ? 'Cuenta del gasto o del pasivo' : 'Cuenta del ingreso o del pasivo'} list="cuentas-contrapartida" value={counter} onChange={(e) => setCounter(e.target.value)} hint={name ?? 'Código de la cuenta, por ejemplo 530505.'} />
        <TextField label="Descripción (opcional)" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} />
      </div>
      <Button type="submit" variant="primary" busy={submit.busy}>Contabilizar y conciliar</Button>
      <Button className="ml-2" onClick={onCancel}>Cancelar</Button>
    </form>
  );
}

function LinesView({ base, account, currency, manage, accounts }) {
  const [range, setRange] = useState(() => monthRange(today()));
  const [status, setStatus] = useState('all');
  const [importing, setImporting] = useState(false);
  const [open, setOpen] = useState(null); // { id, mode: 'candidates' | 'book' }
  const [notice, setNotice] = useState(null);
  const list = useLoad(() => api.get(`${base}/bank/lines?${new URLSearchParams({ account, currency, from: range.from, to: range.to, status })}`), [base, account, currency, range.from, range.to, status]);
  const refresh = () => {
    setOpen(null);
    list.reload();
  };
  const auto = useSubmit(async () => {
    const r = await api.post(`${base}/bank/matches/auto`, { account, currency });
    setNotice(`Se concilió ${r.matched} ${r.matched === 1 ? 'línea' : 'líneas'}. ${r.ambiguous ? `${r.ambiguous} tienen más de una candidata: elige tú. ` : ''}${r.unmatched - r.ambiguous > 0 ? `${r.unmatched - r.ambiguous} no tienen candidata en el libro.` : ''}`);
    refresh();
  });
  const undo = useSubmit(async (matchId) => {
    await api.delete(`${base}/bank/matches/${matchId}`);
    refresh();
  });
  const remove = useSubmit(async (id) => {
    await api.delete(`${base}/bank/lines/${id}`);
    refresh();
  });
  const items = list.data?.items ?? [];

  const columns = [
    { key: 'date', title: 'Fecha', nowrap: true, render: (l) => formatDay(l.date) },
    { key: 'description', title: 'Detalle', render: (l) => (l.reference ? `${l.description} · ${l.reference}` : l.description) },
    { key: 'amount', title: `Importe (${currency})`, align: 'right', render: (l) => formatAmount(l.amount, currency) },
    { key: 'status', title: 'Estado', render: (l) => (l.status === 'matched' ? `Conciliada con ${l.match.document ?? 'el libro'}` : 'Sin conciliar') },
    {
      key: 'actions',
      title: 'Acciones',
      render: (l) => {
        if (!manage) return null;
        if (l.status === 'matched') return <TextButton danger onClick={() => undo.run(l.match._id)}>Deshacer</TextButton>;
        return (
          <span className="flex flex-wrap gap-3">
            <TextButton onClick={() => setOpen(open?.id === l._id && open.mode === 'candidates' ? null : { id: l._id, mode: 'candidates' })}>Buscar en el libro</TextButton>
            <TextButton onClick={() => setOpen(open?.id === l._id && open.mode === 'book' ? null : { id: l._id, mode: 'book' })}>Contabilizar</TextButton>
            <TextButton danger onClick={() => remove.run(l._id)}>Quitar</TextButton>
          </span>
        );
      },
    },
  ];

  return (
    <>
      {importing ? <ImportPanel base={base} account={account} currency={currency} onDone={() => list.reload()} onCancel={() => setImporting(false)} /> : null}
      <div className="grid gap-x-4 sm:grid-cols-4">
        <TextField label="Desde" type="date" value={range.from} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} />
        <TextField label="Hasta" type="date" value={range.to} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} />
        <SelectField label="Estado" value={status} onChange={(e) => setStatus(e.target.value)} options={STATUS} />
      </div>
      {manage ? (
        <div className="mb-4 flex flex-wrap gap-2">
          {!importing ? <Button onClick={() => setImporting(true)}>Cargar extracto</Button> : null}
          <Button busy={auto.busy} onClick={() => auto.run()}>Conciliar automáticamente</Button>
        </div>
      ) : null}
      {notice ? <Notice kind="success">{notice}</Notice> : null}
      {[auto, undo, remove].map((s, i) => (s.error ? <Notice key={i} kind="error">{errorMessage(s.error)}</Notice> : null))}
      {list.error ? <Notice kind="error">{errorMessage(list.error)}</Notice> : null}
      {list.data ? (
        <DataTable
          caption="Extracto bancario"
          columns={columns}
          rows={items}
          rowKey={(l) => l._id}
          empty="No hay líneas del extracto en este rango. Carga el extracto del banco."
          expandedRow={(l) => {
            if (open?.id !== l._id) return null;
            return open.mode === 'candidates' ? (
              <Candidates base={base} line={l} currency={currency} manage={manage} onMatched={refresh} />
            ) : (
              <BookForm base={base} line={l} accounts={accounts} onDone={refresh} onCancel={() => setOpen(null)} />
            );
          }}
        />
      ) : null}
    </>
  );
}

function SummaryView({ base, account, currency, manage }) {
  const [asOf, setAsOf] = useState(today());
  const [balanceText, setBalanceText] = useState('');
  const [result, setResult] = useState(null);
  const [errors, setErrors] = useState([]);
  const [notice, setNotice] = useState(null);
  const [reasonFor, setReasonFor] = useState(null);
  const [reason, setReason] = useState('');
  const history = useLoad(() => api.get(`${base}/bank/reconciliations?${new URLSearchParams({ account, currency })}`), [base, account, currency]);
  const money = (v) => formatAmount(v, currency);

  const load = async () => {
    const balance = parseSignedAmount(balanceText, currency);
    if (balanceText.trim() === '' || balance === null) {
      setErrors(['Escribe el saldo final del extracto a esa fecha, por ejemplo 1.250.000,00 (con signo si está sobregirado).']);
      return;
    }
    setErrors([]);
    setResult(await api.get(`${base}/bank/reconciliation?${new URLSearchParams({ account, currency, asOf, statementBalance: String(balance) })}`));
  };
  const run = useSubmit(load);
  const close = useSubmit(async () => {
    const closed = await api.post(`${base}/bank/reconciliations`, { account, currency, asOf, statementBalance: result.statementBalance });
    setNotice(`Conciliación cerrada al ${formatDay(closed.asOf)}.`);
    history.reload();
    await load();
  });
  const reopen = useSubmit(async (id) => {
    await api.post(`${base}/bank/reconciliations/${id}/reopen`);
    setNotice('Conciliación reabierta.');
    history.reload();
    if (result) await load();
  });
  const manual = useSubmit(async (item) => {
    if (!reason.trim()) throw new Error('Escribe la razón.');
    await api.post(`${base}/bank/matches/manual`, { account, currency, journalId: item.journalId, lineIndex: item.lineIndex, reason: reason.trim() });
    setReasonFor(null);
    setReason('');
    await load();
  });

  const bookColumns = [
    { key: 'date', title: 'Fecha', nowrap: true, render: (b) => formatDay(b.date) },
    { key: 'document', title: 'Asiento', nowrap: true, render: (b) => b.document },
    { key: 'description', title: 'Detalle', render: (b) => b.description },
    { key: 'amount', title: `Importe (${currency})`, align: 'right', render: (b) => money(b.amount) },
    {
      key: 'action',
      title: 'Acción',
      render: (b) =>
        manage ? (
          reasonFor === `${b.journalId}-${b.lineIndex}` ? (
            <span className="flex flex-wrap items-center gap-2">
              <input aria-label="Razón" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} className="w-48 rounded-sm border border-borde-fuerte bg-papel px-2 py-1 text-sm text-tinta focus:outline-2 focus:outline-azul" />
              <TextButton onClick={() => manual.run(b)}>Marcar</TextButton>
              <TextButton onClick={() => setReasonFor(null)}>Cancelar</TextButton>
            </span>
          ) : (
            <TextButton onClick={() => { setReasonFor(`${b.journalId}-${b.lineIndex}`); setReason('Saldo inicial'); }}>Marcar como conciliada</TextButton>
          )
        ) : null,
    },
  ];
  const bankColumns = [
    { key: 'date', title: 'Fecha', nowrap: true, render: (l) => formatDay(l.date) },
    { key: 'description', title: 'Detalle', render: (l) => l.description },
    { key: 'amount', title: `Importe (${currency})`, align: 'right', render: (l) => money(l.amount) },
  ];
  const historyColumns = [
    { key: 'asOf', title: 'Conciliada al', nowrap: true, render: (r) => formatDay(r.asOf) },
    { key: 'statement', title: 'Saldo del extracto', align: 'right', render: (r) => money(r.statementBalance) },
    { key: 'book', title: 'Saldo del libro', align: 'right', render: (r) => money(r.bookBalance) },
    { key: 'status', title: 'Estado', render: (r) => (r.status === 'closed' ? 'Cerrada' : 'Reabierta') },
    {
      key: 'action',
      title: 'Acción',
      render: (r) => (manage && r.status === 'closed' && r._id === history.data?.items.find((x) => x.status === 'closed')?._id ? <TextButton danger onClick={() => reopen.run(r._id)}>Reabrir</TextButton> : null),
    },
  ];

  return (
    <>
      <p className="mb-4 text-sm text-tinta">
        Escribe el saldo final que dice el extracto a una fecha. El libro y el extracto cuadran cuando «extracto más lo pendiente del libro» es igual a «libro más lo pendiente del banco».
      </p>
      <div className="grid gap-x-4 sm:grid-cols-4">
        <TextField label="Conciliar al" type="date" value={asOf} onChange={(e) => { setAsOf(e.target.value); setResult(null); }} />
        <TextField label={`Saldo del extracto (${currency})`} value={balanceText} onChange={(e) => { setBalanceText(e.target.value); setResult(null); }} inputMode="decimal" />
      </div>
      {errors.map((m) => <Notice key={m} kind="error">{m}</Notice>)}
      {run.error ? <Notice kind="error">{errorMessage(run.error)}</Notice> : null}
      <Button variant="primary" busy={run.busy} onClick={() => run.run()}>Ver conciliación</Button>
      {notice ? <div className="mt-3"><Notice kind="success">{notice}</Notice></div> : null}
      {[close, reopen, manual].map((s, i) => (s.error ? <div key={i} className="mt-3"><Notice kind="error">{errorMessage(s.error)}</Notice></div> : null))}

      {result ? (
        <div className="mt-6">
          <dl className="mb-4 grid max-w-xl grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm text-tinta">
            <dt>Saldo del extracto</dt>
            <dd className="text-right tabular-nums">{money(result.statementBalance)}</dd>
            <dt>Más: pendiente del libro (en tránsito)</dt>
            <dd className="text-right tabular-nums">{money(result.unmatchedBook.net)}</dd>
            <dt className="font-semibold">Saldo del extracto ajustado</dt>
            <dd className="text-right font-semibold tabular-nums">{money(result.adjustedBank)}</dd>
            <dt>Saldo del libro</dt>
            <dd className="text-right tabular-nums">{money(result.bookBalance)}</dd>
            <dt>Más: pendiente del banco (sin contabilizar)</dt>
            <dd className="text-right tabular-nums">{money(result.unmatchedBank.net)}</dd>
            <dt className="font-semibold">Saldo del libro ajustado</dt>
            <dd className="text-right font-semibold tabular-nums">{money(result.adjustedBook)}</dd>
          </dl>
          <p className={`mb-3 text-sm font-semibold ${result.difference === 0 ? 'text-verde' : 'text-rojo'}`}>{differenceText(result.difference, money)}</p>
          {result.lastClosedAsOf ? <p className="mb-3 text-sm text-tinta">Cerrada hasta el {formatDay(result.lastClosedAsOf)}.</p> : null}
          {manage && result.difference === 0 ? (
            <div className="mb-4">
              <Button variant="primary" busy={close.busy} onClick={() => close.run()}>Cerrar la conciliación</Button>
              <p className="mt-1 text-sm text-tinta-segundo">Lo cerrado no se altera: no se cargan, quitan ni concilian líneas de esa fecha o anteriores.</p>
            </div>
          ) : null}

          <h2 className="mb-2 mt-6 text-lg font-semibold text-tinta">Pendiente del libro ({result.unmatchedBook.count})</h2>
          <p className="mb-2 text-sm text-tinta">Asientos en bancos que el extracto aún no trae: consignaciones y cheques en tránsito. Si es el saldo con el que empezaste, márcalo como conciliado.</p>
          <DataTable caption="Pendiente del libro" columns={bookColumns} rows={result.unmatchedBook.items} rowKey={(b) => `${b.journalId}-${b.lineIndex}`} empty="No hay nada pendiente en el libro." />
          {result.unmatchedBook.truncated ? <p className="mt-1 text-sm text-tinta">Se muestran las primeras {result.unmatchedBook.items.length}; el total cuenta todas.</p> : null}

          <h2 className="mb-2 mt-6 text-lg font-semibold text-tinta">Pendiente del banco ({result.unmatchedBank.count})</h2>
          <p className="mb-2 text-sm text-tinta">Líneas del extracto que el libro no tiene: comisiones, intereses, impuestos. Contabilízalas desde la pestaña Extracto.</p>
          <DataTable caption="Pendiente del banco" columns={bankColumns} rows={result.unmatchedBank.items} rowKey={(l) => l._id} empty="No hay nada pendiente en el banco." />
        </div>
      ) : null}

      <h2 className="mb-2 mt-8 text-lg font-semibold text-tinta">Conciliaciones cerradas</h2>
      {history.data ? <DataTable caption="Conciliaciones cerradas" columns={historyColumns} rows={history.data.items} rowKey={(r) => r._id} empty="Todavía no se ha cerrado ninguna." /> : null}
    </>
  );
}

export function BankScreen() {
  const base = useTenantApi();
  const { tenant, can } = useSession();
  const manage = can('bank:manage');
  const all = useLoad(() => api.get(`${base}/accounts?activeOnly=true`), [base]);
  const postable = useMemo(() => (all.data?.items ?? []).filter((a) => a.postable), [all.data]);
  const assets = postable.filter((a) => a.type === 'asset');
  const [account, setAccount] = useState('');
  const [view, setView] = useState('lines');
  const currency = tenant.currency;

  return (
    <>
      <PageHeader title="Conciliación bancaria" />
      <p className="mb-4 text-sm text-tinta">Compara el extracto del banco con lo que dice el libro de la cuenta de bancos: concilia línea a línea, contabiliza lo que el banco cobró y el libro no tiene, y cierra cada mes cuando la diferencia es cero.</p>
      <datalist id="cuentas-contrapartida">
        {postable.map((a) => (
          <option key={a.code} value={a.code}>{a.name}</option>
        ))}
      </datalist>
      <div className="grid gap-x-4 sm:grid-cols-2">
        <SelectField
          label="Cuenta de bancos"
          value={account}
          onChange={(e) => setAccount(e.target.value)}
          options={[{ value: '', label: 'Elige la cuenta' }, ...assets.map((a) => ({ value: a.code, label: `${a.code} · ${a.name}` }))]}
        />
      </div>
      {account ? (
        <>
          <div className="mb-4 flex gap-4 border-b border-borde pb-2" role="tablist" aria-label="Vista">
            {[['lines', 'Extracto'], ['summary', 'Conciliación y cierre']].map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={view === key}
                onClick={() => setView(key)}
                className={`pb-1 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-azul ${view === key ? 'border-b-2 border-azul text-azul' : 'text-tinta'}`}
              >
                {label}
              </button>
            ))}
          </div>
          {view === 'lines' ? <LinesView key={account} base={base} account={account} currency={currency} manage={manage} accounts={postable} /> : <SummaryView key={account} base={base} account={account} currency={currency} manage={manage} />}
        </>
      ) : (
        <p className="text-sm text-tinta">Elige la cuenta de bancos para empezar.</p>
      )}
    </>
  );
}
