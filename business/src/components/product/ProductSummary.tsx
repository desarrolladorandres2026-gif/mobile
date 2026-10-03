import { useState } from 'react';
import { Circle, CircleCheck } from 'lucide-react';
import { money } from '../../lib/orderFlow';
import type { ChecklistItem } from '../../lib/productForm';

/**
 * "Resumen rápido": la ficha en cinco líneas, lo que falta y el borrador.
 *
 * La lista de completitud usa círculos y no casillas a propósito: no se
 * pueden marcar, y una casilla invita a hacer clic.
 */

export interface DraftStatus {
  /** Último guardado del borrador en este navegador. */
  savedAt: number | null;
  /** Hora del borrador que se recuperó al abrir, si se recuperó alguno. */
  restoredFrom: number | null;
  /** Hay una foto elegida que el borrador no guarda. */
  hasPendingPhoto: boolean;
  onDiscard: () => void;
}

interface Props {
  name: string;
  categoryName: string;
  price: number | null;
  discountPrice: number | null;
  /** Porcentaje real de la oferta, aunque la app no pinte la etiqueta. */
  discountPercent: number | null;
  ownPrepMinutes: number | null;
  businessPrepMinutes: number | null;
  requiresAgeVerification: boolean;
  checklist: ChecklistItem[];
  /** Solo en el alta: editar no guarda borrador. */
  draft: DraftStatus | null;
}

export default function ProductSummary({
  name, categoryName, price, discountPrice, discountPercent, ownPrepMinutes,
  businessPrepMinutes, requiresAgeVerification, checklist, draft,
}: Props) {
  const rows: Array<[string, string]> = [
    ['Nombre', name.trim() || '—'],
    ['Categoría', categoryName || '—'],
    ['Precio regular', price ? money(price) : '—'],
    [
      'Oferta',
      discountPrice ? `${money(discountPrice)}${discountPercent ? ` · ${discountPercent} % menos` : ''}` : 'Sin oferta',
    ],
    [
      'Preparación',
      ownPrepMinutes
        ? `${ownPrepMinutes} min`
        : businessPrepMinutes
          ? `General del negocio (~${businessPrepMinutes} min)`
          : 'General del negocio',
    ],
  ];
  if (requiresAgeVerification) rows.push(['Venta', 'Solo mayores de 18']);

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-[var(--color-text-main)]">Resumen rápido</h3>

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-[var(--color-text-secondary)]">{label}</dt>
            <dd className="truncate font-semibold text-[var(--color-text-main)] tabular">{value}</dd>
          </div>
        ))}
      </dl>

      <ul className="space-y-1.5 border-t border-[var(--color-border)] pt-3">
        {checklist.map((item) => (
          <li key={item.label} className="flex items-center gap-2 text-xs text-[var(--color-text-main)]">
            {item.done ? (
              <CircleCheck className="h-4 w-4 shrink-0 text-[var(--color-success)]" aria-hidden />
            ) : (
              <Circle className="h-4 w-4 shrink-0 text-[var(--color-border-strong)]" aria-hidden />
            )}
            <span className={item.done ? 'font-semibold' : ''}>{item.label}</span>
            <span className="sr-only">{item.done ? 'listo' : 'pendiente'}</span>
          </li>
        ))}
      </ul>

      {draft && <DraftLine draft={draft} />}
    </div>
  );
}

function DraftLine({ draft }: { draft: DraftStatus }) {
  // Una vez al montar: basta para saber si el borrador es de hoy.
  const [today] = useState(() => new Date().toDateString());

  // Recién recuperado y sin tocar, las dos líneas dirían la misma hora.
  const showSaved = draft.savedAt !== null && draft.savedAt !== draft.restoredFrom;

  // Sin punto final: la hora ya termina en "p. m.".
  return (
    <div className="space-y-1 border-t border-[var(--color-border)] pt-3 text-[11px] leading-relaxed text-[var(--color-text-secondary)]">
      {draft.restoredFrom !== null && (
        <p>
          Recuperamos el borrador que guardaste {formatWhen(draft.restoredFrom, today)}
          {draft.hasPendingPhoto ? '' : ', sin la foto'}
          <button
            type="button"
            onClick={draft.onDiscard}
            className="block font-semibold text-[var(--color-primary-dark)] hover:underline cursor-pointer"
          >
            Empezar de cero
          </button>
        </p>
      )}
      <p aria-live="polite">
        {showSaved
          ? `Borrador guardado en este navegador ${formatWhen(draft.savedAt!, today)}${
              draft.hasPendingPhoto ? ' (sin la foto)' : ''
            }`
          : draft.restoredFrom === null
            ? 'Lo que escribas se guarda como borrador en este navegador.'
            : null}
      </p>
    </div>
  );
}

/** "a las 3:42 p. m." si es de hoy; "el 26 sept., 3:42 p. m." si no. */
function formatWhen(ms: number, today: string): string {
  const date = new Date(ms);
  const time = date.toLocaleTimeString('es-CO', { hour: 'numeric', minute: '2-digit' });
  if (date.toDateString() === today) return `a las ${time}`;
  return `el ${date.toLocaleDateString('es-CO', { day: 'numeric', month: 'short' })}, ${time}`;
}
