import { cloudinary } from '../config';
import { AppError } from '../middlewares/errorHandler';
import { signedPrivateUrl } from './privateStorage.service';
import type { IContractFile } from '../models/DriverContract';

/**
 * Bytes de los archivos del expediente, leídos desde el almacén privado.
 *
 * El navegador nunca recibe una URL de Cloudinary: el backend comprueba el
 * permiso, descarga el archivo con su propia firma y lo entrega en la misma
 * respuesta (`Cache-Control: no-store`). Así cada apertura exige el token del
 * administrador y deja rastro, y no existe un enlace que se pueda copiar y
 * reenviar. (Las imágenes en entrega `authenticated` no caducan; esta ruta es
 * lo que le pone vida útil real al acceso.)
 */

/** Un anexo escaneado pesa poco; esto corta una respuesta absurda antes de llenar la memoria. */
const MAX_REMOTE_BYTES = 15 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

export interface DossierFileBytes {
  buffer: Buffer;
  /** `jpg` para toda imagen (se convierte al bajar), `pdf` para PDFs. */
  format: 'jpg' | 'pdf';
  contentType: string;
}

/**
 * Solo el almacén propio: la entrega (`res.cloudinary.com`) y la descarga
 * privada de PDF (`api.cloudinary.com`), ambas con nuestro `cloud_name` en la
 * ruta. Comprobar solo el host dejaría pasar la cuenta de cualquier otro.
 */
export function isOwnStorageUrl(url: string, cloud = cloudinary.config().cloud_name): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || !cloud) return false;
  return (
    (u.hostname === 'res.cloudinary.com' && u.pathname.startsWith(`/${cloud}/`)) ||
    (u.hostname === 'api.cloudinary.com' && u.pathname.startsWith(`/v1_1/${cloud}/`))
  );
}

async function fetchRemote(url: string): Promise<Buffer> {
  if (!isOwnStorageUrl(url)) throw new AppError('Origen de archivo no permitido', 502);

  // Sin seguir redirecciones: una 3xx podría llevar la petición fuera del almacén.
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'error' });
  if (!response.ok) throw new AppError('No se pudo leer el archivo del almacén', 502);
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_REMOTE_BYTES) throw new AppError('El archivo es demasiado grande', 502);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_REMOTE_BYTES) throw new AppError('El archivo es demasiado grande', 502);
  return buffer;
}

/** URL firmada de una imagen privada, convertida a JPG (WEBP/PNG no se incrustan igual en un PDF). */
export function privateImageJpgUrl(key: string): string {
  return cloudinary.url(key, {
    type: 'authenticated',
    resource_type: 'image',
    sign_url: true,
    secure: true,
    format: 'jpg',
    transformation: [{ quality: 85 }],
  });
}

/** Documentos anteriores a la migración 015 siguen con `imageUrl` público: se les pide el JPG por transformación. */
export function legacyImageJpgUrl(url: string): string {
  return url.replace('/upload/', '/upload/f_jpg,q_85/').replace(/\.[a-zA-Z0-9]+$/, '.jpg');
}

const asImage = (buffer: Buffer): DossierFileBytes => ({ buffer, format: 'jpg', contentType: 'image/jpeg' });

/** Foto de un documento del domiciliario (`DriverDocument`). */
export async function readDriverDocumentFile(doc: {
  imageKey?: string | null;
  imageUrl?: string | null;
  isPrivate?: boolean;
}): Promise<DossierFileBytes> {
  if (doc.isPrivate && doc.imageKey) return asImage(await fetchRemote(privateImageJpgUrl(doc.imageKey)));
  if (doc.imageUrl) return asImage(await fetchRemote(legacyImageJpgUrl(doc.imageUrl)));
  throw new AppError('Este documento no tiene archivo', 404);
}

/** Contrato o anexo del contrato (imagen o PDF, ya sondeado al subirlo). */
export async function readContractFile(
  file: Pick<IContractFile, 'key' | 'resourceType' | 'format'>
): Promise<DossierFileBytes> {
  if (file.resourceType === 'raw' || file.format === 'pdf') {
    const url = signedPrivateUrl({ key: file.key, resourceType: 'raw' });
    if (!url) throw new AppError('Este documento no tiene archivo', 404);
    return { buffer: await fetchRemote(url), format: 'pdf', contentType: 'application/pdf' };
  }
  return asImage(await fetchRemote(privateImageJpgUrl(file.key)));
}
