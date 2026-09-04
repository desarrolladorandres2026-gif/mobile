import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

// Cloudinary vuelve a recortar y optimizar, pero comprimir aquí es lo que
// ahorra datos y hace la subida rápida: el original de la cámara puede
// pesar 4–8 MB y sólo necesitamos una miniatura cuadrada.
const AVATAR_UPLOAD_SIZE = 640; // lado máximo en px antes de subir
const AVATAR_UPLOAD_QUALITY = 0.8; // 0 = mínima calidad, 1 = sin comprimir

/**
 * Toma la imagen elegida en la galería y devuelve un archivo local ya
 * reducido y recomprimido en JPEG, listo para subir.
 */
export async function prepareAvatarForUpload(uri: string): Promise<string> {
  const rendered = await ImageManipulator.manipulate(uri)
    .resize({ width: AVATAR_UPLOAD_SIZE })
    .renderAsync();
  const result = await rendered.saveAsync({
    compress: AVATAR_UPLOAD_QUALITY,
    format: SaveFormat.JPEG,
  });
  return result.uri;
}
