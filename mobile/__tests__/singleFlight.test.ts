import { singleFlight } from '../lib/singleFlight';

/**
 * El candado que evita refrescos de sesión concurrentes.
 *
 * Sin él, dos peticiones que caducan a la vez dispararían dos refrescos con
 * el mismo refresh token; el backend trata el segundo uso como robo de
 * sesión y **revoca todas las sesiones del usuario**. El fallo no se ve en
 * ninguna pantalla — se ve como usuarios que se desconectan solos y no hay
 * forma de reproducirlo a mano sin dos peticiones exactamente simultáneas.
 */

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('singleFlight', () => {
  it('coalesce llamadas concurrentes en una sola ejecución', async () => {
    const calls: Array<ReturnType<typeof deferred<string>>> = [];
    const fn = jest.fn(() => {
      const d = deferred<string>();
      calls.push(d);
      return d.promise;
    });

    const run = singleFlight(fn);

    // Tres "peticiones" que caducan casi a la vez, como tres queries de
    // React Query montándose juntas.
    const p1 = run();
    const p2 = run();
    const p3 = run();

    expect(fn).toHaveBeenCalledTimes(1);

    calls[0].resolve('token-nuevo');

    await expect(p1).resolves.toBe('token-nuevo');
    await expect(p2).resolves.toBe('token-nuevo');
    await expect(p3).resolves.toBe('token-nuevo');
  });

  it('permite un intento nuevo después de que el anterior se asentó', async () => {
    const fn = jest.fn(async () => 'token');
    const run = singleFlight(fn);

    await run();
    await run();

    // Dos ráfagas separadas en el tiempo son dos refrescos legítimos, no la
    // misma llamada repetida.
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('libera el candado también cuando la llamada falla', async () => {
    const first = deferred<string>();
    const fn = jest
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(async () => 'token-tras-reintentar');

    const run = singleFlight(fn);

    const p1 = run();
    first.reject(new Error('sin refresh token'));
    await expect(p1).rejects.toThrow('sin refresh token');

    // Si el candado se quedara puesto tras un fallo, esta segunda llamada
    // recibiría el mismo rechazo colgado en vez de intentarlo de nuevo —y
    // la sesión quedaría cerrada para siempre en el primer refresco fallido,
    // aunque el segundo intento sí tuviera un refresh token válido.
    await expect(run()).resolves.toBe('token-tras-reintentar');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
