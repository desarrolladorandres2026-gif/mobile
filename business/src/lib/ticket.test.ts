import { describe, it, expect } from 'vitest';
import { buildTicket } from './ticket';
import type { BusinessOrder } from './orderFlow';

const order = (patch: Partial<BusinessOrder> = {}): BusinessOrder =>
  ({
    _id: 'o1',
    orderNumber: '1042',
    status: 'accepted',
    createdAt: '2026-10-15T20:00:00Z',
    items: [
      { productName: 'Hamburguesa', quantity: 2, unitPrice: 24000, totalPrice: 48000, notes: 'sin cebolla' },
      {
        productName: 'Papas',
        quantity: 1,
        unitPrice: 8000,
        totalPrice: 8000,
        selectedExtras: [{ name: 'Queso extra', quantity: 1 }],
      },
    ],
    subtotal: 56000,
    total: 61000,
    ...patch,
  }) as BusinessOrder;

describe('buildTicket', () => {
  it('lleva las líneas con su nota y adicionales, y el total de productos', () => {
    const ticket = buildTicket(order(), 'La Esquina', 80);
    expect(ticket.orderNumber).toBe('1042');
    expect(ticket.businessName).toBe('La Esquina');
    expect(ticket.items[0]).toEqual({ name: 'Hamburguesa · Nota: sin cebolla', quantity: 2, price: 24000 });
    expect(ticket.items[1].name).toBe('Papas · 1× Queso extra');
    // Lo vendido en productos, no el total del cliente con domicilio.
    expect(ticket.total).toBe(56000);
  });

  it('el ancho de papel solo puede ser 58 u 80', () => {
    expect(buildTicket(order(), 'X', 58).paperWidthMm).toBe(58);
    expect(buildTicket(order(), 'X', 80).paperWidthMm).toBe(80);
    expect(buildTicket(order(), 'X', 112).paperWidthMm).toBe(80);
  });

  it('recorta lo que el contenedor rechazaría en vez de dejar de imprimir', () => {
    const ticket = buildTicket(
      order({ notes: 'n'.repeat(900), items: [{ productName: 'p'.repeat(400), quantity: 1, unitPrice: 1, totalPrice: 1 }] }),
      'N'.repeat(400),
      80
    );
    expect(ticket.items[0].name.length).toBeLessThanOrEqual(200);
    expect(ticket.businessName.length).toBeLessThanOrEqual(200);
    expect(ticket.notes!.length).toBeLessThanOrEqual(500);
  });

  it('el dinero sale entero y no negativo, y la cantidad tiene techo', () => {
    const ticket = buildTicket(
      order({
        subtotal: 1234.7,
        items: [{ productName: 'A', quantity: 5000, unitPrice: -5, totalPrice: 0 }],
      }),
      'X',
      80
    );
    expect(Number.isInteger(ticket.total)).toBe(true);
    expect(ticket.items[0].price).toBe(0);
    expect(ticket.items[0].quantity).toBe(999);
  });

  it('avisa cuando hay más líneas de las que caben', () => {
    const items = Array.from({ length: 103 }, (_, i) => ({
      productName: `P${i}`,
      quantity: 1,
      unitPrice: 100,
      totalPrice: 100,
    }));
    const ticket = buildTicket(order({ items }), 'X', 80);
    expect(ticket.items).toHaveLength(100);
    expect(ticket.notes).toContain('+3 líneas más');
  });
});
