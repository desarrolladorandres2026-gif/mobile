import crypto from 'crypto';
import { cloudinary } from '../config';
import { AppError } from '../middlewares/errorHandler';
import { readImageHeader } from '../utils/imageHeader';

/**
 * Almacenamiento privado de archivos sensibles (cédulas, RUT, certificados
 * bancarios): Cloudinary con entrega `authenticated`.
 *
 * El patrón es el mismo de las evidencias de entrega y de los documentos de
 * domiciliarios (S16):
 *   - se guarda solo la **llave** (`public_id`), nunca una URL;
 *   - la URL firmada se calcula en cada lectura, después de que el servicio
 *     comprobó quién pregunta, y jamás se persiste — así un volcado de la
 *     base no contiene enlaces utilizables.
 *
 * Aquí vive la pieza compartida para que un tercer documento sensible no
 * copie un tercer `upload_stream`. (`driver.service.ts#documentImageUrl` y
 * `driverSecurity.signedImageUrl` siguen con su copia; migrarlas a este
 * módulo es un refactor mecánico pendiente.)
 */

export type PrivateFileFormat = 'jpg' | 'png' | 'webp' | 'pdf';
export type PrivateResourceType = 'image' | 'raw';

export interface StoredPrivateFile {
  /** `public_id` de Cloudinary. Es lo único que se guarda. */
  key: string;
  /** Con qué `resource_type` se subió: hace falta el mismo para firmar. */
  resourceType: PrivateResourceType;
  format: PrivateFileFormat;
  bytes: number;
}

/**
 * El formato real del archivo, leído de sus bytes.
 *
 * `multer` solo conoce lo que el cliente declara en `Content-Type`; un
 * ejecutable renombrado a `.jpg` llega con `image/jpeg`. Esto mira la firma
 * binaria y devuelve `null` para cualquier cosa que no sea un JPG, PNG, WEBP
 * o PDF reconocible.
 */
export function sniffPrivateFile(buffer: Buffer): PrivateFileFormat | null {
  if (buffer.length >= 5 && buffer.toString('latin1', 0, 5) === '%PDF-') return 'pdf';

  const image = readImageHeader(buffer);
  return image ? image.format : null;
}

/**
 * Acciones activas que un PDF de un RUT o una cédula escaneada no necesita:
 * JavaScript, lanzar programas, adjuntos incrustados y acciones al abrir.
 *
 * Es una **heurística**: mira los nombres en claro del archivo. Un PDF con
 * objetos comprimidos u ofuscados (`/J#61vaScript`) puede esquivarla, así que
 * no sustituye a que el visor del revisor sea de confianza; solo corta el
 * caso trivial (y el más común) de un PDF armado a mano.
 */
const ACTIVE_PDF_CONTENT = /\/(?:JavaScript|Launch|EmbeddedFile|OpenAction|RichMedia)(?![A-Za-z])|\/JS(?=[\s(<\/\[>])/;

export function pdfHasActiveContent(buffer: Buffer): boolean {
  return ACTIVE_PDF_CONTENT.test(buffer.toString('latin1'));
}

export interface UploadPrivateOptions {
  /** Carpeta lógica, p. ej. `zipp/business-documents/<businessId>`. */
  folder: string;
  /** Tope de tamaño; el de `multer` ya cortó antes, esto es la segunda barrera. */
  maxBytes?: number;
}

/**
 * Sube un archivo a entrega privada tras comprobar sus bytes.
 *
 * Las imágenes se limitan (no se recortan: un número de matrícula recortado
 * no se lee, y leerlo es todo el propósito de la foto) y los PDF se suben
 * `raw`, porque Cloudinary bloquea por defecto la entrega de PDF como
 * `image` en cuentas nuevas.
 */
export async function storePrivateFile(
  buffer: Buffer,
  options: UploadPrivateOptions
): Promise<StoredPrivateFile> {
  if (options.maxBytes && buffer.length > options.maxBytes) {
    throw new AppError('El archivo supera el tamaño permitido', 413);
  }

  const format = sniffPrivateFile(buffer);
  if (!format) {
    throw new AppError('El archivo no es una imagen (JPG, PNG, WEBP) ni un PDF válido', 400);
  }

  if (format === 'pdf' && pdfHasActiveContent(buffer)) {
    throw new AppError(
      'El PDF contiene contenido activo (scripts o adjuntos) y no se acepta. Súbelo como imagen o expórtalo de nuevo.',
      400,
      'PDF_ACTIVE_CONTENT'
    );
  }

  const resourceType: PrivateResourceType = format === 'pdf' ? 'raw' : 'image';

  const key = await new Promise<string>((resolve, reject) => {
    const callback = (error: unknown, result: { public_id: string } | undefined) => {
      if (error || !result) {
        reject(new AppError('No se pudo guardar el archivo. Intenta de nuevo.', 502));
        return;
      }
      resolve(result.public_id);
    };

    const stream =
      resourceType === 'raw'
        ? cloudinary.uploader.upload_stream(
            {
              resource_type: 'raw',
              type: 'authenticated',
              // En `raw` el `public_id` es el nombre completo, extensión
              // incluida; sin ella el archivo se sirve sin tipo.
              public_id: `${options.folder}/${crypto.randomUUID()}.pdf`,
            },
            callback
          )
        : cloudinary.uploader.upload_stream(
            {
              resource_type: 'image',
              type: 'authenticated',
              folder: options.folder,
              transformation: [
                { width: 1600, height: 1600, crop: 'limit' },
                { quality: 'auto', fetch_format: 'auto' },
              ],
            },
            callback
          );

    stream.end(buffer);
  });

  return { key, resourceType, format, bytes: buffer.length };
}

/** Vida de la URL de un documento (segundos). Cinco minutos: abrir y mirar, no compartir. */
export const PRIVATE_URL_TTL_SECONDS = 300;

/**
 * URL para ver un archivo privado. Se llama solo después de comprobar que
 * quien lee puede verlo, y el resultado no se guarda.
 *
 *  - **PDF (`raw`)**: URL de descarga privada de la API de Cloudinary
 *    (`private_download_url`), firmada con `expires_at`: **caduca a los 5
 *    minutos**. El SDK la firma con la API key/secret, sin add-on de pago (es
 *    la misma firma que cualquier llamada a la Upload API). Baja como
 *    adjunto, que para un PDF es lo esperado.
 *  - **Imagen**: se mantiene la URL firmada de entrega (`s--firma--`), que
 *    **no caduca**. La alternativa (`private_download_url`) obliga a
 *    descargar como adjunto y a adivinar el formato final tras el
 *    `fetch_format: auto`, y los paneles abren la imagen en otra pestaña para
 *    verla; la caducidad real de imágenes requiere el add-on de token
 *    (Akamai/`auth_token`) de Cloudinary. Pendiente hasta contratarlo.
 */
export function signedPrivateUrl(file: {
  key?: string | null;
  resourceType?: PrivateResourceType | null;
}): string | undefined {
  if (!file.key) return undefined;

  if (file.resourceType === 'raw') {
    const url = cloudinary.utils.private_download_url(file.key, '', {
      resource_type: 'raw',
      type: 'authenticated',
      expires_at: Math.floor(Date.now() / 1000) + PRIVATE_URL_TTL_SECONDS,
    });
    // `format=` vacío va en la cadena de consulta pero no en la firma.
    return url.replace(/([?&])format=(&|$)/, (_m, lead, tail) => (tail === '&' ? lead : ''));
  }

  return cloudinary.url(file.key, {
    type: 'authenticated',
    resource_type: file.resourceType ?? 'image',
    sign_url: true,
    secure: true,
  });
}
