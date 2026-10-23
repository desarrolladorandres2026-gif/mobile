import { useEffect, useRef, useState } from 'react';
import { PlainButton } from './Button';
import { FormStatus, TextAreaField } from './Form';
import type { MenuProduct } from '../lib/api';
import { addLine, MAX_LINE_QUANTITY, type BusinessRef } from '../lib/cart';
import { money } from '../lib/format';
import {
  groupHint, isRequired, isSingle, sortedGroups, selectionTotal, toggleChoice, validateSelection,
  type ModifierChoice,
} from '../lib/modifiers';

const GROUP_MESSAGES = {
  MODIFIER_REQUIRED: (g: string) => `Elige una opción en «${g}».`,
  MODIFIER_TOO_MANY: (g: string) => `Elegiste demasiadas opciones en «${g}».`,
  MODIFIER_UNAVAILABLE: (g: string) => `Una opción de «${g}» se agotó. Elige otra.`,
  MODIFIER_UNKNOWN: (g: string) => `Revisa «${g}»: la carta cambió.`,
} as const;

/**
 * Hoja para agregar un producto: opciones por grupo, cantidad y nota. Usa el
 * elemento nativo `<dialog>`, que ya atrapa el foco, cierra con Escape y
 * marca el resto de la página como inerte para los lectores de pantalla.
 */
export function ProductSheet({
  product, business, onClose,
}: { product: MenuProduct; business: BusinessRef; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [choices, setChoices] = useState<ModifierChoice[]>([]);
  const [quantity, setQuantity] = useState(1);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const groups = sortedGroups(product.modifierGroups);
  const base = product.discountPrice != null && product.discountPrice < product.price ? product.discountPrice : product.price;
  const unit = base + selectionTotal(choices);

  const submit = (replace = false) => {
    const problem = validateSelection(product.modifierGroups, choices);
    if (problem) {
      setError(GROUP_MESSAGES[problem.code](problem.group?.name ?? 'esta opción'));
      return;
    }
    const result = addLine(
      business,
      { productId: product._id, name: product.name, image: product.image, unitPrice: unit, quantity, notes: notes.trim(), choices },
      { replace },
    );
    if (result === 'conflict') {
      setConflict(true);
      return;
    }
    onClose();
  };

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-labelledby="hoja-titulo"
      className="m-auto w-[min(32rem,calc(100vw-2rem))] max-h-[90dvh] overflow-y-auto rounded-sm border border-border-strong bg-bg p-0 text-text-main backdrop:bg-text-main/60"
    >
      <div className="p-6">
        <h2 id="hoja-titulo" className="text-xl font-semibold">{product.name}</h2>
        {product.description && <p className="mt-2 text-base text-text-secondary">{product.description}</p>}
        {product.requiresAgeVerification && (
          <p className="mt-2 text-sm text-text-main">Solo para mayores de 18 años. Te pediremos la cédula al entregar.</p>
        )}

        {groups.map((group) => {
          const single = isSingle(group);
          return (
            <fieldset key={group._id} className="mt-6 border-t border-border pt-4">
              <legend className="text-base font-semibold">
                {group.name} <span className="font-normal text-text-secondary">· {groupHint(group)}{isRequired(group) ? ', obligatorio' : ''}</span>
              </legend>
              {group.options.map((option) => {
                const checked = choices.some((c) => c.optionId === option._id);
                const unavailable = option.isAvailable === false;
                const id = `op-${option._id}`;
                return (
                  <div key={option._id} className="flex min-h-11 items-center justify-between gap-4">
                    <label htmlFor={id} className="flex flex-1 cursor-pointer items-center gap-3 py-2 text-base">
                      <input
                        id={id}
                        type={single ? 'radio' : 'checkbox'}
                        name={`grupo-${group._id}`}
                        checked={checked}
                        disabled={unavailable}
                        onChange={() => { setError(null); setChoices((c) => toggleChoice(c, group, option)); }}
                        className="h-5 w-5 accent-primary"
                      />
                      <span>{option.name}{unavailable ? ' (agotado)' : ''}</span>
                    </label>
                    {option.price > 0 && <span className="text-base tabular-nums">+ {money(option.price)}</span>}
                  </div>
                );
              })}
            </fieldset>
          );
        })}

        <div className="mt-6 border-t border-border pt-4">
          <TextAreaField label="Nota para el comercio (opcional)" maxLength={200} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>

        <div className="mt-6 flex items-center justify-between gap-4">
          <div className="flex items-center">
            <button
              type="button"
              aria-label="Una unidad menos"
              onClick={() => setQuantity((q) => Math.max(1, q - 1))}
              className="min-h-11 min-w-11 border border-border-strong text-lg font-semibold"
            >
              −
            </button>
            <span className="min-w-11 text-center text-base font-semibold tabular-nums" aria-live="polite">{quantity}</span>
            <button
              type="button"
              aria-label="Una unidad más"
              onClick={() => setQuantity((q) => Math.min(MAX_LINE_QUANTITY, q + 1))}
              className="min-h-11 min-w-11 border border-border-strong text-lg font-semibold"
            >
              +
            </button>
          </div>
          <p className="text-base font-semibold tabular-nums">{money(unit * quantity)}</p>
        </div>

        <div className="mt-4"><FormStatus error={error} /></div>

        {conflict ? (
          <div className="mt-4 border-t border-border pt-4">
            <p className="text-base text-text-main">
              Tu pedido tiene productos de otro comercio. Si agregas este, empezamos un pedido nuevo y se vacía el anterior.
            </p>
            <div className="mt-3 flex flex-wrap gap-3">
              <PlainButton type="button" onClick={() => submit(true)}>Empezar pedido nuevo</PlainButton>
              <PlainButton type="button" variant="secondary" onClick={onClose}>Conservar el anterior</PlainButton>
            </div>
          </div>
        ) : (
          <div className="mt-4 flex flex-wrap gap-3">
            <PlainButton type="button" onClick={() => submit()}>Agregar al pedido</PlainButton>
            <PlainButton type="button" variant="tertiary" onClick={onClose}>Cancelar</PlainButton>
          </div>
        )}
      </div>
    </dialog>
  );
}
