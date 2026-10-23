import { Link } from 'react-router-dom';
import { ZippWordmark } from './ZippMark';
import { SUPPORT_PHONE, SUPPORT_PHONE_DISPLAY, supportWhatsAppUrl } from '../lib/contact';
import { BUSINESS_URL } from '../lib/config';
import { LEGAL_LINKS } from '../lib/legal';


const LINK_CLASS =
  'inline-flex min-h-11 items-center text-base text-text-secondary transition-colors duration-100 hover:text-text-main';

export default function Footer() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto flex max-w-6xl flex-col gap-8 px-6 py-10 sm:px-10 md:flex-row md:justify-between">
        <div>
          <ZippWordmark size={22} />
          <p className="mt-3 text-sm text-text-secondary">© {new Date().getFullYear()} ZIPP</p>
        </div>

        <nav aria-label="Información" className="flex flex-col">
          <Link to="/comercios" className={LINK_CLASS}>Comercios</Link>
          <Link to="/unete-comercio" className={LINK_CLASS}>Vende en ZIPP</Link>
          <Link to="/repartidores" className={LINK_CLASS}>Reparte con ZIPP</Link>
          <a href={BUSINESS_URL} target="_blank" rel="noopener noreferrer" className={LINK_CLASS}>
            Portal de comercios
          </a>
        </nav>

        <nav aria-label="Legal" className="flex flex-col">
          {LEGAL_LINKS.map((l) => (
            <Link key={l.kind} to={`/legal/${l.kind}`} className={LINK_CLASS}>{l.label}</Link>
          ))}
          <Link to="/eliminar-cuenta" className={LINK_CLASS}>Eliminar mi cuenta</Link>
        </nav>

        <div className="flex flex-col">
          <p className="text-base font-semibold text-text-main">Ayuda y PQR</p>
          <Link to="/soporte" className={LINK_CLASS}>Formulario de soporte</Link>
          <a
            href={supportWhatsAppUrl('Hola, necesito ayuda con ZIPP.')}
            target="_blank"
            rel="noopener noreferrer"
            className={LINK_CLASS}
          >
            Escríbenos por WhatsApp
          </a>
          <a href={`tel:${SUPPORT_PHONE}`} className={LINK_CLASS}>
            {SUPPORT_PHONE_DISPLAY}
          </a>
          <a
            href="https://github.com/twitter/twemoji"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 text-sm text-text-secondary underline underline-offset-4"
          >
            Ilustraciones: Twemoji © Twitter, Inc. y colaboradores, CC-BY 4.0
          </a>
        </div>
      </div>
    </footer>
  );
}
