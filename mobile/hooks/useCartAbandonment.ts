import { useEffect, useRef } from 'react';
import { useCartStore } from '../stores/cartStore';
import { useAuthStore } from '../stores/authStore';
import { cartApi } from '../services/endpoints';

const SYNC_DEBOUNCE_MS = 4_000;

/**
 * Le avisa al servidor cómo va la bolsa, con rebote, para que pueda mandar
 * el recordatorio de "se te quedó la bolsa llena" si el cliente la deja
 * quieta mucho rato. La bolsa en sí sigue viviendo solo en el teléfono —
 * esto manda apenas lo necesario para el recordatorio: negocio, cuántos
 * productos, cuánto suma.
 *
 * Nunca bloquea ni avisa de un fallo: si el ping no llega, el peor caso es
 * que no salga el recordatorio, no que se rompa la compra.
 */
export function useCartAbandonment() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const carts = useCartStore((s) => s.carts);
  const getSubtotal = useCartStore((s) => s.getSubtotal);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!isAuthenticated) return;

    if (timer.current) clearTimeout(timer.current);

    if (carts.length === 0) {
      // Sin bolsas: se limpia de inmediato, sin rebote, para no dejar un
      // recordatorio pendiente de un carrito que ya no existe.
      cartApi.clear().catch(() => {});
      return;
    }

    timer.current = setTimeout(() => {
      // Una bolsa por negocio: cada una manda su propio aviso de abandono.
      carts.forEach((cart) => {
        const itemCount = cart.items.reduce((sum, i) => sum + i.quantity, 0);
        cartApi
          .sync(cart.businessId, cart.businessName, itemCount, getSubtotal(cart.businessId))
          .catch(() => {});
      });
    }, SYNC_DEBOUNCE_MS);

    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [isAuthenticated, carts, getSubtotal]);
}
