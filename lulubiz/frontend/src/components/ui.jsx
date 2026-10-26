import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import { loadCompanyIdentity } from '../lib/companyIdentity.js';
import { downloadXlsx } from '../lib/exportXlsx.js';
import { Link } from '../lib/router.jsx';
import { useOptionalSession } from '../lib/session.jsx';

function ArrowIcon() {
  return (
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path
          fillRule="evenodd"
          d="M12 2.25c-5.385 0-9.75 4.365-9.75 9.75s4.365 9.75 9.75 9.75 9.75-4.365 9.75-9.75S17.385 2.25 12 2.25zm4.28 10.28a.75.75 0 000-1.06l-3-3a.75.75 0 10-1.06 1.06l1.72 1.72H8.25a.75.75 0 000 1.5h5.69l-1.72 1.72a.75.75 0 101.06 1.06l3-3z"
          clipRule="evenodd"
        />
      </svg>
  );
}

export function Button({ variant = 'secondary', busy = false, type = 'button', className = '', children, ...props }) {
  return (
    <button type={type} disabled={busy || props.disabled} className={`btn-flecha btn-flecha-${variant} ${className}`} {...props}>
      {busy ? 'Procesando…' : children}
      <ArrowIcon />
    </button>
  );
}

/** Botón de «ver», «revisar» o «consultar»: lanza una consulta o un chequeo, no guarda nada. */
export function ViewButton({ busy = false, type = 'button', className = '', children, ...props }) {
  return (
    <button type={type} disabled={busy || props.disabled} className={`ver-mas ${className}`} {...props}>
      <span className="ver-mas-circulo" aria-hidden="true">
        <span className="ver-mas-flecha" />
      </span>
      <span className="ver-mas-texto">{busy ? 'Procesando…' : children}</span>
    </button>
  );
}

/** Lo mismo que `ViewButton`, pero navega: para «Revisar», «Hacerlo ahora», «Ver…» que llevan a otra pantalla. */
export function ViewLink({ href, className = '', children, ...props }) {
  return (
    <Link href={href} className={`ver-mas no-underline! ${className}`} {...props}>
      <span className="ver-mas-circulo" aria-hidden="true">
        <span className="ver-mas-flecha" />
      </span>
      <span className="ver-mas-texto">{children}</span>
    </Link>
  );
}

const ACTION_ICONS = {
  save: (
    <>
      <path d="m19,21H5c-1.1,0-2-.9-2-2V5c0-1.1.9-2,2-2h11l5,5v11c0,1.1-.9,2-2,2Z" data-path="box" />
      <path d="M7 3L7 8L15 8" data-path="line-top" />
      <path d="M17 20L17 13L7 13L7 20" data-path="line-bottom" />
    </>
  ),
  print: (
    <>
      <path d="M6 9V2h12v7" />
      <path d="M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2" />
      <path d="M6 14h12v8H6z" data-path="paper" />
    </>
  ),
  export: (
    <>
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
      <path d="M7 10l5 5 5-5M12 15V3" data-path="arrow" />
    </>
  ),
};

/** Botón de solo icono para guardar, imprimir o exportar. `label` es obligatorio: es su nombre accesible y su tooltip. */
export function ActionButton({ kind = 'save', label, className = '', type = 'button', ...props }) {
  return (
    <button type={type} aria-label={label} title={label} className={`accion accion-${kind} print:hidden ${className}`} {...props}>
      <svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        {ACTION_ICONS[kind]}
      </svg>
    </button>
  );
}

/** Botón compacto para acciones dentro de una fila de tabla o de un aviso. Siempre visible. */
export function TextButton({ danger = false, className = '', children, ...props }) {
  return (
    <button type="button" className={`btn-flecha btn-flecha-sm btn-flecha-${danger ? 'danger' : 'secondary'} ${className}`} {...props}>
      {children}
      <ArrowIcon />
    </button>
  );
}

/** Botón de eliminar: círculo con papelera que al pasar el cursor se ensancha y muestra `children`. */
export function DeleteButton({ children = 'Quitar', className = '', ...props }) {
  return (
    <button type="button" aria-label={typeof children === 'string' ? children : undefined} data-label={children} className={`btn-eliminar ${className}`} {...props}>
      <svg viewBox="0 0 448 512" aria-hidden="true">
        <path d="M135.2 17.7L128 32H32C14.3 32 0 46.3 0 64S14.3 96 32 96H416c17.7 0 32-14.3 32-32s-14.3-32-32-32H320l-7.2-14.3C307.4 6.8 296.3 0 284.2 0H163.8c-12.1 0-23.2 6.8-28.6 17.7zM416 128H32L53.2 467c1.6 25.3 22.6 45 47.9 45H346.9c25.3 0 46.3-19.7 47.9-45L416 128z" />
      </svg>
    </button>
  );
}

const INPUT =
  'w-full rounded-full border-2 bg-papel px-3.5 py-1.5 text-sm text-tinta shadow-md transition-all duration-300 placeholder:text-tinta-segundo focus:border-azul focus:outline-none motion-reduce:transition-none';
const INPUT_BORDER = 'border-borde';

export function Field({ label, error, hint, children, htmlFor }) {
  return (
    <div className="mb-4">
      <label htmlFor={htmlFor} className="mb-1 block text-sm font-semibold text-tinta">
        {label}
      </label>
      {children}
      {hint && !error ? <p id={htmlFor ? `${htmlFor}-ayuda` : undefined} className="mt-1 text-sm text-tinta-segundo">{hint}</p> : null}
      {error ? (
        <p id={htmlFor ? `${htmlFor}-error` : undefined} role="alert" className="mt-1 text-sm font-semibold text-rojo">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function TextField({ label, error, hint, className = '', inputClassName = '', ...props }) {
  const id = useId();
  return (
    <div className={className}>
      <Field label={label} error={error} hint={hint} htmlFor={id}>
        <input
          id={id}
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={error ? `${id}-error` : hint ? `${id}-ayuda` : undefined}
          className={`${INPUT} ${error ? 'border-rojo' : INPUT_BORDER} ${inputClassName}`}
          {...props}
        />
      </Field>
    </div>
  );
}

/**
 * Barra de búsqueda: píldora gris con lupa, sombra y botón integrado.
 * Con `onSubmit` muestra el botón (Enter también lo dispara); sin él es un filtro en vivo y no hay botón.
 */
export function SearchBox({ onSubmit, buttonLabel = 'Buscar', compact = false, className = '', inputClassName = '', onKeyDown, placeholder = 'Buscar…', ...props }) {
  const inputRef = useRef(null);
  // Vacía el campo avisando a React (sirve igual si el input es controlado o no).
  const clear = () => {
    const el = inputRef.current;
    if (!el) return;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.focus();
  };
  return (
    <div
      className={`relative w-full max-w-[480px] rounded-2xl bg-papel-fondo ${compact ? 'p-1' : 'p-1.5'} shadow-md transition-all duration-150 ease-in-out focus-within:ring-2 focus-within:ring-azul hover:scale-105 hover:shadow-lg motion-reduce:transition-none motion-reduce:hover:scale-100 ${className}`}
    >
      <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-2.5">
        <svg className="size-5 text-tinta-segundo" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path fillRule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clipRule="evenodd" />
        </svg>
      </div>
      <input
        ref={inputRef}
        type="search"
        placeholder={placeholder}
        onKeyDown={(e) => {
          if (onSubmit && e.key === 'Enter') onSubmit();
          onKeyDown?.(e);
        }}
        className={`w-full rounded-lg bg-transparent ${compact ? 'py-1.5 text-sm' : 'py-2.5 text-base'} pl-8 text-tinta peer placeholder:text-tinta-segundo focus:outline-none [&::-webkit-search-cancel-button]:appearance-none ${onSubmit ? (compact ? 'pr-28' : 'pr-32') : 'pr-8'} ${inputClassName}`}
        {...props}
      />
      <button
        type="button"
        onClick={clear}
        aria-label="Borrar búsqueda"
        className={`absolute top-1/2 -translate-y-1/2 p-1 text-tinta-segundo hover:text-tinta peer-placeholder-shown:hidden focus-visible:outline-2 focus-visible:outline-azul ${onSubmit ? (compact ? 'right-[4.75rem]' : 'right-[5.75rem]') : 'right-2'}`}
      >
        <svg className="size-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
      {onSubmit ? (
        <button
          type="button"
          onClick={onSubmit}
          className={`absolute inset-y-1 right-1 rounded-xl bg-azul ${compact ? 'px-4 text-xs' : 'px-5 text-sm'} font-semibold text-white hover:bg-azul-oscuro focus:outline-none focus-visible:ring-2 focus-visible:ring-azul focus-visible:ring-offset-2`}
        >
          {buttonLabel}
        </button>
      ) : null}
    </div>
  );
}

/** Búsqueda con etiqueta y ayuda, igual que `TextField`, pero con la barra de `SearchBox`. */
export function SearchField({ label, hint, className = '', ...props }) {
  const id = useId();
  return (
    <div className={className}>
      <Field label={label} hint={hint} htmlFor={id}>
        <SearchBox id={id} aria-describedby={hint ? `${id}-ayuda` : undefined} {...props} />
      </Field>
    </div>
  );
}

export function SelectField({ label, error, hint, options, className = '', ...props }) {
  const id = useId();
  return (
    <div className={className}>
      <Field label={label} error={error} hint={hint} htmlFor={id}>
        <select id={id} aria-invalid={error ? 'true' : undefined} aria-describedby={error ? `${id}-error` : hint ? `${id}-ayuda` : undefined} className={`${INPUT} ${error ? 'border-rojo' : INPUT_BORDER}`} {...props}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>
    </div>
  );
}

/** Aviso de estado. El color acompaña a un texto que ya dice qué pasó: nunca es lo único que lo indica. */
export function Notice({ kind = 'info', title, children }) {
  const tone =
    kind === 'error'
      ? 'border-rojo bg-rojo-suave'
      : kind === 'success'
        ? 'border-verde bg-verde-suave'
        : 'border-azul bg-azul-suave';
  return (
    <div role={kind === 'error' ? 'alert' : 'status'} className={`mb-4 border-l-4 px-3 py-2 text-sm text-tinta ${tone}`}>
      {title ? <p className="font-semibold">{title}</p> : null}
      {children ? <div>{children}</div> : null}
    </div>
  );
}

export function PageHeader({ title, children }) {
  return (
    <div className="sticky top-0 z-10 -mt-5 mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-borde bg-papel pb-3 pt-5 print:static">
      <h1 className="text-xl font-semibold text-tinta">{title}</h1>
      <div className="flex flex-wrap items-center gap-2">
        {children}
        <ActionButton kind="print" label="Imprimir" onClick={() => window.print()} />
      </div>
    </div>
  );
}

const ExportInfoContext = createContext(null);

/**
 * Período y filtros del informe en pantalla: los Excel de las tablas de dentro los llevan en su encabezado y en la
 * hoja de información. `filters`: [[etiqueta, valor]]. `currency` reemplaza la moneda de la empresa si el informe
 * se pidió en otra.
 */
export function ExportInfo({ period, filters, currency, children }) {
  const value = useMemo(() => ({ period, filters, currency }), [period, filters, currency]);
  return <ExportInfoContext.Provider value={value}>{children}</ExportInfoContext.Provider>;
}

// Las columnas de acciones (botones) no tienen nada que hacer en un archivo.
const ACTION_TITLE = /^acci[oó]n(es)?$/i;

/**
 * Tabla de datos: cabeceras claras, importes alineados a la derecha, filas con separador discreto.
 * `columns`: [{ key, title, align, render?(row), type?, export? }]. `align: 'right'` para cifras.
 * Para el Excel: `type` (amount | integer | date | percent | text) afina el formato; `export: false` deja la
 * columna fuera. `rowMeta(row)` → { depth, kind: 'group' | 'total' } da jerarquía y totales.
 */
export function DataTable({ columns, rows, rowKey, empty = 'No hay registros.', caption, expandedRow, exportName, rowMeta }) {
  const tableRef = useRef(null);
  const exportInfo = useContext(ExportInfoContext);
  const session = useOptionalSession();
  const [exporting, setExporting] = useState(false);
  // Toda tabla con título se puede exportar; `exportName={false}` lo evita.
  const fileName = exportName === false ? null : (exportName ?? (typeof caption === 'string' ? caption : null));
  const exportTable = async () => {
    setExporting(true);
    try {
      const tenant = session?.tenant ?? null;
      const company = await loadCompanyIdentity(tenant ? `/v1/tenants/${tenant.tenantId}` : null, tenant?.name);
      downloadXlsx(tableRef.current, {
        title: fileName,
        company,
        info: exportInfo ?? {},
        user: session?.account?.email ?? null,
        currency: exportInfo?.currency ?? tenant?.currency ?? null,
      });
    } finally {
      setExporting(false);
    }
  };
  return (
    <div>
      {fileName && rows.length > 0 ? (
        <div className="mb-1 flex justify-end print:hidden">
          <ActionButton kind="export" label="Exportar a Excel" disabled={exporting} onClick={exportTable} />
        </div>
      ) : null}
    <div className="relative overflow-x-auto">
      <table ref={tableRef} className="w-full border-collapse text-sm">
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <thead>
          <tr className="border-b border-borde-fuerte text-left">
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                data-xl-type={c.type ?? (c.align === 'right' ? 'amount' : 'text')}
                data-xl-skip={c.export === false || (typeof c.title === 'string' && ACTION_TITLE.test(c.title.trim())) ? '' : undefined}
                className={`px-3 py-2 font-semibold text-tinta ${c.align === 'right' ? 'text-right' : 'text-left'}`}
              >
                {c.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-3 py-6 text-tinta-segundo">
                {empty}
              </td>
            </tr>
          ) : (
            rows.flatMap((row) => {
              const detail = expandedRow?.(row);
              const meta = rowMeta?.(row);
              return [
                <tr
                  key={rowKey(row)}
                  data-xl-kind={meta?.kind || undefined}
                  data-xl-depth={meta?.depth || undefined}
                  className={`align-top ${detail ? '' : 'border-b border-borde'}`}
                >
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      className={`px-3 py-2 text-tinta ${c.align === 'right' ? 'text-right tabular-nums' : 'text-left'} ${c.nowrap ? 'whitespace-nowrap' : ''}`}
                    >
                      {c.render ? c.render(row) : row[c.key]}
                    </td>
                  ))}
                </tr>,
                ...(detail
                  ? [
                      <tr key={`${rowKey(row)}-detalle`} className="border-b border-borde">
                        <td colSpan={columns.length} className="px-3 pb-3 pt-0">
                          {detail}
                        </td>
                      </tr>,
                    ]
                  : []),
              ];
            })
          )}
        </tbody>
      </table>
    </div>
    </div>
  );
}

/** Mensaje legible para cualquier error de la API. */
export const errorMessage = (error) => (error?.message ? error.message : 'Ocurrió un error inesperado.');

/**
 * Carga datos al montar y cuando cambian `deps`. Descarta respuestas de peticiones viejas, para que una
 * lenta que llega tarde no pise a la más reciente.
 */
export function useLoad(loader, deps = []) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const latest = useRef(0);

  const load = useCallback(async () => {
    const mine = ++latest.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await loader();
      if (mine === latest.current) setState({ loading: false, data, error: null });
    } catch (error) {
      if (mine === latest.current) setState({ loading: false, data: null, error });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    load();
  }, [load]);

  return { ...state, reload: load };
}

/** Ejecuta una acción asíncrona de un formulario y lleva el estado de envío y el error. */
export function useSubmit(action) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = useCallback(
    async (...args) => {
      setBusy(true);
      setError(null);
      try {
        return await action(...args);
      } catch (e) {
        setError(e);
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [action],
  );
  return { busy, error, run, clearError: () => setError(null) };
}
