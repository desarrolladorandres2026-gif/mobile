import { cloudinary } from '../config';

/**
 * Construcción de las URLs de una imagen de producto.
 *
 * Vive aquí y no en `productImage.service.ts` por una razón concreta: el
 * **modelo** necesita estas URLs para exponerlas como campo virtual en
 * cada consulta, y el servicio importa el modelo. Con la lógica en el
 * servicio, model → service → model sería un ciclo. Este módulo no
 * importa ningún modelo: solo describe la forma que necesita.
 */

export type BackgroundRemovalStatusLike = 'none' | 'pending' | 'processing' | 'completed' | 'failed';

/** Lo mínimo que hace falta para construir una URL. */
export interface ProductImageAssetLike {
  publicId: string;
  width: number;
  height: number;
  enhanced: boolean;
  backgroundRemoved: boolean;
  /** La miniatura borrosa ya incrustada, si se calculó al subir. */
  placeholderDataUri?: string | null;
  /** La foto sin fondo, si ya existe. Opcional: lo de antes no la tiene. */
  cutout?: { publicId: string; placeholderDataUri?: string | null } | null;
  backgroundRemoval?: { status?: BackgroundRemovalStatusLike | null } | null;
  useOriginal?: boolean | null;
}

/** Tamaños que sirve el catálogo. Cuadrados, en píxeles. */
export const PRODUCT_IMAGE_VARIANTS = {
  /** Miniatura de la lista del menú (84 pt en móvil, a 2×). */
  thumb: 200,
  /** Tarjeta de catálogo y rejillas. */
  catalog: 400,
  /** Ficha del producto. */
  detail: 800,
  /** Pantallas grandes y zoom. */
  large: 1200,
} as const;

export interface ProductImageUrls {
  thumb: string;
  catalog: string;
  detail: string;
  large: string;
  /**
   * Versión diminuta y borrosa para pintar mientras carga la de verdad.
   *
   * Un `data:` URI cuando se calculó al subir; la URL de Cloudinary en los
   * productos que aún no pasaron por el relleno. Los dos se pintan igual.
   */
  placeholder: string;
  width: number;
  height: number;
  enhanced: boolean;
  /** Lo que se muestra no tiene fondo (recorte actual o complemento antiguo). */
  backgroundRemoved: boolean;
  /**
   * El producto sin fondo, **transparente**, a 1200 px como máximo.
   *
   * Una sola URL y no cuatro variantes: la carga de cada respuesta importa
   * (por eso salió `srcSet`), y quien la use puede pedir otro tamaño con la
   * misma transformación de ancho que ya aplica la app a logos y portadas.
   * Las variantes de arriba siguen siendo opacas, así que las apps que no
   * conocen este campo no notan nada.
   */
  cutout: string | null;
  /** En qué va el recorte: el panel lo usa para decir "Mejorando imagen…". */
  backgroundRemoval: BackgroundRemovalStatusLike;
  /** Se está sirviendo la foto original, con su fondo. */
  usingOriginal: boolean;
}

/**
 * Cadena de mejora automática.
 *
 * Deliberadamente moderada: cada efecto va por debajo de la mitad de su
 * rango. El objetivo es que un producto fotografiado con luz de cocina se
 * vea bien, no que se vea *distinto* — si al cliente le llega algo que no
 * se parece a la foto, el problema que se crea es mayor que el que se
 * resolvió.
 */
const ENHANCE_CHAIN = [
  // Iluminación: levanta sombras sin quemar los brillos.
  { effect: 'auto_brightness:40' },
  { effect: 'auto_contrast:35' },
  // Balance de blancos: el defecto más común bajo luz cálida de local.
  { effect: 'auto_color:30' },
  // `vibrance` sube los tonos apagados y respeta los que ya están
  // saturados; `saturation` los subiría todos y volvería radiactiva
  // cualquier bebida.
  { effect: 'vibrance:15' },
  { effect: 'sharpen:80' },
];

/**
 * Fondo uniforme y sombra suave, del complemento de Cloudinary ya retirado.
 *
 * Solo lo usan las fotos que se subieron con aquel complemento
 * (`backgroundRemoved` sin `cutout`), para que se sigan viendo como
 * entonces. El recorte actual se compone con `cutoutVariantUrl`.
 */
const CLEAN_BACKGROUND = [
  { effect: 'shadow:40,x_0,y_8' },
  { background: 'rgb:f6f8fa' },
];

/**
 * El fondo sobre el que se compone el producto recortado en las variantes
 * de siempre. El mismo platino que usaba el recorte anterior, sin sombra:
 * las sombras son una decisión de estilo que todavía no se ha tomado.
 */
export const CUTOUT_CANVAS_BACKGROUND = 'rgb:f6f8fa';

/**
 * Qué parte del cuadro ocupa el producto. El resto es aire alrededor:
 * pegado al borde, un producto recortado parece cortado.
 */
export const CUTOUT_FILL_RATIO = 0.88;

/** Si lo que se sirve es el recorte y no la foto original. */
export function showsCutout(asset: ProductImageAssetLike): boolean {
  return Boolean(
    asset.cutout?.publicId &&
      asset.backgroundRemoval?.status === 'completed' &&
      !asset.useOriginal
  );
}

/**
 * Una variante cuadrada del producto recortado.
 *
 * `c_fit` lo encaja entero dentro del 88 % del cuadro —nunca lo estira ni
 * le corta un borde— y `c_pad` completa el cuadrado con el fondo, así el
 * producto queda centrado sin que nadie lo encuadre. El fondo va en el
 * mismo paso que el relleno para que cubra también los píxeles
 * transparentes del recorte, no solo el margen añadido.
 */
function cutoutVariantUrl(cutoutPublicId: string, enhanced: boolean, size: number): string {
  const inner = Math.round(size * CUTOUT_FILL_RATIO);
  return cloudinary.url(cutoutPublicId, {
    secure: true,
    transformation: [
      ...(enhanced ? ENHANCE_CHAIN : []),
      { width: inner, height: inner, crop: 'fit' },
      { width: size, height: size, crop: 'pad', background: CUTOUT_CANVAS_BACKGROUND },
      { quality: 'auto:good', fetch_format: 'auto' },
    ],
  });
}

/**
 * El recorte transparente, sin fondo ni margen.
 *
 * `f_auto` conserva el canal alfa: WebP o AVIF a quien los acepta y PNG a
 * lo demás — nunca JPG, que lo aplanaría.
 */
export function productImageCutoutUrl(publicId: string): string {
  return cloudinary.url(publicId, {
    secure: true,
    transformation: [
      { width: PRODUCT_IMAGE_VARIANTS.large, height: PRODUCT_IMAGE_VARIANTS.large, crop: 'limit' },
      { quality: 'auto:good', fetch_format: 'auto' },
    ],
  });
}

/**
 * Una variante cuadrada.
 *
 * `crop: 'fill'` recorta para llenar el cuadro y **nunca estira**;
 * `gravity: 'auto'` elige el recorte por contenido, que es lo que centra
 * el producto y se come el mantel sobrante. `f_auto` deja que Cloudinary
 * negocie el formato con el navegador: AVIF a quien lo acepta, WebP al
 * resto y JPG a lo demás, sin mantener tres copias.
 */
export function productImageUrl(asset: ProductImageAssetLike, size: number): string {
  if (showsCutout(asset)) return cutoutVariantUrl(asset.cutout!.publicId, asset.enhanced, size);
  return cloudinary.url(asset.publicId, {
    secure: true,
    transformation: [
      ...(asset.enhanced ? ENHANCE_CHAIN : []),
      ...(asset.backgroundRemoved ? CLEAN_BACKGROUND : []),
      { width: size, height: size, crop: 'fill', gravity: 'auto' },
      { quality: 'auto:good', fetch_format: 'auto' },
    ],
  });
}

/**
 * La miniatura borrosa: 24 px, muy comprimida, del mismo encuadre que las
 * variantes para que ocupe exactamente su hueco.
 *
 * `format` fijo solo para incrustarla: un `data:` URI no negocia con nadie,
 * y WebP lo pintan los dos teléfonos y todos los navegadores. `version`
 * obliga a Cloudinary a derivarla del archivo recién subido y no de la
 * copia de la foto anterior que el CDN aún pueda tener con el mismo
 * `public_id`.
 */
export function productImagePlaceholderUrl(
  publicId: string,
  options: { format?: 'auto' | 'webp'; version?: number; cutout?: boolean } = {}
): string {
  // Del recorte, la miniatura sale de la versión compuesta: es la que va a
  // ocupar el hueco, y la transparente se vería como una mancha.
  const frame = options.cutout
    ? [
        { width: 21, height: 21, crop: 'fit' },
        { width: 24, height: 24, crop: 'pad', background: CUTOUT_CANVAS_BACKGROUND },
      ]
    : [{ width: 24, height: 24, crop: 'fill', gravity: 'auto' }];
  return cloudinary.url(publicId, {
    secure: true,
    ...(options.version ? { version: options.version } : {}),
    transformation: [
      ...frame,
      { effect: 'blur:400', quality: 30, fetch_format: options.format ?? 'auto' },
    ],
  });
}

/**
 * Una fila de `.aggregate()` con sus variantes resueltas.
 *
 * Los virtuales de Mongoose no corren dentro de un pipeline: sin esto, la
 * búsqueda y las ofertas mandaban `imageAsset` en crudo y ningún `images`,
 * así que el móvil caía en `image` —la de 400 px— hasta para miniaturas
 * de 56, y sin miniatura borrosa mientras cargaba.
 */
export function withProductImages<T extends { imageAsset?: unknown }>(
  row: T
): Omit<T, 'imageAsset'> & { images: ProductImageUrls | null } {
  const { imageAsset, ...rest } = row;
  return { ...rest, images: productImageUrls(imageAsset as ProductImageAssetLike | null) };
}

export function productImageUrls(
  asset: ProductImageAssetLike | null | undefined
): ProductImageUrls | null {
  if (!asset?.publicId) return null;

  const url = (size: number) => productImageUrl(asset, size);
  const cutoutShown = showsCutout(asset);
  const completedCutout =
    asset.cutout?.publicId && asset.backgroundRemoval?.status === 'completed'
      ? asset.cutout
      : null;

  return {
    thumb: url(PRODUCT_IMAGE_VARIANTS.thumb),
    catalog: url(PRODUCT_IMAGE_VARIANTS.catalog),
    detail: url(PRODUCT_IMAGE_VARIANTS.detail),
    large: url(PRODUCT_IMAGE_VARIANTS.large),
    // Incrustada no cuesta un viaje a la red: pesa ~90 bytes, ocupa menos
    // texto que su propia URL y se pinta aunque no haya señal. La URL queda
    // de respaldo para los productos que el relleno aún no alcanzó.
    placeholder:
      cutoutShown && completedCutout
        ? completedCutout.placeholderDataUri ||
          productImagePlaceholderUrl(completedCutout.publicId, { cutout: true })
        : asset.placeholderDataUri || productImagePlaceholderUrl(asset.publicId),
    // Sin `srcSet`: repetía las cuatro URLs en cada producto de cada
    // respuesta —el 44 % del objeto— y solo lo usaba el panel del
    // comercio, que ahora lo arma con estas mismas variantes.
    width: asset.width,
    height: asset.height,
    enhanced: asset.enhanced,
    backgroundRemoved: cutoutShown || (asset.backgroundRemoved && !asset.cutout),
    cutout: completedCutout ? productImageCutoutUrl(completedCutout.publicId) : null,
    backgroundRemoval: asset.backgroundRemoval?.status ?? 'none',
    usingOriginal: !cutoutShown,
  };
}
