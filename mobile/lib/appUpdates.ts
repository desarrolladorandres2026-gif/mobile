import * as Updates from 'expo-updates';
import { reportError } from './crashReporting';

/**
 * Actualizaciones por aire (OTA).
 *
 * Sin esto, cada arreglo —incluidos los seis defectos del Bloque 0— exigía
 * una release de tienda y esperar a que la gente actualizara a mano. Un bug
 * en el flujo de dinero podía tardar días en dejar de existir.
 *
 * Solo actualiza el JavaScript. Cualquier cambio nativo (una dependencia
 * nueva, un permiso) sigue necesitando build de tienda: OTA no es un
 * sustituto de publicar, es lo que evita publicar por una línea.
 */

/**
 * Busca una actualización y la descarga, sin reiniciar.
 *
 * **No se recarga la app sola.** Un `reloadAsync()` en caliente puede caer a
 * mitad de un checkout y hacerle perder el pedido a alguien: se descarga
 * ahora y el sistema la aplica en el siguiente arranque en frío, que es
 * cuando no hay nada que interrumpir.
 *
 * Devuelve si quedó una versión nueva lista, por si algún día se quiere
 * ofrecer un "hay una versión nueva, toca para aplicarla".
 */
export async function checkForUpdate(): Promise<boolean> {
  // En desarrollo no hay canal de actualizaciones y estas llamadas lanzan.
  if (!Updates.isEnabled || __DEV__) return false;

  try {
    const result = await Updates.checkForUpdateAsync();
    if (!result.isAvailable) return false;

    await Updates.fetchUpdateAsync();
    return true;
  } catch (err) {
    // Un fallo aquí no es del usuario y no puede interrumpirle nada: sigue
    // con la versión que ya tiene. Se reporta porque un canal de
    // actualizaciones roto es exactamente lo que no se quiere descubrir el
    // día que haga falta usarlo con urgencia.
    reportError(err, { scope: 'updates:check' });
    return false;
  }
}
