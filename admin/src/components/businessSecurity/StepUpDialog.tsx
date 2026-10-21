import { useState } from 'react';

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

const input = 'field field-lg';
const label = 'field-label';

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
      <button type="button" aria-label="Cancelar" onClick={onCancel} className="zipp-backdrop absolute inset-0 cursor-default" />
      <form onSubmit={submit} role="dialog" aria-label={title} className="zipp-modal relative w-full max-w-[480px] space-y-3 p-4">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold text-[var(--color-text-main)]">{title}</h3>
            <p className="mt-1 text-sm text-[var(--color-text-main)]">{message}</p>
          </div>
          <button type="button" onClick={onCancel} className="btn btn-text shrink-0">
            Cerrar
          </button>
        </div>

        <label className="block">
          <span className={label}>Motivo</span>
          <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder={reasonPlaceholder} className={input} />
        </label>
        <label className="block">
          <span className={label}>Código de verificación en dos pasos</span>
          <input value={totp} onChange={(e) => setTotp(e.target.value)} inputMode="numeric" maxLength={20} autoComplete="one-time-code" className={input} />
        </label>

        {(local || error) && <p className="field-error-msg">{local || error}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onCancel} className="btn btn-lg btn-secondary">
            Cancelar
          </button>
          <button
            type="submit"
            disabled={busy}
            className="btn btn-lg btn-danger-fill"
          >
            {busy ? 'Procesando…' : confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
