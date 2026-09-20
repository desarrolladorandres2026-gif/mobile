import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * El cupón que alguien eligió en Descuentos, esperando en el pago.
 *
 * Hasta ahora el camino entre ver un cupón y usarlo pasaba por la memoria
 * del cliente: la tarjeta enseñaba el código, y en el checkout había que
 * teclearlo de nuevo sin equivocarse. Guardarlo aquí cierra ese hueco sin
 * cambiar quién manda: el código viaja, pero **el descuento lo sigue
 * decidiendo la cotización del servidor**. Esto es un recordatorio, no una
 * promesa de dinero.
 *
 * Se guarda uno solo. Un pedido admite un cupón y ya: una lista de cupones
 * guardados obligaría a elegir entre ellos justo en el momento de pagar,
 * que es cuando menos ganas hay de decidir nada.
 *
 * Persistido porque el camino normal no cabe en una sesión: alguien ve el
 * cupón a media mañana, entra al negocio, arma el carrito y paga por la
 * tarde, cerrando la app un par de veces por el camino.
 */
interface CouponState {
  /** El código elegido, siempre en mayúsculas. `null` si no hay ninguno. */
  code: string | null;
  /** Para qué negocio se eligió. `null` si sirve en cualquiera. */
  businessId: string | null;

  save: (code: string, businessId?: string | null) => void;
  /** Lo olvida. Se llama al aplicarlo y también cuando el servidor lo rechaza. */
  clear: () => void;
  /**
   * El código que corresponde usar en este negocio, o `null`.
   *
   * Un cupón guardado para la Pizzería no tiene por qué aparecer
   * pre-aplicado en la Panadería: el pago fallaría y el error parecería del
   * negocio, no del cupón.
   */
  codeFor: (businessId: string) => string | null;
}

export const useCouponStore = create<CouponState>()(
  persist(
    (set, get) => ({
      code: null,
      businessId: null,

      save: (code, businessId = null) =>
        set({ code: code.trim().toUpperCase(), businessId: businessId ?? null }),

      clear: () => set({ code: null, businessId: null }),

      codeFor: (businessId) => {
        const { code, businessId: saved } = get();
        if (!code) return null;
        return !saved || saved === businessId ? code : null;
      },
    }),
    {
      name: 'zipp-coupon',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({ code: state.code, businessId: state.businessId }),
    }
  )
);
