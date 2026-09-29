import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { clearDraft, isDraftWorthRestoring, loadDraft, saveDraft } from './productDraft';
import { EMPTY_PRODUCT_FORM } from './productForm';

// Las pruebas corren en Node: un localStorage mínimo en memoria.
const memory = new Map<string, string>();
const fakeStorage = {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => void memory.set(key, value),
  removeItem: (key: string) => void memory.delete(key),
};

beforeEach(() => {
  memory.clear();
  Object.defineProperty(globalThis, 'localStorage', { value: fakeStorage, configurable: true });
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'localStorage');
});

describe('productDraft', () => {
  it('guarda y recupera el formulario, por negocio', () => {
    const form = { ...EMPTY_PRODUCT_FORM, name: 'Pizza', price: '25000', categoryId: 'cat-1' };
    expect(saveDraft('biz-1', form, 1_000)).toBe(1_000);

    expect(loadDraft('biz-1')).toEqual({ savedAt: 1_000, form });
    expect(loadDraft('biz-2')).toBeNull();
  });

  it('borrar lo deja sin borrador', () => {
    saveDraft('biz-1', { ...EMPTY_PRODUCT_FORM, name: 'Pizza' });
    clearDraft('biz-1');
    expect(loadDraft('biz-1')).toBeNull();
  });

  it('un borrador dañado o de otra versión no rompe nada: no hay borrador', () => {
    memory.set('zipp:product-draft:biz-1', '{no es json');
    expect(loadDraft('biz-1')).toBeNull();
    memory.set('zipp:product-draft:biz-1', JSON.stringify({ v: 99, savedAt: 1, form: {} }));
    expect(loadDraft('biz-1')).toBeNull();
  });

  it('rellena lo que falte y descarta lo que no encaja', () => {
    memory.set('zipp:product-draft:biz-1', JSON.stringify({
      v: 1,
      savedAt: 5,
      form: { name: 'Pizza', price: 25000, extras: [{ name: 'Queso', price: 2000 }, { name: 3 }], sobrante: true },
    }));
    const draft = loadDraft('biz-1');
    expect(draft?.form).toEqual({
      ...EMPTY_PRODUCT_FORM,
      name: 'Pizza',
      // Un número donde iba texto no entra: el campo queda vacío.
      price: '',
      extras: [{ name: 'Queso', price: 2000 }],
    });
  });

  it('sin almacenamiento disponible, guardar no revienta', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: { ...fakeStorage, setItem: () => { throw new Error('QuotaExceededError'); } },
      configurable: true,
    });
    expect(saveDraft('biz-1', EMPTY_PRODUCT_FORM)).toBeNull();
  });

  it('un borrador vacío no se ofrece', () => {
    expect(isDraftWorthRestoring({ savedAt: 0, form: { ...EMPTY_PRODUCT_FORM, categoryId: 'cat-1' } }, 0)).toBe(false);
    expect(isDraftWorthRestoring({ savedAt: 0, form: { ...EMPTY_PRODUCT_FORM, name: 'Pizza' } }, 0)).toBe(true);
  });
});
