import crypto from 'crypto';
import { describe, it, expect, vi } from 'vitest';
import { encrypt, decrypt } from '../security/encryption';
import { config } from '../config';

/**
 * El formato v2 del cifrado de secretos (códigos del pedido, 2FA).
 *
 * Lo que importa: lo nuevo se cifra rápido y sin bloquear, lo viejo se
 * sigue leyendo, y la semántica de "si no puedo descifrar, devuelvo lo que
 * me diste" no cambia — hay datos que nunca se cifraron.
 */

/** Cifra como lo hacía la versión anterior, para tener un dato "de antes". */
function legacyEncrypt(plainText: string): string {
  const salt = crypto.randomBytes(32);
  const key = crypto.pbkdf2Sync(config.security.encryptionKey, salt, 100000, 32, 'sha512');
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(plainText, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  return [salt, iv, cipher.getAuthTag()].map((b) => b.toString('base64')).concat(encrypted).join(':');
}

describe('encrypt / decrypt v2', () => {
  it('ida y vuelta', () => {
    const sealed = encrypt('482913');
    expect(sealed).toMatch(/^v2:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(decrypt(sealed)).toBe('482913');
  });

  it('el mismo texto cifrado dos veces da resultados distintos', () => {
    expect(encrypt('secreto')).not.toBe(encrypt('secreto'));
  });

  it('cifrar no corre PBKDF2 (lo que bloqueaba el servidor 134 ms)', () => {
    const spy = vi.spyOn(crypto, 'pbkdf2Sync');
    for (let i = 0; i < 20; i++) decrypt(encrypt(`codigo-${i}`));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('un tag alterado no descifra: devuelve la entrada tal cual', () => {
    const parts = encrypt('482913').split(':');
    const tag = Buffer.from(parts[3], 'base64');
    tag[0] ^= 0xff;
    parts[3] = tag.toString('base64');
    const tampered = parts.join(':');
    expect(decrypt(tampered)).toBe(tampered);
  });

  it('texto que nunca se cifró pasa sin cambios', () => {
    expect(decrypt('JBSWY3DPEHPK3PXP')).toBe('JBSWY3DPEHPK3PXP');
    expect(decrypt('')).toBe('');
    expect(decrypt('a:b')).toBe('a:b');
  });
});

describe('compatibilidad con el formato anterior', () => {
  it('sigue leyendo lo que se cifró antes del cambio', () => {
    const old = legacyEncrypt('JBSWY3DPEHPK3PXP');
    expect(old.split(':')).toHaveLength(4);
    expect(decrypt(old)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('leer el mismo dato viejo muchas veces deriva su clave una sola vez', () => {
    const old = legacyEncrypt('771204');
    const spy = vi.spyOn(crypto, 'pbkdf2Sync');
    for (let i = 0; i < 10; i++) expect(decrypt(old)).toBe('771204');
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
