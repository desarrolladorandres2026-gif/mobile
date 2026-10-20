import { describe, expect, it } from 'vitest';
import { open, parseKey, seal } from './secretbox.js';
import { base32Decode, base32Encode, generateSecret, otpauthUri, totpAt, verifyTotp } from './totp.js';

// Secreto de prueba del RFC 6238: la cadena ASCII "12345678901234567890".
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

describe('TOTP (RFC 6238)', () => {
  it('reproduce los vectores de prueba oficiales (SHA-1, 8 dígitos)', () => {
    const vectors = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
      [20000000000, '65353130'],
    ];
    for (const [seconds, expected] of vectors) {
      expect(totpAt(RFC_SECRET, seconds * 1000, { digits: 8 })).toBe(expected);
    }
  });

  it('con 6 dígitos usa los 6 últimos del mismo valor', () => {
    expect(totpAt(RFC_SECRET, 59_000)).toBe('287082');
  });

  it('base32 es reversible y rechaza símbolos ajenos', () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255, 7, 8, 9]);
    expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true);
    expect(() => base32Decode('ABC1')).toThrow(/inválido/);
  });

  it('genera secretos de 160 bits, distintos cada vez', () => {
    const a = generateSecret();
    expect(a).toMatch(/^[A-Z2-7]{32}$/);
    expect(generateSecret()).not.toBe(a);
  });

  it('acepta el código actual y el de pasos vecinos, pero no uno lejano', () => {
    const now = 1_700_000_000_000;
    const at = (offset) => totpAt(RFC_SECRET, now + offset * 30_000);
    expect(verifyTotp(RFC_SECRET, at(0), { now })).not.toBeNull();
    expect(verifyTotp(RFC_SECRET, at(-1), { now })).not.toBeNull();
    expect(verifyTotp(RFC_SECRET, at(1), { now })).not.toBeNull();
    expect(verifyTotp(RFC_SECRET, at(3), { now })).toBeNull();
    expect(verifyTotp(RFC_SECRET, at(-3), { now })).toBeNull();
  });

  it('no deja reutilizar un código: exige un paso posterior al último aceptado', () => {
    const now = 1_700_000_000_000;
    const code = totpAt(RFC_SECRET, now);
    const step = verifyTotp(RFC_SECRET, code, { now });
    expect(step).not.toBeNull();
    expect(verifyTotp(RFC_SECRET, code, { now, lastStep: step })).toBeNull();
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, now + 30_000), { now: now + 30_000, lastStep: step })).toBeGreaterThan(step);
  });

  it('rechaza entradas que no son un código de 6 dígitos', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 456', null, undefined, 123456]) {
      expect(verifyTotp(RFC_SECRET, bad, { now: 1_700_000_000_000 })).toBeNull();
    }
  });

  it('arma el URI para el código QR con emisor y cuenta codificados', () => {
    const uri = otpauthUri({ secret: 'ABCDEFGH', account: 'ana+prueba@empresa.co', issuer: 'Lulubiz' });
    expect(uri.startsWith('otpauth://totp/Lulubiz:ana%2Bprueba%40empresa.co?')).toBe(true);
    expect(uri).toContain('secret=ABCDEFGH');
    expect(uri).toContain('issuer=Lulubiz');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
  });
});

describe('cifrado de secretos', () => {
  const key = parseKey(Buffer.alloc(32, 7).toString('base64'));

  it('cifra y descifra, con un IV distinto en cada cifrado', () => {
    const a = seal('JBSWY3DPEHPK3PXP', key);
    const b = seal('JBSWY3DPEHPK3PXP', key);
    expect(a).not.toBe(b);
    expect(a.startsWith('v1.')).toBe(true);
    expect(a).not.toContain('JBSWY3DPEHPK3PXP');
    expect(open(a, key)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('detecta manipulación y clave equivocada', () => {
    const sealed = seal('secreto', key);
    const parts = sealed.split('.');
    parts[3] = Buffer.from('otro-contenido').toString('base64');
    expect(() => open(parts.join('.'), key)).toThrow();
    expect(() => open(sealed, parseKey(Buffer.alloc(32, 9).toString('base64')))).toThrow();
    expect(() => open('basura', key)).toThrow(/formato/);
  });

  it('exige una clave de 32 bytes', () => {
    expect(() => parseKey('corta')).toThrow(/32 bytes/);
    expect(() => parseKey(undefined)).toThrow(/32 bytes/);
  });
});
