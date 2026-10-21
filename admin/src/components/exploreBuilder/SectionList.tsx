import { useRef, useState } from 'react';
import { sectionSummary, sectionTitle, TYPE_LABEL } from './sections';
import type { BuilderOptions, Section } from './types';

/**
 * El orden de Explorar, de arriba a abajo: 01, 02, 03…
 *
 * Se reordena arrastrando (mismo patrón nativo que Banners de inicio) o con
 * las flechas, que son las que sirven con teclado. Filas separadas por una
 * línea fina; la seleccionada se marca con el color de marca, sin fondo.
 */
export function SectionList({
 sections, selectedId, onSelect, onChange, onDuplicate, onDelete, options, readOnly,
}: {
 sections: Section[];
 selectedId: string | null;
 onSelect: (id: string) => void;
 onChange: (sections: Section[]) => void;
 onDuplicate: (id: string) => void;
 onDelete: (id: string) => void;
 options: BuilderOptions | null;
 readOnly: boolean;
}) {
 const dragId = useRef<string | null>(null);
 const [dragOverId, setDragOverId] = useState<string | null>(null);

 const move = (from: number, to: number) => {
 if (to < 0 || to >= sections.length || from === to) return;
 const next = [...sections];
 const [moved] = next.splice(from, 1);
 next.splice(to, 0, moved);
 onChange(next);
 };

 const drop = (targetId: string) => {
 const sourceId = dragId.current;
 dragId.current = null;
 setDragOverId(null);
 if (!sourceId || sourceId === targetId) return;
 move(sections.findIndex((s) => s.id === sourceId), sections.findIndex((s) => s.id === targetId));
 };

 const toggleHidden = (id: string) =>
 onChange(sections.map((s) => (s.id === id ? { ...s, hidden: !s.hidden } : s)));

 const iconButton = 'p-1.5 rounded text-[var(--color-text-main)] hover:text-[var(--color-text-main)] cursor-pointer disabled:cursor-default';

 return (
 <ol className="divide-y divide-[var(--color-border-light)]">
 {sections.map((section, index) => {
 const selected = section.id === selectedId;
 return (
 <li
 key={section.id}
 draggable={!readOnly}
 onDragStart={() => { dragId.current = section.id; }}
 onDragOver={(e) => { e.preventDefault(); setDragOverId(section.id); }}
 onDragLeave={() => setDragOverId((current) => (current === section.id ? null : current))}
 onDrop={() => drop(section.id)}
 className={`group flex items-start gap-2 py-3 pl-2 border-l-2 transition-colors ${
 selected ? 'border-[var(--color-primary)]' : 'border-transparent'
 } ${dragOverId === section.id ? 'border-t-2 border-t-[var(--color-primary)]' : ''}`}
 >
 
 <button type="button" onClick={() => onSelect(section.id)} className="flex-1 min-w-0 text-left cursor-pointer">
 <div className="flex items-baseline gap-2">
 <span className={`font-mono text-xs ${selected ? 'text-[var(--color-text-main)]' : 'text-[var(--color-text-main)]'}`}>
 {String(index + 1).padStart(2, '0')}
 </span>
 <span className={`text-sm font-semibold truncate ${section.hidden ? 'text-[var(--color-text-main)] line-through' : 'text-[var(--color-text-main)]'}`}>
 {sectionTitle(section, options)}
 </span>
 </div>
 <p className="text-xs text-[var(--color-text-main)] truncate mt-0.5 pl-7">
 {TYPE_LABEL[section.type]} · {sectionSummary(section, options)}
 </p>
 </button>
 {!readOnly ? (
 <div className="flex items-center gap-0.5">
 <button type="button" className={iconButton} onClick={() => move(index, index - 1)} disabled={index === 0} title="Subir" aria-label="Subir">Subir</button>
 <button type="button" className={iconButton} onClick={() => move(index, index + 1)} disabled={index === sections.length - 1} title="Bajar" aria-label="Bajar">Bajar</button>
 <button type="button" className={iconButton} onClick={() => toggleHidden(section.id)} title={section.hidden ? 'Mostrar' : 'Ocultar'} aria-label={section.hidden ? 'Mostrar' : 'Ocultar'}>
 {section.hidden ? 'Mostrar' : 'Ocultar'}
 </button>
 <button type="button" className={iconButton} onClick={() => onDuplicate(section.id)} title="Duplicar" aria-label="Duplicar">Duplicar</button>
 <button type="button" className={`${iconButton} hover:text-[var(--color-danger)]`} onClick={() => onDelete(section.id)} title="Eliminar" aria-label="Eliminar">Eliminar</button>
 </div>
 ) : null}
 </li>
 );
 })}
 </ol>
 );
}
