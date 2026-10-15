import { describe, it, expect } from 'vitest';
import { scheduledTone, untilLabel } from './scheduledOrders';

const MIN = 60_000;

describe('untilLabel', () => {
  it('lo dice como en la cocina', () => {
    expect(untilLabel(-5 * MIN)).toBe('Ya toca');
    expect(untilLabel(20_000)).toBe('En menos de 1 min');
    expect(untilLabel(12 * MIN)).toBe('En 12 min');
    expect(untilLabel(135 * MIN)).toBe('En 2 h 15 min');
    expect(untilLabel(120 * MIN)).toBe('En 2 h');
    expect(untilLabel(24 * 60 * MIN)).toBe('En 1 día');
    expect(untilLabel(72 * 60 * MIN)).toBe('En 3 días');
  });
});

describe('scheduledTone', () => {
  it('se calienta a medida que se acerca', () => {
    expect(scheduledTone(-1)).toBe('danger');
    expect(scheduledTone(30 * MIN)).toBe('warning');
    expect(scheduledTone(5 * 60 * MIN)).toBe('info');
    expect(scheduledTone(48 * 60 * MIN)).toBe('muted');
  });
});
