import { X } from 'lucide-react';

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
      button: 'bg-[var(--color-danger)] text-white hover:opacity-90',
    },
    warning: {
      button: 'bg-[var(--color-warning)] text-[var(--zipp-obsidian)] hover:opacity-90',
    },
    default: {
      button: 'bg-[var(--color-primary)] text-[var(--zipp-obsidian)] hover:bg-[var(--color-primary-light)]',
    },
  }[variant];

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <button
        type="button"
        aria-label={cancelLabel}
        onClick={onCancel}
        className="absolute inset-0 bg-black/50 cursor-default"
      />

      <div
        role="dialog"
        aria-label={title}
        className="relative w-full max-w-sm zipp-modal"
      >
        <div className="p-5 space-y-4">
          <div className="flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <h3 className="text-sm font-semibold text-[var(--color-text-main)]">{title}</h3>
              <p className="text-xs text-[var(--color-text-secondary)] mt-1 leading-relaxed">
                {message}
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

          <div className="flex justify-end gap-2 pt-1">
            <button
              onClick={onCancel}
              className="h-8 px-4 rounded-md text-xs font-medium text-[var(--color-text-main)] border border-[var(--color-border)] hover:bg-[var(--color-surface-hover)] cursor-pointer"
            >
              {cancelLabel}
            </button>
            <button
              onClick={onConfirm}
              className={`h-8 px-4 rounded-md text-xs font-semibold cursor-pointer ${tone.button}`}
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
