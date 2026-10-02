import { describe, it, expect } from 'vitest';
import {
  isActionable, isForeignCancellation, ringPatternFor, waitingOrders, waitingSince,
  type EscalationInput,
} from './orderAlarm';
import type { BusinessOrder } from './orderFlow';

const NOW = Date.parse('2026-09-30T15:00:00Z');
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

function order(id: string, extra: Partial<BusinessOrder> = {}): BusinessOrder {
  return {
    _id: id,
    orderNumber: id,
    status: 'pending',
    createdAt: minutesAgo(1),
    items: [],
    subtotal: 1000,
    total: 1000,
    paymentMethod: 'cash_on_delivery',
    ...extra,
  };
}

describe('isActionable', () => {
  it('un pendiente en efectivo se puede aceptar', () => {
    expect(isActionable(order('a'))).toBe(true);
  });

  it('un pedido en línea solo cuando está pagado', () => {
    expect(isActionable(order('a', { paymentMethod: 'online', paymentStatus: 'pending' }))).toBe(false);
    expect(isActionable(order('a', { paymentMethod: 'online', paymentStatus: 'failed' }))).toBe(false);
    expect(isActionable(order('a', { paymentMethod: 'online', paymentStatus: 'paid' }))).toBe(true);
  });

  it('lo que ya se aceptó no suena más', () => {
    for (const status of ['accepted', 'preparing', 'ready', 'cancelled'] as const) {
      expect(isActionable(order('a', { status }))).toBe(false);
    }
  });
});

describe('waitingSince', () => {
  it('desde que entró, en un pedido normal', () => {
    const o = order('a', { createdAt: minutesAgo(12) });
    expect(waitingSince(o)).toBe(NOW - 12 * 60_000);
  });

  it('un programado espera desde que se activó, no desde que se creó', () => {
    const o = order('a', { createdAt: minutesAgo(60 * 24), scheduledActivatedAt: minutesAgo(3) });
    expect(waitingSince(o)).toBe(NOW - 3 * 60_000);
  });

  it('un pedido en línea espera desde que este panel lo vio pagado', () => {
    const o = order('a', { paymentMethod: 'online', paymentStatus: 'paid', createdAt: minutesAgo(15) });
    expect(waitingSince(o, NOW - 2 * 60_000)).toBe(NOW - 2 * 60_000);
  });

  it('sin ese dato, cae a createdAt (adelanta el escalamiento: el error seguro)', () => {
    const o = order('a', { paymentMethod: 'online', paymentStatus: 'paid', createdAt: minutesAgo(15) });
    expect(waitingSince(o)).toBe(NOW - 15 * 60_000);
  });
});

describe('waitingOrders', () => {
  const a = order('a', { createdAt: minutesAgo(10) });
  const b = order('b', { createdAt: minutesAgo(30) });
  const c = order('c', { status: 'accepted' });

  it('solo los aceptables, el más antiguo primero', () => {
    expect(waitingOrders([a, b, c]).map((o) => o._id)).toEqual(['b', 'a']);
  });
});

describe('ringPatternFor', () => {
  it('sin pedidos que suenen no hay patrón', () => {
    expect(ringPatternFor([], NOW)).toBeNull();
  });

  it('entrega a la política los minutos del más antiguo y cuántos suenan', () => {
    const seen: EscalationInput[] = [];
    const policy = (input: EscalationInput) => { seen.push(input); return 'urgent' as const; };
    const ringing = [order('a', { createdAt: minutesAgo(25) }), order('b', { createdAt: minutesAgo(4) })];

    expect(ringPatternFor(ringing, NOW, {}, policy)).toBe('urgent');
    expect(seen).toEqual([{ oldestWaitingMinutes: 25, ringingCount: 2 }]);
  });

  it('mientras el usuario no escriba su política, el timbre es normal', () => {
    expect(ringPatternFor([order('a', { createdAt: minutesAgo(99) })], NOW)).toBe('normal');
  });
});

describe('isForeignCancellation', () => {
  it('cancela el cliente, ZIPP o el sistema: es ajena', () => {
    for (const cancelledBy of ['client', 'admin', 'system', 'driver'] as const) {
      expect(isForeignCancellation({ status: 'cancelled', cancelledBy })).toBe(true);
    }
  });

  it('el rechazo del propio local no lo es', () => {
    expect(isForeignCancellation({ status: 'cancelled', cancelledBy: 'business' })).toBe(false);
  });

  it('sin autor se da por ajena: un aviso de más, nunca de menos', () => {
    expect(isForeignCancellation({ status: 'cancelled' })).toBe(true);
  });

  it('otro estado no es una cancelación', () => {
    expect(isForeignCancellation({ status: 'accepted', cancelledBy: 'client' })).toBe(false);
  });
});
