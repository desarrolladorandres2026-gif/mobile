import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

/**
 * Node 25 trae su propio `localStorage` global, incompleto sin archivo de respaldo, y tapa al de jsdom.
 * Si el que hay no sirve, se reemplaza por uno en memoria con la interfaz estándar.
 */
function ensureStorage(name) {
  if (typeof window[name]?.clear === 'function') return;
  const data = new Map();
  const storage = {
    getItem: (key) => (data.has(String(key)) ? data.get(String(key)) : null),
    setItem: (key, value) => void data.set(String(key), String(value)),
    removeItem: (key) => void data.delete(String(key)),
    clear: () => data.clear(),
    key: (index) => [...data.keys()][index] ?? null,
    get length() {
      return data.size;
    },
  };
  for (const target of [window, globalThis]) Object.defineProperty(target, name, { value: storage, configurable: true });
}
ensureStorage('localStorage');
ensureStorage('sessionStorage');

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});
