import { tokenExpiresAt } from '../lib/jwt';

/** Un JWT con el payload dado (la firma no se verifica, solo se lee `exp`). */
function jwt(payload: Record<string, unknown>): string {
  const b64url = (value: object) =>
    btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.firma`;
}

describe('tokenExpiresAt', () => {
  it('devuelve el vencimiento en milisegundos', () => {
    expect(tokenExpiresAt(jwt({ id: 'u1', exp: 1_900_000_000 }))).toBe(1_900_000_000_000);
  });

  it('lee payloads con caracteres de base64url (- y _)', () => {
    // "ñ" y "?" fuerzan bytes que en base64 estándar serían + y /.
    const token = jwt({ name: 'Peña ???>>>', exp: 1_800_000_000 });
    expect(tokenExpiresAt(token)).toBe(1_800_000_000_000);
  });

  it.each([
    [null],
    [undefined],
    [''],
    ['no-es-un-jwt'],
    ['a.b.c'],
  ])('con %j devuelve null en vez de lanzar', (token) => {
    expect(tokenExpiresAt(token as any)).toBeNull();
  });

  it('sin exp devuelve null', () => {
    expect(tokenExpiresAt(jwt({ id: 'u1' }))).toBeNull();
  });
});
