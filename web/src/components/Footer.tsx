import { ZippWordmark } from './ZippMark';
import { SUPPORT_PHONE, SUPPORT_PHONE_DISPLAY } from '../lib/contact';

const BUSINESS_URL = import.meta.env.VITE_BUSINESS_URL || 'http://localhost:3002';

const LINKS = [
  { href: '/#operaciones', label: 'Cómo funciona' },
  { href: BUSINESS_URL, label: 'Portal de comercios', external: true },
  { href: '/legal/terms', label: 'Términos' },
  { href: '/legal/privacy', label: 'Privacidad' },
  { href: '/legal/habeas_data', label: 'Tratamiento de datos' },
];

export default function Footer() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto max-w-6xl px-6 sm:px-10 py-10 flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
        <ZippWordmark size={22} />

        <nav className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-text-secondary">
          {LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              target={link.external ? '_blank' : undefined}
              rel={link.external ? 'noopener noreferrer' : undefined}
              className="hover:text-text-main transition-colors"
            >
              {link.label}
            </a>
          ))}
        </nav>

        <div className="flex flex-col gap-1 text-xs text-text-muted sm:items-end">
          <span>© {new Date().getFullYear()} Zipp</span>
          <a href={`tel:${SUPPORT_PHONE}`} className="hover:text-text-secondary">
            {SUPPORT_PHONE_DISPLAY}
          </a>
        </div>
      </div>
    </footer>
  );
}
