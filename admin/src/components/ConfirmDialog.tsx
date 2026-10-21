import { useState } from 'react';

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

 // La confirmación destructiva va en rojo relleno; el resto, en el acento.
 const confirmClass = variant === 'danger' ? 'btn-danger-fill' : 'btn-primary';

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
 className="zipp-backdrop absolute inset-0 cursor-default"
 />

 <div
 role="dialog"
 aria-label={title}
 className="zipp-modal relative w-full max-w-[480px]"
 >
 <div className="space-y-3 p-4">
 <div className="flex items-start gap-3">
 <div className="min-w-0 flex-1">
 <h3 className="text-base font-semibold text-[var(--color-text-main)]">{title}</h3>
 <p className="mt-1 text-sm text-[var(--color-text-main)]">{message}</p>
 </div>

 <button
 onClick={onCancel}
 className="btn btn-text shrink-0"
 >
 Cerrar
 </button>
 </div>

 {reason && (
 <label className="block">
 <span className="field-label">{reason.label}</span>
 <textarea
 autoFocus
 rows={2}
 maxLength={300}
 value={text}
 onChange={(e) => setText(e.target.value)}
 placeholder={reason.placeholder}
 className={`field ${tried && !reasonOk ? 'field-error' : ''}`}
 />
 {tried && !reasonOk && (
 <span className="field-error-msg block">
 Escribe el motivo (mínimo {minLength} caracteres).
 </span>
 )}
 </label>
 )}

 <div className="flex justify-end gap-2 pt-1">
 <button onClick={onCancel} className="btn btn-lg btn-secondary">
 {cancelLabel}
 </button>
 <button onClick={confirm} className={`btn btn-lg ${confirmClass}`}>
 {confirmLabel}
 </button>
 </div>
 </div>
 </div>
 </div>
 );
}
