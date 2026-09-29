import { describe, it, expect } from 'vitest';
import { productChecks, type CheckLimits, type PhotoState } from './productChecks';
import { EMPTY_PRODUCT_FORM, type ProductFormState } from './productForm';

const limits: CheckLimits = { minDimension: 500, recommendedDimension: 1200, canRemoveBackground: true };

const form = (patch: Partial<ProductFormState> = {}): ProductFormState => ({
  ...EMPTY_PRODUCT_FORM,
  name: 'Pizza especial',
  categoryId: 'cat-1',
  price: '25000',
  description: 'Masa madre, tomate y albahaca.',
  ...patch,
});

const pending = (sourcePixels: number, removeBackground = true): PhotoState => ({
  kind: 'pending', sourcePixels, removeBackground,
});

const byId = (checks: ReturnType<typeof productChecks>, id: string) =>
  checks.find((check) => check.id === id);

describe('productChecks · foto', () => {
  it('sin foto avisa de la ilustración genérica', () => {
    expect(byId(productChecks(form(), { kind: 'none' }, limits), 'photo')?.tone).toBe('warning');
  });

  it('la nitidez sale de los píxeles de la original, con los cortes de la app', () => {
    expect(byId(productChecks(form(), pending(320), limits), 'resolution')?.tone).toBe('warning');
    expect(byId(productChecks(form(), pending(800), limits), 'resolution')?.tone).toBe('info');
    expect(byId(productChecks(form(), pending(1200), limits), 'resolution')?.tone).toBe('ok');
  });

  it('una foto guardada se mide por su lado corto', () => {
    const saved: PhotoState = { kind: 'saved', width: 1200, height: 400, backgroundRemoved: false };
    expect(byId(productChecks(form(), saved, limits), 'resolution')).toMatchObject({
      tone: 'warning',
      text: expect.stringContaining('1200 × 400 px'),
    });
  });

  it('el fondo solo se menciona si el servidor sabe quitarlo', () => {
    expect(byId(productChecks(form(), pending(1500, true), limits), 'background')?.tone).toBe('ok');
    expect(byId(productChecks(form(), pending(1500, false), limits), 'background')?.tone).toBe('info');
    expect(
      byId(productChecks(form(), pending(1500), { ...limits, canRemoveBackground: false }), 'background')
    ).toBeUndefined();
  });
});

describe('productChecks · texto, oferta y edad', () => {
  it('sin descripción lo dice; con ella, calla', () => {
    expect(byId(productChecks(form({ description: '  ' }), pending(1500), limits), 'description')).toBeDefined();
    expect(byId(productChecks(form(), pending(1500), limits), 'description')).toBeUndefined();
  });

  it('oferta mayor o igual al precio: aviso de que no se puede guardar', () => {
    expect(byId(productChecks(form({ discountPrice: '25000' }), pending(1500), limits), 'discount')?.tone)
      .toBe('warning');
  });

  it('menos del 5 %: la app no pinta la etiqueta', () => {
    expect(byId(productChecks(form({ discountPrice: '24000' }), pending(1500), limits), 'discount')?.tone)
      .toBe('info');
  });

  it('desde el 5 %: anuncia la etiqueta con su cifra', () => {
    expect(byId(productChecks(form({ discountPrice: '20000' }), pending(1500), limits), 'discount')).toMatchObject({
      tone: 'ok',
      text: expect.stringContaining('−20%'),
    });
  });

  it('+18 explica lo que exige la app', () => {
    expect(byId(productChecks(form({ requiresAgeVerification: true }), pending(1500), limits), 'age')).toBeDefined();
  });
});
