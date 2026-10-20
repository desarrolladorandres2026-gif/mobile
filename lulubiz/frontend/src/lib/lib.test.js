import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, setUnauthorizedHandler, takeFragmentToken } from './api.js';
import { formatDay } from './format.js';
import { formatAmount, parseAmount } from './money.js';
import { nitCheckDigit, taxIdTypesFor } from './nit.js';

describe('dinero: texto a unidades menores', () => {
  it.each([
    ['1.190.000,50', 'COP', 119000050],
    ['1190000,5', 'COP', 119000050],
    ['1190000', 'COP', 119000000],
    ['0,05', 'COP', 5],
    ['1.234', 'COP', 123400],
    ['1.234', 'CLP', 1234],
    ['  250  ', 'USD', 25000],
    ['', 'COP', 0],
    ['   ', 'COP', 0],
  ])('%s en %s es %i', (text, currency, expected) => {
    expect(parseAmount(text, currency)).toBe(expected);
  });

  it.each([
    ['1.2345,00', 'COP'], // miles mal agrupados
    ['1,234.50', 'COP'], // formato en inglés
    ['12,345', 'COP'], // más decimales de los que admite la moneda
    ['10,5', 'CLP'], // el peso chileno no tiene decimales
    ['-5', 'COP'],
    ['abc', 'COP'],
    ['1e5', 'COP'],
    ['99999999999999999999', 'COP'], // fuera del rango seguro
  ])('rechaza «%s» (%s)', (text, currency) => {
    expect(parseAmount(text, currency)).toBeNull();
  });

  it('nunca pasa por decimales: importes grandes siguen exactos', () => {
    expect(parseAmount('90.071.992.547.409,91', 'COP')).toBe(9007199254740991);
    expect(parseAmount('90.071.992.547.409,92', 'COP')).toBeNull();
  });
});

describe('dinero: unidades menores a texto', () => {
  it.each([
    [119000050, 'COP', '1.190.000,50'],
    [5, 'COP', '0,05'],
    [0, 'COP', '0,00'],
    [100, 'COP', '1,00'],
    [-250075, 'COP', '-2.500,75'],
    [1234, 'CLP', '1.234'],
    [9007199254740991, 'COP', '90.071.992.547.409,91'],
  ])('%i %s se muestra como %s', (minor, currency, expected) => {
    expect(formatAmount(minor, currency)).toBe(expected);
  });

  it('ida y vuelta sin pérdida', () => {
    for (const minor of [0, 1, 99, 100, 123456789, 9007199254740991]) {
      expect(parseAmount(formatAmount(minor, 'COP'), 'COP')).toBe(minor);
    }
  });

  it('un valor que no es entero seguro no se muestra como número', () => {
    expect(formatAmount(1.5, 'COP')).toBe('—');
    expect(formatAmount(NaN, 'COP')).toBe('—');
  });
});

describe('NIT', () => {
  it('calcula el dígito de verificación de NIT conocidos', () => {
    expect(nitCheckDigit('800197268')).toBe(4); // DIAN
    expect(nitCheckDigit('899999068')).toBe(1); // Ecopetrol
    expect(nitCheckDigit('890903938')).toBe(8); // Bancolombia
  });

  it('devuelve null si no son solo dígitos', () => {
    expect(nitCheckDigit('8001972a8')).toBeNull();
    expect(nitCheckDigit('')).toBeNull();
  });

  it('ofrece los tipos de documento de cada país', () => {
    expect(taxIdTypesFor('CO').map((t) => t.value)).toContain('NIT');
    expect(taxIdTypesFor('US').map((t) => t.value)).toContain('TAX_ID');
    expect(taxIdTypesFor('US').map((t) => t.value)).not.toContain('NIT');
  });
});

describe('cliente de la API', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setUnauthorizedHandler(() => {});
  });

  const respond = (status, body) => vi.fn(async () => ({ status, ok: status < 400, json: async () => body }));

  it('envía JSON con credenciales del mismo origen y devuelve el cuerpo', async () => {
    const fetchMock = respond(200, { ok: true });
    vi.stubGlobal('fetch', fetchMock);
    expect(await api.post('/v1/x', { a: 1 }, { 'idempotency-key': 'k' })).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/v1/x');
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', body: '{"a":1}' });
    expect(init.headers).toMatchObject({ 'content-type': 'application/json', 'idempotency-key': 'k' });
  });

  it('un GET no envía cuerpo ni tipo de contenido', async () => {
    const fetchMock = respond(200, {});
    vi.stubGlobal('fetch', fetchMock);
    await api.get('/v1/x');
    expect(fetchMock.mock.calls[0][1].body).toBeUndefined();
    expect(fetchMock.mock.calls[0][1].headers['content-type']).toBeUndefined();
  });

  it('un 204 devuelve null', async () => {
    vi.stubGlobal('fetch', respond(204));
    expect(await api.delete('/v1/x')).toBeNull();
  });

  it('un error de la API se convierte en ApiError con código y mensaje', async () => {
    vi.stubGlobal('fetch', respond(409, { error: 'PERIOD_CLOSED', message: 'el período 2026-10 está cerrado' }));
    const error = await api.post('/v1/x').catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: 'PERIOD_CLOSED', message: 'el período 2026-10 está cerrado' });
  });

  it('una respuesta que no es JSON da un mensaje genérico, sin romper', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 502, ok: false, json: async () => { throw new Error('html'); } })));
    const error = await api.get('/v1/x').catch((e) => e);
    expect(error).toMatchObject({ status: 502, code: 'ERROR', message: 'Error 502' });
  });

  it('sin red lanza un error legible', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const error = await api.get('/v1/x').catch((e) => e);
    expect(error).toMatchObject({ status: 0, code: 'NETWORK' });
    expect(error.message).toMatch(/conexión/);
  });

  it('solo una sesión vencida avisa al manejador; credenciales o código incorrectos no', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    vi.stubGlobal('fetch', respond(401, { error: 'INVALID_CREDENTIALS', message: 'credenciales inválidas' }));
    await api.post('/v1/auth/login').catch(() => {});
    vi.stubGlobal('fetch', respond(401, { error: 'INVALID_MFA', message: 'código inválido' }));
    await api.post('/v1/auth/mfa/verify').catch(() => {});
    expect(handler).not.toHaveBeenCalled();

    vi.stubGlobal('fetch', respond(401, { error: 'INVALID_SESSION', message: 'sesión vencida' }));
    await api.get('/v1/me').catch(() => {});
    expect(handler).toHaveBeenCalledOnce();
  });
});

describe('token en el fragmento de la URL', () => {
  it('lo lee y lo borra de la barra de direcciones', () => {
    window.history.replaceState(null, '', '/restablecer-contrasena?x=1#token=abc%2Fdef-123');
    expect(takeFragmentToken()).toBe('abc/def-123');
    expect(window.location.hash).toBe('');
    expect(window.location.pathname + window.location.search).toBe('/restablecer-contrasena?x=1');
    expect(takeFragmentToken()).toBeNull();
  });
});

describe('fechas', () => {
  it('muestra día/mes/año tomando la parte de fecha del instante, sin cambiar de día por la zona horaria', () => {
    expect(formatDay('2026-10-20T12:00:00.000Z')).toBe('20/10/2026');
    expect(formatDay('2026-01-01T00:00:00Z')).toBe('01/01/2026');
    expect(formatDay('2026-12-31T23:59:59Z')).toBe('31/12/2026');
  });
  it('un valor que no es fecha da texto vacío', () => {
    expect(formatDay(undefined)).toBe('');
    expect(formatDay('ayer')).toBe('');
  });
});
