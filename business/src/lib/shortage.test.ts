import { describe, it, expect } from 'vitest';
import { buildShortageBody, isShortagePending, shortageCountdown, type ItemShortage, type OrderWithShortage } from './shortage';
import type { OrderItem } from './orderFlow';

const item = (id: string, quantity: number): OrderItem =>
  ({ _id: id, productName: id, quantity, unitPrice: 1000, totalPrice: 1000 * quantity }) as OrderItem;

const shortage = (patch: Partial<ItemShortage> = {}): ItemShortage => ({
  id: 's1',
  status: 'pending_client',
  reason: 'out_of_stock',
  items: [],
  requestedAt: '2026-10-16T12:00:00Z',
  expiresAt: '2026-10-16T12:03:00Z',
  refundAmount: 1000,
  ...patch,
});

describe('buildShortageBody', () => {
  it('manda solo las líneas con algo que falta', () => {
    const body = buildShortageBody([item('a', 2), item('b', 1)], { a: 1 }, 'damaged');
    expect(body).toEqual({ reason: 'damaged', items: [{ itemId: 'a', missingQty: 1 }] });
  });

  it('nunca pide más unidades de las que tiene la línea', () => {
    const body = buildShortageBody([item('a', 2)], { a: 9 }, 'out_of_stock');
    expect(body.items).toEqual([{ itemId: 'a', missingQty: 2 }]);
  });

  it('sin nada marcado no manda líneas', () => {
    expect(buildShortageBody([item('a', 2)], {}, 'other').items).toEqual([]);
  });
});

describe('estado de la consulta', () => {
  const order = (s: ItemShortage | null) => ({ itemShortage: s }) as OrderWithShortage;

  it('está pendiente solo mientras el cliente puede responder', () => {
    const before = new Date('2026-10-16T12:01:00Z').getTime();
    const after = new Date('2026-10-16T12:04:00Z').getTime();
    expect(isShortagePending(order(shortage()), before)).toBe(true);
    expect(isShortagePending(order(shortage()), after)).toBe(false);
    expect(isShortagePending(order(shortage({ status: 'accepted' })), before)).toBe(false);
    expect(isShortagePending(order(null), before)).toBe(false);
  });

  it('la cuenta regresiva se escribe m:ss y no baja de cero', () => {
    expect(shortageCountdown(shortage(), new Date('2026-10-16T12:00:19Z').getTime())).toBe('2:41');
    expect(shortageCountdown(shortage(), new Date('2026-10-16T12:10:00Z').getTime())).toBe('0:00');
  });
});
