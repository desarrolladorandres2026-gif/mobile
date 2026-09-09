/**
 * Lo mínimo para que los módulos de la app se puedan importar en pruebas.
 *
 * No se monta nada de UI aquí a propósito: los tests que valen la pena en
 * esta app son los de las reglas que mueven dinero —el carrito, el candado
 * del refresco de sesión, hasta cuándo se puede cancelar—, y esos son lógica
 * pura. Montar pantallas enteras cuesta mucho mantenimiento y encuentra
 * menos errores reales.
 */

// `expo-secure-store` toca el llavero nativo, que no existe en Node.
jest.mock('expo-secure-store', () => {
  const store = new Map();
  return {
    getItemAsync: jest.fn(async (k) => (store.has(k) ? store.get(k) : null)),
    setItemAsync: jest.fn(async (k, v) => { store.set(k, v); }),
    deleteItemAsync: jest.fn(async (k) => { store.delete(k); }),
    AFTER_FIRST_UNLOCK: 'AFTER_FIRST_UNLOCK',
  };
});

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(),
  notificationAsync: jest.fn(),
  selectionAsync: jest.fn(),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
}));

/**
 * `lucide-react-native` se publica solo como ESM.
 *
 * Se simula en vez de añadirlo a `transformIgnorePatterns` por dos razones:
 * transformar todo el paquete de iconos es lento en cada arranque de la
 * suite, y en Windows ese patrón usa `/` mientras las rutas reales llevan
 * `\`, así que no casa y el arreglo parece no hacer nada.
 *
 * El `Proxy` devuelve un componente para **cualquier** nombre de icono, así
 * que no hay que mantener una lista al día cada vez que se usa uno nuevo.
 */
jest.mock('lucide-react-native', () => {
  const React = require('react');
  const Stub = (props) => React.createElement('Icon', props);
  return new Proxy(
    { __esModule: true },
    {
      get: (target, prop) => (prop in target ? target[prop] : Stub),
    }
  );
});
