import { useCallback, useEffect, useRef } from 'react';

/**
 * Una función que, llamada varias veces seguidas, se ejecuta una sola vez
 * cuando pasan `waitMs` sin llamadas.
 *
 * Para las recargas que dispara el socket: cuando se publican varios
 * pedidos seguidos llega un aviso por cada uno, y cada aviso volvía a
 * pedir la lista entera.
 */
export function useTrailingCallback(fn: () => void, waitMs: number): () => void {
  const latest = useRef(fn);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    latest.current = fn;
  });
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      latest.current();
    }, waitMs);
  }, [waitMs]);
}
