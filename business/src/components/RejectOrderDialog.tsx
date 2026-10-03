import { useState } from 'react';
import { X } from 'lucide-react';
import { REJECTION_REASONS, shortId, type BusinessOrder } from '../lib/orderFlow';

/**
 * Rechazar un pedido, diciendo por qué.
 *
 * Antes el botón "Rechazar" mandaba `status: cancelled` a secas, así que
 * el cliente recibía "tu pedido fue cancelado" sin explicación y ZIPP no
 * podía distinguir un local cerrado de un producto agotado —que son dos
 * problemas distintos y se corrigen de formas distintas.
 *
 * El motivo se elige de una lista cerrada y no se escribe libre: el campo
 * alimenta el informe de incidencias, y "no habia", "sin stock" y
 * "agotado" tecleados a mano son tres motivos diferentes para cualquier
 * agregación. La nota libre queda como detalle, no como categoría.
 */

interface Props {
  order: BusinessOrder;
  onCancel: () => void;
  onConfirm: (reason: string) => Promise<void> | void;
}

export default function RejectOrderDialog({ order, onCancel, onConfirm }: Props) {
  const [reason, setReason] = useState<string>(REJECTION_REASONS[0].value);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const label = REJECTION_REASONS.find((item) => item.value === reason)?.label ?? '';
  const needsNote = reason === 'other';
  const blocked = submitting || (needsNote && note.trim().length < 3);

  const submit = async () => {
    if (blocked) return;
    setSubmitting(true);
    try {
      // El motivo viaja legible: es lo que el cliente va a leer en su app
      // y lo que quedará en la bitácora del pedido.
      const detail = note.trim();
      await onConfirm(detail ? `${label}: ${detail}` : label);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Cancelar"
        onClick={onCancel}
        className="absolute inset-0 bg-black/50 cursor-default"
      />

      <div
        role="dialog"
        aria-label="Rechazar pedido"
        className="relative w-full max-w-md zipp-modal"
      >
        <div className="p-5 space-y-4">
          <div className="flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <h3 className="text-sm font-semibold text-[var(--color-text-main)]">
                Rechazar el pedido {order.orderNumber ?? shortId(order._id)}
              </h3>
              <p className="text-xs text-[var(--color-text-secondary)] mt-1 leading-relaxed">
                El cliente verá el motivo y, si ya había pagado, se le
                devuelve el dinero automáticamente.
              </p>
            </div>
            <button
              onClick={onCancel}
              aria-label="Cerrar"
              className="p-1 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text-main)] hover:bg-[var(--color-surface-hover)] cursor-pointer shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <fieldset className="space-y-1.5">
            <legend className="text-[11px] font-semibold text-[var(--color-text-muted)] mb-1.5">
              ¿Qué pasó?
            </legend>

            {REJECTION_REASONS.map((item) => (
              <label
                key={item.value}
                className={`flex items-center gap-2.5 px-3 py-2 rounded-md border cursor-pointer transition-colors ${
                  reason === item.value
                    ? 'border-[var(--color-primary)] bg-[var(--color-primary-bg)]'
                    : 'border-[var(--color-border)] hover:bg-[var(--color-surface-hover)]'
                }`}
              >
                <input
                  type="radio"
                  name="rejection-reason"
                  value={item.value}
                  checked={reason === item.value}
                  onChange={() => setReason(item.value)}
                  className="accent-[var(--color-primary)]"
                />
                <span className="text-xs font-medium text-[var(--color-text-main)]">
                  {item.label}
                </span>
              </label>
            ))}
          </fieldset>

          <div className="space-y-1.5">
            <label
              htmlFor="rejection-note"
              className="text-[11px] font-semibold text-[var(--color-text-muted)]"
            >
              Detalle {needsNote ? '(obligatorio)' : '(opcional)'}
            </label>
            <textarea
              id="rejection-note"
              value={note}
              onChange={(event) => setNote(event.target.value.slice(0, 160))}
              rows={2}
              placeholder="Ej.: se acabó la carne de la hamburguesa doble"
              className="w-full rounded-md bg-[var(--color-surface)] border border-[var(--color-border)] px-3 py-2 text-xs text-[var(--color-text-main)] placeholder-[var(--color-text-muted)] outline-none focus:border-[var(--color-primary)] transition-colors resize-none"
            />
          </div>

          <div className="flex justify-end gap-2">
            <button
              onClick={onCancel}
              disabled={submitting}
              className="h-8 px-4 rounded-md text-xs font-medium text-[var(--color-text-main)] border border-[var(--color-border)] hover:bg-[var(--color-surface-hover)] cursor-pointer disabled:opacity-50"
            >
              Volver
            </button>
            <button
              onClick={submit}
              disabled={blocked}
              className="h-8 px-4 rounded-md text-xs font-semibold bg-[var(--color-danger)] text-white hover:opacity-90 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? 'Rechazando…' : 'Rechazar pedido'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
