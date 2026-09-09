import { isOlder } from '../lib/versionCompare';

/**
 * La comparación de versiones.
 *
 * Se prueba porque el fallo aquí es silencioso y caro en las dos
 * direcciones: si compara mal por defecto, deja entrar a una versión que se
 * quería sacar del aire; si compara mal por exceso, bloquea a todo el mundo
 * y la app deja de existir para sus usuarios hasta que se publique un
 * arreglo — que es justo lo que no se puede hacer rápido.
 */
describe('isOlder', () => {
  it('acepta la versión exacta que se pide', () => {
    expect(isOlder('1.2.0', '1.2.0')).toBe(false);
  });

  it('acepta una versión más nueva', () => {
    expect(isOlder('1.3.0', '1.2.0')).toBe(false);
  });

  it('bloquea una versión más vieja', () => {
    expect(isOlder('1.1.9', '1.2.0')).toBe(true);
  });

  it('compara por número y no alfabéticamente', () => {
    // El caso que rompe un `<` de cadenas: "1.10.0" < "1.9.0" en texto,
    // pero 10 es mayor que 9. Sin esto, cada versión con un componente de
    // dos cifras bloquearía a usuarios que ya están al día.
    expect(isOlder('1.10.0', '1.9.0')).toBe(false);
    expect(isOlder('1.9.0', '1.10.0')).toBe(true);
  });

  it('trata los componentes que faltan como cero', () => {
    expect(isOlder('2', '2.0.0')).toBe(false);
    expect(isOlder('2.0', '2.0.1')).toBe(true);
  });
});
