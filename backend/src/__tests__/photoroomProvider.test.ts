import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { config } from '../config';
import {
  BackgroundRemovalError,
  PhotoroomProvider,
  parseRetryAfter,
} from '../services/imageProcessing';
import { pngHasAlpha } from '../utils/imageHeader';

/**
 * El proveedor de recorte de fondo, sin red.
 *
 * `fetch` se sustituye por una respuesta armada a mano: ninguna prueba
 * llama a Photoroom de verdad, ni gasta un crédito, ni necesita clave.
 * Lo que se comprueba es la traducción de cada respuesta posible a un
 * error que el orquestador sabe tratar, y que la clave no se escape.
 */

const SECRET = 'sk_test_NO_DEBE_SALIR_NUNCA';

/** PNG mínimo con el tipo de color que se le pida (6 = RGBA, 2 = RGB opaco). */
function png(width: number, height: number, colorType = 6): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4);
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;
  ihdr[17] = colorType;
  return Buffer.concat([signature, ihdr, Buffer.alloc(64, 3)]);
}

const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08]),
  Buffer.from([0x03, 0x20, 0x03, 0x20]),
  Buffer.alloc(40, 1),
]);

function respond(
  status: number,
  body: Buffer | string = '',
  headers: Record<string, string> = {}
) {
  return vi.fn(async (_url: string, _init?: RequestInit) =>
    new Response(typeof body === 'string' ? body : new Uint8Array(body), { status, headers })
  );
}

const provider = new PhotoroomProvider();
const input = { buffer: JPEG, mimetype: 'image/jpeg' };
let originalKey: string;
let logged: string[];

beforeEach(() => {
  originalKey = config.backgroundRemoval.photoroom.apiKey;
  config.backgroundRemoval.photoroom.apiKey = SECRET;
  logged = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    logged.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
  });
});

afterEach(() => {
  config.backgroundRemoval.photoroom.apiKey = originalKey;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function failureOf(promise: Promise<unknown>): Promise<BackgroundRemovalError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(BackgroundRemovalError);
    return error as BackgroundRemovalError;
  }
  throw new Error('Se esperaba un fallo');
}

describe('Photoroom: respuesta correcta', () => {
  it('devuelve el PNG con transparencia y pide PNG recortado al contorno', async () => {
    const fetchMock = respond(200, png(900, 1000), { 'content-type': 'image/png' });
    vi.stubGlobal('fetch', fetchMock);

    const output = await provider.removeBackground(input);

    expect(output.format).toBe('png');
    expect(output.width).toBe(900);
    expect(output.height).toBe(1000);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(config.backgroundRemoval.photoroom.apiUrl);
    expect((init!.headers as Record<string, string>)['x-api-key']).toBe(SECRET);
    const form = init!.body as FormData;
    expect(form.get('format')).toBe('png');
    expect(form.get('crop')).toBe('true');
    expect(form.get('image_file')).toBeInstanceOf(Blob);
    // Con tope de tiempo: sin él, un proveedor colgado deja la foto en
    // "Mejorando imagen…" para siempre.
    expect(init!.signal).toBeDefined();
  });
});

describe('Photoroom: cada fallo, con su código', () => {
  it('error del proveedor (5xx): se puede reintentar', async () => {
    vi.stubGlobal('fetch', respond(500, '{"detail":"boom"}'));
    const error = await failureOf(provider.removeBackground(input));
    expect(error.code).toBe('PROVIDER_ERROR');
    expect(error.retryable).toBe(true);
    expect(error.billable).toBe(false);
  });

  it('timeout: se puede reintentar', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    }));
    const error = await failureOf(provider.removeBackground(input));
    expect(error.code).toBe('TIMEOUT');
    expect(error.retryable).toBe(true);
  });

  it('rate limit (429): respeta lo que pide esperar', async () => {
    vi.stubGlobal('fetch', respond(429, '', { 'retry-after': '12' }));
    const error = await failureOf(provider.removeBackground(input));
    expect(error.code).toBe('RATE_LIMITED');
    expect(error.retryable).toBe(true);
    expect(error.retryAfterMs).toBe(12_000);
  });

  it('sin créditos (402) o clave rechazada (403): no se reintenta', async () => {
    vi.stubGlobal('fetch', respond(402));
    expect((await failureOf(provider.removeBackground(input))).code).toBe('NO_CREDITS');

    vi.stubGlobal('fetch', respond(403));
    const auth = await failureOf(provider.removeBackground(input));
    expect(auth.code).toBe('AUTH_FAILED');
    expect(auth.retryable).toBe(false);
  });

  it('imagen rechazada (400): no se reintenta', async () => {
    vi.stubGlobal('fetch', respond(400, '{"detail":"bad image"}'));
    const error = await failureOf(provider.removeBackground(input));
    expect(error.code).toBe('REJECTED');
    expect(error.retryable).toBe(false);
  });

  it('respuesta que no es una imagen: inválida, cobrada y sin reintento', async () => {
    vi.stubGlobal('fetch', respond(200, '<html>error</html>', { 'content-type': 'text/html' }));
    const error = await failureOf(provider.removeBackground(input));
    expect(error.code).toBe('INVALID_RESPONSE');
    expect(error.retryable).toBe(false);
    // Respondió 200: ese crédito ya se cobró.
    expect(error.billable).toBe(true);
  });

  it('un JPEG o un PNG opaco no es un recorte', async () => {
    vi.stubGlobal('fetch', respond(200, JPEG, { 'content-type': 'image/jpeg' }));
    expect((await failureOf(provider.removeBackground(input))).code).toBe('INVALID_RESPONSE');

    vi.stubGlobal('fetch', respond(200, png(900, 900, 2), { 'content-type': 'image/png' }));
    expect((await failureOf(provider.removeBackground(input))).code).toBe('INVALID_RESPONSE');
  });

  it('respuesta vacía o fuera de medida: inválida', async () => {
    vi.stubGlobal('fetch', respond(200, Buffer.alloc(0), { 'content-type': 'image/png' }));
    expect((await failureOf(provider.removeBackground(input))).code).toBe('INVALID_RESPONSE');

    vi.stubGlobal('fetch', respond(200, png(7000, 900), { 'content-type': 'image/png' }));
    expect((await failureOf(provider.removeBackground(input))).code).toBe('INVALID_RESPONSE');
  });

  it('sin clave no llama a nadie', async () => {
    config.backgroundRemoval.photoroom.apiKey = '';
    const fetchMock = respond(200, png(900, 900));
    vi.stubGlobal('fetch', fetchMock);

    const error = await failureOf(provider.removeBackground(input));
    expect(error.code).toBe('NOT_CONFIGURED');
    expect(provider.isConfigured()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Photoroom: la clave no sale de aquí', () => {
  it('ningún fallo la escribe en el log ni en el error', async () => {
    const statuses = [400, 402, 403, 429, 500];
    for (const status of statuses) {
      vi.stubGlobal('fetch', respond(status, `{"echo":"${SECRET}"}`));
      const error = await failureOf(provider.removeBackground(input));
      expect(error.message).not.toContain(SECRET);
      expect(JSON.stringify(error)).not.toContain(SECRET);
    }
    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) expect(line).not.toContain(SECRET);
  });
});

describe('Utilidades', () => {
  it('Retry-After en segundos o como fecha', () => {
    expect(parseRetryAfter('30')).toBe(30_000);
    const now = Date.parse('2026-09-22T15:00:00Z');
    expect(parseRetryAfter('Tue, 22 Sep 2026 15:01:00 GMT', now)).toBe(60_000);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('mañana')).toBeNull();
  });

  it('detecta la transparencia de un PNG', () => {
    expect(pngHasAlpha(png(10, 10, 6))).toBe(true);
    expect(pngHasAlpha(png(10, 10, 4))).toBe(true);
    expect(pngHasAlpha(png(10, 10, 2))).toBe(false);
    expect(pngHasAlpha(JPEG)).toBe(false);
  });
});
