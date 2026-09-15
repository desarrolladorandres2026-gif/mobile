import { Plus, X, ChevronUp, ChevronDown, ToggleLeft, ToggleRight } from 'lucide-react';
import {
  describeRules, emptyGroup, emptyOption, type GroupDraft, type OptionDraft,
} from '../lib/modifierGroups';

/**
 * Editor de grupos de modificadores dentro del formulario del producto.
 *
 * Cada grupo es una pregunta al cliente ("¿Tipo de carne?") con sus
 * respuestas y dos números: cuántas tiene que elegir como mínimo y cuántas
 * puede como máximo. "Obligatorio" y "selección única" no se marcan: se
 * leen de esos dos números, que es como los guarda el servidor.
 *
 * El componente no valida ni convierte: trabaja con borradores de texto y
 * deja las reglas a `fromDrafts`, que corre al guardar.
 */

const inputClass =
  'h-9 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] px-3 text-xs font-semibold text-[var(--color-text-main)] placeholder-[var(--color-text-muted)] outline-none focus:border-[var(--color-primary)] transition-colors';

const iconButton =
  'h-8 w-8 inline-flex items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)] text-[var(--color-text-secondary)] cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-default';

interface Props {
  groups: GroupDraft[];
  onChange: (groups: GroupDraft[]) => void;
}

export default function ModifierGroupsEditor({ groups, onChange }: Props) {
  const updateGroup = (index: number, patch: Partial<GroupDraft>) =>
    onChange(groups.map((g, i) => (i === index ? { ...g, ...patch } : g)));

  const updateOption = (gi: number, oi: number, patch: Partial<OptionDraft>) =>
    updateGroup(gi, { options: groups[gi].options.map((o, i) => (i === oi ? { ...o, ...patch } : o)) });

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= groups.length) return;
    const next = [...groups];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  return (
    <div className="border-t border-[var(--color-border-light)] pt-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <span className="block text-[11px] font-bold text-[var(--color-text-secondary)] uppercase tracking-wider">
            Opciones para elegir
          </span>
          <p className="text-[11px] text-[var(--color-text-muted)] mt-0.5">
            Tamaño, tipo de carne, salsas… El cliente elige antes de agregar.
          </p>
        </div>
        <button
          type="button"
          onClick={() => onChange([...groups, emptyGroup()])}
          disabled={groups.length >= 15}
          className="px-3 h-8 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] hover:bg-[var(--color-surface-hover)] text-xs font-bold text-[var(--color-text-main)] cursor-pointer transition-colors inline-flex items-center gap-1.5 disabled:opacity-40"
        >
          <Plus className="w-3.5 h-3.5" />
          Grupo
        </button>
      </div>

      {groups.map((group, gi) => {
        const min = Number(group.minSelect);
        const max = Number(group.maxSelect);
        const rules = Number.isFinite(min) && Number.isFinite(max) && max >= 1 ? describeRules(min, max) : '';

        return (
          <div
            key={group._id ?? `new-${gi}`}
            className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 space-y-3"
          >
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={group.name}
                onChange={(e) => updateGroup(gi, { name: e.target.value })}
                placeholder="Nombre del grupo (ej.: Tipo de carne)"
                aria-label={`Nombre del grupo ${gi + 1}`}
                maxLength={60}
                className={`${inputClass} flex-1`}
              />
              <button type="button" onClick={() => move(gi, -1)} disabled={gi === 0} aria-label="Subir grupo" className={iconButton}>
                <ChevronUp className="w-4 h-4" />
              </button>
              <button type="button" onClick={() => move(gi, 1)} disabled={gi === groups.length - 1} aria-label="Bajar grupo" className={iconButton}>
                <ChevronDown className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => onChange(groups.filter((_, i) => i !== gi))}
                aria-label={`Quitar grupo ${group.name || gi + 1}`}
                className={`${iconButton} hover:text-[var(--color-danger)]`}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex items-center gap-3 flex-wrap">
              <label className="flex items-center gap-1.5 text-[11px] font-semibold text-[var(--color-text-secondary)]">
                Mínimo
                <input
                  type="number"
                  min={0}
                  value={group.minSelect}
                  onChange={(e) => updateGroup(gi, { minSelect: e.target.value })}
                  aria-label={`Mínimo de ${group.name || `grupo ${gi + 1}`}`}
                  className={`${inputClass} w-16 tabular`}
                />
              </label>
              <label className="flex items-center gap-1.5 text-[11px] font-semibold text-[var(--color-text-secondary)]">
                Máximo
                <input
                  type="number"
                  min={1}
                  value={group.maxSelect}
                  onChange={(e) => updateGroup(gi, { maxSelect: e.target.value })}
                  aria-label={`Máximo de ${group.name || `grupo ${gi + 1}`}`}
                  className={`${inputClass} w-16 tabular`}
                />
              </label>
              {rules ? (
                <span className="text-[11px] font-semibold text-[var(--color-text-muted)]">{rules}</span>
              ) : null}
            </div>

            <div className="space-y-1.5">
              {group.options.map((option, oi) => (
                <div key={option._id ?? `new-${oi}`} className="flex items-center gap-2">
                  <input
                    type="text"
                    value={option.name}
                    onChange={(e) => updateOption(gi, oi, { name: e.target.value })}
                    placeholder="Opción (ej.: Angus 150 g)"
                    aria-label={`Opción ${oi + 1} de ${group.name || `grupo ${gi + 1}`}`}
                    maxLength={60}
                    className={`${inputClass} flex-1 ${option.isAvailable ? '' : 'line-through text-[var(--color-text-muted)]'}`}
                  />
                  <input
                    type="number"
                    min={0}
                    step={100}
                    value={option.price}
                    onChange={(e) => updateOption(gi, oi, { price: e.target.value })}
                    placeholder="0"
                    aria-label={`Precio adicional de ${option.name || `opción ${oi + 1}`}`}
                    className={`${inputClass} w-24 tabular font-bold text-[var(--color-primary)]`}
                  />
                  <button
                    type="button"
                    onClick={() => updateOption(gi, oi, { isAvailable: !option.isAvailable })}
                    aria-label={option.isAvailable ? `Marcar ${option.name || 'opción'} como agotada` : `Volver a ofrecer ${option.name || 'opción'}`}
                    aria-pressed={option.isAvailable}
                    title={option.isAvailable ? 'Disponible' : 'Agotada'}
                    className={`${iconButton} ${option.isAvailable ? 'text-[var(--color-primary)]' : ''}`}
                  >
                    {option.isAvailable ? <ToggleRight className="w-4 h-4" /> : <ToggleLeft className="w-4 h-4" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => updateGroup(gi, { options: group.options.filter((_, i) => i !== oi) })}
                    disabled={group.options.length <= 1}
                    aria-label={`Quitar ${option.name || `opción ${oi + 1}`}`}
                    className={`${iconButton} hover:text-[var(--color-danger)]`}
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => updateGroup(gi, { options: [...group.options, emptyOption()] })}
                disabled={group.options.length >= 30}
                className="text-xs font-bold text-[var(--color-primary)] hover:underline cursor-pointer inline-flex items-center gap-1 disabled:opacity-40"
              >
                <Plus className="w-3.5 h-3.5" />
                Opción
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
