import { AlertTriangle, Trash2, X } from 'lucide-react';

/**
 * Confirmación de una acción que no se puede deshacer.
 *
 * Los colores salen de los tokens del sistema y no de hex fijos: escritos
 * a mano, este diálogo se pintaba blanco sobre blanco en el tema oscuro —
 * el texto seguía ahí, simplemente no se leía.
 */
interface ConfirmDialogProps {
  title: string;
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'danger' | 'warning' | 'default';
}

export default function ConfirmDialog({
  title,
  message,
  onConfirm,
  onCancel,
  confirmLabel = 'Confirmar',
  cancelLabel = 'Cancelar',
  variant = 'danger',
}: ConfirmDialogProps) {
  const tone = {
    danger: {
      icon: 'text-[var(--color-danger)]',
      iconBg: 'bg-[var(--color-danger-bg)]',
      button: 'bg-[var(--color-danger)] text-white hover:opacity-90',
    },
    warning: {
      icon: 'text-[var(--color-warning)]',
      iconBg: 'bg-[var(--color-warning-bg)]',
      button: 'bg-[var(--color-warning)] text-white hover:opacity-90',
    },
    default: {
      icon: 'text-[var(--color-primary)]',
      iconBg: 'bg-[var(--color-primary-bg)]',
      button: 'bg-[var(--color-primary)] text-white hover:bg-[var(--color-primary-dark)]',
    },
  }[variant];

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
            <span
              className={`w-10 h-10 rounded-xl ${tone.iconBg} flex items-center justify-center shrink-0`}
            >
              {variant === 'danger' ? (
                <Trash2 className={`w-5 h-5 ${tone.icon}`} strokeWidth={1.75} />
              ) : (
                <AlertTriangle className={`w-5 h-5 ${tone.icon}`} strokeWidth={1.75} />
              )}
            </span>

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

          <div className="flex gap-2 pt-1">
            <button
              onClick={onCancel}
              className="flex-1 py-2 rounded-lg text-xs font-semibold text-[var(--color-text-secondary)] border border-[var(--color-border)] hover:bg-[var(--color-surface-hover)] cursor-pointer"
            >
              {cancelLabel}
            </button>
            <button
              onClick={onConfirm}
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
