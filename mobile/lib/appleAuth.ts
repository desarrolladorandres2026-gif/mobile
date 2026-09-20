import { useCallback } from 'react';
import * as WebBrowser from 'expo-web-browser';
import * as Crypto from 'expo-crypto';
import Constants from 'expo-constants';
import { API_URL } from '../constants';
import { readOAuthCallback, bytesToHex } from './oauthCallback';

const appleAuth = (Constants.expoConfig?.extra?.appleAuth ?? {}) as {
  servicesId?: string;
};

/** `app.json` todavía trae el `YOUR_APPLE_SERVICES_ID` de plantilla. */
const isPlaceholder = (id?: string) => !id || id.startsWith('YOUR_');
const isAppleConfigured = !isPlaceholder(appleAuth.servicesId);

// Apple exige que el `redirect_uri` sea un dominio HTTPS registrado en el
// Services ID — nunca un esquema propio (`zipp://`) — así que el primer
// salto va al backend (`/auth/apple/callback`), que a su vez rebota a este
// deep link. Debe ser exactamente el mismo string en los dos lados: el
// backend lo arma con `config.deepLinkScheme` (por defecto "zipp", igual
// que el `scheme` de app.json).
const APPLE_REDIRECT_URI = `${API_URL}/auth/apple/callback`;
const APPLE_APP_DEEP_LINK = 'zipp://apple-callback';

/**
 * `state` es la defensa contra CSRF de login: si fuera adivinable, alguien
 * podría fabricar de antemano un `zipp://apple-callback?...&state=X` y
 * hacer que la víctima complete el login de Apple del atacante sin darse
 * cuenta. Por eso sale de `expo-crypto` (128 bits reales) y no de
 * `Math.random()`/`Date.now()`, que no son generadores criptográficos.
 */
async function randomState(): Promise<string> {
  return bytesToHex(await Crypto.getRandomBytesAsync(16));
}

/**
 * "Sign in with Apple" sin SDK nativo: a diferencia de Google, este flujo es
 * el mismo en cualquier plataforma (Apple no ofrece un SDK nativo para
 * Android) — abre el navegador del sistema contra `appleid.apple.com`, que
 * al terminar hace un `form_post` a nuestro backend, y el backend rebota al
 * deep link de la app. Por eso corre igual en Expo Go que en un dev build,
 * sin el `require` condicional que sí necesita `googleAuth.ts`.
 *
 * El deep link trae un `code` de un solo uso, no el `id_token`. Canjearlo
 * exige el `nonce` en claro que se genera aquí: a Apple se le manda solo su
 * SHA-256, que queda firmado dentro del token. Antes esta función buscaba
 * `idToken` en el deep link (que el backend ya no manda) y nunca generaba
 * el nonce, así que todo intento terminaba como "canceló".
 *
 * Devuelve `null` si la persona cerró el navegador, y lanza si Apple o el
 * backend fallaron, para que eso sí se le diga.
 */
export function useAppleAuth() {
  const signIn = useCallback(async (): Promise<{ code: string; nonce: string } | null> => {
    if (!isAppleConfigured) return null;

    const state = await randomState();
    const nonce = bytesToHex(await Crypto.getRandomBytesAsync(32));
    const nonceHash = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, nonce);

    const authorizeUrl =
      'https://appleid.apple.com/auth/authorize?' +
      new URLSearchParams({
        client_id: appleAuth.servicesId!,
        redirect_uri: APPLE_REDIRECT_URI,
        response_type: 'code id_token',
        response_mode: 'form_post',
        scope: 'name email',
        state,
        nonce: nonceHash,
      }).toString();

    const result = await WebBrowser.openAuthSessionAsync(authorizeUrl, APPLE_APP_DEEP_LINK);
    if (result.type !== 'success') return null;

    const back = readOAuthCallback(result.url, state);
    if (back.ok) return { code: back.code, nonce };
    if (back.reason === 'cancelled') return null;
    throw new Error('Apple no confirmó el inicio de sesión');
  }, []);

  return { signIn, isConfigured: isAppleConfigured };
}
