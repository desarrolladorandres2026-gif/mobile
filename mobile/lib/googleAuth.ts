import { useCallback, useEffect } from 'react';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import type {
  GoogleSignin as GoogleSigninType,
  isSuccessResponse as isSuccessResponseType,
} from '@react-native-google-signin/google-signin';

const googleAuth = (Constants.expoConfig?.extra?.googleAuth ?? {}) as {
  webClientId?: string;
  iosClientId?: string;
  androidClientId?: string;
};

/** `app.json` todavía trae los `YOUR_GOOGLE_..._CLIENT_ID` de plantilla. */
const isPlaceholder = (id?: string) => !id || id.startsWith('YOUR_');

const hasRealClientIds =
  !isPlaceholder(googleAuth.webClientId) &&
  !isPlaceholder(googleAuth.iosClientId) &&
  !isPlaceholder(googleAuth.androidClientId);

/**
 * Expo Go es un binario genérico: no trae compilado el módulo nativo de
 * `@react-native-google-signin/google-signin`. Solo `require`arlo (y por lo
 * tanto ejecutar su `TurboModuleRegistry.getEnforcing` de nivel superior)
 * cuando corremos en un development build de verdad — si no, la app entera
 * se cae al abrir el login.
 */
const isExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

let GoogleSignin: typeof GoogleSigninType | undefined;
let isSuccessResponse: typeof isSuccessResponseType | undefined;

if (!isExpoGo && hasRealClientIds) {
  try {
    ({ GoogleSignin, isSuccessResponse } = require('@react-native-google-signin/google-signin'));
  } catch {
    // Módulo nativo no vinculado en este binario (p. ej. build vieja sin el
    // plugin de config aplicado todavía): tratar como no configurado.
  }
}

const isGoogleConfigured = !!GoogleSignin && !!isSuccessResponse;

let didConfigure = false;

/**
 * `GoogleSignin.configure` solo hace falta llamarlo una vez por vida de la
 * app, no en cada intento de login — de ahí la bandera de módulo en vez de
 * volver a llamarlo dentro de `signIn`.
 */
function ensureConfigured() {
  if (didConfigure || !isGoogleConfigured || !GoogleSignin) return;
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
    if (!isGoogleConfigured || !GoogleSignin || !isSuccessResponse) return null;
    ensureConfigured();

    await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
    const response = await GoogleSignin.signIn();

    // type !== 'success' es el usuario cerrando el selector: no es un error.
    if (!isSuccessResponse(response)) return null;
    return response.data.idToken;
  }, []);

  return { signIn, isConfigured: isGoogleConfigured };
}
