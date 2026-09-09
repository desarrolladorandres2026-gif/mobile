import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

/**
 * Almacén para lo que no puede quedar en claro.
 *
 * Los tokens de sesión vivían en `AsyncStorage`, que en Android es una base
 * SQLite sin cifrar y en iOS un fichero normal — nada de Keychain. El modelo
 * de amenaza ya estaba reconocido en el código: el backend rota el refresh
 * token en cada uso y trata reusar uno viejo como robo de sesión. Esa
 * defensa asume que el token es difícil de leer, y el almacén no acompañaba.
 *
 * En web `expo-secure-store` no existe, así que allí se cae a
 * `AsyncStorage` (que es `localStorage`). No es una mejora de seguridad en
 * ese entorno y no se pretende que lo sea: es lo que hay en un navegador, y
 * degradar en silencio es mejor que romper la PWA.
 */

const isWeb = Platform.OS === 'web';

export async function secureGet(key: string): Promise<string | null> {
  try {
    if (isWeb) return await AsyncStorage.getItem(key);
    return await SecureStore.getItemAsync(key);
  } catch {
    // Un almacén ilegible se trata como vacío: es lo mismo que no tener
    // sesión, y lanzar aquí impediría arrancar la app para siempre.
    return null;
  }
}

export async function secureSet(key: string, value: string): Promise<void> {
  try {
    if (isWeb) {
      await AsyncStorage.setItem(key, value);
      return;
    }
    await SecureStore.setItemAsync(key, value, {
      // El token se necesita para refrescar la sesión al abrir la app, y en
      // ese momento el teléfono puede estar recién reiniciado y sin
      // desbloquear todavía. Con la opción más estricta, la sesión se
      // perdería en cada reinicio.
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
    });
  } catch {
    // Ver `secureGet`: no poder guardar degrada a "no hay sesión guardada",
    // que el usuario resuelve entrando otra vez.
  }
}

export async function secureDelete(key: string): Promise<void> {
  try {
    if (isWeb) {
      await AsyncStorage.removeItem(key);
      return;
    }
    await SecureStore.deleteItemAsync(key);
  } catch {
    // Nada que hacer: si no se puede borrar, tampoco se puede avisar.
  }
}
