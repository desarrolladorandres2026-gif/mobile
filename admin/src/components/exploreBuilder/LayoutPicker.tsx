import type { ProductCard, ProductLayout } from './types';
import { CARD_LABEL, maxGridRows } from './sections';

/**
 * Elegir cómo se pinta una sección de productos mirando su forma, no su
 * nombre. Cada opción es un botón con un esquema de la disposición: las
 * rayas son tarjetas, la flecha dice que se desliza hacia el lado.
 */

type Option = { id: string; label: string; layout: ProductLayout };

const OPTIONS: Option[] = [
 { id: 'c1', label: 'Carrusel', layout: { kind: 'carousel', rows: 1, card: 'compact' } },
 { id: 'c2', label: 'Carrusel 2 filas', layout: { kind: 'carousel', rows: 2, card: 'compact' } },
 { id: 'c3', label: 'Carrusel 3 filas', layout: { kind: 'carousel', rows: 3, card: 'compact' } },
 { id: 'g2', label: 'Cuadrícula 2', layout: { kind: 'grid', columns: 2, rows: 3 } },
 { id: 'g3', label: 'Cuadrícula 3', layout: { kind: 'grid', columns: 3, rows: 4 } },
 { id: 'g4', label: 'Cuadrícula 4', layout: { kind: 'grid', columns: 4, rows: 3 } },
];

function optionId(layout: ProductLayout): string {
 return layout.kind === 'grid' ? `g${layout.columns}` : `c${layout.rows}`;
}

/** El esquema: filas × columnas de rayas finas; los carruseles asoman una columna cortada. */
function Schematic({ layout }: { layout: ProductLayout }) {
 const rows = layout.kind === 'grid' ? Math.min(layout.rows, 3) : layout.rows;
 const cols = layout.kind === 'grid' ? layout.columns : 3;
 return (
 <div className="flex flex-col gap-[3px] w-14" aria-hidden>
 {Array.from({ length: rows }).map((_, r) => (
 <div key={r} className="flex gap-[3px]">
 {Array.from({ length: cols }).map((__, c) => (
 <span
 key={c}
 className={`h-2.5 rounded-[2px] border border-current ${layout.kind === 'carousel' && c === cols - 1 ? 'w-1.5 opacity-50' : 'flex-1'}`}
 />
 ))}
 </div>
 ))}
 </div>
 );
}

export function LayoutPicker({
 value, onChange, maxItems = 12, compact = false,
}: {
 value: ProductLayout;
 onChange: (layout: ProductLayout) => void;
 maxItems?: number;
 /** Sin selectores de tarjeta ni filas: para el patrón de una banda. */
 compact?: boolean;
}) {
 const selected = optionId(value);

 const pick = (option: Option) => {
 if (option.layout.kind === 'grid') {
 const rows = Math.min(option.layout.rows, maxGridRows(option.layout.columns, maxItems));
 onChange({ ...option.layout, rows });
 } else if (value.kind === 'carousel' && option.layout.rows === 1) {
 onChange({ ...option.layout, card: value.card });
 } else {
 onChange(option.layout);
 }
 };

 return (
 <div className="space-y-3">
 <div className="flex flex-wrap gap-2">
 {OPTIONS.map((option) => {
 const active = option.id === selected;
 return (
 <button
 key={option.id}
 type="button"
 onClick={() => pick(option)}
 aria-pressed={active}
 className={`flex flex-col items-center gap-1.5 px-3 py-2 rounded-lg border text-[11px] font-semibold transition-colors cursor-pointer ${
 active
 ? 'border-[var(--color-primary)] text-[var(--color-primary)]'
 : 'border-[var(--color-border)] text-[var(--color-text-main)] hover:text-[var(--color-text-main)]'
 }`}
 >
 <Schematic layout={option.layout} />
 {option.label}
 </button>
 );
 })}
 </div>

 {!compact && value.kind === 'carousel' && value.rows === 1 ? (
 <label className="flex items-center gap-3 text-xs text-[var(--color-text-main)]">
 Tarjeta
 <select
 value={value.card}
 onChange={(e) => onChange({ ...value, card: e.target.value as ProductCard })}
 className="h-9 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] px-2.5 text-xs text-[var(--color-text-main)] cursor-pointer"
 >
 {(Object.keys(CARD_LABEL) as ProductCard[]).map((card) => (
 <option key={card} value={card}>{CARD_LABEL[card]}</option>
 ))}
 </select>
 </label>
 ) : null}

 {!compact && value.kind === 'grid' ? (
 <label className="flex items-center gap-3 text-xs text-[var(--color-text-main)]">
 Filas
 <select
 value={value.rows}
 onChange={(e) => onChange({ ...value, rows: Number(e.target.value) })}
 className="h-9 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] px-2.5 text-xs text-[var(--color-text-main)] cursor-pointer"
 >
 {Array.from({ length: maxGridRows(value.columns, maxItems) }, (_, i) => i + 1).map((rows) => (
 <option key={rows} value={rows}>{rows} {rows === 1 ? 'fila' : 'filas'} · {rows * value.columns} productos</option>
 ))}
 </select>
 </label>
 ) : null}
 </div>
 );
}
