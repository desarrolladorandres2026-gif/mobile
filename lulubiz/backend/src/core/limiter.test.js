import { describe, expect, it } from 'vitest';
import { BusyError, createKeyedLimiter } from './limiter.js';

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe('limitador por clave', () => {
  it('nunca ejecuta más de las permitidas a la vez por clave, y respeta el orden de llegada', async () => {
    const limiter = createKeyedLimiter({ maxConcurrent: 2 });
    let active = 0;
    let peak = 0;
    const order = [];
    const task = (name) => async () => {
      active += 1;
      peak = Math.max(peak, active);
      order.push(name);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return name;
    };
    const results = await Promise.all(['a', 'b', 'c', 'd', 'e'].map((n) => limiter.run('k', task(n))));
    expect(results).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(peak).toBe(2);
    expect(order).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('claves distintas no se estorban entre sí', async () => {
    const limiter = createKeyedLimiter({ maxConcurrent: 1 });
    const gate = deferred();
    const slow = limiter.run('a', () => gate.promise);
    // 'b' corre aunque 'a' esté ocupada.
    expect(await limiter.run('b', async () => 'listo')).toBe('listo');
    expect(limiter.stats('a')).toEqual({ active: 1, queued: 0 });
    gate.resolve();
    await slow;
    expect(limiter.stats('a')).toEqual({ active: 0, queued: 0 });
  });

  it('libera el turno aunque la operación falle', async () => {
    const limiter = createKeyedLimiter({ maxConcurrent: 1 });
    await expect(limiter.run('k', async () => { throw new Error('falló'); })).rejects.toThrow('falló');
    expect(await limiter.run('k', async () => 'siguiente')).toBe('siguiente');
  });

  it('rechaza con BusyError cuando la cola está llena', async () => {
    const limiter = createKeyedLimiter({ maxConcurrent: 1, maxQueue: 1 });
    const gate = deferred();
    const first = limiter.run('k', () => gate.promise);
    const second = limiter.run('k', async () => 'segundo'); // en cola
    await expect(limiter.run('k', async () => 'tercero')).rejects.toBeInstanceOf(BusyError);
    gate.resolve();
    await first;
    expect(await second).toBe('segundo');
  });

  it('rechaza con BusyError si espera demasiado, y no deja la cola atascada', async () => {
    const limiter = createKeyedLimiter({ maxConcurrent: 1, queueTimeoutMs: 30 });
    const gate = deferred();
    const first = limiter.run('k', () => gate.promise);
    await expect(limiter.run('k', async () => 'nunca')).rejects.toBeInstanceOf(BusyError);
    expect(limiter.stats('k').queued).toBe(0);
    gate.resolve();
    await first;
    expect(await limiter.run('k', async () => 'después')).toBe('después');
  });

  it('no acumula estado de claves ya inactivas', async () => {
    const limiter = createKeyedLimiter({ maxConcurrent: 1 });
    await limiter.run('x', async () => 1);
    expect(limiter.stats('x')).toEqual({ active: 0, queued: 0 });
  });
});
