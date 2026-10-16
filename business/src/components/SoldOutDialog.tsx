import { useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { minutesUntilMidnight } from '../lib/soldOut';

/**
 * Agotar un producto: por cuánto tiempo.
 *
 * Un «agotado» sin fecha que nadie desmarca son ventas perdidas al día
 * siguiente. Igual que el cierre del local, aquí se elige un plazo y el
 * servidor repone el producto solo; «hasta que yo lo active» sigue existiendo
 * para quien quiere decidirlo a mano.
 */

interface Option {
  label: string;
  /** Sin `minutes` queda agotado hasta que el comercio lo active. */
  minutes?: number;
}

const optionsAt = (now: Date): Option[] => [
  { label: '1 hora', minutes: 60 },
  { label: '2 horas', minutes: 120 },
  { label: 'Hasta que cierre el día', minutes: minutesUntilMidnight(now) },
  { label: 'Hasta que yo lo active' },
];

const time = new Intl.DateTimeFormat('es-CO', { hour: 'numeric', minute: '2-digit', hour12: true });

interface Props {
  productName: string;
  busy: boolean;
  onConfirm: (minutes?: number) => void;
  onCancel: () => void;
}

export default function SoldOutDialog({ productName, busy, onConfirm, onCancel }: Props) {
  // Se fija al abrir: las horas que se muestran son las que se envían.
  const [openedAt] = useState(() => new Date());
  const options = optionsAt(openedAt);
  const [picked, setPicked] = useState(0);

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Cancelar"
        onClick={onCancel}
        className="absolute inset-0 cursor-default bg-black/50"
      />
      <div role="dialog" aria-label={`Agotar ${productName}`} className="zipp-modal relative w-full max-w-sm">
        <div className="space-y-3 p-5">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-semibold text-[var(--color-text-main)]">Marcar como agotado</h3>
              <p className="mt-1 text-xs leading-relaxed text-[var(--color-text-secondary)]">
                {productName}. ¿Por cuánto tiempo? Los clientes dejan de verlo disponible ahora.
              </p>
            </div>
            <button
              type="button"
              onClick={onCancel}
              aria-label="Cerrar"
              className="shrink-0 cursor-pointer rounded-md p-1 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-main)]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <ul role="radiogroup" aria-label="Duración del agotado" className="divide-y divide-[var(--color-border)]">
            {options.map((option, index) => {
              const selected = picked === index;
              return (
                <li key={option.label}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setPicked(index)}
                    className="flex h-11 w-full cursor-pointer items-center gap-3 px-1 text-sm text-[var(--color-text-main)] hover:bg-[var(--color-surface-hover)]"
                  >
                    <span
                      aria-hidden
                      className={`grid h-4 w-4 shrink-0 place-items-center rounded-full border ${selected ? 'border-[var(--color-primary)]' : 'border-[var(--color-border-strong)]'}`}
                    >
                      {selected && <span className="h-2 w-2 rounded-full bg-[var(--color-primary)]" />}
                    </span>
                    <span className={selected ? 'font-semibold' : ''}>{option.label}</span>
                    {option.minutes && (
                      <span className="ml-auto text-xs tabular-nums text-[var(--color-text-secondary)]">
                        vuelve {time.format(new Date(openedAt.getTime() + option.minutes * 60_000))}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onCancel}
              className="h-8 cursor-pointer rounded-md border border-[var(--color-border)] px-4 text-xs font-medium text-[var(--color-text-main)] hover:bg-[var(--color-surface-hover)]"
            >
              Cancelar
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => onConfirm(options[picked].minutes)}
              className="h-8 cursor-pointer rounded-md bg-[var(--color-danger)] px-4 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-60"
            >
              {busy ? 'Guardando…' : 'Marcar agotado'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
