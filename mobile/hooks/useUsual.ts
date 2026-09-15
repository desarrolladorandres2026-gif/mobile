import { useMemo } from 'react';
import { useMyOrders } from './useApi';
import { useCartStore } from '../stores/cartStore';

export interface UsualOrder {
  orderId: string;
  businessId: string;
  businessName: string;
  businessCategory: string;
  /** Resumen legible: "Hamburguesa doble y 2 más". */
  summary: string;
  itemCount: number;
  total: number;
  /** Cuántas veces se ha pedido lo mismo en este negocio. */
  timesOrdered: number;
  items: any[];
}

/**
 * "Lo de siempre": los pedidos que vale la pena repetir.
 *
 * En un pueblo la gente no explora un catálogo cada noche; pide otra vez lo
 * mismo del mismo sitio. Por eso el inicio abre con esto y no con
 * promociones: es lo que la persona vino a hacer, a un toque en vez de cinco.
 *
 * Se arma del historial real, agrupando por negocio y dejando el pedido más
 * reciente de cada uno.
 */
export function useUsual(limit = 5) {
  const { data, isLoading } = useMyOrders(1);

  const usual = useMemo<UsualOrder[]>(() => {
    const orders: any[] = data?.orders ?? [];

    const delivered = orders
      .filter((o) => o.status === 'delivered' && o.businessId?._id && o.items?.length)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const byBusiness = new Map<string, UsualOrder>();

    for (const order of delivered) {
      const id = order.businessId._id;
      const existing = byBusiness.get(id);

      if (existing) {
        // Ya tenemos el más reciente de este negocio; esto solo suma frecuencia.
        existing.timesOrdered += 1;
        continue;
      }

      const items = order.items ?? [];
      const first = items[0]?.productName ?? 'Tu pedido';
      const extra = items.length - 1;

      byBusiness.set(id, {
        orderId: order._id,
        businessId: id,
        businessName: order.businessId.name ?? 'Negocio',
        businessCategory: order.businessId.category ?? 'restaurant',
        summary: extra > 0 ? `${first} y ${extra} más` : first,
        itemCount: items.reduce((n: number, i: any) => n + (i.quantity ?? 1), 0),
        total: order.total ?? 0,
        timesOrdered: 1,
        items,
      });
    }

    return Array.from(byBusiness.values())
      .sort((a, b) => b.timesOrdered - a.timesOrdered)
      .slice(0, limit);
  }, [data, limit]);

  return { usual, isLoading };
}

/**
 * Vuelve a armar la bolsa con un pedido anterior.
 *
 * Se copian nombres, cantidades y adicionales, nunca los precios finales: el
 * servidor vuelve a cotizar todo al llegar al checkout. Si el local subió un
 * precio desde la última vez, el cliente lo ve antes de confirmar en vez de
 * enterarse al recibir la factura.
 */
export function reorder(usual: UsualOrder) {
  const cart = useCartStore.getState();
  cart.clearCart();

  for (const item of usual.items) {
    cart.addItem(usual.businessId, usual.businessName, {
      productId: typeof item.productId === 'object' ? item.productId._id : item.productId,
      productName: item.productName,
      quantity: item.quantity ?? 1,
      unitPrice: item.unitPrice ?? 0,
      // Los ids de grupo y opción se conservan: son lo que el servidor
      // necesita para volver a resolver la misma elección.
      selectedExtras: (item.selectedExtras ?? []).map((e: any) => ({
        name: e.name,
        price: e.price ?? 0,
        quantity: e.quantity ?? 1,
        ...(e.optionId ? { groupId: e.groupId, groupName: e.groupName, optionId: e.optionId } : {}),
      })),
      notes: item.notes ?? '',
    });
  }
}

/**
 * Racha y puntos, calculados del historial real.
 *
 * No hay tabla de fidelización en el servidor todavía, así que esto se deriva
 * de los pedidos que ya existen. Es honesto: muestra lo que de verdad has
 * pedido, sin prometer un canje que el backend aún no puede cumplir.
 */
export function useZippStats() {
  const { data } = useMyOrders(1);

  return useMemo(() => {
    const orders: any[] = data?.orders ?? [];
    const delivered = orders.filter((o) => o.status === 'delivered');

    const totalSpent = delivered.reduce((sum, o) => sum + (o.total ?? 0), 0);
    // Un punto por cada mil pesos entregados.
    /**
     * OBSOLETO: los puntos viven ahora en el servidor.
     *
     * Este cálculo salía del historial local, así que cambiaba de teléfono
     * a teléfono y desaparecía al reinstalar. Se conserva solo porque
     * pantallas viejas podrían leerlo mientras se migran; el saldo bueno
     * es `useLoyalty().balance`. No lo uses en nada nuevo.
     */
    const points = Math.floor(totalSpent / 1000);

    // Semanas seguidas con al menos un pedido, contando hacia atrás.
    const weeks = new Set(
      delivered.map((o) => {
        const d = new Date(o.createdAt);
        const firstJan = new Date(d.getFullYear(), 0, 1);
        const week = Math.floor((d.getTime() - firstJan.getTime()) / (7 * 86_400_000));
        return `${d.getFullYear()}-${week}`;
      })
    );

    const now = new Date();
    const firstJan = new Date(now.getFullYear(), 0, 1);
    const currentWeek = Math.floor((now.getTime() - firstJan.getTime()) / (7 * 86_400_000));

    let streak = 0;
    for (let back = 0; back < 52; back++) {
      const w = currentWeek - back;
      const key = w >= 0 ? `${now.getFullYear()}-${w}` : `${now.getFullYear() - 1}-${52 + w}`;
      if (weeks.has(key)) streak++;
      else if (back > 0) break;
    }

    const favoriteBusiness = mostFrequent(
      delivered.map((o) => o.businessId?.name).filter(Boolean)
    );

    return {
      orderCount: delivered.length,
      totalSpent,
      points,
      streak,
      favoriteBusiness,
    };
  }, [data]);
}

function mostFrequent(values: string[]): string | null {
  if (values.length === 0) return null;
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0][0];
}
