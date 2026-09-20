import { composeBirthDate, formatBirthDate } from '../lib/birthDate';
import { formatDocument, normalizeDocumentNumber } from '../lib/identityDocument';
import { meetsPasswordRules } from '../lib/passwordRules';
import { describeSession, lastSeen } from '../lib/sessionLabels';

/**
 * Lo puro de Mi cuenta: armar y mostrar la fecha de nacimiento, el
 * documento, las reglas de contraseña y cómo se llama cada sesión.
 */

describe('Fecha de nacimiento', () => {
  it('arma AAAA-MM-DD con ceros a la izquierda', () => {
    expect(composeBirthDate('9', '3', '2001')).toEqual({ ok: true, value: '2001-03-09' });
  });

  it('rechaza fechas que no existen, con el motivo', () => {
    expect(composeBirthDate('31', '02', '2001')).toEqual({ ok: false, error: 'Esa fecha no existe' });
    expect(composeBirthDate('29', '02', '2001')).toMatchObject({ ok: false });
    expect(composeBirthDate('29', '02', '2000')).toEqual({ ok: true, value: '2000-02-29' });
    expect(composeBirthDate('10', '13', '2001')).toMatchObject({ ok: false, error: 'El mes va de 1 a 12' });
    expect(composeBirthDate('10', '10', '01')).toMatchObject({ ok: false });
    expect(composeBirthDate('', '10', '2001')).toMatchObject({ ok: false });
  });

  it('se muestra sin pasar por la zona horaria del teléfono', () => {
    // Medianoche UTC: con `new Date()` en Colombia saldría el 8 de marzo.
    expect(formatBirthDate('2001-03-09T00:00:00.000Z')).toBe('09/03/2001');
    expect(formatBirthDate('2001-03-09')).toBe('09/03/2001');
    expect(formatBirthDate(undefined)).toBe('');
  });
});

describe('Documento de identidad', () => {
  it('quita puntos, espacios y guiones', () => {
    expect(normalizeDocumentNumber('CC', '1.020.304.050')).toBe('1020304050');
    expect(normalizeDocumentNumber('CE', ' 123 456-7 ')).toBe('1234567');
  });

  it('el pasaporte conserva letras, en mayúscula', () => {
    expect(normalizeDocumentNumber('PASAPORTE', 'ab-123 456')).toBe('AB123456');
  });

  it('se muestra con el tipo corto y miles', () => {
    expect(formatDocument('CC', '1020304050')).toBe(`CC ${(1020304050).toLocaleString('es-CO')}`);
    expect(formatDocument('PASAPORTE', 'AB123456')).toBe('Pasaporte AB123456');
    expect(formatDocument(undefined, '123')).toBe('');
  });
});

describe('Reglas de contraseña nueva', () => {
  it('son las mismas del servidor', () => {
    expect(meetsPasswordRules('Zipp.2026')).toBe(true);
    expect(meetsPasswordRules('zipp.2026')).toBe(false); // sin mayúscula
    expect(meetsPasswordRules('Zipp2026')).toBe(false); // sin símbolo
    expect(meetsPasswordRules('Zi.26')).toBe(false); // corta
  });
});

describe('Nombre de cada sesión', () => {
  it('usa el modelo que manda la app desde este cambio', () => {
    expect(
      describeSession({
        userAgent: 'Zipp/1.0.0 (Android 14; SM-A515F)',
        deviceInfo: { os: 'Android', platform: 'mobile', browser: 'unknown' },
      })
    ).toBe('SM-A515F · Android');
  });

  it('con el agente viejo solo sabe el sistema, o nada', () => {
    expect(describeSession({ userAgent: 'okhttp/4.12.0', deviceInfo: { os: 'unknown' } })).toBe(
      'Dispositivo sin identificar'
    );
    expect(describeSession({ userAgent: 'Mozilla/5.0 (iPhone)', deviceInfo: { os: 'iOS' } })).toBe('Teléfono iOS');
  });

  it('dice cuándo se usó por última vez', () => {
    const now = Date.parse('2026-09-19T15:00:00Z');
    expect(lastSeen('2026-09-19T14:58:00Z', now)).toBe('Activa ahora');
    expect(lastSeen('2026-09-19T14:20:00Z', now)).toBe('hace 40 min');
    expect(lastSeen('2026-09-19T12:00:00Z', now)).toBe('hace 3 h');
    expect(lastSeen('2026-09-18T12:00:00Z', now)).toBe('hace 1 día');
  });
});
