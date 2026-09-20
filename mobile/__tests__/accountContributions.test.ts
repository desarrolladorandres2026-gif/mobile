import { ageInBogota } from '../lib/birthDate';
import { validateDocumentNumber } from '../lib/identityDocument';

/**
 * Casos para las dos funciones que quedaron con TODO(usuario):
 * `ageInBogota` (lib/birthDate.ts) y `validateDocumentNumber`
 * (lib/identityDocument.ts).
 *
 * Están en `describe.skip` para no dejar la suite en rojo mientras no
 * existan. Al implementarlas, quita el `.skip` y corre `npm test`.
 * El servidor ya aplica las mismas reglas (backend/src/utils/age.ts y
 * `documentNumberRules` en backend/src/validators/auth.validator.ts).
 */

describe.skip('ageInBogota', () => {
  it('no suma el año antes del cumpleaños en Bogotá, aunque en UTC ya sea el día', () => {
    // 8 de marzo, 8 p. m. en Bogotá = 9 de marzo, 01:00 UTC.
    expect(ageInBogota('2000-03-09', new Date('2026-03-09T01:00:00Z'))).toBe(25);
    expect(ageInBogota('2000-03-09', new Date('2026-03-09T05:30:00Z'))).toBe(26);
  });

  it('acepta el ISO completo que devuelve el servidor', () => {
    expect(ageInBogota('2000-03-09T00:00:00.000Z', new Date('2026-09-19T15:00:00Z'))).toBe(26);
  });

  it('29 de febrero: cumple el 1 de marzo en años no bisiestos', () => {
    expect(ageInBogota('2008-02-29', new Date('2026-02-28T17:00:00Z'))).toBe(17);
    expect(ageInBogota('2008-02-29', new Date('2026-03-01T17:00:00Z'))).toBe(18);
  });

  it('null si no puede leer la fecha', () => {
    expect(ageInBogota('no-es-fecha')).toBeNull();
  });
});

describe.skip('validateDocumentNumber', () => {
  it('acepta los formatos válidos', () => {
    expect(validateDocumentNumber('CC', '1020304050')).toBeNull();
    expect(validateDocumentNumber('CC', '12345')).toBeNull();
    expect(validateDocumentNumber('CE', '123456')).toBeNull();
    expect(validateDocumentNumber('PPT', '1234567')).toBeNull();
    expect(validateDocumentNumber('PASAPORTE', 'AB123456')).toBeNull();
  });

  it('rechaza con un mensaje los que no cuadran con su tipo', () => {
    expect(validateDocumentNumber('CC', '1234')).toEqual(expect.any(String));
    expect(validateDocumentNumber('CC', '12345678901')).toEqual(expect.any(String));
    expect(validateDocumentNumber('CE', '12345')).toEqual(expect.any(String));
    expect(validateDocumentNumber('PASAPORTE', 'AB-12')).toEqual(expect.any(String));
  });
});
