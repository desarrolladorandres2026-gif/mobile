import { useState } from 'react';
import { ShieldAlert, X } from 'lucide-react';

/**
 * Confirmación con motivo y código TOTP para las acciones de mayor impacto
 * del centro de seguridad: cerrar todas las sesiones de una persona o de un
 * negocio, y exportar el historial. El backend vuelve a exigir las dos
 * cosas (`assertStepUpAuthorized`); esto solo las recoge.
 *
 * El código se pide en cada acción: haber pasado el 2FA al entrar no basta
 * para una acción puntual que saca a un comercio entero de su panel.
 */
interface StepUpDialogProps {
  title: string;
  message: string;
  confirmLabel: string;
  reasonPlaceholder?: string;
  busy?: boolean;
  error?: string;
  onConfirm: (reason: string, totpToken: string) => void;
  onCancel: () => void;
}

const input =
  'h-10 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-xs text-[var(--color-text-main)] outline-none focus:border-[var(--color-primary)]';
const label = 'text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-main)]';

export default function StepUpDialog({
  title,
  message,
  confirmLabel,
  reasonPlaceholder = 'Por qué lo haces',
  busy,
  error,
  onConfirm,
  onCancel,
}: StepUpDialogProps) {
  const [reason, setReason] = useState('');
  const [totp, setTotp] = useState('');
  const [local, setLocal] = useState('');

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (reason.trim().length < 5) return setLocal('Escribe el motivo (mínimo 5 caracteres). Queda en la auditoría.');
    if (totp.trim().length < 6) return setLocal('Escribe el código de tu app de verificación.');
    setLocal('');
    onConfirm(reason.trim(), totp.trim());
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <button type="button" aria-label="Cancelar" onClick={onCancel} className="absolute inset-0 cursor-default bg-black/50 backdrop-blur-[2px]" />
      <form onSubmit={submit} role="dialog" aria-label={title} className="zipp-modal relative w-full max-w-md space-y-4 rounded-2xl p-6">
        <div className="flex items-start gap-3">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-danger)]" strokeWidth={1.75} />
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-bold text-[var(--color-text-main)]">{title}</h3>
            <p className="mt-1 text-xs leading-relaxed text-[var(--color-text-secondary)]">{message}</p>
          </div>
          <button type="button" onClick={onCancel} aria-label="Cerrar" className="cursor-pointer text-[var(--color-text-muted)] hover:text-[var(--color-text-main)]">
            <X className="h-4 w-4" />
          </button>
        </div>

        <label className="block space-y-1">
          <span className={label}>Motivo</span>
          <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder={reasonPlaceholder} className={input} />
        </label>
        <label className="block space-y-1">
          <span className={label}>Código de verificación en dos pasos</span>
          <input value={totp} onChange={(e) => setTotp(e.target.value)} inputMode="numeric" maxLength={20} autoComplete="one-time-code" className={input} />
        </label>

        {(local || error) && <p className="text-xs font-semibold text-[var(--color-danger)]">{local || error}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onCancel} className="cursor-pointer rounded-lg px-4 py-2 text-xs font-semibold text-[var(--color-text-main)]">
            Cancelar
          </button>
          <button
            type="submit"
            disabled={busy}
            className="cursor-pointer rounded-lg bg-[var(--color-danger)] px-4 py-2 text-xs font-bold uppercase tracking-wider text-white disabled:opacity-60"
          >
            {busy ? 'Procesando…' : confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
