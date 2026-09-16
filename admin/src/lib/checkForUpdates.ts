import { useEffect, useRef, useState } from 'react';

/**
 * Detección de deploys nuevos por polling de /version.json.
 *
 * Cada `vite build` escribe un /version.json con un buildId distinto (ver
 * el plugin `versionFile` en vite.config.ts). La primera lectura, al montar
 * la app, solo fija la línea base — nunca dispara el aviso: así una visita
 * nueva jamás confunde "acabo de cargar" con "hay una versión más nueva".
 * A partir de ahí, cualquier lectura con un buildId distinto al de la línea
 * base es un deploy publicado después de que esta pestaña cargó.
 *
 * Tres disparadores del mismo chequeo (arranque + intervalo de 60s + focus/
 * visibilitychange/online), con throttle de 15s entre ellos para no
 * encimar peticiones si dos eventos llegan casi juntos (p. ej. volver de
 * segundo plano dispara focus y visibilitychange casi a la vez).
 */
const POLL_INTERVAL_MS = 60_000;
const CHECK_THROTTLE_MS = 15_000;

async function fetchBuildId(): Promise<string | null> {
  try {
    // El query param rompe cualquier caché intermedia (CDN/proxy) que no
    // respete `cache: 'no-store'`, que solo controla la caché del propio
    // navegador.
    const res = await fetch(`/version.json?_=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data.buildId === 'string' ? data.buildId : null;
  } catch {
    // Sin red, con /version.json caído, o en `vite dev` (donde el archivo
    // no existe): no hay nada que reportar, se reintenta en el próximo
    // disparador.
    return null;
  }
}

export function useUpdateAvailable() {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const baselineRef = useRef<string | null>(null);
  const lastCheckRef = useRef(0);

  useEffect(() => {
    // /version.json solo existe en el build de producción (el plugin de
    // Vite lo emite en `generateBundle`, que no corre en modo dev).
    if (!import.meta.env.PROD) return;

    let cancelled = false;

    const check = async () => {
      const now = Date.now();
      if (now - lastCheckRef.current < CHECK_THROTTLE_MS) return;
      lastCheckRef.current = now;

      const buildId = await fetchBuildId();
      if (cancelled || buildId === null) return;

      if (baselineRef.current === null) {
        baselineRef.current = buildId;
        return;
      }

      if (buildId !== baselineRef.current) {
        setUpdateAvailable(true);
      }
    };

    check();
    const interval = setInterval(check, POLL_INTERVAL_MS);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') check();
    };

    window.addEventListener('focus', check);
    window.addEventListener('online', check);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener('focus', check);
      window.removeEventListener('online', check);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  const applyUpdate = () => window.location.reload();

  return { updateAvailable, applyUpdate };
}
