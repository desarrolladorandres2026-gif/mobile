import { Link } from 'react-router-dom';
import { estimatedSubtotal, itemCount, useCart } from '../lib/cart';
import { money } from '../lib/format';

/**
 * Barra fija con lo que hay en el carrito. La suma es orientativa; el total
 * a pagar (envío, servicio, descuentos) lo calcula el servidor en el pedido.
 */
export function CartBar() {
  const cart = useCart();
  const count = itemCount(cart);
  if (count === 0) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border-strong bg-bg" style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>
      <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-6 py-3 sm:px-10">
        <p className="text-base text-text-main">
          <span className="font-semibold">{count} {count === 1 ? 'producto' : 'productos'}</span>
          {' · '}
          <span className="tabular-nums">{money(estimatedSubtotal(cart))}</span>
          <span className="text-text-secondary"> + envío</span>
        </p>
        <Link
          to="/pedido"
          className="inline-flex min-h-11 items-center bg-primary px-6 text-base font-semibold text-text-main transition-colors duration-100 hover:bg-primary-light"
        >
          Ver pedido
        </Link>
      </div>
    </div>
  );
}
