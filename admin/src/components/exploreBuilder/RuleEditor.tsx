import { Plus, X } from 'lucide-react';
import NumericInput from '../NumericInput';
import type { BuilderOptions, Rule, RuleDSL, RuleSource } from './types';
import { CATEGORY_LABEL, SALES_LABEL, SORT_LABEL, SOURCE_LABEL, defaultRule } from './sections';

/**
 * La regla de datos de una sección: el mismo lenguaje cerrado del motor de
 * descubrimiento (`DiscoveryCollection.rule`), escrito con selectores.
 *
 * Todas las condiciones se cumplen a la vez (Y). El tope de cuatro no es
 * técnico: con cinco condiciones un catálogo de pueblo devuelve dos
 * productos, y una sección de dos productos no se publica.
 */

const SOURCES: RuleSource[] = [
 'discount', 'price', 'tags', 'sales', 'new', 'featured', 'businessCategory', 'businessRating', 'prepTime', 'nearby',
];

const inputClass = 'h-9 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] px-2.5 text-xs text-[var(--color-text-main)] focus:border-[var(--color-primary)] focus:outline-none';

/** Selección múltiple: el estado se lee por el borde dorado, no por un símbolo en el texto. */
export function Chips({ values, selected, onToggle, label }: {
 values: string[];
 selected: string[];
 onToggle: (value: string) => void;
 label: (value: string) => string;
}) {
 return (
 <div className="flex flex-wrap gap-1.5">
 {values.map((value) => {
 const on = selected.includes(value);
 return (
 <button
 key={value}
 type="button"
 onClick={() => onToggle(value)}
 aria-pressed={on}
 className={`px-2.5 py-1 rounded-full border text-[11px] font-semibold cursor-pointer transition-colors ${
 on
 ? 'border-[var(--color-primary)] text-[var(--color-text-main)]'
 : 'border-[var(--color-border)] text-[var(--color-text-main)] hover:text-[var(--color-text-main)]'
 }`}
 >
 {label(value)}
 </button>
 );
 })}
 </div>
 );
}

const toggle = (list: string[], value: string) =>
 list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

function num(value: string): number | undefined {
 if (value.trim() === '') return undefined;
 const n = Number(value);
 return Number.isFinite(n) ? n : undefined;
}

function RuleFields({ rule, onChange, options }: {
 rule: Rule;
 onChange: (rule: Rule) => void;
 options: BuilderOptions;
}) {
 switch (rule.source) {
 case 'tags':
 return (
 <Chips
 values={options.discovery.tags}
 selected={rule.any}
 onToggle={(tag) => onChange({ ...rule, any: toggle(rule.any, tag) })}
 label={(tag) => tag.replace(/_/g, ' ')}
 />
 );
 case 'discount':
 return (
 <label className="flex items-center gap-2 text-xs text-[var(--color-text-main)]">
 Al menos
 <input type="number" min={1} max={95} value={rule.minPercent} className={`${inputClass} w-20`}
 onChange={(e) => onChange({ ...rule, minPercent: num(e.target.value) ?? 1 })} />
 % de descuento
 </label>
 );
 case 'price':
 return (
 <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-text-main)]">
 Desde $
 <NumericInput value={rule.min ?? ''} placeholder="sin mínimo" className={`${inputClass} w-28`}
 onValueChange={(d) => onChange({ ...rule, min: num(d) })} />
 hasta $
 <NumericInput value={rule.max ?? ''} placeholder="sin máximo" className={`${inputClass} w-28`}
 onValueChange={(d) => onChange({ ...rule, max: num(d) })} />
 </div>
 );
 case 'prepTime':
 return (
 <label className="flex items-center gap-2 text-xs text-[var(--color-text-main)]">
 Listos en máximo
 <input type="number" min={5} max={240} value={rule.maxMinutes} className={`${inputClass} w-20`}
 onChange={(e) => onChange({ ...rule, maxMinutes: num(e.target.value) ?? 5 })} />
 minutos
 </label>
 );
 case 'new':
 return (
 <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-text-main)]">
 <select value={rule.of} className={inputClass}
 onChange={(e) => onChange({ ...rule, of: e.target.value as 'product' | 'business' })}>
 <option value="product">Productos</option>
 <option value="business">Negocios</option>
 </select>
 de los últimos
 <input type="number" min={1} max={365} value={rule.withinDays} className={`${inputClass} w-20`}
 onChange={(e) => onChange({ ...rule, withinDays: num(e.target.value) ?? 1 })} />
 días
 </div>
 );
 case 'sales':
 return (
 <select value={rule.window} className={inputClass}
 onChange={(e) => onChange({ ...rule, window: e.target.value as 'mostOrdered' | 'repeat' | 'trending' })}>
 {Object.entries(SALES_LABEL).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
 </select>
 );
 case 'businessRating':
 return (
 <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-text-main)]">
 Calificación desde
 <input type="number" min={0} max={5} step={0.1} value={rule.min} className={`${inputClass} w-20`}
 onChange={(e) => onChange({ ...rule, min: num(e.target.value) ?? 0 })} />
 con al menos
 <input type="number" min={0} value={rule.minReviews ?? ''} placeholder="0" className={`${inputClass} w-20`}
 onChange={(e) => onChange({ ...rule, minReviews: num(e.target.value) })} />
 reseñas
 </div>
 );
 case 'businessCategory':
 return (
 <Chips
 values={options.discovery.businessCategories}
 selected={rule.any}
 onToggle={(category) => onChange({ ...rule, any: toggle(rule.any, category) })}
 label={(category) => CATEGORY_LABEL[category] ?? category}
 />
 );
 case 'featured':
 return <p className="text-xs text-[var(--color-text-main)]">Solo los productos marcados como destacados.</p>;
 case 'nearby':
 return <p className="text-xs text-[var(--color-text-main)]">Ordena por distancia. Sin ubicación del cliente, la sección no sale.</p>;
 }
}

export function RuleEditor({ value, onChange, options, minSize, targetSize, onSizes }: {
 value: RuleDSL;
 onChange: (rule: RuleDSL) => void;
 options: BuilderOptions;
 minSize: number;
 targetSize: number;
 onSizes: (sizes: { minSize: number; targetSize: number }) => void;
}) {
 const maxRules = options.discovery.maxRules || 4;
 const update = (index: number, rule: Rule) =>
 onChange({ ...value, all: value.all.map((r, i) => (i === index ? rule : r)) });

 return (
 <div className="space-y-4">
 {value.all.map((rule, index) => (
 <div key={index} className="space-y-2 pb-4 border-b border-[var(--color-border-light)]">
 <div className="flex items-center gap-2">
 <select
 value={rule.source}
 onChange={(e) => update(index, defaultRule(e.target.value as RuleSource))}
 className={`${inputClass} flex-1`}
 >
 {SOURCES.map((source) => <option key={source} value={source}>{SOURCE_LABEL[source]}</option>)}
 </select>
 <button
 type="button"
 onClick={() => onChange({ ...value, all: value.all.filter((_, i) => i !== index) })}
 className="p-1.5 text-[var(--color-text-main)] hover:text-[var(--color-danger)] cursor-pointer"
 title="Quitar condición"
 aria-label="Quitar condición"
 >
 <X className="w-4 h-4" />
 </button>
 </div>
 <RuleFields rule={rule} onChange={(next) => update(index, next)} options={options} />
 </div>
 ))}

 {value.all.length < maxRules ? (
 <button
 type="button"
 onClick={() => onChange({ ...value, all: [...value.all, defaultRule('discount')] })}
 className="flex items-center gap-1.5 text-xs font-semibold text-[var(--color-text-main)] cursor-pointer"
 >
 <Plus className="w-3.5 h-3.5" /> Agregar condición
 </button>
 ) : (
 <p className="text-[11px] text-[var(--color-text-main)]">Máximo {maxRules} condiciones.</p>
 )}

 <div className="flex flex-wrap items-center gap-3 text-xs text-[var(--color-text-main)]">
 Ordenar por
 <select value={value.sortBy} onChange={(e) => onChange({ ...value, sortBy: e.target.value })} className={inputClass}>
 {options.discovery.sorts.map((sort) => <option key={sort} value={sort}>{SORT_LABEL[sort] ?? sort}</option>)}
 </select>
 </div>

 <div className="flex flex-wrap items-center gap-3 text-xs text-[var(--color-text-main)]">
 Mostrar hasta
 <input type="number" min={1} max={30} value={targetSize} className={`${inputClass} w-20`}
 onChange={(e) => onSizes({ minSize, targetSize: num(e.target.value) ?? 1 })} />
 y ocultar si hay menos de
 <input type="number" min={1} max={20} value={minSize} className={`${inputClass} w-20`}
 onChange={(e) => onSizes({ targetSize, minSize: num(e.target.value) ?? 1 })} />
 </div>
 </div>
 );
}
