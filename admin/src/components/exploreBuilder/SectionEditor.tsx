import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react';
import api from '../../services/api';
import { apiMessage } from '../../lib/apiError';
import { LayoutPicker } from './LayoutPicker';
import { Chips, RuleEditor } from './RuleEditor';
import {
 CATEGORY_LABEL, DAYPART_LABEL, HEADER_LABEL, TYPE_HINT, TYPE_LABEL, WEEKDAY_LABEL,
} from './sections';
import type {
 BuilderOptions, BusinessesSection, DiscoveryBandSection, ProductLayout, ProductSource,
 ProductsSection, PromoSection, Section, SectionRules,
} from './types';

/**
 * El formulario de la sección seleccionada.
 *
 * Plano a propósito: bloques separados por aire y una línea fina, jerarquía
 * por tipografía. Lo único con superficie son los controles.
 */

export interface KnownProduct {
 name: string;
 businessName?: string;
}

const inputClass = 'w-full h-10 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] px-3.5 text-xs font-medium text-[var(--color-text-main)] focus:border-[var(--color-primary)] focus:outline-none transition-all placeholder:text-[var(--color-text-main)]';
const labelClass = 'block text-[11px] font-bold text-[var(--color-text-main)] uppercase tracking-wider mb-1.5';
const groupClass = 'space-y-3 pt-5 border-t border-[var(--color-border-light)]';

function Segmented<T extends string>({ value, options, onChange }: {
 value: T;
 options: Array<{ id: T; label: string }>;
 onChange: (value: T) => void;
}) {
 return (
 <div className="flex flex-wrap gap-1.5">
 {options.map((option) => (
 <button
 key={option.id}
 type="button"
 onClick={() => onChange(option.id)}
 aria-pressed={value === option.id}
 className={`px-3 h-8 rounded-lg border text-xs font-semibold cursor-pointer transition-colors ${
 value === option.id
 ? 'border-[var(--color-primary)] text-[var(--color-primary)]'
 : 'border-[var(--color-border)] text-[var(--color-text-main)] hover:text-[var(--color-text-main)]'
 }`}
 >
 {option.label}
 </button>
 ))}
 </div>
 );
}

function toLocalInput(iso: string | null): string {
 if (!iso) return '';
 const d = new Date(iso);
 const pad = (n: number) => String(n).padStart(2, '0');
 return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function VisibilityFields({ rules, onChange }: { rules: SectionRules; onChange: (rules: SectionRules) => void }) {
 const toggleDaypart = (d: SectionRules['dayparts'][number]) =>
 onChange({ ...rules, dayparts: rules.dayparts.includes(d) ? rules.dayparts.filter((x) => x !== d) : [...rules.dayparts, d] });
 const toggleWeekday = (d: number) =>
 onChange({ ...rules, weekdays: rules.weekdays.includes(d) ? rules.weekdays.filter((x) => x !== d) : [...rules.weekdays, d].sort() });

 return (
 <div className={groupClass}>
 <p className={labelClass}>Cuándo se muestra</p>
 <p className="text-[11px] text-[var(--color-text-main)] -mt-1">Sin nada marcado, se muestra siempre. Hora de Bogotá.</p>
 <Chips
 values={Object.keys(DAYPART_LABEL)}
 selected={rules.dayparts}
 onToggle={(d) => toggleDaypart(d as SectionRules['dayparts'][number])}
 label={(d) => DAYPART_LABEL[d]}
 />
 <Chips
 values={WEEKDAY_LABEL.map((_, d) => String(d))}
 selected={rules.weekdays.map(String)}
 onToggle={(d) => toggleWeekday(Number(d))}
 label={(d) => WEEKDAY_LABEL[Number(d)]}
 />
 <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
 <label className="text-xs text-[var(--color-text-main)] space-y-1">
 <span>Desde</span>
 <input type="datetime-local" value={toLocalInput(rules.startDate)} className={inputClass}
 onChange={(e) => onChange({ ...rules, startDate: e.target.value ? new Date(e.target.value).toISOString() : null })} />
 </label>
 <label className="text-xs text-[var(--color-text-main)] space-y-1">
 <span>Hasta</span>
 <input type="datetime-local" value={toLocalInput(rules.endDate)} className={inputClass}
 onChange={(e) => onChange({ ...rules, endDate: e.target.value ? new Date(e.target.value).toISOString() : null })} />
 </label>
 </div>
 </div>
 );
}

/** Reordenar, quitar y añadir ids en una lista hecha a mano. */
function ManualList({ ids, labelOf, onChange }: {
 ids: string[];
 labelOf: (id: string) => string;
 onChange: (ids: string[]) => void;
}) {
 const move = (from: number, to: number) => {
 if (to < 0 || to >= ids.length) return;
 const next = [...ids];
 const [moved] = next.splice(from, 1);
 next.splice(to, 0, moved);
 onChange(next);
 };
 if (!ids.length) return <p className="text-xs text-[var(--color-text-main)]">Todavía no hay nada elegido.</p>;
 return (
 <ol className="divide-y divide-[var(--color-border-light)]">
 {ids.map((id, i) => (
 <li key={id} className="flex items-center gap-2 py-2 text-xs">
 <span className="w-5 text-[var(--color-text-main)] font-mono">{i + 1}</span>
 <span className="flex-1 text-[var(--color-text-main)] truncate">{labelOf(id)}</span>
 <button type="button" onClick={() => move(i, i - 1)} className="p-1 text-[var(--color-text-main)] hover:text-[var(--color-text-main)] cursor-pointer" aria-label="Subir"><ArrowUp className="w-3.5 h-3.5" /></button>
 <button type="button" onClick={() => move(i, i + 1)} className="p-1 text-[var(--color-text-main)] hover:text-[var(--color-text-main)] cursor-pointer" aria-label="Bajar"><ArrowDown className="w-3.5 h-3.5" /></button>
 <button type="button" onClick={() => onChange(ids.filter((x) => x !== id))} className="p-1 text-[var(--color-text-main)] hover:text-[var(--color-danger)] cursor-pointer" aria-label="Quitar"><X className="w-3.5 h-3.5" /></button>
 </li>
 ))}
 </ol>
 );
}

function ManualProductPicker({ ids, onChange, businesses, known, onKnown }: {
 ids: string[];
 onChange: (ids: string[]) => void;
 businesses: Array<{ _id: string; name: string }>;
 known: Record<string, KnownProduct>;
 onKnown: (products: Record<string, KnownProduct>) => void;
}) {
 const [businessId, setBusinessId] = useState('');
 const [products, setProducts] = useState<Array<{ _id: string; name: string; price: number }>>([]);
 const [error, setError] = useState('');

 useEffect(() => {
 if (!businessId) return;
 let alive = true;
 api.get(`/products/business/${businessId}`)
 .then(({ data }) => { if (alive) setProducts(data.data ?? []); })
 .catch((err) => { if (alive) setError(apiMessage(err, 'No se pudieron cargar los productos de ese negocio.')); });
 return () => { alive = false; };
 }, [businessId]);

 const businessName = businesses.find((b) => b._id === businessId)?.name;
 const visibleProducts = businessId ? products : [];
 const add = (product: { _id: string; name: string }) => {
 if (ids.includes(product._id) || ids.length >= 20) return;
 onKnown({ [product._id]: { name: product.name, businessName } });
 onChange([...ids, product._id]);
 };

 return (
 <div className="space-y-3">
 <ManualList
 ids={ids}
 onChange={onChange}
 labelOf={(id) => (known[id] ? `${known[id].name}${known[id].businessName ? ` · ${known[id].businessName}` : ''}` : `Producto …${id.slice(-6)}`)}
 />
 {ids.length < 20 ? (
 <div className="space-y-2">
 <select value={businessId} onChange={(e) => { setError(''); setBusinessId(e.target.value); }} className={inputClass}>
 <option value="">Elige un negocio para ver su carta</option>
 {businesses.map((b) => <option key={b._id} value={b._id}>{b.name}</option>)}
 </select>
 {error ? <p className="text-xs text-[var(--color-danger)]">{error}</p> : null}
 {visibleProducts.length ? (
 <ul className="max-h-48 overflow-y-auto divide-y divide-[var(--color-border-light)]">
 {visibleProducts.map((p) => (
 <li key={p._id}>
 <button
 type="button"
 onClick={() => add(p)}
 disabled={ids.includes(p._id)}
 className="w-full flex items-center justify-between gap-2 py-2 text-xs text-left text-[var(--color-text-main)] disabled:text-[var(--color-text-main)] cursor-pointer disabled:cursor-default"
 >
 <span className="truncate">{p.name}</span>
 {ids.includes(p._id)
 ? <span className="text-[var(--color-text-main)]">Elegido</span>
 : <Plus className="w-3.5 h-3.5 text-[var(--color-primary)]" />}
 </button>
 </li>
 ))}
 </ul>
 ) : null}
 </div>
 ) : (
 <p className="text-[11px] text-[var(--color-text-main)]">Máximo 20 productos.</p>
 )}
 </div>
 );
}

function ProductsEditor({ section, onChange, options, businesses, known, onKnown }: {
 section: ProductsSection;
 onChange: (section: Section) => void;
 options: BuilderOptions;
 businesses: Array<{ _id: string; name: string }>;
 known: Record<string, KnownProduct>;
 onKnown: (products: Record<string, KnownProduct>) => void;
}) {
 const source = section.dataSource;
 const setSource = (dataSource: ProductSource) => onChange({ ...section, dataSource });

 const switchKind = (kind: ProductSource['kind']) => {
 if (kind === source.kind) return;
 if (kind === 'collection') {
 const first = options.collections.find((c) => c.isActive && c.feed !== 'home') ?? options.collections[0];
 setSource({ kind: 'collection', key: first?.key ?? '' });
 } else if (kind === 'rule') {
 setSource({ kind: 'rule', rule: { all: [{ source: 'discount', minPercent: 20 }], sortBy: 'discount' }, minSize: 4, targetSize: 10 });
 } else {
 setSource({ kind: 'manual', productIds: [] });
 }
 };

 const maxItems = options.limits.maxGridItems;

 return (
 <>
 <div className={groupClass}>
 <p className={labelClass}>Qué productos</p>
 <Segmented
 value={source.kind}
 options={[
 { id: 'collection', label: 'Una colección' },
 { id: 'rule', label: 'Regla propia' },
 { id: 'manual', label: 'Elegidos a mano' },
 ]}
 onChange={switchKind}
 />
 {source.kind === 'collection' ? (
 <select value={source.key} onChange={(e) => setSource({ kind: 'collection', key: e.target.value })} className={inputClass}>
 {options.collections.map((c) => (
 <option key={c.key} value={c.key}>
 {c.title}{c.isActive ? '' : ' (apagada)'}{c.feed === 'home' ? ' · de Inicio' : ''}
 </option>
 ))}
 </select>
 ) : null}
 {source.kind === 'rule' ? (
 <RuleEditor
 value={source.rule}
 onChange={(rule) => setSource({ ...source, rule })}
 options={options}
 minSize={source.minSize}
 targetSize={source.targetSize}
 onSizes={(sizes) => setSource({ ...source, ...sizes })}
 />
 ) : null}
 {source.kind === 'manual' ? (
 <ManualProductPicker
 ids={source.productIds}
 onChange={(productIds) => setSource({ kind: 'manual', productIds })}
 businesses={businesses}
 known={known}
 onKnown={onKnown}
 />
 ) : null}
 </div>

 <div className={groupClass}>
 <p className={labelClass}>Cómo se ve</p>
 <LayoutPicker value={section.layout} onChange={(layout) => onChange({ ...section, layout })} maxItems={maxItems} />
 </div>
 </>
 );
}

function BusinessesEditor({ section, onChange, options, businesses }: {
 section: BusinessesSection;
 onChange: (section: Section) => void;
 options: BuilderOptions;
 businesses: Array<{ _id: string; name: string }>;
}) {
 const source = section.dataSource;
 const nameOf = (id: string) => businesses.find((b) => b._id === id)?.name ?? `Negocio …${id.slice(-6)}`;

 return (
 <>
 <div className={groupClass}>
 <p className={labelClass}>Qué negocios</p>
 <Segmented
 value={source.kind}
 options={[{ id: 'query', label: 'Por categoría y calificación' }, { id: 'manual', label: 'Elegidos a mano' }]}
 onChange={(kind) => onChange({
 ...section,
 dataSource: kind === 'manual'
 ? { kind: 'manual', businessIds: [] }
 : { kind: 'query', categories: [], minRating: 0, sortBy: 'rating', limit: 10 },
 })}
 />
 {source.kind === 'manual' ? (
 <div className="space-y-2">
 <ManualList ids={source.businessIds} labelOf={nameOf} onChange={(businessIds) => onChange({ ...section, dataSource: { kind: 'manual', businessIds } })} />
 {source.businessIds.length < 20 ? (
 <select
 value=""
 onChange={(e) => e.target.value && onChange({ ...section, dataSource: { kind: 'manual', businessIds: [...source.businessIds, e.target.value] } })}
 className={inputClass}
 >
 <option value="">Agregar un negocio…</option>
 {businesses.filter((b) => !source.businessIds.includes(b._id)).map((b) => <option key={b._id} value={b._id}>{b.name}</option>)}
 </select>
 ) : null}
 </div>
 ) : (
 <div className="space-y-3">
 <Chips
 values={options.discovery.businessCategories}
 selected={source.categories}
 onToggle={(c) => onChange({
 ...section,
 dataSource: { ...source, categories: source.categories.includes(c) ? source.categories.filter((x) => x !== c) : [...source.categories, c] },
 })}
 label={(c) => CATEGORY_LABEL[c] ?? c}
 />
 <div className="flex flex-wrap items-center gap-3 text-xs text-[var(--color-text-main)]">
 Calificación desde
 <input type="number" min={0} max={5} step={0.1} value={source.minRating} className={`${inputClass} w-20`}
 onChange={(e) => onChange({ ...section, dataSource: { ...source, minRating: Number(e.target.value) || 0 } })} />
 ordenados por
 <select value={source.sortBy} className={`${inputClass} w-auto`}
 onChange={(e) => onChange({ ...section, dataSource: { ...source, sortBy: e.target.value as 'rating' | 'newest' | 'nearby' } })}>
 <option value="rating">Mejor calificados</option>
 <option value="newest">Más nuevos</option>
 <option value="nearby">Más cerca</option>
 </select>
 hasta
 <input type="number" min={3} max={20} value={source.limit} className={`${inputClass} w-20`}
 onChange={(e) => onChange({ ...section, dataSource: { ...source, limit: Number(e.target.value) || 3 } })} />
 </div>
 </div>
 )}
 </div>
 <div className={groupClass}>
 <p className={labelClass}>Cómo se ve</p>
 <Segmented
 value={section.layout.kind}
 options={[{ id: 'row', label: 'Fila deslizable' }, { id: 'spotlight', label: 'Spotlight de 3' }]}
 onChange={(kind) => onChange({ ...section, layout: { kind } })}
 />
 </div>
 </>
 );
}

function BandEditor({ section, onChange, options }: {
 section: DiscoveryBandSection;
 onChange: (section: Section) => void;
 options: BuilderOptions;
}) {
 const setPattern = (pattern: ProductLayout[]) => onChange({ ...section, pattern });
 return (
 <>
 <div className={groupClass}>
 <p className={labelClass}>Cuántas colecciones</p>
 <Segmented
 value={section.take === 'rest' ? 'rest' : 'count'}
 options={[{ id: 'rest', label: 'Todas las restantes' }, { id: 'count', label: 'Un número fijo' }]}
 onChange={(v) => onChange({ ...section, take: v === 'rest' ? 'rest' : 6 })}
 />
 {section.take !== 'rest' ? (
 <input type="number" min={1} max={40} value={section.take} className={`${inputClass} w-24`}
 onChange={(e) => onChange({ ...section, take: Math.max(1, Math.min(40, Number(e.target.value) || 1)) })} />
 ) : null}
 <p className="text-[11px] text-[var(--color-text-main)]">
 El motor elige qué colecciones entran según el día y la franja; las que fijaste en otras secciones no se repiten aquí.
 </p>
 </div>
 <div className={groupClass}>
 <p className={labelClass}>Patrón de presentación</p>
 <p className="text-[11px] text-[var(--color-text-main)] -mt-1">Se aplica en ciclo: primera colección, segunda, tercera…</p>
 {section.pattern.map((layout, i) => (
 <div key={i} className="space-y-2 pb-3 border-b border-[var(--color-border-light)]">
 <div className="flex items-center justify-between text-xs text-[var(--color-text-main)]">
 <span>Posición {i + 1}</span>
 {section.pattern.length > 1 ? (
 <button type="button" onClick={() => setPattern(section.pattern.filter((_, j) => j !== i))}
 className="p-1 text-[var(--color-text-main)] hover:text-[var(--color-danger)] cursor-pointer" aria-label="Quitar posición">
 <X className="w-3.5 h-3.5" />
 </button>
 ) : null}
 </div>
 <LayoutPicker value={layout} maxItems={options.limits.maxGridItems}
 onChange={(next) => setPattern(section.pattern.map((l, j) => (j === i ? next : l)))} />
 </div>
 ))}
 {section.pattern.length < 6 ? (
 <button type="button" onClick={() => setPattern([...section.pattern, { kind: 'carousel', rows: 1, card: 'compact' }])}
 className="flex items-center gap-1.5 text-xs font-semibold text-[var(--color-primary)] cursor-pointer">
 <Plus className="w-3.5 h-3.5" /> Agregar posición al patrón
 </button>
 ) : null}
 </div>
 </>
 );
}

function PromoEditor({ section, onChange }: { section: PromoSection; onChange: (section: Section) => void }) {
 return (
 <div className={groupClass}>
 <label className="flex items-start gap-2.5 cursor-pointer">
 <input type="checkbox" checked={section.includeAd} className="mt-0.5 w-4 h-4 accent-[var(--color-primary)]"
 onChange={(e) => onChange({ ...section, includeAd: e.target.checked })} />
 <span className="text-xs text-[var(--color-text-main)]">
 Lleva el anuncio pagado
 <span className="block text-[11px] text-[var(--color-text-main)] mt-0.5">
 La campaña de Publicidad con superficie Explorar va primera en este carrusel. Tiene que haber exactamente un bloque así para publicar.
 </span>
 </span>
 </label>
 <p className="text-[11px] text-[var(--color-text-main)]">
 Los banners gratuitos se gestionan en Banners de Inicio, con ubicación «Solo Explorar» o «Toda la app».
 </p>
 </div>
 );
}

export function SectionEditor({ section, onChange, options, businesses, knownProducts, onKnownProducts }: {
 section: Section;
 onChange: (section: Section) => void;
 options: BuilderOptions;
 businesses: Array<{ _id: string; name: string }>;
 knownProducts: Record<string, KnownProduct>;
 onKnownProducts: (products: Record<string, KnownProduct>) => void;
}) {
 const [showRules, setShowRules] = useState(
 !!(section.rules.dayparts.length || section.rules.weekdays.length || section.rules.startDate || section.rules.endDate)
 );

 return (
 <div className="space-y-5">
 <div>
 <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-primary)]">{TYPE_LABEL[section.type]}</p>
 <p className="text-xs text-[var(--color-text-main)] mt-1">{TYPE_HINT[section.type]}</p>
 </div>

 {section.type !== 'promo' && section.type !== 'discovery_band' ? (
 <div className="space-y-3">
 <div>
 <label className={labelClass}>Título</label>
 <input value={section.title} maxLength={60} className={inputClass}
 placeholder={section.type === 'products' && section.dataSource.kind === 'collection' ? 'El de la colección' : 'Ej. Almuerzos desde $12.000'}
 onChange={(e) => onChange({ ...section, title: e.target.value })} />
 </div>
 <div>
 <label className={labelClass}>Subtítulo</label>
 <input value={section.subtitle} maxLength={120} className={inputClass}
 onChange={(e) => onChange({ ...section, subtitle: e.target.value })} />
 </div>
 <div className="flex flex-wrap items-center gap-4">
 <label className="flex items-center gap-2 text-xs text-[var(--color-text-main)] cursor-pointer">
 <input type="checkbox" checked={section.showTitle} className="w-4 h-4 accent-[var(--color-primary)]"
 onChange={(e) => onChange({ ...section, showTitle: e.target.checked })} />
 Mostrar título
 </label>
 <label className="flex items-center gap-2 text-xs text-[var(--color-text-main)]">
 Encabezado
 <select value={section.headerVariant} className="h-9 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] px-2.5 text-xs text-[var(--color-text-main)] cursor-pointer"
 onChange={(e) => onChange({ ...section, headerVariant: e.target.value as Section['headerVariant'] })}>
 {options.headerVariants.map((v) => <option key={v} value={v}>{HEADER_LABEL[v] ?? v}</option>)}
 </select>
 </label>
 </div>
 </div>
 ) : null}

 {section.type === 'products' ? (
 <ProductsEditor section={section} onChange={onChange} options={options} businesses={businesses}
 known={knownProducts} onKnown={onKnownProducts} />
 ) : null}
 {section.type === 'businesses' ? (
 <BusinessesEditor section={section} onChange={onChange} options={options} businesses={businesses} />
 ) : null}
 {section.type === 'discovery_band' ? <BandEditor section={section} onChange={onChange} options={options} /> : null}
 {section.type === 'promo' ? <PromoEditor section={section} onChange={onChange} /> : null}

 {showRules ? (
 <VisibilityFields rules={section.rules} onChange={(rules) => onChange({ ...section, rules })} />
 ) : (
 <button type="button" onClick={() => setShowRules(true)}
 className="text-xs font-semibold text-[var(--color-primary)] cursor-pointer pt-5 border-t border-[var(--color-border-light)] w-full text-left">
 Programar cuándo se muestra (franja, días, fechas)
 </button>
 )}
 </div>
 );
}
