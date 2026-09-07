import { Platform } from 'react-native';

/**
 * Registra el service worker sólo en web. En iOS/Android `Platform.OS` nunca
 * es 'web', así que esta función es un no-op ahí — no hace falta más guarda.
 *
 * `onUpdateAvailable` se dispara cuando ya se descargó una versión nueva del
 * shell pero la pestaña sigue corriendo la vieja (el SW nuevo queda en
 * "waiting" hasta que todas las pestañas se cierren). Qué hacer con eso es
 * una decisión de producto, no técnica — ver el TODO en app/_layout.tsx.
 */
export function registerServiceWorker(onUpdateAvailable?: () => void) {
  if (Platform.OS !== 'web') return;
  if (!('serviceWorker' in navigator)) return;

  window.addEventListener('load', () => {
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
  });
}
