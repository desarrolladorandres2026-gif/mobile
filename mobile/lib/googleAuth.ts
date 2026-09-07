import * as WebBrowser from 'expo-web-browser';
import * as Google from 'expo-auth-session/providers/google';
import Constants from 'expo-constants';

WebBrowser.maybeCompleteAuthSession();

const googleAuth = (Constants.expoConfig?.extra?.googleAuth ?? {}) as {
  webClientId?: string;
  iosClientId?: string;
  androidClientId?: string;
};

/**
 * Flujo de Google resuelto en el navegador del sistema vía `expo-auth-session`.
 * No requiere el módulo nativo de Google (que exige un development build de
 * EAS): corre igual en Expo Go, en un dev build o en producción, y entrega
 * directamente el id_token que el backend valida en POST /auth/google.
 */
export function useGoogleAuth() {
  const [request, response, promptAsync] = Google.useIdTokenAuthRequest({
    webClientId: googleAuth.webClientId,
    iosClientId: googleAuth.iosClientId,
    androidClientId: googleAuth.androidClientId,
  });

  const idToken =
    response?.type === 'success' ? response.params.id_token : undefined;

  return { request, response, promptAsync, idToken };
}
