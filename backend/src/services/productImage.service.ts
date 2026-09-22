import crypto from 'crypto';
import { cloudinary, config } from '../config';
import { AppError } from '../middlewares';
import { IProduct, IProductImage } from '../models';
import {
  PRODUCT_IMAGE_VARIANTS,
  ProductImageUrls,
  productImagePlaceholderUrl,
  productImageUrl,
  productImageUrls,
} from '../utils/productImageUrls';

export { PRODUCT_IMAGE_VARIANTS };
export type { ProductImageUrls };

/**
 * Imágenes de producto: validación, normalización y entrega.
 *
 * Tres decisiones sostienen todo lo demás:
 *
 * 1. **Se guarda un único master ya recortado**, con tope de 1200 px. La
 *    foto de 8 MB que sale de un celular no se guarda nunca: no aporta
 *    nada que se pueda ver y se paga en almacenamiento y en transferencia.
 *
 * 2. **La mejora y el encuadre viven en la URL de entrega**, no en el
 *    archivo. El master queda intacto, así que "Mejorar" es reversible y
 *    el comercio siempre puede volver a la foto que tomó. Un retoque
 *    irreversible sobre el original es justo lo que impide comparar el
 *    resultado con el producto real.
 *
 * 3. **Todas las variantes son cuadradas.** El catálogo mezcla fotos de
 *    cincuenta comercios distintos y la uniformidad es lo que hace que no
 *    parezca un tablón de anuncios. `crop: 'fill'` recorta, nunca
 *    deforma, y `gravity: 'auto'` deja el producto centrado sin que nadie
 *    tenga que encuadrarlo a mano.
 */

export const PRODUCT_IMAGE_ERROR = {
  INVALID_FILE: 'PRODUCT_IMAGE_INVALID_FILE',
  TOO_LARGE: 'PRODUCT_IMAGE_TOO_LARGE',
  TOO_SMALL: 'PRODUCT_IMAGE_TOO_SMALL',
  STORAGE: 'PRODUCT_IMAGE_STORAGE_FAILED',
  NOT_CONFIGURED: 'PRODUCT_IMAGE_NOT_CONFIGURED',
  NO_IMAGE: 'PRODUCT_IMAGE_MISSING',
} as const;

interface InspectResult {
  format: 'jpg' | 'png' | 'webp';
  width: number;
  height: number;
  checksum: string;
}

/** Lo que devuelve el almacenamiento de una foto recién subida. */
interface StoredImage {
  publicId: string;
  width: number;
  height: number;
  bytes: number;
  format: string;
  placeholderDataUri: string | null;
}

/** Una miniatura de 24 px pesa ~90 bytes; algo de más de 1 KB no lo es. */
const PLACEHOLDER_MAX_BYTES = 1024;
/** Lo que se le concede a Cloudinary antes de seguir sin incrustarla. */
const PLACEHOLDER_FETCH_TIMEOUT_MS = 2500;

/**
 * La miniatura borrosa de una foto, lista para viajar dentro del JSON.
 *
 * Como URL costaba una petición más por producto, y con mala señal esa
 * petición es la que llega tarde: el hueco se quedaba vacío justo cuando
 * más falta hacía algo que mirar. Incrustada se pinta con la respuesta.
 *
 * Nunca lanza. Si Cloudinary no contesta a tiempo o devuelve algo raro, el
 * producto se guarda igual y sirve la URL, que es lo de antes.
 */
export async function fetchInlinePlaceholder(
  publicId: string,
  version?: number
): Promise<string | null> {
  try {
    const res = await fetch(productImagePlaceholderUrl(publicId, { format: 'webp', version }), {
      signal: AbortSignal.timeout(PLACEHOLDER_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
    if (!type.startsWith('image/')) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (!bytes.length || bytes.length > PLACEHOLDER_MAX_BYTES) return null;
    return `data:${type};base64,${bytes.toString('base64')}`;
  } catch {
    return null;
  }
}

export class ProductImageService {
  /** Si la cuenta de Cloudinary tiene el complemento de quitar fondo. */
  get backgroundRemovalAvailable(): boolean {
    return config.productImages.backgroundRemoval && this.isConfigured;
  }

  get isConfigured(): boolean {
    return Boolean(config.cloudinary.cloudName && config.cloudinary.apiKey);
  }

  /** Lo que el panel necesita saber antes de enseñar un botón. */
  capabilities() {
    return {
      enabled: this.isConfigured,
      backgroundRemoval: this.backgroundRemovalAvailable,
      maxBytes: config.productImages.maxBytes,
      minDimension: config.productImages.minDimension,
      recommendedDimension: PRODUCT_IMAGE_VARIANTS.large,
      acceptedFormats: ['image/jpeg', 'image/png', 'image/webp'],
      aspectRatio: '1:1',
    };
  }

  /**
   * Comprueba que el binario es de verdad una imagen usable.
   *
   * Las dimensiones se leen de la **cabecera del archivo**, antes de subir
   * nada. Podría dejarse que Cloudinary las devuelva y borrar después lo
   * que no sirva, pero eso significa pagar la subida de cada foto mala y
   * dejar basura cuando el borrado falle. Aquí una foto de 200×150 se
   * rechaza sin salir del proceso.
   */
  inspect(buffer: Buffer, declaredMime: string): InspectResult {
    if (!buffer?.length) {
      throw new AppError('La imagen llegó vacía', 400, PRODUCT_IMAGE_ERROR.INVALID_FILE);
    }

    const { maxBytes, minDimension } = config.productImages;
    if (buffer.length > maxBytes) {
      const mb = (maxBytes / (1024 * 1024)).toFixed(0);
      throw new AppError(
        `La imagen pesa más de ${mb} MB. Tómala de nuevo o redúcela antes de subirla.`,
        413,
        PRODUCT_IMAGE_ERROR.TOO_LARGE
      );
    }

    const probed = readImageHeader(buffer);
    if (!probed) {
      throw new AppError(
        'El archivo no es una imagen válida o está dañado. Usa JPG, PNG o WEBP.',
        400,
        PRODUCT_IMAGE_ERROR.INVALID_FILE
      );
    }

    // El `Content-Type` lo escribe el cliente y la extensión también: las
    // dos se falsifican escribiendo texto. Lo que no se puede fingir sin
    // cambiar el archivo son sus primeros bytes, así que manda el binario
    // y un desacuerdo se rechaza en vez de "corregirse" en silencio.
    const declared = (declaredMime || '').toLowerCase();
    const expected = probed.format === 'jpg' ? 'image/jpeg' : `image/${probed.format}`;
    if (declared && declared !== expected) {
      throw new AppError(
        'El archivo no coincide con su tipo declarado',
        400,
        PRODUCT_IMAGE_ERROR.INVALID_FILE
      );
    }

    if (probed.width < minDimension || probed.height < minDimension) {
      throw new AppError(
        `La imagen es demasiado pequeña (${probed.width}×${probed.height}). ` +
          `Necesitamos al menos ${minDimension}×${minDimension} píxeles para que ` +
          'no se vea pixelada en el catálogo.',
        400,
        PRODUCT_IMAGE_ERROR.TOO_SMALL
      );
    }

    return {
      ...probed,
      checksum: crypto.createHash('sha256').update(buffer).digest('hex'),
    };
  }

  /**
   * Sube la imagen de un producto y sustituye la anterior.
   *
   * El orden importa: primero se sube la nueva, luego se apunta el
   * producto a ella y solo al final se borra la vieja. Al revés, un fallo
   * en la subida dejaría al producto sin ninguna foto habiendo borrado ya
   * la que funcionaba.
   */
  async replace(params: {
    product: IProduct;
    buffer: Buffer;
    mimetype: string;
    enhance?: boolean;
    removeBackground?: boolean;
  }): Promise<IProduct> {
    const { product, buffer } = params;

    if (!this.isConfigured) {
      throw new AppError(
        'El almacenamiento de imágenes no está configurado en este entorno',
        503,
        PRODUCT_IMAGE_ERROR.NOT_CONFIGURED
      );
    }

    const inspected = this.inspect(buffer, params.mimetype);
    const previous = product.imageAsset?.publicId ?? null;

    const wantsBackgroundRemoval =
      params.removeBackground === true && this.backgroundRemovalAvailable;

    const uploaded = await this.store({
      buffer,
      businessId: product.businessId.toString(),
      productId: product._id.toString(),
      removeBackground: wantsBackgroundRemoval,
    });

    product.imageAsset = {
      publicId: uploaded.publicId,
      width: uploaded.width,
      height: uploaded.height,
      bytes: uploaded.bytes,
      format: uploaded.format,
      checksum: inspected.checksum,
      enhanced: params.enhance !== false,
      backgroundRemoved: wantsBackgroundRemoval,
      placeholderDataUri: uploaded.placeholderDataUri,
      uploadedAt: new Date(),
    } as IProductImage;

    // `image` sigue siendo la URL de catálogo porque la app móvil lee ese
    // campo. Cambiarlo a un objeto habría roto todas las fichas de
    // producto en los teléfonos que no se hayan actualizado.
    product.image = this.buildUrl(product.imageAsset, PRODUCT_IMAGE_VARIANTS.catalog);
    await product.save();

    if (previous && previous !== uploaded.publicId) {
      // Ya no la referencia nadie. Si el borrado falla no se propaga: el
      // producto está bien guardado y lo único que queda es un archivo de
      // más, que es infinitamente preferible a devolver un error por algo
      // que al comercio ya le salió bien.
      await this.destroy(previous);
    }

    return product;
  }

  /**
   * Cambia los ajustes de entrega sin volver a subir el archivo.
   *
   * Es lo que hace que "Mejorar" sea un interruptor y no un viaje de ida:
   * las variantes se recalculan desde el mismo master.
   */
  async updateOptions(product: IProduct, options: { enhance?: boolean }): Promise<IProduct> {
    if (!product.imageAsset) {
      throw new AppError('Este producto no tiene imagen', 404, PRODUCT_IMAGE_ERROR.NO_IMAGE);
    }

    if (options.enhance !== undefined) product.imageAsset.enhanced = options.enhance;

    product.image = this.buildUrl(product.imageAsset, PRODUCT_IMAGE_VARIANTS.catalog);
    product.markModified('imageAsset');
    await product.save();
    return product;
  }

  // ── Galería ────────────────────────────────────────────────────────

  /** Cuántas fotos adicionales admite un producto. */
  static readonly MAX_GALLERY = 5;

  /**
   * Añade una foto a la galería del producto.
   *
   * No toca `imageAsset`: la principal se cambia con `replace` y es la que
   * leen las listas. Esto es lo que se desliza en la ficha.
   *
   * Exige que ya haya principal. Una galería sin portada dejaría al
   * producto sin miniatura en el catálogo mientras tiene cuatro fotos
   * dentro — el comercio creería que subió la foto y en la carta no
   * aparecería nada.
   */
  async addToGallery(params: {
    product: IProduct;
    buffer: Buffer;
    mimetype: string;
    removeBackground?: boolean;
  }): Promise<IProduct> {
    const { product, buffer } = params;

    if (!this.isConfigured) {
      throw new AppError(
        'El almacenamiento de imágenes no está configurado en este entorno',
        503,
        PRODUCT_IMAGE_ERROR.NOT_CONFIGURED
      );
    }

    if (!product.imageAsset) {
      throw new AppError(
        'Sube primero la foto principal: es la que aparece en la carta',
        409,
        PRODUCT_IMAGE_ERROR.NO_IMAGE
      );
    }

    if (product.gallery.length >= ProductImageService.MAX_GALLERY) {
      throw new AppError(
        `Máximo ${ProductImageService.MAX_GALLERY} fotos adicionales. Borra una para subir otra.`,
        409
      );
    }

    const inspected = this.inspect(buffer, params.mimetype);

    // La misma foto dos veces es un deslizamiento que no enseña nada nuevo,
    // y el checksum ya se calcula igualmente para el master.
    const duplicate =
      product.imageAsset.checksum === inspected.checksum ||
      product.gallery.some((image) => image.checksum === inspected.checksum);
    if (duplicate) {
      throw new AppError('Esa foto ya está en este producto', 409);
    }

    const uploaded = await this.store({
      buffer,
      businessId: product.businessId.toString(),
      productId: product._id.toString(),
      removeBackground: params.removeBackground === true && this.backgroundRemovalAvailable,
    });

    product.gallery.push({
      publicId: uploaded.publicId,
      width: uploaded.width,
      height: uploaded.height,
      bytes: uploaded.bytes,
      format: uploaded.format,
      checksum: inspected.checksum,
      enhanced: true,
      backgroundRemoved: params.removeBackground === true && this.backgroundRemovalAvailable,
      placeholderDataUri: uploaded.placeholderDataUri,
      uploadedAt: new Date(),
    } as IProductImage);

    await product.save();
    return product;
  }

  /** Quita una foto concreta de la galería. */
  async removeFromGallery(product: IProduct, publicId: string): Promise<IProduct> {
    const index = product.gallery.findIndex((image) => image.publicId === publicId);
    if (index === -1) {
      throw new AppError('Esa foto no está en este producto', 404);
    }

    product.gallery.splice(index, 1);
    await product.save();

    await this.destroy(publicId);
    return product;
  }

  /** Quita la imagen del producto y el archivo que la respaldaba. */
  async remove(product: IProduct): Promise<IProduct> {
    const publicId = product.imageAsset?.publicId ?? null;

    product.imageAsset = null;
    product.image = null;
    await product.save();

    if (publicId) await this.destroy(publicId);
    return product;
  }

  /**
   * Borra el archivo de un producto que desaparece.
   *
   * Se llama desde el borrado del producto: sin esto, cada producto
   * eliminado deja su foto en Cloudinary sin que nada la referencie ya.
   */
  async forget(product: IProduct): Promise<void> {
    if (product.imageAsset?.publicId) await this.destroy(product.imageAsset.publicId);
    // La galería también: si no, borrar un producto con cinco fotos deja
    // cinco archivos huérfanos en vez de uno.
    for (const image of product.gallery ?? []) {
      await this.destroy(image.publicId);
    }
  }

  // ── Entrega ──────────────────────────────────────────────────────────

  /**
   * Las URLs que consume el frontend.
   *
   * La construcción vive en `utils/productImageUrls` porque el modelo la
   * necesita para su campo virtual y no puede importar este servicio sin
   * crear un ciclo.
   */
  urlsFor(asset: IProductImage | null | undefined): ProductImageUrls | null {
    return productImageUrls(asset);
  }

  private buildUrl(asset: IProductImage, size: number): string {
    return productImageUrl(asset, size);
  }

  // ── Almacenamiento ───────────────────────────────────────────────────

  /**
   * Sube el master y le calcula la miniatura incrustada.
   *
   * Aislado para poder sustituirlo en pruebas sin tocar la red.
   *
   * Con recorte de fondo no se incrusta: Cloudinary lo aplica en diferido,
   * así que la miniatura saldría de la foto con fondo. La URL, que se
   * deriva al pedirla, ya ve la recortada.
   */
  private async store(params: {
    buffer: Buffer;
    businessId: string;
    productId: string;
    removeBackground: boolean;
  }): Promise<StoredImage> {
    const uploaded = await this.upload(params);
    const placeholderDataUri = params.removeBackground
      ? null
      : await fetchInlinePlaceholder(uploaded.publicId, uploaded.version);
    const { version: _version, ...stored } = uploaded;
    return { ...stored, placeholderDataUri };
  }

  private upload(params: {
    buffer: Buffer;
    businessId: string;
    productId: string;
    removeBackground: boolean;
  }): Promise<Omit<StoredImage, 'placeholderDataUri'> & { version: number }> {
    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: `${config.productImages.folder}/${params.businessId}`,
          public_id: params.productId,
          // Sobrescribe la del mismo producto: un `public_id` estable
          // evita acumular una foto por cada edición.
          overwrite: true,
          invalidate: true,
          resource_type: 'image',
          // El master se guarda acotado. Nadie va a mirar un producto a
          // más de 1200 px y guardar el original de 4000 solo cuesta.
          transformation: [{ width: 1200, height: 1200, crop: 'limit' }],
          tags: ['product-image', params.businessId],
          ...(params.removeBackground ? { background_removal: 'cloudinary_ai' } : {}),
        },
        (error, result) => {
          if (error || !result) {
            reject(
              new AppError(
                'No pudimos guardar la imagen. Inténtalo de nuevo.',
                502,
                PRODUCT_IMAGE_ERROR.STORAGE
              )
            );
            return;
          }
          resolve({
            publicId: result.public_id,
            width: result.width,
            height: result.height,
            bytes: result.bytes,
            format: result.format,
            version: result.version,
          });
        }
      );
      stream.end(params.buffer);
    });
  }

  /** Borrado tolerante a fallos: nunca tumba la operación que lo llamó. */
  private async destroy(publicId: string): Promise<void> {
    try {
      await cloudinary.uploader.destroy(publicId, { resource_type: 'image', invalidate: true });
    } catch (error) {
      console.error('[PRODUCT_IMAGE] No se pudo borrar la imagen anterior', {
        publicId,
        error: (error as Error).message,
      });
    }
  }
}

// ── Lectura de cabeceras ───────────────────────────────────────────────

/**
 * Ancho, alto y formato leídos del propio binario.
 *
 * Sin dependencias a propósito: son tres formatos y una cabecera cada
 * uno. Devuelve `null` para cualquier cosa que no sea una imagen
 * reconocible, que es lo que convierte "archivo corrupto" en un rechazo
 * temprano y no en un error de Cloudinary media subida después.
 */
export function readImageHeader(
  buffer: Buffer
): { format: 'jpg' | 'png' | 'webp'; width: number; height: number } | null {
  // ── PNG ──
  if (
    buffer.length > 24 &&
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
  ) {
    // El primer chunk de un PNG válido es siempre IHDR, y lleva las
    // dimensiones en sus ocho primeros bytes de datos.
    if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
    return {
      format: 'png',
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
  }

  // ── WEBP ──
  if (
    buffer.length > 30 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    const kind = buffer.toString('ascii', 12, 16);
    if (kind === 'VP8X') {
      // Anchos y altos de 24 bits, menos uno, en little-endian.
      return {
        format: 'webp',
        width: 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16)),
        height: 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16)),
      };
    }
    if (kind === 'VP8 ') {
      return {
        format: 'webp',
        width: buffer.readUInt16LE(26) & 0x3fff,
        height: buffer.readUInt16LE(28) & 0x3fff,
      };
    }
    if (kind === 'VP8L') {
      const bits = buffer.readUInt32LE(21);
      return {
        format: 'webp',
        width: 1 + (bits & 0x3fff),
        height: 1 + ((bits >> 14) & 0x3fff),
      };
    }
    return null;
  }

  // ── JPEG ──
  if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    // Hay que recorrer los segmentos hasta dar con un marcador SOF, que es
    // el único que lleva las dimensiones. Los demás (EXIF, cuantización,
    // Huffman) se saltan por su longitud declarada.
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];

      // Relleno y marcadores sin carga útil.
      if (marker === 0xff || (marker >= 0xd0 && marker <= 0xd9)) {
        offset += 2;
        continue;
      }

      const length = buffer.readUInt16BE(offset + 2);
      if (length < 2) return null;

      // SOF0..SOF15, excluyendo DHT (c4), JPGA (c8) y DAC (cc), que caen
      // en el mismo rango pero no describen la imagen.
      const isSof =
        marker >= 0xc0 && marker <= 0xcf &&
        marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

      if (isSof) {
        return {
          format: 'jpg',
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7),
        };
      }

      offset += 2 + length;
    }
    return null;
  }

  return null;
}

export const productImageService = new ProductImageService();
