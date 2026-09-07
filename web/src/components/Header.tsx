import { useState } from 'react';
import { Menu, X } from 'lucide-react';
import { ZippWordmark } from './ZippMark';

const BUSINESS_URL = import.meta.env.VITE_BUSINESS_URL || 'http://localhost:3002';

const NAV_LINKS = [
  { href: '#inicio', label: 'INICIO' },
  { href: '#simulador', label: 'TELEMETRÍA' },
  { href: '#operaciones', label: 'OPERACIONES' },
  { href: '#metricas', label: 'RENDIMIENTO' },
  { href: '#descargar', label: 'OBTENER APP' },
];

export default function Header() {
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 border-b border-white/10 bg-[#06080C]/90 backdrop-blur-xl">
      <div className="mx-auto flex h-18 max-w-7xl items-center justify-between px-6 sm:px-10">
        {/* Logotipo ZIPP con la corona dorada */}
        <a href="#inicio" className="shrink-0 flex items-center gap-3" onClick={() => setOpen(false)}>
          <ZippWordmark size={30} dark />
        </a>

        {/* Enlaces de navegación desktop */}
        <nav className="hidden items-center gap-8 md:flex font-mono">
          {NAV_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="text-[11px] font-semibold tracking-[0.2em] text-zinc-400 transition-colors hover:text-[#E5B242]"
            >
              {link.label}
            </a>
          ))}
        </nav>

        {/* Botones de acción desktop */}
        <div className="hidden items-center gap-4 md:flex font-mono">
          <a
            href={BUSINESS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="px-5 py-2.5 text-xs font-bold uppercase tracking-wider text-black bg-[#E5B242] transition-all hover:bg-white hover:text-black shadow-[inset_0_1px_0_rgba(255,255,255,0.4)]"
          >
            Portal Comercios ↗
          </a>
        </div>

        {/* Botón hamburguesa móvil */}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex h-10 w-10 items-center justify-center border border-white/10 text-white md:hidden"
          aria-label={open ? 'Cerrar menú' : 'Abrir menú'}
          aria-expanded={open}
        >
          {open ? <X className="h-5 w-5 text-[#E5B242]" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>

      {/* Menú desplegable móvil */}
      {open && (
        <div className="border-t border-white/10 bg-[#06080C] px-6 py-6 font-mono md:hidden">
          <nav className="flex flex-col gap-3">
            {NAV_LINKS.map((link) => (
              <a
                key={link.href}
                href={link.href}
                onClick={() => setOpen(false)}
                className="py-2 text-xs font-bold tracking-widest text-zinc-300 hover:text-[#E5B242]"
              >
                {link.label}
              </a>
            ))}
            <div className="mt-4 pt-4 border-t border-white/10">
              <a
                href={BUSINESS_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="block text-center py-3 text-xs font-bold uppercase tracking-wider text-black bg-[#E5B242]"
              >
                Portal Comercios ↗
              </a>
            </div>
          </nav>
        </div>
      )}
    </header>
  );
}
