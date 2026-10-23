import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api, ApiError } from './http';
import { clearSession, getAccessToken, getRefreshToken, setTokens } from './session';

/** JWT mínimo con `exp` en segundos; la firma no se verifica en el cliente. */
function jwt(expSeconds: number): string {
  const payload = btoa(JSON.stringify({ exp: expSeconds })).replace(/=+$/, '');
  return `h.${payload}.s`;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const farFuture = () => Math.floor(Date.now() / 1000) + 3600;
const past = () => Math.floor(Date.now() / 1000) - 10;

describe('api', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    clearSession();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('devuelve data del cuerpo', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { data: { ok: true } }));
    await expect(api('/x')).resolves.toEqual({ ok: true });
  });

  it('lanza ApiError con el mensaje y el código del servidor', async () => {
    fetchMock.mockResolvedValueOnce(json(422, { message: 'Monto inválido', code: 'BAD_AMOUNT' }));
    await expect(api('/x')).rejects.toMatchObject({ message: 'Monto inválido', status: 422, code: 'BAD_AMOUNT' });
  });

  it('un 401 renueva una vez y repite la petición con el token nuevo', async () => {
    setTokens(jwt(farFuture()), 'refresh-1');
    fetchMock
      .mockResolvedValueOnce(json(401, { message: 'vencido' }))
      .mockResolvedValueOnce(json(200, { data: { accessToken: jwt(farFuture()), refreshToken: 'refresh-2' } }))
      .mockResolvedValueOnce(json(200, { data: 'listo' }));

    await expect(api('/orders/my', { auth: true })).resolves.toBe('listo');
    expect(getRefreshToken()).toBe('refresh-2');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('dos peticiones con el token vencido comparten un solo refresco', async () => {
    setTokens(jwt(past()), 'refresh-1');
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/auth/refresh-token')) {
        return json(200, { data: { accessToken: jwt(farFuture()), refreshToken: 'refresh-2' } });
      }
      return json(200, { data: 'ok' });
    });

    await Promise.all([api('/a', { auth: true }), api('/b', { auth: true })]);

    const refreshCalls = fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/auth/refresh-token'));
    expect(refreshCalls).toHaveLength(1);
  });

  it('un refresh rechazado con 401 cierra la sesión', async () => {
    setTokens(jwt(farFuture()), 'robado');
    fetchMock
      .mockResolvedValueOnce(json(401, { message: 'vencido' }))
      .mockResolvedValueOnce(json(401, { message: 'Sesión comprometida', code: 'REFRESH_REUSED' }));

    await expect(api('/orders/my', { auth: true })).rejects.toBeInstanceOf(ApiError);
    expect(getAccessToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
  });

  it('un fallo 5xx del refresh no cierra la sesión', async () => {
    setTokens(jwt(farFuture()), 'refresh-1');
    fetchMock
      .mockResolvedValueOnce(json(401, { message: 'vencido' }))
      .mockResolvedValueOnce(json(503, { message: 'caído' }));

    await expect(api('/orders/my', { auth: true })).rejects.toBeInstanceOf(ApiError);
    expect(getRefreshToken()).toBe('refresh-1');
  });

  it('con retryOn401 apagado, un 401 de negocio no renueva ni repite la petición', async () => {
    setTokens(jwt(farFuture()), 'refresh-1');
    fetchMock.mockResolvedValueOnce(json(401, { message: 'Contraseña actual incorrecta' }));

    await expect(api('/auth/change-password', { method: 'POST', body: {}, auth: true, retryOn401: false }))
      .rejects.toMatchObject({ status: 401, message: 'Contraseña actual incorrecta' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getRefreshToken()).toBe('refresh-1');
  });

  it('bearer explícito se manda tal cual aunque no haya sesión guardada', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { data: null }));
    await api('/auth/logout', { method: 'POST', bearer: 'token-ajeno' });
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer token-ajeno');
  });

  it('reintenta el refresh si otra petición lo está rotando (409)', async () => {
    vi.useFakeTimers();
    try {
      setTokens(jwt(farFuture()), 'refresh-1');
      fetchMock
        .mockResolvedValueOnce(json(401, { message: 'vencido' }))
        .mockResolvedValueOnce(json(409, { message: 'renovando', code: 'REFRESH_IN_PROGRESS' }))
        .mockResolvedValueOnce(json(200, { data: { accessToken: jwt(farFuture()), refreshToken: 'refresh-2' } }))
        .mockResolvedValueOnce(json(200, { data: 'ok' }));

      const pending = api('/orders/my', { auth: true });
      await vi.advanceTimersByTimeAsync(500);
      await expect(pending).resolves.toBe('ok');
      expect(getRefreshToken()).toBe('refresh-2');
    } finally {
      vi.useRealTimers();
    }
  });
});
