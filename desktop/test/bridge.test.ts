import { describe, it, expect } from 'vitest';
import {
  validateAttention,
  validateReportStatus,
  validateSettingsGet,
  validateSettingsSet,
} from '../src/shared/bridge';

/**
 * El panel corre dentro de un `webContents` sandboxeado, pero un XSS ahí
 * igual podría llamar a `window.zippDesktop.*` con cualquier cosa. Estas
 * pruebas son la otra mitad de esa defensa: lo que no pasa de aquí nunca
 * llega a tocar el sistema operativo (notificaciones, impresora, ajustes).
 */
describe('Validación de los mensajes del puente', () => {
  it('attention válido pasa, con y sin orderNumber', () => {
    expect(validateAttention({ pattern: 'urgent', count: 3, orderNumber: '1042' })).toMatchObject({ ok: true });
    expect(validateAttention({ pattern: null, count: 0 })).toMatchObject({ ok: true });
  });

  it('attention rechaza un pattern inventado o un count negativo/absurdo', () => {
    expect(validateAttention({ pattern: 'ultra', count: 1 }).ok).toBe(false);
    expect(validateAttention({ pattern: 'normal', count: -1 }).ok).toBe(false);
    expect(validateAttention({ pattern: 'normal', count: 999_999 }).ok).toBe(false);
    expect(validateAttention({ pattern: 'normal', count: 1.5 }).ok).toBe(false);
    expect(validateAttention('no es un objeto').ok).toBe(false);
    expect(validateAttention(null).ok).toBe(false);
  });

  it('attention rechaza un orderNumber que no es texto corto', () => {
    expect(validateAttention({ pattern: 'normal', count: 1, orderNumber: 12 }).ok).toBe(false);
    expect(validateAttention({ pattern: 'normal', count: 1, orderNumber: 'x'.repeat(41) }).ok).toBe(false);
  });

  it('report-status exige los cuatro campos con su tipo', () => {
    expect(
      validateReportStatus({ connection: 'online', session: 'active', storeOpen: true, quiet: false })
    ).toMatchObject({ ok: true });
    expect(validateReportStatus({ connection: 'offline' }).ok).toBe(false);
    expect(
      validateReportStatus({ connection: 'bad', session: 'active', storeOpen: true, quiet: false }).ok
    ).toBe(false);
  });

  it('settings-get solo deja pasar claves conocidas', () => {
    expect(validateSettingsGet({ key: 'launchAtLogin' })).toMatchObject({ ok: true });
    expect(validateSettingsGet({ key: '__proto__' }).ok).toBe(false);
    expect(validateSettingsGet({ key: 'anythingElse' }).ok).toBe(false);
  });

  it('settings-set exige el tipo correcto para cada clave', () => {
    expect(validateSettingsSet({ key: 'launchAtLogin', value: true })).toMatchObject({ ok: true });
    expect(validateSettingsSet({ key: 'launchAtLogin', value: 'true' }).ok).toBe(false);
    expect(validateSettingsSet({ key: 'printerName', value: 'EPSON TM-T20' })).toMatchObject({ ok: true });
    expect(validateSettingsSet({ key: 'printerName', value: 123 }).ok).toBe(false);
    expect(validateSettingsSet({ key: 'paperWidthMm', value: 80 })).toMatchObject({ ok: true });
    expect(validateSettingsSet({ key: 'paperWidthMm', value: '80' }).ok).toBe(false);
  });
});
