import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { announceChange, COALESCE_MS } from '../realtime/invalidate';
import { setIO } from '../sockets/emitter';

describe('announceChange', () => {
  const emit = vi.fn();
  const to = vi.fn(() => ({ emit }));

  beforeEach(() => {
    vi.useFakeTimers();
    emit.mockClear();
    to.mockClear();
    setIO({ to } as never);
  });
  afterEach(() => vi.useRealTimers());

  it('agrupa una ráfaga en un solo aviso, sin datos, a la sala live', () => {
    for (let i = 0; i < 20; i++) announceChange('orders');
    expect(emit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(COALESCE_MS);
    expect(to).toHaveBeenCalledWith('admin:live');
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('invalidate', { resource: 'orders' });
  });

  it('cada recurso se anuncia por separado y una nueva ráfaga vuelve a avisar', () => {
    announceChange('orders');
    announceChange('users');
    vi.advanceTimersByTime(COALESCE_MS);
    expect(emit).toHaveBeenCalledTimes(2);
    announceChange('orders');
    vi.advanceTimersByTime(COALESCE_MS);
    expect(emit).toHaveBeenCalledTimes(3);
  });
});
