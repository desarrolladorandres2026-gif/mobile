import {
  readOAuthCallback, bytesToBase64Url, hexToBytes, bytesToHex, pkceChallengeFromHex,
} from '../lib/oauthCallback';

/**
 * Logins por navegador (Apple y Facebook): el deep link de vuelta y PKCE.
 */

describe('Deep link de vuelta', () => {
  it('entrega el código si el state es el mismo', () => {
    expect(readOAuthCallback('zipp://apple-callback?code=abc&state=s1', 's1')).toEqual({ ok: true, code: 'abc' });
  });

  it('descarta un deep link con otro state (CSRF de login)', () => {
    expect(readOAuthCallback('zipp://apple-callback?code=abc&state=otro', 's1')).toEqual({ ok: false, reason: 'state' });
    expect(readOAuthCallback('zipp://apple-callback?code=abc', 's1')).toEqual({ ok: false, reason: 'state' });
  });

  it('distingue el error del proveedor de cerrar el navegador', () => {
    expect(readOAuthCallback('zipp://facebook-callback?error=1&state=s1', 's1')).toEqual({ ok: false, reason: 'error' });
    expect(readOAuthCallback(undefined, 's1')).toEqual({ ok: false, reason: 'cancelled' });
  });

  it('el deep link viejo con idToken ya no sirve', () => {
    // Antes la app buscaba `idToken`; el backend manda `code` desde el endurecimiento.
    expect(readOAuthCallback('zipp://apple-callback?idToken=x&state=s1', 's1')).toEqual({ ok: false, reason: 'error' });
  });
});

describe('PKCE', () => {
  it('base64url sin relleno, igual que la referencia de Node', () => {
    for (const len of [1, 2, 3, 4, 31, 32, 33]) {
      const bytes = Uint8Array.from({ length: len }, (_, i) => (i * 37 + len) % 256);
      expect(bytesToBase64Url(bytes)).toBe(Buffer.from(bytes).toString('base64url'));
    }
  });

  it('un verificador de 32 bytes da 43 caracteres (el mínimo de RFC 7636)', () => {
    expect(bytesToBase64Url(new Uint8Array(32).fill(255))).toHaveLength(43);
  });

  it('code_challenge S256 a partir del SHA-256 en hexadecimal', () => {
    // SHA-256 de "dBjftJeZ4CVP-mJ92ZcC9RGvwO7w1fkJp7s-WQ-3Y2A", calculado con Node.
    const hex = '76068b5a95e35a3d2a2de07da14c596b1908b0af8914dbabf046ebff015d3d02';
    expect(pkceChallengeFromHex(hex)).toBe('dgaLWpXjWj0qLeB9oUxZaxkIsK-JFNur8Ebr_wFdPQI');
  });

  it('hex ↔ bytes ida y vuelta', () => {
    expect(bytesToHex(hexToBytes('00ff10ab'))).toBe('00ff10ab');
  });
});
