import { useEffect, useId, useState, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { PlainButton } from './Button';
import { INPUT } from './ui';

interface FieldShellProps {
  label: string;
  hint?: string;
  error?: string;
  children: (ids: { id: string; describedBy?: string }) => ReactNode;
}

/** Etiqueta, control, ayuda y error con los `id` enlazados para lectores de pantalla. */
function FieldShell({ label, hint, error, children }: FieldShellProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div>
      <label htmlFor={id} className="block text-base font-semibold text-text-main">{label}</label>
      {hint && <p id={hintId} className="mt-1 text-sm text-text-secondary">{hint}</p>}
      <div className="mt-2">{children({ id, describedBy })}</div>
      {error && <p id={errorId} role="alert" className="mt-1 text-sm text-error">{error}</p>}
    </div>
  );
}

type BaseProps = { label: string; hint?: string; error?: string };

export function TextField({ label, hint, error, ...props }: BaseProps & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <FieldShell label={label} hint={hint} error={error}>
      {({ id, describedBy }) => (
        <input id={id} aria-describedby={describedBy} aria-invalid={error ? true : undefined} className={INPUT} {...props} />
      )}
    </FieldShell>
  );
}

export function TextAreaField({ label, hint, error, ...props }: BaseProps & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <FieldShell label={label} hint={hint} error={error}>
      {({ id, describedBy }) => (
        <textarea
          id={id}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          rows={5}
          className={`${INPUT} min-h-32 py-2`}
          {...props}
        />
      )}
    </FieldShell>
  );
}

export function SelectField({
  label, hint, error, options, ...props
}: BaseProps & SelectHTMLAttributes<HTMLSelectElement> & { options: { value: string; label: string }[] }) {
  return (
    <FieldShell label={label} hint={hint} error={error}>
      {({ id, describedBy }) => (
        <select id={id} aria-describedby={describedBy} aria-invalid={error ? true : undefined} className={INPUT} {...props}>
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      )}
    </FieldShell>
  );
}

/**
 * Campo trampa anti-bots: invisible y fuera del orden de tabulación. Una
 * persona nunca lo llena; un bot que rellena todos los campos sí. El backend
 * descarta en silencio el envío que lo traiga lleno.
 */
export function Honeypot({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
      <label>
        No llenes este campo
        <input type="text" name="website" tabIndex={-1} autoComplete="off" value={value} onChange={(e) => onChange(e.target.value)} />
      </label>
    </div>
  );
}

/** Resultado de un envío: éxito en texto normal, error como alerta. */
export function FormStatus({ error, success }: { error?: string | null; success?: string | null }) {
  if (error) return <p role="alert" className="text-base text-error">{error}</p>;
  if (success) return <p role="status" className="text-base font-semibold text-text-main">{success}</p>;
  return null;
}

const OTP_COOLDOWN_SECONDS = 60;

/**
 * Pide el código por WhatsApp y recibe el que escribe la persona. El botón
 * se bloquea 60 s tras cada envío: el backend limita los códigos por número,
 * y reenviar sin freno solo agota ese cupo.
 */
export function OtpField({
  code, onCodeChange, onSend, error,
}: {
  code: string;
  onCodeChange: (v: string) => void;
  /** Lanza un `Error` con el mensaje a mostrar si no se puede enviar (celular inválido, límite). */
  onSend: () => Promise<void>;
  error?: string;
}) {
  const [sendError, setSendError] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    if (seconds <= 0) return;
    const t = setTimeout(() => setSeconds((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [seconds]);

  const send = async () => {
    setSending(true);
    setSendError(null);
    try {
      await onSend();
      setSent(true);
      setSeconds(OTP_COOLDOWN_SECONDS);
    } catch (e) {
      setSendError(e instanceof Error ? e.message : 'No pudimos enviar el código. Intenta de nuevo.');
    } finally {
      setSending(false);
    }
  };

  return (
    <div>
      <PlainButton type="button" variant="secondary" disabled={sending || seconds > 0} onClick={send}>
        {seconds > 0 ? `Reenviar en ${seconds} s` : sent ? 'Reenviar código' : 'Enviar código por WhatsApp'}
      </PlainButton>
      {sendError && <p role="alert" className="mt-2 text-sm text-error">{sendError}</p>}
      {sent && (
        <div className="mt-4">
          <TextField
            label="Código de 6 dígitos"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => onCodeChange(e.target.value.replace(/\D/g, ''))}
            error={error}
          />
        </div>
      )}
    </div>
  );
}
