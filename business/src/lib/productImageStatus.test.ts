import { describe, it, expect } from 'vitest';
import { isImageInProgress, productImageStatus, IMAGE_POLL_WINDOW_MS } from './productImageStatus';
import type { ProductImages } from '../components/SmartImage';

const base: ProductImages = {
  thumb: 't',
  catalog: 'c',
  detail: 'd',
  large: 'l',
  placeholder: 'p',
  width: 1200,
  height: 1200,
  enhanced: true,
  backgroundRemoved: false,
};

describe('productImageStatus', () => {
  it('sin foto no dice nada', () => {
    expect(productImageStatus(null, null, true)).toMatchObject({ message: null, action: null });
  });

  it('mientras se procesa: "Mejorando imagen…", sin acciones', () => {
    for (const status of ['pending', 'processing'] as const) {
      const view = productImageStatus({ ...base, backgroundRemoval: status }, null, true);
      expect(view.message).toBe('Mejorando imagen…');
      expect(view.working).toBe(true);
      expect(view.action).toBeNull();
    }
  });

  it('terminado: ofrece volver a la original, y desde ahí volver al recorte', () => {
    const done = { ...base, backgroundRemoval: 'completed' as const, cutout: 'x', usingOriginal: false };
    expect(productImageStatus(done, null, true).action).toBe('use-original');
    expect(productImageStatus({ ...done, usingOriginal: true }, null, true).action).toBe('use-cutout');
  });

  it('fallido: usa la original y ofrece reintentar', () => {
    const view = productImageStatus({ ...base, backgroundRemoval: 'failed' }, 'TIMEOUT', true);
    expect(view.message).toBe('No pudimos quitar el fondo. Usaremos la imagen original.');
    expect(view.tone).toBe('warning');
    expect(view.action).toBe('retry');
  });

  it('el tope diario se explica con sus palabras', () => {
    const view = productImageStatus({ ...base, backgroundRemoval: 'failed' }, 'DAILY_LIMIT', true);
    expect(view.message).toMatch(/máximo de fotos sin fondo por hoy/);
    expect(view.action).toBe('retry');
  });

  it('sin el servicio disponible no ofrece acciones que fallarían', () => {
    expect(productImageStatus({ ...base, backgroundRemoval: 'failed' }, null, false).action).toBeNull();
    expect(productImageStatus(base, null, false).action).toBeNull();
    expect(productImageStatus(base, null, true).action).toBe('remove-background');
  });

  it('nunca menciona al proveedor', () => {
    const statuses = ['none', 'pending', 'processing', 'completed', 'failed'] as const;
    for (const status of statuses) {
      const { message } = productImageStatus({ ...base, backgroundRemoval: status }, null, true);
      expect(message ?? '').not.toMatch(/photoroom|cloudinary|api/i);
    }
  });
});

describe('isImageInProgress', () => {
  const now = Date.parse('2026-09-22T15:00:00Z');
  const pending = (minutesAgo: number) => ({
    images: { ...base, backgroundRemoval: 'pending' as const },
    imageAsset: { backgroundRemoval: { requestedAt: new Date(now - minutesAgo * 60_000).toISOString() } },
  });

  it('pregunta mientras el recorte es reciente', () => {
    expect(isImageInProgress(pending(1), now)).toBe(true);
  });

  it('deja de preguntar pasada la ventana', () => {
    expect(isImageInProgress(pending(IMAGE_POLL_WINDOW_MS / 60_000 + 1), now)).toBe(false);
  });

  it('no pregunta por fotos terminadas o sin recorte', () => {
    expect(isImageInProgress({ images: { ...base, backgroundRemoval: 'completed' } }, now)).toBe(false);
    expect(isImageInProgress({ images: base }, now)).toBe(false);
  });
});
