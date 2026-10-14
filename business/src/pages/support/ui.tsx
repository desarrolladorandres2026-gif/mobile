import { ArrowLeft } from 'lucide-react';

export const fieldClass =
  'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-main)]';

export const labelClass = 'block text-[11px] font-semibold text-[var(--color-text-secondary)]';

export const primaryBtn =
  'inline-flex items-center justify-center gap-2 cursor-pointer rounded-md bg-[var(--color-primary)] hover:bg-[var(--color-primary-light)] px-4 py-2 text-xs font-semibold text-white disabled:opacity-50';

export function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <button onClick={onBack} className="md:hidden mb-3 inline-flex items-center gap-1 cursor-pointer text-xs font-semibold text-[var(--color-text-secondary)]">
      <ArrowLeft className="w-4 h-4" /> Casos
    </button>
  );
}
