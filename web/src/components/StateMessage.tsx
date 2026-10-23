import type { ReactNode } from 'react';

type Kind = 'loading' | 'empty' | 'error';

/** Carga, vacío y error en una sola forma: título, qué hacer y, si hay, una acción. */
export function StateMessage({ kind, title, children }: { kind: Kind; title: string; children?: ReactNode }) {
  return (
    <div
      className="py-12"
      role={kind === 'error' ? 'alert' : 'status'}
      aria-live={kind === 'error' ? 'assertive' : 'polite'}
    >
      <p className="text-lg font-semibold text-text-main">{title}</p>
      {children && <div className="mt-2 max-w-md text-base text-text-secondary">{children}</div>}
    </div>
  );
}
