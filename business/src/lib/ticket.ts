import { describeExtras, type BusinessOrder } from './orderFlow';

/**
 * La comanda que se imprime en la cocina, a partir del pedido.
 *
 * El contenedor (`desktop/src/shared/ticket.ts`) valida este objeto y rechaza
 * lo que se pase de largo, así que aquí se recorta antes en vez de dejar que
 * un pedido con una nota larga no imprima nada.
 *
 * Es una comanda, no una factura: el total es lo vendido en productos
 * (`subtotal`), sin domicilio, propina ni descuentos de plataforma, y cada
 * línea lleva sus adicionales y su nota porque eso es lo que la cocina lee.
 */

export interface Ticket {
  orderNumber: string;
  businessName: string;
  items: Array<{ name: string; quantity: number; price: number }>;
  total: number;
  paperWidthMm: 58 | 80;
  notes?: string;
}

const MAX_NAME = 200;
const MAX_NOTES = 500;
const MAX_ITEMS = 100;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Entero no negativo: el contenedor no acepta centavos ni negativos. */
const wholeMoney = (value: number | null | undefined) => {
  const n = Math.round(Number(value) || 0);
  return n > 0 ? n : 0;
};

export function buildTicket(
  order: Pick<BusinessOrder, 'orderNumber' | 'items' | 'subtotal' | 'notes'>,
  businessName: string,
  paperWidthMm: number
): Ticket {
  const items = order.items.slice(0, MAX_ITEMS).map((item) => {
    const extras = describeExtras(item.selectedExtras);
    const note = item.notes?.trim();
    const name = [item.productName, extras, note ? `Nota: ${note}` : '']
      .filter(Boolean)
      .join(' · ');
    return {
      name: clip(name || 'Producto', MAX_NAME),
      quantity: Math.min(999, Math.max(1, Math.round(item.quantity) || 1)),
      price: wholeMoney(item.unitPrice),
    };
  });

  const extraLines = order.items.length - items.length;
  const notes = [order.notes?.trim(), extraLines > 0 ? `+${extraLines} líneas más en el panel` : '']
    .filter(Boolean)
    .join('\n');

  return {
    orderNumber: clip(String(order.orderNumber), 20),
    businessName: clip(businessName || 'Comanda', MAX_NAME),
    items,
    total: wholeMoney(order.subtotal),
    paperWidthMm: paperWidthMm === 58 ? 58 : 80,
    ...(notes ? { notes: clip(notes, MAX_NOTES) } : {}),
  };
}
