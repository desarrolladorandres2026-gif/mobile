import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'tertiary';

const VARIANT: Record<Variant, string> = {
  primary: 'bg-primary text-bg hover:bg-primary-light',
  secondary: 'border border-border-strong text-text-main hover:border-primary hover:text-primary',
  tertiary: 'text-text-secondary hover:text-text-main px-0 py-0',
};

const BASE = 'inline-flex items-center justify-center rounded-md px-6 py-3 text-sm font-semibold transition-colors';

interface LinkButtonProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  variant?: Variant;
  children: ReactNode;
}

/** Único punto de estilo para los CTA del sitio: mantiene la jerarquía primary/secondary/tertiary consistente en vez de clases sueltas repetidas por archivo. */
export function LinkButton({ variant = 'primary', className = '', children, ...props }: LinkButtonProps) {
  const base = variant === 'tertiary' ? 'text-sm font-medium transition-colors' : BASE;
  return (
    <a className={`${base} ${VARIANT[variant]} ${className}`} {...props}>
      {children}
    </a>
  );
}

interface PlainButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  children: ReactNode;
}

export function PlainButton({ variant = 'primary', className = '', children, ...props }: PlainButtonProps) {
  const base = variant === 'tertiary' ? 'text-sm font-medium transition-colors' : BASE;
  return (
    <button className={`${base} ${VARIANT[variant]} ${className}`} {...props}>
      {children}
    </button>
  );
}
