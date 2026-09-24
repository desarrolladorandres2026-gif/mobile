import type { ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';

/**
 * Piezas de lectura compartidas por las fichas de pedido y de comercio.
 * Sin cajas: se separa con una línea fina, espacio y tipografía.
 */

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-5 border-t border-[var(--color-border-light)] py-7">
      <h3 className="text-sm font-bold text-[var(--color-text-main)]">{title}</h3>
      {children}
    </section>
  );
}

export function Sub({ title, empty, children }: { title: string; empty?: string; children?: ReactNode }) {
  return (
    <div className="space-y-2">
      <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">{title}</p>
      {children ?? <p className="text-[var(--color-text-muted)]">{empty ?? 'Nada por aquí.'}</p>}
    </div>
  );
}

export function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">{label}</p>
      <p className="truncate text-sm font-semibold text-[var(--color-text-main)]">{value || '—'}</p>
    </div>
  );
}

export function Row({ left, right }: { left: ReactNode; right?: ReactNode }) {
  return (
    <li className="flex justify-between gap-3">
      <span className="min-w-0 text-[var(--color-text-secondary)]">{left}</span>
      {right !== undefined && (
        <span className="shrink-0 font-semibold text-[var(--color-text-main)]">{right}</span>
      )}
    </li>
  );
}

export function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-1.5 font-semibold text-[var(--color-danger)]">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> <span className="min-w-0">{children}</span>
    </p>
  );
}

/** Botón de acción de la ficha: borde fino, sin relleno. */
export const actionButtonClass =
  'flex cursor-pointer items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3.5 py-2 text-xs font-bold uppercase tracking-wider text-[var(--color-text-main)] disabled:opacity-60';

export const primaryButtonClass =
  'cursor-pointer rounded-lg bg-[var(--color-primary)] px-3.5 py-1.5 text-xs font-bold text-white disabled:opacity-60';

export const secondaryButtonClass =
  'cursor-pointer rounded-lg border border-[var(--color-border)] px-3.5 py-1.5 text-xs font-semibold text-[var(--color-text-main)]';

export const inputClass =
  'w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs text-[var(--color-text-main)] outline-none focus:border-[var(--color-primary)]';

export const fieldLabelClass =
  'text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]';
