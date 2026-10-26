import { useMemo, useState } from 'react';
import { useCostCenters } from '../components/CostCenterSelect.jsx';
import { ViewButton, Button, DataTable, Notice, PageHeader, TextField, errorMessage, useLoad, useSubmit } from '../components/ui.jsx';
import { api, newIdempotencyKey } from '../lib/api.js';
import { CsvError, parseCsv } from '../lib/csv.js';
import { formatAmount } from '../lib/money.js';
import { OPENING_COLUMNS, buildOpeningEntry, documentsIn, mapOpening } from '../lib/openingBalances.js';
import { Link } from '../lib/router.jsx';
import { useSession, useTenantApi } from '../lib/session.jsx';

const SHOWN = 30;
const COLUMN_HELP = [
  ['cuenta', 'Sí', 'Código de la cuenta (tiene que admitir asientos).'],
  ['debito, credito', 'Al menos una', 'Saldo al débito o al crédito, con coma decimal: 1.250.000,50. Una línea lleva uno solo.'],
  ['tercero', 'No', 'Documento del cliente o proveedor (NIT con o sin dígito). Tiene que existir: impórtalo antes en «Importar».'],
  ['centro', 'No', 'Código de un centro de costo activo.'],
  ['detalle', 'No', 'Texto de la línea.'],
];

const today = () => new Date().toISOString().slice(0, 10);

/** Busca cada documento en el servidor, de a pocos a la vez, y devuelve documento → id del tercero. */
async function resolveParties(base, documents) {
  const found = new Map();
  const queue = [...documents];
  const worker = async () => {
    for (let doc = queue.shift(); doc !== undefined; doc = queue.shift()) {
      const page = await api.get(`${base}/parties?search=${encodeURIComponent(doc)}&limit=10`);
      const hit = page.items.find((p) => String(p.taxId).toUpperCase() === doc);
      if (hit) found.set(doc, hit._id);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return found;
}

/**
 * Saldos iniciales: un asiento con lo que la empresa traía de su sistema anterior (balance de prueba por cuenta, y por
 * tercero o centro de costo cuando el archivo lo trae). Se revisa sin guardar y solo se registra si cuadra.
 */
export function OpeningBalancesScreen() {
  const base = useTenantApi();
  const { tenant } = useSession();
  const currency = tenant.currency;
  const accounts = useLoad(() => api.get(`${base}/accounts?activeOnly=true`), [base]);
  const centers = useCostCenters(base);
  const [date, setDate] = useState(today());
  const [text, setText] = useState('');
  const [review, setReview] = useState(null);
  const [error, setError] = useState(null);
  const [created, setCreated] = useState(null);
  const [key, setKey] = useState(newIdempotencyKey);

  const accountsByCode = useMemo(() => new Map((accounts.data?.items ?? []).filter((a) => a.postable).map((a) => [a.code, a])), [accounts.data]);
  const centerCodes = useMemo(() => new Set(centers.map((c) => c.code)), [centers]);

  const reset = () => {
    setReview(null);
    setError(null);
    setCreated(null);
  };

  const check = useSubmit(async () => {
    reset();
    try {
      const { header, rows } = parseCsv(text);
      const mapped = mapOpening(header, rows);
      if (mapped.missing.length) {
        setReview({ missing: mapped.missing, unknown: mapped.unknown });
        return;
      }
      const partyByDocument = await resolveParties(base, documentsIn(mapped.objects));
      setKey(newIdempotencyKey());
      setReview({ missing: [], unknown: mapped.unknown, entry: buildOpeningEntry(mapped.objects, { currency, accountsByCode, partyByDocument, centerCodes }) });
    } catch (e) {
      setError(e instanceof CsvError ? e.message : errorMessage(e));
    }
  });

  const entry = review?.entry;
  const ready = entry && entry.errors.length === 0 && entry.difference === 0;

  const post = useSubmit(async () => {
    const res = await api.post(
      `${base}/journals`,
      { docType: 'CC', date: `${date}T12:00:00Z`, currency, description: 'Saldos iniciales', lines: entry.lines },
      { 'idempotency-key': key },
    );
    setCreated(res.journal);
  });

  const load = async (file) => {
    reset();
    if (file) setText(await file.text());
  };

  return (
    <>
      <PageHeader title="Saldos iniciales" />
      <p className="mb-4 text-sm text-tinta">
        Carga los saldos con que empieza la empresa, desde el balance de prueba de tu sistema anterior (por ejemplo, un Excel guardado como CSV). Se registran como un solo asiento fechado el día de corte, que tiene que cuadrar. Primero se revisa todo sin guardar.
      </p>
      <Notice kind="info" title="Qué entra y qué no">
        Los saldos por tercero quedan en los estados de cuenta y en el libro auxiliar del tercero. Las facturas y compras pendientes una por una (con vencimientos) no se cargan aquí, por lo que no aparecen en la cartera por edades; los artículos con existencias entran con un ajuste de inventario.
      </Notice>

      <h2 className="mb-2 mt-6 text-lg font-semibold text-tinta">Columnas del archivo</h2>
      <p className="mb-2 text-sm text-tinta">La primera fila es el encabezado, con estos nombres (sin importar mayúsculas ni tildes). Admite coma, punto y coma o tabulador.</p>
      <DataTable
        caption="Columnas del archivo de saldos iniciales"
        columns={[
          { key: 'n', title: 'Columna', render: (c) => c[0] },
          { key: 'r', title: 'Obligatoria', nowrap: true, render: (c) => c[1] },
          { key: 'w', title: 'Qué lleva', render: (c) => c[2] },
        ]}
        rows={COLUMN_HELP}
        rowKey={(c) => c[0]}
        exportName={false}
      />
      <p className="mt-2 text-sm text-tinta">También se reconocen: {Object.entries(OPENING_COLUMNS).map(([k, a]) => `${k} (${a.slice(0, 2).join(', ')})`).join('; ')}.</p>

      <h2 className="mb-2 mt-8 text-lg font-semibold text-tinta">Archivo</h2>
      <div className="grid gap-x-4 sm:grid-cols-3">
        <TextField label="Fecha de corte" type="date" value={date} onChange={(e) => { setDate(e.target.value); setCreated(null); }} hint="Normalmente el último día del período anterior al primero que llevarás en Lulubiz." />
      </div>
      <div className="mb-3">
        <label htmlFor="archivo-saldos" className="mb-1 block text-sm font-semibold text-tinta">Archivo CSV</label>
        <input id="archivo-saldos" type="file" accept=".csv,.txt,text/csv" onChange={(e) => load(e.target.files?.[0])} className="text-sm text-tinta" />
      </div>
      <label htmlFor="contenido-saldos" className="mb-1 block text-sm font-semibold text-tinta">O pega el contenido</label>
      <textarea
        id="contenido-saldos"
        value={text}
        onChange={(e) => { setText(e.target.value); reset(); }}
        rows={6}
        className="mb-3 w-full rounded-sm border border-borde-fuerte bg-papel px-2.5 py-1.5 text-sm text-tinta focus:outline-2 focus:outline-azul"
      />
      <ViewButton busy={check.busy} disabled={!accounts.data} onClick={() => check.run()}>Revisar archivo</ViewButton>

      {error ? <div className="mt-4"><Notice kind="error">{error}</Notice></div> : null}

      {review ? (
        <div className="mt-6">
          <h2 className="mb-2 text-lg font-semibold text-tinta">Revisión</h2>
          {review.missing.length ? (
            <Notice kind="error" title="Faltan columnas obligatorias">El archivo no trae: {review.missing.join(', ')}. Agrégalas al encabezado y vuelve a revisar.</Notice>
          ) : (
            <>
              {review.unknown.length ? <Notice kind="info">Estas columnas no se reconocen y se ignoran: {review.unknown.join(', ')}.</Notice> : null}
              <dl className="mb-4 grid max-w-sm grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm text-tinta">
                <dt>Líneas con importe</dt>
                <dd className="text-right tabular-nums">{entry.lines.length}</dd>
                <dt>Total débitos</dt>
                <dd className="text-right tabular-nums">{formatAmount(entry.debits, currency)}</dd>
                <dt>Total créditos</dt>
                <dd className="text-right tabular-nums">{formatAmount(entry.credits, currency)}</dd>
                <dt className="font-semibold">Diferencia</dt>
                <dd className="text-right font-semibold tabular-nums">{formatAmount(entry.difference, currency)}</dd>
              </dl>
              {entry.errors.length ? (
                <>
                  <Notice kind="error">El archivo tiene {entry.errors.length} {entry.errors.length === 1 ? 'problema' : 'problemas'}. Corrígelos y revisa de nuevo: el asiento se registra completo o no se registra.</Notice>
                  <DataTable
                    caption="Problemas del archivo de saldos iniciales"
                    columns={[{ key: 'line', title: 'Línea', align: 'right', render: (r) => r.line || '—' }, { key: 'error', title: 'Problema', render: (r) => r.error }]}
                    rows={entry.errors.slice(0, SHOWN)}
                    rowKey={(r) => `${r.line}-${r.error}`}
                    exportName={false}
                  />
                  {entry.errors.length > SHOWN ? <p className="mt-2 text-sm text-tinta">Se muestran los primeros {SHOWN}.</p> : null}
                </>
              ) : entry.difference !== 0 ? (
                <Notice kind="error">El asiento no cuadra: los débitos y los créditos deben sumar lo mismo. Falta {formatAmount(Math.abs(entry.difference), currency)} al {entry.difference > 0 ? 'crédito' : 'débito'}.</Notice>
              ) : null}
              {ready && !created ? (
                <div className="mt-4">
                  {post.error ? <Notice kind="error">{errorMessage(post.error)}</Notice> : null}
                  <Button variant="primary" busy={post.busy} onClick={() => post.run()}>Registrar saldos iniciales</Button>
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {created ? (
        <div className="mt-6">
          <Notice kind="success" title="Saldos iniciales registrados">
            Asiento {created.docType}-{created.number} con {created.lines?.length ?? entry.lines.length} líneas. <Link href="/app/asientos">Ver asientos</Link>
          </Notice>
        </div>
      ) : null}
    </>
  );
}
