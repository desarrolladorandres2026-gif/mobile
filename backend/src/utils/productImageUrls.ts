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

/** Lo mínimo que hace falta para construir una URL. */
export interface ProductImageAssetLike {
  publicId: string;
  width: number;
  height: number;
  enhanced: boolean;
  backgroundRemoved: boolean;
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
  /** Versión diminuta y borrosa para pintar mientras carga la de verdad. */
  placeholder: string;
  /** `srcset` listo para usar, en anchos reales. */
  srcSet: string;
  width: number;
  height: number;
  enhanced: boolean;
  backgroundRemoved: boolean;
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
 * Fondo uniforme y sombra suave.
 *
 * Solo se aplica cuando el recorte de fondo llegó a ejecutarse: sobre una
 * foto que conserva su fondo, poner otro detrás no hace nada.
 */
const CLEAN_BACKGROUND = [
  { effect: 'shadow:40,x_0,y_8' },
  { background: 'rgb:f6f8fa' },
];

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

export function productImageUrls(
  asset: ProductImageAssetLike | null | undefined
): ProductImageUrls | null {
  if (!asset?.publicId) return null;

  const url = (size: number) => productImageUrl(asset, size);

  return {
    thumb: url(PRODUCT_IMAGE_VARIANTS.thumb),
    catalog: url(PRODUCT_IMAGE_VARIANTS.catalog),
    detail: url(PRODUCT_IMAGE_VARIANTS.detail),
    large: url(PRODUCT_IMAGE_VARIANTS.large),
    // 24 px y muy comprimida: pesa un par de cientos de bytes, llega
    // antes que la imagen real y ocupa exactamente el mismo hueco, así
    // que la tarjeta no da el salto de maquetación al cargar.
    placeholder: cloudinary.url(asset.publicId, {
      secure: true,
      transformation: [
        { width: 24, height: 24, crop: 'fill', gravity: 'auto' },
        { effect: 'blur:400', quality: 30, fetch_format: 'auto' },
      ],
    }),
    srcSet: (Object.values(PRODUCT_IMAGE_VARIANTS) as number[])
      .map((size) => `${url(size)} ${size}w`)
      .join(', '),
    width: asset.width,
    height: asset.height,
    enhanced: asset.enhanced,
    backgroundRemoved: asset.backgroundRemoved,
  };
}
