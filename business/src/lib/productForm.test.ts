import { describe, it, expect } from 'vitest';
import {
  EMPTY_PRODUCT_FORM, discountPercent, hasDraftContent, productChecklist, productProgress,
  rawDiscountPercent, readPricing, type ProductFormState,
} from './productForm';

const form = (patch: Partial<ProductFormState> = {}): ProductFormState => ({
  ...EMPTY_PRODUCT_FORM,
  name: 'Pizza especial',
  categoryId: 'cat-1',
  price: '25000',
  ...patch,
});

describe('readPricing', () => {
  it('convierte precio, oferta y tiempo', () => {
    expect(readPricing(form({ discountPrice: '20000', prepTimeMinutes: '40' }))).toEqual({
      ok: true, price: 25000, discountPrice: 20000, prepTimeMinutes: 40,
    });
  });

  it('sin precio, o en cero, señala el campo del precio', () => {
    for (const price of ['', '0']) {
      expect(readPricing(form({ price }))).toMatchObject({ ok: false, field: 'price' });
    }
  });

  it('una oferta en cero es "sin oferta", no un descuento de cero', () => {
    expect(readPricing(form({ discountPrice: '0' }))).toMatchObject({ ok: true, discountPrice: null });
  });

  it('una oferta igual o mayor al precio no se puede guardar', () => {
    for (const discountPrice of ['25000', '30000']) {
      expect(readPricing(form({ discountPrice }))).toMatchObject({ ok: false, field: 'discountPrice' });
    }
  });

  it('el tiempo vacío hereda el del negocio; fuera de 1–180 o con decimales, no', () => {
    expect(readPricing(form({ prepTimeMinutes: '' }))).toMatchObject({ ok: true, prepTimeMinutes: null });
    expect(readPricing(form({ prepTimeMinutes: '181' }))).toMatchObject({ ok: false, field: 'prepTimeMinutes' });
    expect(readPricing(form({ prepTimeMinutes: '12.5' }))).toMatchObject({ ok: false, field: 'prepTimeMinutes' });
  });
});

describe('discountPercent', () => {
  it('redondea hacia abajo, como la app', () => {
    expect(rawDiscountPercent(30000, 20000)).toBe(33);
  });

  it('por debajo del 5 % la app no pinta la etiqueta', () => {
    expect(rawDiscountPercent(10000, 9600)).toBe(4);
    expect(discountPercent(10000, 9600)).toBeNull();
    expect(discountPercent(10000, 9500)).toBe(5);
  });

  it('sin oferta válida no hay porcentaje', () => {
    expect(rawDiscountPercent(10000, null)).toBeNull();
    expect(rawDiscountPercent(10000, 10000)).toBeNull();
  });
});

describe('productProgress', () => {
  it('sin foto se queda en el paso 1 aunque lo demás esté listo', () => {
    expect(productProgress(form(), false)).toEqual({ steps: [false, true, false], current: 1 });
  });

  it('con foto y datos, pero sin precio, va por el paso 2', () => {
    expect(productProgress(form({ price: '' }), true)).toEqual({ steps: [true, false, false], current: 2 });
  });

  it('todo completo: los tres tramos llenos y el paso 3', () => {
    expect(productProgress(form(), true)).toEqual({ steps: [true, true, true], current: 3 });
  });

  it('un nombre de una letra no completa el paso 1: el servidor pide dos', () => {
    expect(productProgress(form({ name: 'P' }), true).current).toBe(1);
  });
});

describe('productChecklist', () => {
  it('marca lo que hay y lo que falta', () => {
    expect(productChecklist(form(), false)).toEqual([
      { label: 'Foto principal', done: false },
      { label: 'Datos esenciales', done: true },
      { label: 'Descripción', done: false },
    ]);
  });
});

describe('hasDraftContent', () => {
  it('un formulario recién abierto, con su categoría puesta, está vacío', () => {
    expect(hasDraftContent({ ...EMPTY_PRODUCT_FORM, categoryId: 'cat-1' })).toBe(false);
  });

  it('cualquier cosa escrita cuenta', () => {
    expect(hasDraftContent({ ...EMPTY_PRODUCT_FORM, price: '1000' })).toBe(true);
    expect(hasDraftContent({ ...EMPTY_PRODUCT_FORM, requiresAgeVerification: true })).toBe(true);
    expect(hasDraftContent({ ...EMPTY_PRODUCT_FORM, extras: [{ name: 'Queso', price: 2000 }] })).toBe(true);
  });
});
