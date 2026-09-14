import { useState } from 'react';
import { Menu, X } from 'lucide-react';
import { ZippWordmark } from './ZippMark';
import { LinkButton } from './Button';

const BUSINESS_URL = import.meta.env.VITE_BUSINESS_URL || 'http://localhost:3002';

const NAV_LINKS = [
  { href: '/#inicio', label: 'Inicio' },
  { href: '/#simulador', label: 'Calculadora' },
  { href: '/#operaciones', label: 'Cómo funciona' },
  { href: '/#descargar', label: 'Descargar' },
];

export default function Header() {
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 border-b border-border bg-bg">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6 sm:px-10">
        <a href="/" className="shrink-0" onClick={() => setOpen(false)}>
          <ZippWordmark size={26} />
        </a>

        <nav className="hidden items-center gap-8 md:flex">
          {NAV_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="text-sm text-text-secondary transition-colors hover:text-text-main"
            >
              {link.label}
            </a>
          ))}
        </nav>

        <div className="hidden md:block">
          <LinkButton
            href={BUSINESS_URL}
            target="_blank"
            rel="noopener noreferrer"
            variant="primary"
            className="px-5 py-2"
          >
            Portal de comercios
          </LinkButton>
        </div>

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex h-9 w-9 items-center justify-center text-text-main md:hidden"
          aria-label={open ? 'Cerrar menú' : 'Abrir menú'}
          aria-expanded={open}
        >
          {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>

      {open && (
        <div className="border-t border-border bg-bg px-6 py-6 md:hidden">
          <nav className="flex flex-col gap-5">
            {NAV_LINKS.map((link) => (
              <a
                key={link.href}
                href={link.href}
                onClick={() => setOpen(false)}
                className="text-sm text-text-secondary hover:text-text-main"
              >
                {link.label}
              </a>
            ))}
            <LinkButton
              href={BUSINESS_URL}
              target="_blank"
              rel="noopener noreferrer"
              variant="primary"
              className="mt-2 w-full"
            >
              Portal de comercios
            </LinkButton>
          </nav>
        </div>
      )}
    </header>
  );
}
