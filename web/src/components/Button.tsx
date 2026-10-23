import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'tertiary';

const VARIANT: Record<Variant, string> = {
  primary: 'bg-primary text-text-main hover:bg-primary-light',
  secondary: 'border border-border-strong text-text-main hover:border-primary hover:text-primary-text',
  tertiary: 'text-text-secondary hover:text-text-main',
};

const BASE = 'inline-flex min-h-11 items-center justify-center rounded-sm px-6 text-base font-semibold transition-colors duration-100 disabled:cursor-wait disabled:border-border disabled:bg-bg-alt disabled:text-text-secondary';

interface LinkButtonProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  variant?: Variant;
  children: ReactNode;
}

/** Único punto de estilo para los CTA del sitio: mantiene la jerarquía primary/secondary/tertiary consistente en vez de clases sueltas repetidas por archivo. */
export function LinkButton({ variant = 'primary', className = '', children, ...props }: LinkButtonProps) {
  const base = variant === 'tertiary' ? 'inline-flex min-h-11 items-center text-base font-semibold transition-colors duration-100' : BASE;
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
  const base = variant === 'tertiary' ? 'inline-flex min-h-11 items-center text-base font-semibold transition-colors duration-100' : BASE;
  return (
    <button className={`${base} ${VARIANT[variant]} ${className}`} {...props}>
      {children}
    </button>
  );
}
