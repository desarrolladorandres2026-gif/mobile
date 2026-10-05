import { Platform } from 'react-native';

/**
 * Registra el service worker sólo en web. En iOS/Android `Platform.OS` nunca
 * es 'web', así que esta función es un no-op ahí — no hace falta más guarda.
 *
 * `onUpdateAvailable` se dispara cuando ya se descargó una versión nueva del
 * shell pero la pestaña sigue corriendo la vieja (el SW nuevo queda en
 * "waiting" hasta que todas las pestañas se cierren). app/_layout.tsx lo usa
 * para mostrar el aviso de "Hay una versión nueva".
 */
export function registerServiceWorker(onUpdateAvailable?: () => void) {
  if (Platform.OS !== 'web') return;
  if (!('serviceWorker' in navigator)) return;

  const register = () => {
    navigator.serviceWorker.register('/sw.js').then((registration) => {
      registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        if (!installing) return;

        installing.addEventListener('statechange', () => {
          const hasActiveController = Boolean(navigator.serviceWorker.controller);
          if (installing.state === 'installed' && hasActiveController) {
            onUpdateAvailable?.();
          }
        });
      });
    }).catch((err) => {
      console.warn('[PWA] No se pudo registrar el service worker:', err);
    });
  };

  // Se llama desde un useEffect, cuando la página ya puede haber terminado de
  // cargar: si `load` ya pasó, esperar el evento dejaría el service worker
  // sin registrar nunca.
  if (document.readyState === 'complete') {
    register();
  } else {
    window.addEventListener('load', register, { once: true });
  }
}
