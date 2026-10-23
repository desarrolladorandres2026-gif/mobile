import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { downloadCsv, tableToCsv } from '../lib/exportCsv.js';

const BUTTON = {
  primary: 'bg-azul text-white hover:bg-azul-oscuro',
  secondary: 'border border-borde-fuerte bg-papel text-tinta hover:bg-papel-fondo',
  danger: 'bg-rojo text-white hover:bg-rojo-oscuro',
};

export function Button({ variant = 'secondary', busy = false, type = 'button', className = '', children, ...props }) {
  return (
    <button
      type={type}
      disabled={busy || props.disabled}
      className={`inline-flex items-center rounded-sm px-3.5 py-1.5 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-azul disabled:cursor-wait ${BUTTON[variant]} ${className}`}
      {...props}
    >
      {busy ? 'Procesando…' : children}
    </button>
  );
}

/** Un botón con aspecto de texto, para acciones dentro de una fila de tabla. Siempre visible. */
export function TextButton({ danger = false, className = '', children, ...props }) {
  return (
    <button
      type="button"
      className={`text-sm font-semibold underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-azul ${danger ? 'text-rojo hover:text-rojo-oscuro' : 'text-azul hover:text-azul-oscuro'} ${className}`}
      {...props}
    >
      {children}
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
  'w-full rounded-sm border bg-papel px-2.5 py-1.5 text-sm text-tinta focus:outline-2 focus:outline-offset-0 focus:outline-azul';

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
          className={`${INPUT} ${error ? 'border-rojo' : 'border-borde-fuerte'} ${inputClassName}`}
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
export function SearchBox({ onSubmit, buttonLabel = 'Buscar', compact = false, className = '', inputClassName = '', onKeyDown, ...props }) {
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
        type="search"
        onKeyDown={(e) => {
          if (onSubmit && e.key === 'Enter') onSubmit();
          onKeyDown?.(e);
        }}
        className={`w-full rounded-lg bg-transparent ${compact ? 'py-1.5 text-sm' : 'py-2.5 text-base'} pl-8 text-tinta placeholder:text-tinta-segundo focus:outline-none ${onSubmit ? (compact ? 'pr-20' : 'pr-24') : 'pr-3'} ${inputClassName}`}
        {...props}
      />
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
        <select id={id} aria-invalid={error ? 'true' : undefined} aria-describedby={error ? `${id}-error` : hint ? `${id}-ayuda` : undefined} className={`${INPUT} ${error ? 'border-rojo' : 'border-borde-fuerte'}`} {...props}>
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
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-borde pb-3">
      <h1 className="text-xl font-semibold text-tinta">{title}</h1>
      <div className="flex flex-wrap items-center gap-2">
        {children}
        <TextButton className="print:hidden" onClick={() => window.print()}>
          Imprimir
        </TextButton>
      </div>
    </div>
  );
}

/**
 * Tabla de datos: cabeceras claras, importes alineados a la derecha, filas con separador discreto.
 * `columns`: [{ key, title, align, render?(row) }]. `align: 'right'` para cifras.
 */
export function DataTable({ columns, rows, rowKey, empty = 'No hay registros.', caption, expandedRow, exportName }) {
  const tableRef = useRef(null);
  // Toda tabla con título se puede exportar; `exportName={false}` lo evita.
  const fileName = exportName === false ? null : (exportName ?? (typeof caption === 'string' ? caption : null));
  return (
    <div>
      {fileName && rows.length > 0 ? (
        <div className="mb-1 flex justify-end print:hidden">
          <TextButton onClick={() => downloadCsv(fileName, tableToCsv(tableRef.current))}>Exportar a Excel</TextButton>
        </div>
      ) : null}
    <div className="relative overflow-x-auto">
      <table ref={tableRef} className="w-full border-collapse text-sm">
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <thead>
          <tr className="border-b border-borde-fuerte text-left">
            {columns.map((c) => (
              <th key={c.key} scope="col" className={`px-3 py-2 font-semibold text-tinta ${c.align === 'right' ? 'text-right' : 'text-left'}`}>
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
              return [
                <tr key={rowKey(row)} className={`align-top ${detail ? '' : 'border-b border-borde'}`}>
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
