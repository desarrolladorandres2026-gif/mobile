/**
 * Interruptor plano: reemplaza al checkbox donde la pregunta es «¿sí o no?» y
 * el resultado se nota al instante (un día abierto, una franja visible). Es un
 * `role="switch"` real, así que se maneja con teclado y lo lee un lector de
 * pantalla.
 */
export default function Toggle({
  checked, onChange, label, disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Texto accesible; lo que se ve lo pone quien usa el interruptor. */
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 cursor-pointer rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        checked
          ? 'border-[var(--color-primary)] bg-[var(--color-primary)]'
          : 'border-[var(--color-border-strong)] bg-[var(--color-bg-alt)]'
      }`}
    >
      <span
        className={`absolute top-0.5 h-3.5 w-3.5 rounded-full transition-all ${
          checked ? 'left-[1.1rem] bg-[var(--zipp-obsidian)]' : 'left-0.5 bg-[var(--color-text-secondary)]'
        }`}
      />
    </button>
  );
}
