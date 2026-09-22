/**
 * Lectura de cabeceras de imagen sin dependencias.
 *
 * Vive en `utils` y no en `productImage.service.ts` porque la usan
 * también el proveedor de recorte de fondo y los flyers de publicidad:
 * dentro del servicio, el proveedor —que el servicio importa— cerraría un
 * ciclo de imports.
 */

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

/**
 * Si un PNG trae transparencia.
 *
 * Es la prueba de que el recorte ocurrió: un proveedor que devuelve la foto
 * opaca —con el fondo pintado de blanco, o la misma de entrada— respondió
 * "bien" sin hacer el trabajo, y guardar eso como recorte dejaría al
 * comercio creyendo que su foto ya no tiene fondo.
 *
 * Tipos de color 4 (gris + alfa) y 6 (RGBA) lo llevan en cada píxel; una
 * paleta (3) solo si trae un chunk `tRNS` antes de los datos.
 */
export function pngHasAlpha(buffer: Buffer): boolean {
  const header = readImageHeader(buffer);
  if (header?.format !== 'png') return false;

  const colorType = buffer[25];
  if (colorType === 4 || colorType === 6) return true;
  if (colorType !== 3) return false;

  // Recorre los chunks desde el que sigue a IHDR (8 de firma + 25 de IHDR).
  let offset = 33;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (type === 'tRNS') return true;
    if (type === 'IDAT' || type === 'IEND') return false;
    offset += 12 + length;
  }
  return false;
}
