import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

/**
 * La foto de un documento del domiciliario.
 *
 * Deliberadamente distinta de `captureEvidence`, que es camera-only: una
 * evidencia de entrega elegida del carrete no prueba nada, mientras que un
 * SOAT casi siempre llega al teléfono como un PDF o una captura del correo
 * de la aseguradora. Obligar a fotografiar la pantalla del portátil sería
 * empeorar la prueba en nombre de la seguridad.
 *
 * Y es que camera-only tampoco defiende de lo que parece: nada impide
 * fotografiar la cédula de otra persona. Lo que de verdad ata el documento
 * a quien conduce es la selfie de verificación en turno, que ya existe
 * (ver `driverSecurity.ts`). Esta foto sirve para *leer* el documento; la
 * identidad la comprueba el otro mecanismo.
 *
 * Se reduce a 1600px —más que la evidencia— porque aquí hay que leer un
 * número de póliza, y a 1440px con compresión agresiva los dígitos
 * pequeños se empastan.
 */

export type DocumentPhotoSource = 'camera' | 'library';

async function prepare(uri: string): Promise<string> {
  const rendered = await ImageManipulator.manipulate(uri)
    .resize({ width: 1600 })
    .renderAsync();

  // Menos compresión que en la evidencia (0.75): lo que se sube tiene que
  // poder leerse por un administrador, no solo reconocerse.
  const saved = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 0.85 });
  return saved.uri;
}

/**
 * Devuelve la ruta de la foto lista para subir, o `null` si se canceló.
 * Lanza con un mensaje presentable si falta el permiso.
 */
export async function captureDocumentPhoto(
  source: DocumentPhotoSource
): Promise<string | null> {
  if (source === 'camera') {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      throw new Error(
        'Necesitamos la cámara para tomar la foto del documento. Actívala en los ajustes del teléfono.'
      );
    }

    const shot = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images'],
      quality: 0.9,
      // Sí se permite encuadrar, al revés que en la evidencia: un
      // documento mal encuadrado es un documento que hay que rechazar y
      // volver a pedir, y cada rechazo es un día más sin poder trabajar.
      allowsEditing: true,
      exif: false,
    });

    if (shot.canceled || !shot.assets?.length) return null;
    return prepare(shot.assets[0].uri);
  }

  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    throw new Error(
      'Necesitamos permiso para acceder a tus fotos. Actívalo en los ajustes del teléfono.'
    );
  }

  const picked = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsEditing: true,
    quality: 0.9,
    exif: false,
  });

  if (picked.canceled || !picked.assets?.length) return null;
  return prepare(picked.assets[0].uri);
}
