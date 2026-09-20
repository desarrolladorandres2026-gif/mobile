/**
 * Piezas puras de los logins por navegador (Apple y Facebook): leer el deep
 * link de vuelta y codificar lo que exige PKCE. Aparte de `appleAuth.ts` y
 * `facebookAuth.ts` para poder probarlas sin navegador ni módulos nativos.
 */

export type OAuthCallback =
  | { ok: true; code: string }
  /** `cancelled`: cerró el navegador o negó el permiso; no es un error que mostrar. */
  | { ok: false; reason: 'cancelled' | 'state' | 'error' };

/**
 * Lee `zipp://<proveedor>-callback?code=…&state=…` (o `error=1`).
 *
 * El `state` tiene que ser exactamente el que generó la app: si no, alguien
 * fabricó el deep link para meter a la víctima en una sesión ajena (CSRF de
 * login) y se descarta sin canjear nada.
 */
export function readOAuthCallback(url: string | null | undefined, expectedState: string): OAuthCallback {
  if (!url) return { ok: false, reason: 'cancelled' };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'error' };
  }
  if (parsed.searchParams.get('state') !== expectedState) return { ok: false, reason: 'state' };
  if (parsed.searchParams.get('error')) return { ok: false, reason: 'error' };
  const code = parsed.searchParams.get('code');
  return code ? { ok: true, code } : { ok: false, reason: 'error' };
}

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Base64url sin relleno (RFC 4648 §5), el formato de PKCE. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = Math.min(4, Math.ceil(((bytes.length - i) * 8) / 6));
    for (let j = 0; j < chars; j++) out += B64URL[(n >> (18 - 6 * j)) & 63];
  }
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export const bytesToHex = (bytes: Uint8Array) =>
  Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * `code_challenge` S256 de PKCE a partir del SHA-256 del verificador en
 * hexadecimal (lo que devuelve `expo-crypto`).
 */
export const pkceChallengeFromHex = (sha256Hex: string) => bytesToBase64Url(hexToBytes(sha256Hex));
