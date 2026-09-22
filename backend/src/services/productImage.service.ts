import crypto from 'crypto';
import { Types } from 'mongoose';
import { cloudinary, config } from '../config';
import { AppError } from '../middlewares';
import { IProduct, IProductImage, IProductImageCutout, Product } from '../models';
import {
  PRODUCT_IMAGE_VARIANTS,
  ProductImageUrls,
  productImagePlaceholderUrl,
  productImageUrl,
  productImageUrls,
} from '../utils/productImageUrls';
import { readImageHeader } from '../utils/imageHeader';
import { getBackgroundRemovalProvider } from './imageProcessing';

export { PRODUCT_IMAGE_VARIANTS, readImageHeader };
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
 *    resultado con el producto real. El recorte de fondo sigue la misma
 *    regla: es un **segundo archivo** (`imageAsset.cutout`), y el original
 *    no se toca.
 *
 * 3. **Todas las variantes son cuadradas.** El catálogo mezcla fotos de
 *    cincuenta comercios distintos y la uniformidad es lo que hace que no
 *    parezca un tablón de anuncios. `crop: 'fill'` recorta, nunca
 *    deforma, y `gravity: 'auto'` deja el producto centrado sin que nadie
 *    tenga que encuadrarlo a mano.
 *
 * Los `public_id` dependen del contenido (`<producto>-<sha12>`): la
 * portada, cada foto de galería y cada recorte tienen el suyo. Con un id
 * fijo por producto, como antes, la galería sobrescribía la portada en
 * Cloudinary y borrar una foto de galería borraba la portada.
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
 * La parte del `public_id` que sale del contenido.
 *
 * Doce caracteres hexadecimales del SHA-256 bastan para que dos fotos del
 * mismo producto no choquen nunca, y la misma foto dé siempre el mismo id.
 */
const contentKey = (checksum: string) => checksum.slice(0, 12);

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
  version?: number,
  options: { cutout?: boolean } = {}
): Promise<string | null> {
  try {
    const url = productImagePlaceholderUrl(publicId, {
      format: 'webp',
      version,
      cutout: options.cutout,
    });
    const res = await fetch(url, { signal: AbortSignal.timeout(PLACEHOLDER_FETCH_TIMEOUT_MS) });
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
  get isConfigured(): boolean {
    return Boolean(config.cloudinary.cloudName && config.cloudinary.apiKey);
  }

  /**
   * Si se puede quitar el fondo en este entorno: hace falta un proveedor
   * con su clave y, además, Cloudinary para guardar el resultado.
   */
  get backgroundRemovalAvailable(): boolean {
    return this.isConfigured && Boolean(getBackgroundRemovalProvider()?.isConfigured());
  }

  /**
   * Lo que el panel necesita saber antes de enseñar un botón.
   *
   * `backgroundRemoval` es un booleano y nada más: ni el proveedor ni su
   * clave salen del backend.
   */
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
      throw new AppError(
        `La imagen pesa más de ${(maxBytes / (1024 * 1024)).toFixed(0)} MB. Tómala de nuevo o redúcela antes de subirla.`,
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
   *
   * La misma foto dos veces (mismo SHA-256) no se vuelve a subir: devuelve
   * el producto tal cual. Quitarle el fondo es cosa del orquestador
   * (`backgroundRemoval.service.ts`), que decide si hace falta.
   *
   * Devuelve el producto leído de nuevo, no el que recibió: la escritura es
   * atómica y el documento de entrada puede no saber de un recorte que
   * terminó mientras se subía la foto.
   */
  async replace(params: {
    product: IProduct;
    buffer: Buffer;
    mimetype: string;
    enhance?: boolean;
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
    if (product.imageAsset?.checksum === inspected.checksum) return product;

    const productId = product._id.toString();
    const uploaded = await this.store({
      buffer,
      businessId: product.businessId.toString(),
      productId,
      publicId: `${productId}-${contentKey(inspected.checksum)}`,
    });

    const asset = {
      publicId: uploaded.publicId,
      width: uploaded.width,
      height: uploaded.height,
      bytes: uploaded.bytes,
      format: uploaded.format,
      checksum: inspected.checksum,
      enhanced: params.enhance !== false,
      backgroundRemoved: false,
      placeholderDataUri: uploaded.placeholderDataUri,
      uploadedAt: new Date(),
      cutout: null,
      backgroundRemoval: null,
      useOriginal: false,
    };

    // `image` sigue siendo la URL de catálogo porque la app móvil lee ese
    // campo. Cambiarlo a un objeto habría roto todas las fichas de
    // producto en los teléfonos que no se hayan actualizado.
    //
    // Sin `new`: devuelve el documento de antes de escribir, que es la
    // única forma de saber con certeza qué archivos dejaron de usarse.
    const before = await Product.findOneAndUpdate(
      { _id: product._id },
      { $set: { imageAsset: asset, image: productImageUrl(asset, PRODUCT_IMAGE_VARIANTS.catalog) } }
    ).lean();

    if (!before) {
      // El producto se borró mientras subía su foto.
      await this.destroy(uploaded.publicId);
      throw new AppError('Producto no encontrado', 404);
    }

    // Ya no los referencia nadie. Si el borrado falla no se propaga: el
    // producto está bien guardado y lo único que queda es un archivo de
    // más, que es infinitamente preferible a devolver un error por algo
    // que al comercio ya le salió bien.
    await this.release(product._id, [
      before.imageAsset?.publicId,
      before.imageAsset?.cutout?.publicId,
    ]);

    return (await Product.findById(product._id))!;
  }

  /**
   * Cambia los ajustes de entrega sin volver a subir el archivo.
   *
   * Es lo que hace que "Mejorar" y "Usar imagen original" sean
   * interruptores y no viajes de ida: las variantes se recalculan desde los
   * mismos archivos.
   *
   * Escritura condicionada y no `save()`: si un recorte termina entre la
   * lectura y la escritura, un `save()` de todo `imageAsset` lo borraría.
   * Aquí la condición va en el filtro y, si el estado cambió, se vuelve a
   * leer.
   */
  async updateOptions(
    product: IProduct,
    options: { enhance?: boolean; useOriginal?: boolean }
  ): Promise<IProduct> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await Product.findById(product._id).lean();
      const asset = current?.imageAsset;
      if (!asset) {
        throw new AppError('Este producto no tiene imagen', 404, PRODUCT_IMAGE_ERROR.NO_IMAGE);
      }

      const next = {
        ...asset,
        enhanced: options.enhance ?? asset.enhanced,
        useOriginal: options.useOriginal ?? Boolean(asset.useOriginal),
      };

      const updated = await Product.findOneAndUpdate(
        {
          _id: product._id,
          'imageAsset.checksum': asset.checksum,
          'imageAsset.cutout.publicId': asset.cutout?.publicId ?? null,
          'imageAsset.backgroundRemoval.status': asset.backgroundRemoval?.status ?? null,
        },
        {
          $set: {
            'imageAsset.enhanced': next.enhanced,
            'imageAsset.useOriginal': next.useOriginal,
            image: productImageUrl(next, PRODUCT_IMAGE_VARIANTS.catalog),
          },
        },
        { new: true }
      );
      if (updated) return updated;
    }

    throw new AppError('La foto cambió mientras la editabas. Inténtalo de nuevo.', 409);
  }

  // ── Galería ────────────────────────────────────────────────────────

  /** Cuántas fotos adicionales admite un producto. */
  static readonly MAX_GALLERY = 5;

  /**
   * Añade una foto a la galería del producto.
   *
   * No toca `imageAsset`: la principal se cambia con `replace` y es la que
   * leen las listas. Esto es lo que se desliza en la ficha. Tampoco se le
   * quita el fondo: la galería suele ser de contexto (el plato servido, el
   * empaque) y cada recorte cuesta un crédito.
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

    const productId = product._id.toString();
    const uploaded = await this.store({
      buffer,
      businessId: product.businessId.toString(),
      productId,
      // Su propio id: con el de la portada, Cloudinary la sobrescribía.
      publicId: `${productId}-g-${contentKey(inspected.checksum)}`,
    });

    product.gallery.push({
      publicId: uploaded.publicId,
      width: uploaded.width,
      height: uploaded.height,
      bytes: uploaded.bytes,
      format: uploaded.format,
      checksum: inspected.checksum,
      enhanced: true,
      backgroundRemoved: false,
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

    // Con la guarda: en los productos que sufrieron el fallo de la galería,
    // esa foto comparte archivo con la portada y borrarlo la dejaría sin foto.
    await this.release(product._id, [publicId]);
    return product;
  }

  /** Quita la imagen del producto y los archivos que la respaldaban. */
  async remove(product: IProduct): Promise<IProduct> {
    const before = await Product.findOneAndUpdate(
      { _id: product._id },
      { $set: { imageAsset: null, image: null } }
    ).lean();

    await this.release(product._id, [
      before?.imageAsset?.publicId,
      before?.imageAsset?.cutout?.publicId,
    ]);
    return (await Product.findById(product._id)) ?? product;
  }

  /**
   * Borra los archivos de un producto que desaparece.
   *
   * Se llama desde el borrado del producto: sin esto, cada producto
   * eliminado deja su foto en Cloudinary sin que nada la referencie ya.
   * Cada archivo una sola vez, aunque dos entradas lo compartan.
   */
  async forget(product: IProduct): Promise<void> {
    const ids = new Set<string>();
    if (product.imageAsset?.publicId) ids.add(product.imageAsset.publicId);
    if (product.imageAsset?.cutout?.publicId) ids.add(product.imageAsset.cutout.publicId);
    // La galería también: si no, borrar un producto con cinco fotos deja
    // cinco archivos huérfanos en vez de uno.
    for (const image of product.gallery ?? []) ids.add(image.publicId);
    for (const id of ids) await this.destroy(id);
  }

  /**
   * Borra los archivos que este producto ya no usa.
   *
   * Antes de borrar comprueba que ninguna entrada del producto siga
   * apuntando al archivo. Es la red para los datos que dejó el fallo de la
   * galería, donde portada y galería compartían el mismo `public_id`.
   */
  async release(
    productId: Types.ObjectId | string,
    publicIds: Array<string | null | undefined>
  ): Promise<void> {
    const unique = [...new Set(publicIds.filter((id): id is string => Boolean(id)))];
    for (const publicId of unique) {
      const stillUsed = await Product.exists({
        _id: productId,
        $or: [
          { 'imageAsset.publicId': publicId },
          { 'imageAsset.cutout.publicId': publicId },
          { 'gallery.publicId': publicId },
        ],
      });
      if (!stillUsed) await this.destroy(publicId);
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

  // ── Almacenamiento ───────────────────────────────────────────────────

  /**
   * Guarda el recorte sin fondo de la foto principal.
   *
   * Otro archivo, con su propio id (`<producto>-<sha12>-cutout`): el
   * original no se toca. La miniatura incrustada sale de la versión
   * compuesta, que es la que ocupa el hueco en el catálogo.
   */
  async storeCutout(params: {
    buffer: Buffer;
    businessId: string;
    productId: string;
    checksum: string;
    provider: string;
  }): Promise<IProductImageCutout> {
    const uploaded = await this.upload({
      buffer: params.buffer,
      businessId: params.businessId,
      publicId: `${params.productId}-${contentKey(params.checksum)}-cutout`,
      tags: ['product-image', 'product-cutout', params.businessId],
    });
    const placeholderDataUri = await fetchInlinePlaceholder(uploaded.publicId, uploaded.version, {
      cutout: true,
    });
    return {
      publicId: uploaded.publicId,
      width: uploaded.width,
      height: uploaded.height,
      bytes: uploaded.bytes,
      format: uploaded.format,
      provider: params.provider,
      placeholderDataUri,
      createdAt: new Date(),
    };
  }

  /**
   * Sube el master y le calcula la miniatura incrustada.
   *
   * Aislado para poder sustituirlo en pruebas sin tocar la red.
   */
  private async store(params: {
    buffer: Buffer;
    businessId: string;
    productId: string;
    publicId: string;
  }): Promise<StoredImage> {
    const uploaded = await this.upload({
      buffer: params.buffer,
      businessId: params.businessId,
      publicId: params.publicId,
      tags: ['product-image', params.businessId],
    });
    const placeholderDataUri = await fetchInlinePlaceholder(uploaded.publicId, uploaded.version);
    const { version: _version, ...stored } = uploaded;
    return { ...stored, placeholderDataUri };
  }

  private upload(params: {
    buffer: Buffer;
    businessId: string;
    publicId: string;
    tags: string[];
  }): Promise<Omit<StoredImage, 'placeholderDataUri'> & { version: number }> {
    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: `${config.productImages.folder}/${params.businessId}`,
          public_id: params.publicId,
          // El id sale del contenido: sobrescribir solo ocurre al volver a
          // subir exactamente el mismo archivo.
          overwrite: true,
          invalidate: true,
          resource_type: 'image',
          // El master se guarda acotado. Nadie va a mirar un producto a
          // más de 1200 px y guardar el original de 4000 solo cuesta.
          transformation: [{ width: 1200, height: 1200, crop: 'limit' }],
          tags: params.tags,
        },
        (error, result) => {
          if (error || !result) {
            console.error('[PRODUCT_IMAGE] Cloudinary rechazó la subida', {
              publicId: params.publicId,
              error: error?.message ?? 'sin resultado',
            });
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

export const productImageService = new ProductImageService();
