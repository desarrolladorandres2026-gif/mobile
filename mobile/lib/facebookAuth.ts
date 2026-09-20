import { useCallback } from 'react';
import * as WebBrowser from 'expo-web-browser';
import * as Crypto from 'expo-crypto';
import Constants from 'expo-constants';
import { API_URL } from '../constants';
import { readOAuthCallback, bytesToHex, bytesToBase64Url, pkceChallengeFromHex } from './oauthCallback';

const facebookAuth = (Constants.expoConfig?.extra?.facebookAuth ?? {}) as {
  appId?: string;
  graphVersion?: string;
};

/** `app.json` trae `YOUR_FACEBOOK_APP_ID` hasta que exista la app en Meta. */
const isPlaceholder = (id?: string) => !id || id.startsWith('YOUR_');
export const isFacebookConfigured = !isPlaceholder(facebookAuth.appId);

// Meta exige un redirect HTTPS registrado en la app ("URI de
// redireccionamiento de OAuth válidos"), igual que Apple: el diálogo vuelve
// al backend y este rebota al deep link. Tiene que ser exactamente el
// `FACEBOOK_REDIRECT_URI` del backend, o Meta rechaza el canje.
const FACEBOOK_REDIRECT_URI = `${API_URL}/auth/facebook/callback`;
const FACEBOOK_APP_DEEP_LINK = 'zipp://facebook-callback';

/**
 * "Continuar con Facebook" sin SDK nativo (decisión del 2026-09-19): nada que
 * recompilar y el secreto de Meta solo en el servidor.
 *
 * PKCE: el `code_verifier` nace aquí y nunca sale del teléfono hasta el
 * canje; a Meta solo va su SHA-256. Una app que registre `zipp://` y capture
 * el deep link se queda con un código que no puede canjear.
 *
 * Devuelve `null` si la persona cerró el diálogo o negó el permiso, y lanza
 * si Meta o el backend fallaron.
 */
export function useFacebookAuth() {
  const signIn = useCallback(async (): Promise<{ code: string; codeVerifier: string } | null> => {
    if (!isFacebookConfigured) return null;

    const state = bytesToHex(await Crypto.getRandomBytesAsync(16));
    // 32 bytes → 43 caracteres base64url: el mínimo de RFC 7636.
    const codeVerifier = bytesToBase64Url(await Crypto.getRandomBytesAsync(32));
    const codeChallenge = pkceChallengeFromHex(
      await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, codeVerifier)
    );

    const dialogUrl =
      `https://www.facebook.com/${facebookAuth.graphVersion ?? 'v21.0'}/dialog/oauth?` +
      new URLSearchParams({
        client_id: facebookAuth.appId!,
        redirect_uri: FACEBOOK_REDIRECT_URI,
        response_type: 'code',
        scope: 'public_profile,email',
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      }).toString();

    const result = await WebBrowser.openAuthSessionAsync(dialogUrl, FACEBOOK_APP_DEEP_LINK);
    if (result.type !== 'success') return null;

    const back = readOAuthCallback(result.url, state);
    if (back.ok) return { code: back.code, codeVerifier };
    if (back.reason === 'cancelled') return null;
    // `error=1` también es lo que manda el backend cuando la persona negó el
    // permiso en el diálogo de Meta: no vale la pena asustarla con un error.
    if (back.reason === 'error') return null;
    throw new Error('Facebook no confirmó el inicio de sesión');
  }, []);

  return { signIn, isConfigured: isFacebookConfigured };
}
