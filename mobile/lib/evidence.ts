import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

/** Ancho al que sale la evidencia del teléfono. */
const EVIDENCE_WIDTH = 1080;

/**
 * Toma la foto de evidencia y la deja lista para subir.
 *
 * Siempre con la cámara, nunca desde la galería: una evidencia elegida del
 * carrete no prueba nada — puede ser de otro pedido, de otro día o de una
 * búsqueda en internet. El backend no puede distinguirlo, así que la
 * restricción tiene que estar aquí, y por eso no se usa
 * `launchImageLibraryAsync`.
 *
 * La imagen se reduce a 1080 px de ancho y se recomprime a JPG antes de
 * salir del teléfono. En la puerta de una casa la conexión es la que es:
 * subir 8 MB de una cámara moderna es la diferencia entre entregar y
 * quedarse esperando la barra de progreso. Eran 1440 px; se bajó el
 * 2026-09-21 (~40 % menos por foto) y sigue leyéndose de sobra como prueba.
 */
export async function captureEvidence(): Promise<string | null> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) {
    throw new Error(
      'Necesitamos la cámara para registrar la evidencia. Actívala en los ajustes del teléfono.'
    );
  }

  const shot = await ImagePicker.launchCameraAsync({
    mediaTypes: ['images'],
    quality: 0.9,
    // Sin edición: recortar o rotar una evidencia es abrir la puerta a
    // "mejorarla". Se sube lo que vio la cámara.
    allowsEditing: false,
    exif: false,
  });

  if (shot.canceled || !shot.assets?.length) return null;

  const rendered = await ImageManipulator.manipulate(shot.assets[0].uri)
    .resize({ width: EVIDENCE_WIDTH })
    .renderAsync();

  const saved = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 0.75 });

  return saved.uri;
}
