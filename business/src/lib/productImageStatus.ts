import type { ProductImages } from '../components/SmartImage';

/**
 * Qué decirle al comercio sobre el recorte de fondo de su foto.
 *
 * Vive aparte del componente para poder probarlo sin montarlo: son las
 * frases que el comercio lee cuando algo sale mal, y equivocarse aquí es
 * decirle "listo" a una foto que sigue con su fondo.
 *
 * Nunca nombra al proveedor. Para el comercio esto es una función de
 * ZIPP, no una integración.
 */

/** Lo que el panel puede hacer con el recorte desde la ficha del producto. */
export type BackgroundAction = 'retry' | 'remove-background' | 'use-original' | 'use-cutout';

export interface ProductImageStatusView {
  /** Línea bajo la miniatura. `null` deja el texto de siempre. */
  message: string | null;
  /** Aviso (algo no salió) o información. */
  tone: 'info' | 'warning';
  /** Se está trabajando en la foto: spinner encima y consultas periódicas. */
  working: boolean;
  /** La acción de recorte que corresponde ahora, si hay alguna. */
  action: BackgroundAction | null;
}

const IDLE: ProductImageStatusView = { message: null, tone: 'info', working: false, action: null };

export const ACTION_LABEL: Record<BackgroundAction, string> = {
  retry: 'Reintentar',
  'remove-background': 'Quitar el fondo',
  'use-original': 'Usar imagen original',
  'use-cutout': 'Usar sin fondo',
};

/**
 * @param images   Las variantes que devolvió el servidor.
 * @param errorCode El código del último fallo (`imageAsset.backgroundRemoval.errorCode`).
 * @param canRemoveBackground Si este entorno puede quitar fondos. Sin eso
 *   no se ofrece ni "Quitar el fondo" ni "Reintentar": en vez de un botón
 *   que siempre falla, no hay botón.
 */
export function productImageStatus(
  images: ProductImages | null | undefined,
  errorCode: string | null | undefined,
  canRemoveBackground: boolean
): ProductImageStatusView {
  if (!images) return IDLE;

  switch (images.backgroundRemoval ?? 'none') {
    case 'pending':
    case 'processing':
      return { message: 'Mejorando imagen…', tone: 'info', working: true, action: null };

    case 'completed':
      return images.usingOriginal
        ? {
            message: 'Estás usando tu foto original.',
            tone: 'info',
            working: false,
            action: images.cutout ? 'use-cutout' : null,
          }
        : {
            message: 'Quitamos el fondo. Tu foto original se conserva.',
            tone: 'info',
            working: false,
            action: 'use-original',
          };

    case 'failed':
      return {
        message:
          errorCode === 'DAILY_LIMIT'
            ? 'Llegaste al máximo de fotos sin fondo por hoy. Usaremos la imagen original.'
            : 'No pudimos quitar el fondo. Usaremos la imagen original.',
        tone: 'warning',
        working: false,
        action: canRemoveBackground ? 'retry' : null,
      };

    default:
      return { ...IDLE, action: canRemoveBackground ? 'remove-background' : null };
  }
}

/**
 * El nombre del archivo según lo que el editor exportó de verdad: PNG si
 * la foto traía transparencia, JPEG si no. El servidor manda por los bytes,
 * pero un nombre que miente confunde a quien lea los registros.
 */
export function productImageFileName(blob: Blob): string {
  return blob.type === 'image/png' ? 'producto.png' : 'producto.jpg';
}

/** Cuánto seguir preguntando por un recorte antes de dejarlo para después. */
export const IMAGE_POLL_WINDOW_MS = 5 * 60_000;

/**
 * Si vale la pena volver a pedir este producto para ver su foto terminada.
 *
 * Con tope: un recorte que lleva más de cinco minutos pendiente lo está
 * reintentando el servidor más tarde, y consultar cada pocos segundos
 * hasta entonces solo gasta el límite de peticiones del comercio.
 */
export function isImageInProgress(
  product: {
    images?: ProductImages | null;
    imageAsset?: { backgroundRemoval?: { requestedAt?: string | null } | null } | null;
  },
  now = Date.now()
): boolean {
  const status = product.images?.backgroundRemoval;
  if (status !== 'pending' && status !== 'processing') return false;
  const requestedAt = Date.parse(product.imageAsset?.backgroundRemoval?.requestedAt ?? '');
  return Number.isNaN(requestedAt) || now - requestedAt < IMAGE_POLL_WINDOW_MS;
}
