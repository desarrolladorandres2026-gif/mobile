import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ZippWordmark } from './ZippMark';
import { LinkButton } from './Button';
import { BUSINESS_URL } from '../lib/config';
import { useAuth } from '../lib/useAuth';
import { itemCount, useCart } from '../lib/cart';


const NAV_LINKS = [
  { to: '/comercios', label: 'Comercios' },
  { to: '/#simulador', label: 'Tarifa de envío' },
  { to: '/unete-comercio', label: 'Vende en ZIPP' },
  { to: '/repartidores', label: 'Reparte con ZIPP' },
];

const NAV_LINK_CLASS =
  'inline-flex min-h-11 items-center text-base text-text-secondary transition-colors duration-100 hover:text-text-main';

export default function Header() {
  const [open, setOpen] = useState(false);
  const { status, user } = useAuth();
  const cartCount = itemCount(useCart());
  const accountLink = status === 'anonymous'
    ? { to: '/ingresar', label: 'Ingresar' }
    : { to: '/cuenta', label: user ? user.name.split(' ')[0] : 'Mi cuenta' };

  return (
    <header className="sticky top-0 z-50 border-b border-border bg-bg">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6 sm:px-10">
        <Link to="/" className="shrink-0" onClick={() => setOpen(false)} aria-label="ZIPP, ir al inicio">
          <ZippWordmark size={26} />
        </Link>

        <nav aria-label="Principal" className="hidden items-center gap-8 md:flex">
          {NAV_LINKS.map((link) => (
            <Link key={link.to} to={link.to} className={NAV_LINK_CLASS}>
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="hidden items-center gap-6 md:flex">
          {cartCount > 0 && <Link to="/pedido" className={`${NAV_LINK_CLASS} font-semibold text-text-main`}>Mi pedido ({cartCount})</Link>}
          {status === 'authenticated' && <Link to="/pedidos" className={NAV_LINK_CLASS}>Mis pedidos</Link>}
          <Link to={accountLink.to} className={`${NAV_LINK_CLASS} font-semibold text-text-main`}>{accountLink.label}</Link>
          <LinkButton href={BUSINESS_URL} target="_blank" rel="noopener noreferrer" variant="secondary">
            Portal de comercios
          </LinkButton>
        </div>

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="min-h-11 px-2 text-base font-semibold text-text-main md:hidden"
          aria-expanded={open}
          aria-controls="menu-movil"
        >
          {open ? 'Cerrar' : 'Menú'}
        </button>
      </div>

      {open && (
        <div id="menu-movil" className="border-t border-border bg-bg px-6 py-4 md:hidden">
          <nav aria-label="Principal" className="flex flex-col">
            {NAV_LINKS.map((link) => (
              <Link key={link.to} to={link.to} onClick={() => setOpen(false)} className={NAV_LINK_CLASS}>
                {link.label}
              </Link>
            ))}
            {cartCount > 0 && <Link to="/pedido" onClick={() => setOpen(false)} className={`${NAV_LINK_CLASS} font-semibold text-text-main`}>Mi pedido ({cartCount})</Link>}
            {status === 'authenticated' && <Link to="/pedidos" onClick={() => setOpen(false)} className={NAV_LINK_CLASS}>Mis pedidos</Link>}
            <Link to={accountLink.to} onClick={() => setOpen(false)} className={`${NAV_LINK_CLASS} font-semibold text-text-main`}>
              {accountLink.label}
            </Link>
            <LinkButton
              href={BUSINESS_URL}
              target="_blank"
              rel="noopener noreferrer"
              variant="secondary"
              className="mt-3 w-full"
            >
              Portal de comercios
            </LinkButton>
          </nav>
        </div>
      )}
    </header>
  );
}
