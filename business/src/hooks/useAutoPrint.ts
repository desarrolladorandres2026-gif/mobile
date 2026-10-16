import { useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '../stores/authStore';
import { qk } from '../lib/queryKeys';
import { desktopSettings, isDesktop, printTicketOnDesktop } from '../lib/desktop';
import { buildTicket } from '../lib/ticket';
import type { BusinessOrder } from '../lib/orderFlow';
import { useBusinessEvent } from './realtimeContext';

/**
 * Imprime la comanda cuando un pedido pasa a «aceptado», en la app de
 * escritorio y solo si «Este equipo» tiene la impresión automática activa.
 *
 * Se imprime por el evento y no por el botón de quien acepta: el aceptado
 * puede venir de otro dispositivo (el celular del encargado) y la impresora
 * de la cocina es la de este equipo.
 *
 * Un mismo pedido no se imprime dos veces en el mismo equipo. El socket se
 * reconecta y reenvía eventos; sin esta marca, cada reconexión reimprimía la
 * comanda y la cocina preparaba el pedido por duplicado. La marca se guarda
 * antes de imprimir: es preferible no imprimir una vez que imprimir dos. Si
 * falla, la ficha del pedido tiene «Imprimir comanda» para reintentar.
 */

const PRINTED_KEY = 'zipp_printed_orders';
const REMEMBER = 200;

function readPrinted(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(PRINTED_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/** true si ya estaba marcado. Si no, lo marca. */
export function markPrinted(orderId: string): boolean {
  const printed = readPrinted();
  if (printed.includes(orderId)) return true;
  try {
    localStorage.setItem(PRINTED_KEY, JSON.stringify([...printed, orderId].slice(-REMEMBER)));
  } catch {
    // Sin almacenamiento no hay marca: se imprime igual.
  }
  return false;
}

const settingValue = async <T,>(key: string, fallback: T): Promise<T> => {
  const result = (await desktopSettings.get(key)) as { ok: boolean; value?: unknown };
  return result.ok && result.value !== undefined && result.value !== null ? (result.value as T) : fallback;
};

export function useAutoPrint() {
  const queryClient = useQueryClient();
  const business = useAuthStore((s) => s.selectedBusiness);
  const businessId = business?._id;

  useBusinessEvent('order:status:changed', (changed) => {
    if (changed.status !== 'accepted' || !isDesktop()) return;
    if (changed.businessId && changed.businessId !== businessId) return;

    void (async () => {
      if (!(await settingValue<boolean>('autoPrint', false))) return;
      if (markPrinted(changed.orderId)) return;

      // La ficha corta del evento no trae las líneas: se lee la lista de
      // activos ya actualizada, que es la que usa el tablero.
      await queryClient.refetchQueries({ queryKey: qk.activeOrders(businessId) });
      const order = queryClient
        .getQueryData<BusinessOrder[]>(qk.activeOrders(businessId))
        ?.find((candidate) => candidate._id === changed.orderId);
      if (!order) {
        console.warn('[auto-print] el pedido aceptado no está en la lista de activos', changed.orderId);
        return;
      }

      const paperWidthMm = await settingValue<number>('paperWidthMm', 80);
      const result = await printTicketOnDesktop(buildTicket(order, business?.name ?? '', paperWidthMm));
      if (!result.ok) console.warn('[auto-print] no se pudo imprimir', result.error);
    })();
  });
}
