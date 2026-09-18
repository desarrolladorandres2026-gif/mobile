import { cloudinary } from '../config';
import { AppError } from '../middlewares';

/**
 * Logo y portada de un comercio.
 *
 * Mismo enfoque que la mini-ilustración de categoría y el banner
 * promocional: el buffer va directo de multer a Cloudinary, nada toca
 * disco, y lo que se guarda en Mongo es la URL ya optimizada. No se
 * construyen variantes por transformación como en el catálogo de productos
 * porque estas dos imágenes se pintan **en un solo sitio y a un solo
 * tamaño** cada una; una cadena de variantes ahí sería maquinaria sin uso.
 *
 * El recorte lo hace el panel antes de subir, así que lo que llega ya viene
 * con la proporción correcta. El `crop: 'limit'` de aquí es la red de
 * seguridad, no el encuadre: acota el peso sin volver a recortar nada, de
 * modo que una subida hecha por fuera del panel tampoco puede meter un
 * archivo de ocho megas en la ficha.
 */

/** Lado del logo. Se pinta a ~88 px, y el triple cubre pantallas densas. */
const LOGO_SIZE = 512;
/** Ancho de la portada. A 16:9 son 1600×900, que llena cualquier teléfono. */
const COVER_WIDTH = 1600;

type Slot = 'logo' | 'cover';

const TRANSFORM: Record<Slot, Record<string, unknown>[]> = {
  logo: [
    { width: LOGO_SIZE, height: LOGO_SIZE, crop: 'limit' },
    { quality: 'auto', fetch_format: 'auto' },
  ],
  cover: [
    { width: COVER_WIDTH, crop: 'limit' },
    { quality: 'auto', fetch_format: 'auto' },
  ],
};

export class BusinessImageService {
  /**
   * Sube una imagen del comercio y devuelve su URL definitiva.
   *
   * El `businessId` va en el `public_id` para que una foto huérfana en
   * Cloudinary se pueda rastrear hasta su negocio. El sufijo de tiempo
   * evita que el CDN siga sirviendo la anterior: sin él, cambiar el logo
   * dejaba el viejo en pantalla durante horas y parecía que no se había
   * guardado.
   */
  upload(slot: Slot, businessId: string, buffer: Buffer): Promise<string> {
    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: `zipp/businesses/${slot}`,
          public_id: `${businessId}-${Date.now()}`,
          resource_type: 'image',
          transformation: TRANSFORM[slot],
        },
        (error, result) => {
          if (error || !result) {
            reject(new AppError('No se pudo subir la imagen', 502));
            return;
          }
          resolve(result.secure_url);
        }
      );
      stream.end(buffer);
    });
  }
}

export const businessImageService = new BusinessImageService();
