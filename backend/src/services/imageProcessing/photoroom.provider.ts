import { config } from '../../config';
import { pngHasAlpha, readImageHeader } from '../../utils/imageHeader';
import {
  BackgroundRemovalError,
  BackgroundRemovalInput,
  BackgroundRemovalOutput,
  BackgroundRemovalProvider,
} from './backgroundRemoval.types';

/**
 * Recorte de fondo con Photoroom (`POST /v1/segment`).
 *
 * Se le pide `format=png` porque es el formato que conserva la
 * transparencia sin sorpresas, y `crop=true` para que devuelva el producto
 * ya ceñido a su contorno: el encuadre y el margen los pone después la URL
 * de entrega, igual para todas las fotos del catálogo.
 *
 * La clave va en la cabecera `x-api-key` y en ningún otro sitio: no se
 * registra, no se devuelve en errores y no sale del backend. De una
 * respuesta fallida solo se guarda el estado HTTP, nunca el cuerpo.
 */

/** Un PNG de 1200 px pesa unos pocos MB; algo diez veces mayor no es lo que se pidió. */
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
/** El máximo que procesa Photoroom por el lado más largo. */
const MAX_DIMENSION = 6000;

/** `Retry-After` llega en segundos o como fecha HTTP. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - now);
  return null;
}

function failure(code: BackgroundRemovalError['code'], status: number | null, options: {
  retryable?: boolean;
  retryAfterMs?: number | null;
  billable?: boolean;
} = {}): BackgroundRemovalError {
  // Solo el código y el estado HTTP: el cuerpo de la respuesta puede citar
  // la petición, y la clave no está en ninguna de las dos cosas que se
  // escriben aquí.
  console.error(`[IMAGE_BG] photoroom ${code}${status ? ` (HTTP ${status})` : ''}`);
  return new BackgroundRemovalError(code, options);
}

export class PhotoroomProvider implements BackgroundRemovalProvider {
  readonly name = 'photoroom';

  isConfigured(): boolean {
    return Boolean(config.backgroundRemoval.photoroom.apiKey);
  }

  async removeBackground({ buffer, mimetype }: BackgroundRemovalInput): Promise<BackgroundRemovalOutput> {
    const { apiKey, apiUrl, timeoutMs } = config.backgroundRemoval.photoroom;
    if (!apiKey) throw new BackgroundRemovalError('NOT_CONFIGURED');

    const extension = mimetype === 'image/png' ? 'png' : mimetype === 'image/webp' ? 'webp' : 'jpg';
    const form = new FormData();
    form.append('image_file', new Blob([new Uint8Array(buffer)], { type: mimetype }), `producto.${extension}`);
    form.append('format', 'png');
    form.append('crop', 'true');

    let res: Response;
    try {
      res = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'x-api-key': apiKey, Accept: 'image/png' },
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const name = (error as Error | undefined)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw failure('TIMEOUT', null, { retryable: true });
      }
      // Sin respuesta (DNS, conexión cortada): nada llegó a cobrarse.
      throw failure('PROVIDER_ERROR', null, { retryable: true });
    }

    if (!res.ok) {
      // El cuerpo no se lee: no aporta nada que se vaya a guardar y podría
      // repetir parte de la petición. Se suelta para liberar la conexión.
      await res.body?.cancel().catch(() => undefined);

      const { status } = res;
      if (status === 429) {
        throw failure('RATE_LIMITED', status, {
          retryable: true,
          retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
        });
      }
      if (status === 402) throw failure('NO_CREDITS', status);
      // Photoroom usa 403 tanto para una clave mala como para una cuenta sin
      // saldo. Ninguna de las dos se arregla reintentando.
      if (status === 401 || status === 403) throw failure('AUTH_FAILED', status);
      if (status >= 500) throw failure('PROVIDER_ERROR', status, { retryable: true });
      throw failure('REJECTED', status);
    }

    // A partir de aquí el proveedor respondió 200: el crédito ya se cobró.
    // Una respuesta inválida no se reintenta, porque repetirla costaría otro.
    const invalid = () => failure('INVALID_RESPONSE', res.status, { billable: true });

    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!type.startsWith('image/')) {
      await res.body?.cancel().catch(() => undefined);
      throw invalid();
    }
    const declaredLength = Number(res.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      await res.body?.cancel().catch(() => undefined);
      throw invalid();
    }

    let output: Buffer;
    try {
      output = Buffer.from(await res.arrayBuffer());
    } catch {
      throw failure('PROVIDER_ERROR', res.status, { retryable: true, billable: true });
    }
    if (!output.length || output.length > MAX_RESPONSE_BYTES) throw invalid();

    const header = readImageHeader(output);
    if (!header || header.format !== 'png') throw invalid();
    if (
      header.width < 1 ||
      header.height < 1 ||
      header.width > MAX_DIMENSION ||
      header.height > MAX_DIMENSION
    ) {
      throw invalid();
    }
    // Un PNG opaco es la foto de vuelta con fondo: no es un recorte.
    if (!pngHasAlpha(output)) throw invalid();

    return { buffer: output, format: 'png', width: header.width, height: header.height };
  }
}

export const photoroomProvider = new PhotoroomProvider();
