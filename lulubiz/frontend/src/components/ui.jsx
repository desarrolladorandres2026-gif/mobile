import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import { loadCompanyIdentity } from '../lib/companyIdentity.js';
import { downloadXlsx } from '../lib/exportXlsx.js';
import { Link } from '../lib/router.jsx';
import { useOptionalSession } from '../lib/session.jsx';

// Botones: rectangulares, solo texto, sin sombra ni animación. El estado deshabilitado cambia de color, no de opacidad.
const BUTTON_BASE =
  'inline-flex items-center justify-center rounded-sm border font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-azul disabled:cursor-wait disabled:border-borde disabled:bg-papel-fondo disabled:text-tinta-segundo';
const BUTTON_VARIANTS = {
  primary: 'border-azul bg-azul text-white hover:border-azul-oscuro hover:bg-azul-oscuro',
  danger: 'border-rojo bg-rojo text-white hover:border-rojo-oscuro hover:bg-rojo-oscuro',
  secondary: 'border-borde-fuerte bg-papel text-tinta hover:bg-azul-suave',
};
const BUTTON_SMALL = 'px-2 py-0.5 text-xs';
const BUTTON_LINK = 'rounded-sm border border-azul bg-papel px-3 py-1 text-xs font-semibold text-azul hover:bg-azul-suave disabled:cursor-wait disabled:border-borde disabled:bg-papel-fondo disabled:text-tinta-segundo focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-azul';

export function Button({ variant = 'secondary', busy = false, type = 'button', className = '', children, ...props }) {
  return (
    <button type={type} {...props} disabled={busy || props.disabled} className={`${BUTTON_BASE} px-4 py-1.5 text-sm ${BUTTON_VARIANTS[variant] ?? BUTTON_VARIANTS.secondary} ${className}`}>
      {busy ? 'Procesando…' : children}
    </button>
  );
}

/** Botón de «ver», «revisar» o «consultar»: lanza una consulta o un chequeo, no guarda nada. */
export function ViewButton({ busy = false, type = 'button', className = '', children, ...props }) {
  return (
    <button type={type} {...props} disabled={busy || props.disabled} className={`inline-block ${BUTTON_LINK} ${className}`}>
      {busy ? 'Procesando…' : children}
    </button>
  );
}

/** Lo mismo que `ViewButton`, pero navega: para «Revisar», «Hacerlo ahora», «Ver…» que llevan a otra pantalla. */
export function ViewLink({ href, className = '', children, ...props }) {
  return (
    <Link href={href} className={`inline-block ${BUTTON_LINK} text-azul! no-underline! ${className}`} {...props}>
      {children}
    </Link>
  );
}

/** Botón compacto para acciones dentro de una fila de tabla o de un aviso. Siempre visible. */
export function TextButton({ danger = false, className = '', children, ...props }) {
  return (
    <button type="button" {...props} className={`${BUTTON_BASE} ${BUTTON_SMALL} ${BUTTON_VARIANTS[danger ? 'danger' : 'secondary']} ${className}`}>
      {children}
    </button>
  );
}

/** Botón de eliminar o quitar una fila: destructivo, con texto (`children`) y siempre visible. */
export function DeleteButton({ children = 'Eliminar', className = '', ...props }) {
  return (
    <button
      type="button"
      {...props}
      className={`${BUTTON_BASE} ${BUTTON_SMALL} border-rojo bg-papel text-rojo hover:bg-rojo-suave ${className}`}
    >
      {children}
    </button>
  );
}

const INPUT =
  'w-full rounded-sm border bg-papel px-3 py-1.5 text-sm text-tinta placeholder:text-tinta-segundo focus:border-azul focus:outline-2 focus:outline-azul disabled:bg-papel-fondo disabled:text-tinta-segundo';
const INPUT_BORDER = 'border-borde-fuerte';

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
 * Barra de búsqueda: campo rectangular con botón integrado.
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
    <div className={`flex w-full max-w-[480px] items-stretch rounded-sm border border-borde-fuerte bg-papel focus-within:outline-2 focus-within:outline-azul ${className}`}>
      <input
        ref={inputRef}
        type="search"
        placeholder={placeholder}
        onKeyDown={(e) => {
          if (onSubmit && e.key === 'Enter') onSubmit();
          onKeyDown?.(e);
        }}
        className={`peer min-w-0 flex-1 rounded-sm bg-transparent px-3 ${compact ? 'py-1.5 text-sm' : 'py-2 text-base'} text-tinta placeholder:text-tinta-segundo focus:outline-none [&::-webkit-search-cancel-button]:appearance-none ${inputClassName}`}
        {...props}
      />
      <button
        type="button"
        onClick={clear}
        aria-label="Borrar búsqueda"
        className="px-2 text-xs font-semibold text-azul hover:text-azul-oscuro peer-placeholder-shown:hidden focus-visible:outline-2 focus-visible:outline-azul"
      >
        Borrar
      </button>
      {onSubmit ? (
        <button
          type="button"
          onClick={onSubmit}
          className={`rounded-r-sm bg-azul ${compact ? 'px-4 text-xs' : 'px-5 text-sm'} font-semibold text-white hover:bg-azul-oscuro focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-azul`}
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

/**
 * Aviso de una carga que falló, con reintento. Un fallo de red no es «no hay datos»: se dice y se deja reintentar.
 * Un 403 no se avisa (el rol simplemente no ve ese dato) salvo que `forbidden` sea verdadero.
 */
export function LoadNotice({ load, what, forbidden = false }) {
  if (!load.error || (!forbidden && load.error.status === 403)) return null;
  return (
    <div className="col-span-full">
      <Notice kind="error" title={`No se pudo cargar ${what}`}>
        {errorMessage(load.error)} <TextButton onClick={load.reload}>Reintentar</TextButton>
      </Notice>
    </div>
  );
}

export function PageHeader({ title, children }) {
  return (
    <div className="sticky top-0 z-10 -mt-5 mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-borde bg-papel pb-3 pt-5 print:static">
      <h1 className="text-xl font-semibold text-tinta">{title}</h1>
      <div className="flex flex-wrap items-center gap-2">
        {children}
        <Button className="print:hidden" onClick={() => window.print()}>Imprimir</Button>
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
          <Button disabled={exporting} onClick={exportTable}>Exportar a Excel</Button>
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
