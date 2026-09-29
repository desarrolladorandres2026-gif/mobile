import { SQUARE, clampCrop, coverScale, type Aspect, type CropTransform } from './cropGeometry';

/**
 * Pintado y exportación del recorte: lo que necesita un <canvas>.
 *
 * Las cuentas del encuadre viven en `cropGeometry`; aquí solo se dibujan.
 * Lo usan el editor (vista previa y "Usar esta foto") y "Girar" en la
 * ficha del producto, que exporta sin abrir el editor.
 */

/** Ancho del master que se sube. En cuadrado, coincide con la variante grande. */
export const OUTPUT_WIDTH = 1200;

/** Pinta la foto transformada dentro de un marco de `frameWidth` píxeles. */
export function drawCrop(
  canvas: HTMLCanvasElement,
  image: HTMLImageElement,
  frameWidth: number,
  transform: CropTransform,
  aspect: Aspect
) {
  const context = canvas.getContext('2d');
  if (!context) return;

  const frameHeight = Math.round((frameWidth * aspect.h) / aspect.w);

  context.clearRect(0, 0, frameWidth, frameHeight);
  context.save();

  // El orden importa: primero al centro, luego el desplazamiento del
  // usuario, luego el giro. Girar antes movería la foto en diagonal.
  context.translate(
    frameWidth / 2 + transform.x * frameWidth,
    frameHeight / 2 + transform.y * frameWidth
  );
  context.rotate((transform.rotation * Math.PI) / 180);

  const scale = coverScale(image, transform.rotation, aspect) * transform.zoom * frameWidth;
  const drawWidth = image.naturalWidth * scale;
  const drawHeight = image.naturalHeight * scale;
  context.drawImage(image, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);

  context.restore();
}

/** Lienzo aparte, a la resolución de salida: el de la vista previa está a tamaño de pantalla. */
export function exportCrop(
  image: HTMLImageElement, transform: CropTransform, aspect: Aspect, sourceType: string
): Promise<Blob | null> {
  const output = document.createElement('canvas');
  output.width = OUTPUT_WIDTH;
  output.height = Math.round((OUTPUT_WIDTH * aspect.h) / aspect.w);
  drawCrop(output, image, OUTPUT_WIDTH, transform, aspect);

  // Un PNG o un WebP pueden traer transparencia —un producto ya recortado,
  // un logo—, y JPEG no la tiene: el navegador pinta de **negro** cada
  // píxel transparente al exportar. Esos salen en PNG. Una foto, en JPEG
  // al 92%: por encima el archivo crece sin que nadie note la diferencia,
  // y Cloudinary vuelve a comprimir con `q_auto` al servir. PNG
  // multiplicaría por seis el peso de una fotografía.
  const keepsTransparency = sourceType === 'image/png' || sourceType === 'image/webp';
  return new Promise((resolve) =>
    keepsTransparency
      ? output.toBlob(resolve, 'image/png')
      : output.toBlob(resolve, 'image/jpeg', 0.92)
  );
}

function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('No pudimos abrir esa imagen.'));
    };
    image.src = url;
  });
}

/**
 * Exporta un encuadre sin abrir el editor.
 *
 * Parte siempre de la foto original: girar el recorte ya exportado
 * recomprimiría el JPEG en cada vuelta.
 */
export async function renderCrop(
  file: Blob, transform: CropTransform, aspect: Aspect = SQUARE
): Promise<Blob | null> {
  const image = await loadImage(file);
  const offset = clampCrop(transform, image, transform.rotation, transform.zoom, aspect);
  return exportCrop(image, { ...transform, ...offset }, aspect, file.type);
}
