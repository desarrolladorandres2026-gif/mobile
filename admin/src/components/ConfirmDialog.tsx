import { useState } from 'react';
import { AlertTriangle, Trash2, X } from 'lucide-react';

/**
 * Confirmación de una acción que no se puede deshacer.
 *
 * Los colores salen de los tokens del sistema y no de hex fijos: escritos
 * a mano, este diálogo se pintaba blanco sobre blanco en el tema oscuro —
 * el texto seguía ahí, simplemente no se leía.
 *
 * Con `reason`, además pide un motivo: queda en la auditoría, y lo lee quien
 * revise la decisión meses después.
 */
interface ConfirmDialogProps {
  title: string;
  message: string;
  onConfirm: (reason?: string) => void;
  onCancel: () => void;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'danger' | 'warning' | 'default';
  reason?: { label: string; placeholder?: string; minLength?: number };
}

export default function ConfirmDialog({
  title,
  message,
  onConfirm,
  onCancel,
  confirmLabel = 'Confirmar',
  cancelLabel = 'Cancelar',
  variant = 'danger',
  reason,
}: ConfirmDialogProps) {
  const [text, setText] = useState('');
  const [tried, setTried] = useState(false);
  const minLength = reason?.minLength ?? 5;
  const reasonOk = !reason || text.trim().length >= minLength;

  const tone = {
    danger: {
      icon: 'text-[var(--color-danger)]',
      button: 'bg-[var(--color-danger)] text-white hover:opacity-90',
    },
    warning: {
      icon: 'text-[var(--color-warning)]',
      button: 'bg-[var(--color-warning)] text-white hover:opacity-90',
    },
    default: {
      icon: 'text-[var(--color-primary)]',
      button: 'bg-[var(--color-primary)] text-white hover:bg-[var(--color-primary-dark)]',
    },
  }[variant];

  const confirm = () => {
    if (!reasonOk) {
      setTried(true);
      return;
    }
    onConfirm(reason ? text.trim() : undefined);
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <button
        type="button"
        aria-label={cancelLabel}
        onClick={onCancel}
        className="absolute inset-0 bg-black/50 backdrop-blur-[2px] cursor-default"
      />

      <div
        role="dialog"
        aria-label={title}
        className="relative w-full max-w-sm rounded-2xl bg-[var(--color-surface)] border border-[var(--color-border)] shadow-2xl animate-fade-in"
      >
        <div className="p-6 space-y-4">
          <div className="flex items-start gap-3.5">
            {variant === 'danger' ? (
              <Trash2 className={`w-5 h-5 mt-0.5 shrink-0 ${tone.icon}`} strokeWidth={1.75} />
            ) : (
              <AlertTriangle className={`w-5 h-5 mt-0.5 shrink-0 ${tone.icon}`} strokeWidth={1.75} />
            )}

            <div className="flex-1 min-w-0">
              <h3 className="text-base font-bold text-[var(--color-text-main)]">{title}</h3>
              <p className="text-xs text-[var(--color-text-secondary)] mt-1 leading-relaxed">
                {message}
              </p>
            </div>

            <button
              onClick={onCancel}
              aria-label="Cerrar"
              className="p-1 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text-main)] hover:bg-[var(--color-surface-hover)] cursor-pointer shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {reason && (
            <label className="block space-y-1.5">
              <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-secondary)]">
                {reason.label}
              </span>
              <textarea
                autoFocus
                rows={2}
                maxLength={300}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={reason.placeholder}
                className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-xs text-[var(--color-text-main)] outline-none focus:border-[var(--color-primary)]"
              />
              {tried && !reasonOk && (
                <span className="block text-[11px] font-semibold text-[var(--color-danger)]">
                  Escribe el motivo (mínimo {minLength} caracteres).
                </span>
              )}
            </label>
          )}

          <div className="flex gap-2 pt-1">
            <button
              onClick={onCancel}
              className="flex-1 py-2 rounded-lg text-xs font-semibold text-[var(--color-text-secondary)] border border-[var(--color-border)] hover:bg-[var(--color-surface-hover)] cursor-pointer"
            >
              {cancelLabel}
            </button>
            <button
              onClick={confirm}
              className={`flex-1 py-2 rounded-lg text-xs font-bold cursor-pointer transition-opacity ${tone.button}`}
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
