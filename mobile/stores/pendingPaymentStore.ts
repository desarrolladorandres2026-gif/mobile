import { create } from 'zustand';
import type { SelectedInstrument } from '../lib/paymentInstrument';

/**
 * El método de pago elegido en el checkout, de camino a la pantalla que
 * cobra.
 *
 * Existe para no pasarlo por los parámetros de la ruta: ahí terminaría en
 * la URL del deep link, en el historial de navegación y en cualquier
 * informe de error que los registre, y una tarjeta nueva viaja como token
 * cobrable. Por lo mismo **no** se persiste: vive solo en memoria y se
 * consume una vez.
 *
 * Si Android mata la app entre el checkout y el cobro, esto se pierde y la
 * pantalla de pago vuelve a preguntar el método. Es lo correcto: mejor
 * pedirlo otra vez que cobrar con algo que nadie ve.
 */
interface PendingPaymentState {
  orderId: string | null;
  selected: SelectedInstrument | null;
  put: (orderId: string, selected: SelectedInstrument) => void;
  /** Devuelve el método solo para ese pedido, y lo olvida. */
  take: (orderId: string) => SelectedInstrument | null;
}

export const usePendingPaymentStore = create<PendingPaymentState>()((set, get) => ({
  orderId: null,
  selected: null,
  put: (orderId, selected) => set({ orderId, selected }),
  take: (orderId) => {
    const { orderId: pendingFor, selected } = get();
    set({ orderId: null, selected: null });
    return pendingFor === orderId ? selected : null;
  },
}));
