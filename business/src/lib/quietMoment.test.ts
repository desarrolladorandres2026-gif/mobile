import { describe, it, expect } from 'vitest';
import { isQuietMoment } from './quietMoment';

describe('isQuietMoment', () => {
  it('es tranquilo sin nada sonando', () => {
    expect(isQuietMoment({ ringingCount: 0 })).toBe(true);
  });

  it('no es tranquilo con algo esperando', () => {
    expect(isQuietMoment({ ringingCount: 1 })).toBe(false);
  });
});
