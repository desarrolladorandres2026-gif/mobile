import { describe, it, expect, vi } from 'vitest';
import {
  classifyRefreshError, createRefresher, decodeJwtPayload, needsRefresh, SessionEndedError,
  type RefresherDeps,
} from './sessionCore';

const NOW = 1_800_000_000_000; // ms

/** Un JWT sin firma real: lo único que se lee es el cuerpo. */
function jwt(payload: object) {
  // Como un JWT real: el cuerpo va en UTF-8 y luego en base64url.
  const b64 = (o: object) =>
    btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(o))))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'HS256' })}.${b64(payload)}.firma`;
}
const expiring = (inMs: number, extra: object = {}) => jwt({ exp: Math.floor((NOW + inMs) / 1000), ...extra });

const httpError = (status: number, code?: string) => ({ response: { status, data: { code } } });

describe('decodeJwtPayload', () => {
  it('lee exp e iat de un base64url sin relleno', () => {
    expect(decodeJwtPayload(jwt({ exp: 10, iat: 5, id: 'u1' }))).toMatchObject({ exp: 10, iat: 5, id: 'u1' });
  });

  it('respeta los acentos (UTF-8)', () => {
    expect(decodeJwtPayload(jwt({ id: 'José Ñandú' }))?.id).toBe('José Ñandú');
  });

  it('un valor roto, vacío o sin cuerpo da null', () => {
    expect(decodeJwtPayload('basura')).toBeNull();
    expect(decodeJwtPayload('a.%%%.c')).toBeNull();
    expect(decodeJwtPayload(null)).toBeNull();
    expect(decodeJwtPayload('')).toBeNull();
  });
});

describe('needsRefresh', () => {
  it('renueva si le queda menos que el margen', () => {
    expect(needsRefresh(expiring(60_000), NOW, 120_000)).toBe(true);
    expect(needsRefresh(expiring(300_000), NOW, 120_000)).toBe(false);
  });

  it('un token sin exp legible se da por caducado', () => {
    expect(needsRefresh('basura', NOW, 0)).toBe(true);
    expect(needsRefresh(jwt({ id: 'x' }), NOW, 0)).toBe(true);
    expect(needsRefresh(null, NOW, 0)).toBe(true);
  });

  it('corrige un reloj adelantado con el desfase del servidor', () => {
    // El equipo cree que son las NOW, pero el servidor va 10 min por delante.
    const token = expiring(5 * 60_000); // caduca a NOW+5min en hora del servidor
    expect(needsRefresh(token, NOW, 60_000, 0)).toBe(false);
    expect(needsRefresh(token, NOW, 60_000, 10 * 60_000)).toBe(true);
  });
});

describe('classifyRefreshError', () => {
  it('409 "en curso" es una carrera, no un cierre de sesión', () => {
    expect(classifyRefreshError(409, 'REFRESH_IN_PROGRESS')).toBe('race');
  });

  it('un rechazo definitivo termina la sesión', () => {
    expect(classifyRefreshError(401, 'REFRESH_INVALID')).toBe('fatal');
    expect(classifyRefreshError(401, 'REFRESH_REUSED')).toBe('fatal');
    expect(classifyRefreshError(401, 'ACCOUNT_UNAVAILABLE')).toBe('fatal');
    expect(classifyRefreshError(400, null)).toBe('fatal');
  });

  it('red caída, 5xx y 429 son transitorios: nunca cierran la sesión', () => {
    expect(classifyRefreshError(null, null)).toBe('transient');
    expect(classifyRefreshError(503, null)).toBe('transient');
    expect(classifyRefreshError(429, null)).toBe('transient');
  });
});

/** Un navegador de juguete: almacenamiento compartido y un servidor que rota. */
function harness(initial: { access: string | null; refresh: string | null }) {
  const storage = { ...initial };
  let counter = 0;
  const adopted: string[] = [];
  const saved: string[] = [];
  const deps: RefresherDeps = {
    readTokens: () => ({ ...storage }),
    adopt: (a) => { adopted.push(a); },
    save: (a, r) => { storage.access = a; storage.refresh = r; saved.push(a); },
    post: vi.fn(async (refresh: string) => {
      counter += 1;
      return { accessToken: expiring(15 * 60_000, { n: counter }), refreshToken: `${refresh}+${counter}` };
    }),
    // Un candado de verdad: una renovación a la vez.
    withLock: (() => {
      let tail: Promise<unknown> = Promise.resolve();
      return <T,>(fn: () => Promise<T>) => {
        const run = tail.then(fn, fn);
        tail = run.catch(() => undefined);
        return run;
      };
    })(),
    sleep: async () => {},
    now: () => NOW,
  };
  return { storage, deps, adopted, saved };
}

describe('createRefresher', () => {
  it('con el token vigente no llama al servidor', async () => {
    const h = harness({ access: expiring(10 * 60_000), refresh: 'r0' });
    const token = await createRefresher(h.deps)();
    expect(token).toBe(h.storage.access);
    expect(h.deps.post).not.toHaveBeenCalled();
  });

  it('dos renovaciones a la vez hacen una sola llamada', async () => {
    const h = harness({ access: expiring(-1000), refresh: 'r0' });
    const ensure = createRefresher(h.deps);
    const [a, b] = await Promise.all([ensure(), ensure()]);
    expect(h.deps.post).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it('si otra pestaña ya rotó el token, lo adopta sin pedir otro', async () => {
    // Esta pestaña arrancó con un token caducado, pero el almacenamiento
    // (escrito por otra pestaña) ya trae uno nuevo.
    const h = harness({ access: expiring(10 * 60_000, { otra: true }), refresh: 'r-de-la-otra-pestaña' });
    const token = await createRefresher(h.deps)({ minValidityMs: 30_000 });
    expect(h.deps.post).not.toHaveBeenCalled();
    expect(h.adopted).toEqual([token]);
  });

  it('un token que falló pero sigue "vigente" en el almacenamiento se renueva', async () => {
    const stale = expiring(10 * 60_000);
    const h = harness({ access: stale, refresh: 'r0' });
    await createRefresher(h.deps)({ failedToken: stale });
    expect(h.deps.post).toHaveBeenCalledTimes(1);
  });

  it('409 y luego otra pestaña termina la renovación: adopta su resultado', async () => {
    const h = harness({ access: expiring(-1000), refresh: 'r0' });
    (h.deps.post as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      // Mientras esperamos, la otra pestaña rota y guarda.
      h.storage.access = expiring(15 * 60_000, { otra: true });
      h.storage.refresh = 'r1';
      throw httpError(409, 'REFRESH_IN_PROGRESS');
    });
    const token = await createRefresher(h.deps)();
    expect(token).toBe(h.storage.access);
    expect(h.deps.post).toHaveBeenCalledTimes(1);
  });

  it('409 tres veces seguidas es transitorio, no un cierre de sesión', async () => {
    const h = harness({ access: expiring(-1000), refresh: 'r0' });
    (h.deps.post as ReturnType<typeof vi.fn>).mockRejectedValue(httpError(409, 'REFRESH_IN_PROGRESS'));
    const result = createRefresher(h.deps)();
    await expect(result).rejects.not.toBeInstanceOf(SessionEndedError);
    await expect(result).rejects.toThrow();
  });

  it('REFRESH_REUSED termina la sesión', async () => {
    const h = harness({ access: expiring(-1000), refresh: 'r0' });
    (h.deps.post as ReturnType<typeof vi.fn>).mockRejectedValue(httpError(401, 'REFRESH_REUSED'));
    await expect(createRefresher(h.deps)()).rejects.toBeInstanceOf(SessionEndedError);
  });

  it('un corte de red no cierra la sesión: el error sube tal cual', async () => {
    const h = harness({ access: expiring(-1000), refresh: 'r0' });
    const offline = new Error('Network Error');
    (h.deps.post as ReturnType<typeof vi.fn>).mockRejectedValue(offline);
    await expect(createRefresher(h.deps)()).rejects.toBe(offline);
  });

  it('tras un fallo transitorio hace una pausa: no vuelve a llamar al servidor', async () => {
    const h = harness({ access: expiring(-1000), refresh: 'r0' });
    (h.deps.post as ReturnType<typeof vi.fn>).mockRejectedValue(httpError(503));
    const ensure = createRefresher(h.deps);

    await expect(ensure()).rejects.toBeTruthy();
    await expect(ensure()).rejects.toThrow(/pausa/);
    await expect(ensure()).rejects.toThrow(/pausa/);
    expect(h.deps.post).toHaveBeenCalledTimes(1);
  });

  it('respeta Retry-After y vuelve a intentar cuando pasa la pausa', async () => {
    const h = harness({ access: expiring(-1000), refresh: 'r0' });
    let now = NOW;
    h.deps.now = () => now;
    const tooMany = { response: { status: 429, data: {}, headers: { 'retry-after': '120' } } };
    (h.deps.post as ReturnType<typeof vi.fn>).mockRejectedValueOnce(tooMany);
    const ensure = createRefresher(h.deps);

    await expect(ensure()).rejects.toBe(tooMany);
    now += 100_000; // menos que los 120 s que pidió el servidor
    await expect(ensure()).rejects.toThrow(/pausa/);
    now += 30_000; // ya pasó
    await expect(ensure()).resolves.toBeTruthy();
  });

  it('sin refresh token no hay sesión', async () => {
    const h = harness({ access: expiring(-1000), refresh: null });
    await expect(createRefresher(h.deps)()).rejects.toBeInstanceOf(SessionEndedError);
  });
});
