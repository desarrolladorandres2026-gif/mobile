/**
 * Geometría del recorte de fotos, sin DOM.
 *
 * Todo en unidades del marco: su ancho vale 1. Así las mismas cuentas
 * sirven para la vista previa en pantalla (320 px) y para el archivo que
 * se sube (1200 px), y un encuadre guardado se puede reabrir en un editor
 * de otro ancho.
 */

/** Proporción del marco. Cuadrada salvo que la pantalla de destino pida otra. */
export interface Aspect {
  w: number;
  h: number;
}

export const SQUARE: Aspect = { w: 1, h: 1 };

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;

/**
 * El encuadre, sin atarse a un tamaño de pantalla.
 *
 * El desplazamiento va en fracciones del **ancho** del marco (los dos ejes)
 * y no en píxeles: así el mismo encuadre se reabre en un editor de otro
 * ancho, o se exporta a 1200 px sin abrir el editor —que es lo que hace
 * "Girar" en la ficha del producto—.
 */
export interface CropTransform {
  zoom: number;
  /** Grados, múltiplo de 90. */
  rotation: number;
  x: number;
  y: number;
}

export const INITIAL_CROP: CropTransform = { zoom: 1, rotation: 0, x: 0, y: 0 };

export interface NaturalSize {
  naturalWidth: number;
  naturalHeight: number;
}

/** Lo que el editor entrega además del archivo recortado. */
export interface CropResult extends NaturalSize {
  transform: CropTransform;
  /** Medidas del archivo exportado. */
  width: number;
  height: number;
}

export const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

/** Medidas de la foto ya girada: a 90° o 270° el ancho y el alto se cambian. */
export function rotatedSize(image: NaturalSize, rotation: number) {
  const swapped = rotation % 180 !== 0;
  return {
    width: swapped ? image.naturalHeight : image.naturalWidth,
    height: swapped ? image.naturalWidth : image.naturalHeight,
  };
}

/**
 * Cuánto hay que escalar la foto para que cubra un marco de ancho 1.
 *
 * Se calcula sobre las medidas ya giradas. Sin esto, una foto apaisada
 * girada dejaría dos franjas vacías.
 */
export function coverScale(image: NaturalSize, rotation: number, aspect: Aspect): number {
  const { width, height } = rotatedSize(image, rotation);
  return Math.max(1 / width, aspect.h / aspect.w / height);
}

/**
 * Recorta el desplazamiento para que no se vea el fondo.
 *
 * El margen disponible es la mitad de lo que sobresale por cada lado.
 * Cuando el zoom es 1 la imagen encaja justo y el margen es cero: la
 * foto no se puede mover, que es el comportamiento correcto.
 */
export function clampCrop(
  next: { x: number; y: number },
  image: NaturalSize,
  rotation: number,
  zoom: number,
  aspect: Aspect
): { x: number; y: number } {
  const { width, height } = rotatedSize(image, rotation);
  const scale = coverScale(image, rotation, aspect) * zoom;
  const slackX = Math.max(0, (width * scale - 1) / 2);
  const slackY = Math.max(0, (height * scale - aspect.h / aspect.w) / 2);
  // `+ 0` convierte en 0 el −0 que sale de acotar a un margen nulo.
  return {
    x: clamp(next.x, -slackX, slackX) + 0,
    y: clamp(next.y, -slackY, slackY) + 0,
  };
}

/**
 * El mismo encuadre girado 90° a la derecha, sin perder lo que se veía.
 *
 * Girar el resultado alrededor del centro lleva el punto (x, y) a (−y, x)
 * —en pantalla la y crece hacia abajo—. Solo vale para marcos cuadrados:
 * en uno apaisado el giro cambiaría la proporción del resultado.
 */
export function rotateCrop(transform: CropTransform): CropTransform {
  return {
    zoom: transform.zoom,
    rotation: (transform.rotation + 90) % 360,
    // `+ 0` convierte el −0 de negar un cero en un 0 corriente.
    x: -transform.y + 0,
    y: transform.x,
  };
}

/**
 * Píxeles de la foto original que caben a lo ancho del marco.
 *
 * Es lo que decide la nitidez, no los 1200 del archivo: el editor escala
 * siempre a ese ancho, así que una foto de 400 px sale de 1200 igual de
 * borrosa. Acercar con el zoom reduce la cifra en la misma proporción.
 */
export function cropSourcePixels(result: CropResult, aspect: Aspect = SQUARE): number {
  const scale = coverScale(result, result.transform.rotation, aspect) * result.transform.zoom;
  return Math.round(1 / scale);
}
