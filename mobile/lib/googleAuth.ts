import { useCallback, useEffect } from 'react';
import Constants from 'expo-constants';
import {
  GoogleSignin,
  isSuccessResponse,
} from '@react-native-google-signin/google-signin';

const googleAuth = (Constants.expoConfig?.extra?.googleAuth ?? {}) as {
  webClientId?: string;
  iosClientId?: string;
  androidClientId?: string;
};

/** `app.json` todavía trae los `YOUR_GOOGLE_..._CLIENT_ID` de plantilla. */
const isPlaceholder = (id?: string) => !id || id.startsWith('YOUR_');

const isGoogleConfigured =
  !isPlaceholder(googleAuth.webClientId) &&
  !isPlaceholder(googleAuth.iosClientId) &&
  !isPlaceholder(googleAuth.androidClientId);

let didConfigure = false;

/**
 * `GoogleSignin.configure` solo hace falta llamarlo una vez por vida de la
 * app, no en cada intento de login — de ahí la bandera de módulo en vez de
 * volver a llamarlo dentro de `signIn`.
 */
function ensureConfigured() {
  if (didConfigure || !isGoogleConfigured) return;
  GoogleSignin.configure({
    webClientId: googleAuth.webClientId,
    iosClientId: googleAuth.iosClientId,
    offlineAccess: false,
  });
  didConfigure = true;
}

/**
 * Google con el selector nativo de cuentas (Credential Manager en Android,
 * el SDK de Google en iOS) — la cuenta se elige dentro de la propia app, sin
 * abrir el navegador del sistema.
 *
 * Reemplaza al flujo anterior por `expo-auth-session` (deprecado en el SDK
 * de Expo instalado): ese abría una pestaña de navegador para todo el
 * intercambio OAuth. Esto exige el módulo nativo del paquete, así que solo
 * corre en un development build — no en Expo Go.
 */
export function useGoogleAuth() {
  useEffect(() => { ensureConfigured(); }, []);

  const signIn = useCallback(async (): Promise<string | null> => {
    if (!isGoogleConfigured) return null;
    ensureConfigured();

    await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
    const response = await GoogleSignin.signIn();

    // type !== 'success' es el usuario cerrando el selector: no es un error.
    if (!isSuccessResponse(response)) return null;
    return response.data.idToken;
  }, []);

  return { signIn, isConfigured: isGoogleConfigured };
}
