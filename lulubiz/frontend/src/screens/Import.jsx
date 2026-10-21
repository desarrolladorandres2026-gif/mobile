import { useState } from 'react';
import { Button, DataTable, Notice, PageHeader, SelectField, errorMessage, useSubmit } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { CsvError, MAX_CSV_ROWS, parseCsv } from '../lib/csv.js';
import { prepare, runImport } from '../lib/importer.js';
import { Link } from '../lib/router.jsx';
import { useSession, useTenantApi } from '../lib/session.jsx';

const KINDS = {
  parties: {
    label: 'Clientes y proveedores',
    path: 'parties',
    success: 'terceros',
    columns: [
      ['nombre', 'Sí', 'Nombre o razón social.'],
      ['documento', 'Sí', 'Número de documento. Un NIT puede traer el dígito con guion: 890.903.938-8.'],
      ['tipo_documento', 'No', 'NIT, CC, CE, TI, PASSPORT… Si falta, NIT.'],
      ['digito', 'No', 'Dígito de verificación del NIT. Si falta, se calcula.'],
      ['rol', 'No', 'cliente, proveedor o ambos. Si falta, cliente.'],
      ['correo, telefono', 'No', 'Datos de contacto.'],
      ['direccion, ciudad, departamento', 'No', 'Dirección.'],
    ],
  },
  items: {
    label: 'Artículos',
    path: 'items',
    success: 'artículos',
    columns: [
      ['codigo', 'Sí', 'Código del artículo: letras, números, punto y guion.'],
      ['nombre', 'Sí', 'Nombre.'],
      ['tipo', 'No', 'bien o servicio. Si falta, bien.'],
      ['unidad', 'No', 'UND, KG, CAJA… Si falta, UND.'],
      ['cuenta_inventario, cuenta_costo', 'Para bienes', 'Códigos de las cuentas de inventario y de costo de ventas. Tienen que existir en el plan de cuentas.'],
      ['cuenta_ingreso', 'No', 'Cuenta de ingresos del artículo.'],
      ['precio', 'No', 'Precio de venta, con coma decimal: 1.250,50.'],
      ['iva', 'No', 'Porcentaje, por ejemplo 19.'],
      ['minimo', 'No', 'Mínimo de existencias: avisa cuando hay menos.'],
    ],
  },
};
const SHOWN = 30;

export function ImportScreen() {
  const base = useTenantApi();
  const { tenant, can } = useSession();
  const kinds = Object.keys(KINDS).filter((k) => (k === 'items' ? can('inventory:manage') : can('parties:manage')));
  const [kind, setKind] = useState(kinds[0] ?? 'parties');
  const [text, setText] = useState('');
  const [review, setReview] = useState(null);
  const [error, setError] = useState(null);
  const [progress, setProgress] = useState(null);
  const [outcome, setOutcome] = useState(null);
  const config = KINDS[kind];

  const reset = () => {
    setReview(null);
    setError(null);
    setProgress(null);
    setOutcome(null);
  };

  const load = async (file) => {
    reset();
    if (!file) return;
    setText(await file.text());
  };

  const check = () => {
    reset();
    try {
      const { header, rows } = parseCsv(text);
      setReview(prepare(kind, header, rows, { currency: tenant.currency, defaultType: tenant.country === 'CO' ? 'NIT' : 'TAX_ID' }));
    } catch (e) {
      setError(e instanceof CsvError ? e.message : 'No se pudo leer el archivo.');
    }
  };

  const valid = review?.results.filter((r) => r.body) ?? [];
  const problems = review?.results.filter((r) => !r.body) ?? [];

  const run = useSubmit(async () => {
    setOutcome(null);
    const result = await runImport(valid, (body) => api.post(`${base}/${config.path}`, body), (done, total) => setProgress({ done, total }));
    setProgress(null);
    setOutcome(result);
  });

  const columnTable = [
    { key: 'name', title: 'Columna', render: (c) => c[0] },
    { key: 'req', title: 'Obligatoria', nowrap: true, render: (c) => c[1] },
    { key: 'what', title: 'Qué lleva', render: (c) => c[2] },
  ];
  const problemTable = [
    { key: 'line', title: 'Línea', align: 'right', render: (r) => r.line },
    { key: 'error', title: 'Problema', render: (r) => r.error },
  ];

  return (
    <>
      <PageHeader title="Importar" />
      <p className="mb-4 text-sm text-tinta">Carga tus clientes, proveedores o artículos desde un archivo CSV (se exporta desde Excel o desde tu sistema anterior). Primero se revisa todo sin guardar nada; después eliges si importar. Repetir una importación no duplica: lo que ya existe se omite.</p>
      <div className="mb-4 grid gap-x-4 sm:grid-cols-3">
        <SelectField label="Qué vas a importar" value={kind} onChange={(e) => { setKind(e.target.value); reset(); }} options={kinds.map((k) => ({ value: k, label: KINDS[k].label }))} />
      </div>

      <h2 className="mb-2 text-lg font-semibold text-tinta">Columnas del archivo</h2>
      <p className="mb-2 text-sm text-tinta">La primera fila es el encabezado, con estos nombres (sin importar mayúsculas ni tildes). Admite coma, punto y coma o tabulador como separador y hasta {MAX_CSV_ROWS} filas por vez.</p>
      <DataTable caption={`Columnas para importar ${config.label.toLowerCase()}`} columns={columnTable} rows={config.columns} rowKey={(c) => c[0]} />

      <h2 className="mb-2 mt-8 text-lg font-semibold text-tinta">Archivo</h2>
      <div className="mb-3">
        <label htmlFor="archivo-csv" className="mb-1 block text-sm font-semibold text-tinta">Archivo CSV</label>
        <input id="archivo-csv" type="file" accept=".csv,.txt,text/csv" onChange={(e) => load(e.target.files?.[0])} className="text-sm text-tinta" />
      </div>
      <label htmlFor="contenido-csv" className="mb-1 block text-sm font-semibold text-tinta">O pega el contenido</label>
      <textarea
        id="contenido-csv"
        value={text}
        onChange={(e) => { setText(e.target.value); reset(); }}
        rows={6}
        className="mb-3 w-full rounded-sm border border-borde-fuerte bg-papel px-2.5 py-1.5 text-sm text-tinta focus:outline-2 focus:outline-azul"
      />
      <Button variant="primary" onClick={check}>Revisar archivo</Button>

      {error ? <div className="mt-4"><Notice kind="error">{error}</Notice></div> : null}

      {review ? (
        <div className="mt-6">
          <h2 className="mb-2 text-lg font-semibold text-tinta">Revisión</h2>
          {review.missing.length ? (
            <Notice kind="error" title="Faltan columnas obligatorias">
              El archivo no trae: {review.missing.join(', ')}. Agrégalas al encabezado y vuelve a revisar.
            </Notice>
          ) : (
            <>
              {review.unknown.length ? <Notice kind="info">Estas columnas no se reconocen y se ignoran: {review.unknown.join(', ')}.</Notice> : null}
              <p className="mb-3 text-sm text-tinta">
                {valid.length} {valid.length === 1 ? 'fila lista' : 'filas listas'} para importar{problems.length ? ` y ${problems.length} con problemas, que se omiten` : ''}.
              </p>
              {problems.length ? (
                <>
                  <DataTable caption="Filas con problemas" columns={problemTable} rows={problems.slice(0, SHOWN)} rowKey={(r) => r.line} />
                  {problems.length > SHOWN ? <p className="mt-2 text-sm text-tinta">Se muestran las primeras {SHOWN}. Corrige el archivo y revísalo de nuevo para ver las demás.</p> : null}
                </>
              ) : null}
              {valid.length && !outcome ? (
                <div className="mt-4">
                  <Button variant="primary" busy={run.busy} onClick={() => run.run()}>
                    {progress ? `Importando ${progress.done} de ${progress.total}…` : `Importar ${valid.length} ${valid.length === 1 ? 'fila' : 'filas'}`}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {run.error ? <div className="mt-4"><Notice kind="error">{errorMessage(run.error)}</Notice></div> : null}

      {outcome ? (
        <div className="mt-6">
          <Notice kind={outcome.failed.length ? 'error' : 'success'} title="Importación terminada">
            Se crearon {outcome.created.length} {config.success}
            {outcome.existed.length ? `, ${outcome.existed.length} ya existían` : ''}
            {outcome.failed.length ? ` y ${outcome.failed.length} fallaron` : ''}.{' '}
            <Link href={`/app/${kind === 'items' ? 'articulos' : 'terceros'}`}>Ver {config.success}</Link>
          </Notice>
          {outcome.existed.length ? (
            <DataTable
              caption="Filas que ya existían"
              columns={[{ key: 'line', title: 'Línea', align: 'right', render: (r) => r.line }, { key: 'message', title: 'Qué pasó', render: (r) => r.message }]}
              rows={outcome.existed.slice(0, SHOWN)}
              rowKey={(r) => r.line}
            />
          ) : null}
          {outcome.failed.length ? (
            <DataTable
              caption="Filas que fallaron"
              columns={[{ key: 'line', title: 'Línea', align: 'right', render: (r) => r.line }, { key: 'message', title: 'Qué pasó', render: (r) => r.message }]}
              rows={outcome.failed.slice(0, SHOWN)}
              rowKey={(r) => r.line}
            />
          ) : null}
        </div>
      ) : null}
    </>
  );
}
