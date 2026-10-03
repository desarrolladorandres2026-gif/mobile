import { useCallback, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:3000';

/**
 * Un solo socket para todo el panel.
 *
 * Antes Dashboard, Incidentes y Flota abrían cada uno su propia conexión al
 * montarse y la cerraban al salir: navegar entre ellas era handshake,
 * autenticación y sala `admin` otra vez en cada cambio de página. Ahora la
 * conexión se comparte, y se mantiene medio minuto después de que la deja
 * la última pantalla que la usaba — lo justo para que ir y volver del
 * Dashboard no la corte.
 *
 * `auth` es una función y no un objeto: el access token dura 15 minutos y
 * el panel lo renueva solo, así que cada reconexión tiene que leer el
 * vigente, no el que había cuando se abrió el socket.
 */
let socket: Socket | null = null;
let users = 0;
let closeTimer: ReturnType<typeof setTimeout> | null = null;

const IDLE_CLOSE_MS = 30_000;

function acquire(): Socket | null {
 if (!localStorage.getItem('admin_token')) return null;
 if (closeTimer) {
 clearTimeout(closeTimer);
 closeTimer = null;
 }
 if (!socket) {
 socket = io(SOCKET_URL, {
 auth: (cb) => cb({ token: localStorage.getItem('admin_token') }),
 transports: ['websocket'],
 });
 }
 users++;
 return socket;
}

function release(): void {
 users = Math.max(0, users - 1);
 if (users > 0 || closeTimer) return;
 closeTimer = setTimeout(() => {
 closeTimer = null;
 if (users === 0) {
 socket?.disconnect();
 socket = null;
 }
 }, IDLE_CLOSE_MS);
}

/**
 * Escucha eventos del servidor mientras la pantalla está montada.
 *
 * Los manejadores se leen de un `ref`, así que pasar funciones nuevas en
 * cada render no reconecta ni re-suscribe nada.
 */
// `never` como parámetro: acepta manejadores con el tipo de payload de cada
// evento sin tener que abrirlo a `any`.
export function useAdminSocketEvents(handlers: Record<string, (payload: never) => void>): void {
 const latest = useRef(handlers);
 useEffect(() => {
 latest.current = handlers;
 });

 const events = Object.keys(handlers).sort().join('|');

 useEffect(() => {
 const s = acquire();
 if (!s) return;
 const bound = events.split('|').filter(Boolean).map((event) => {
 const fn = (payload: unknown) => latest.current[event]?.(payload as never);
 s.on(event, fn);
 return [event, fn] as const;
 });
 return () => {
 for (const [event, fn] of bound) s.off(event, fn);
 release();
 };
 }, [events]);
}

/**
 * Una función que, llamada varias veces seguidas, se ejecuta una sola vez
 * cuando pasan `waitMs` sin llamadas.
 *
 * Para las recargas que dispara el socket: en hora pico llegan varios
 * `order:status:changed` por segundo, y cada uno volvía a pedir el
 * Dashboard entero (cuatro consultas, una de ellas un agregado).
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

/**
 * Estado de la conexión en vivo, para el indicador del Layout.
 * `null` mientras no hay sesión o aún no se abrió el socket.
 */
export function useAdminSocketStatus(): 'live' | 'reconnecting' | null {
 const [status, setStatus] = useState<'live' | 'reconnecting' | null>(null);
 useEffect(() => {
 const s = acquire();
 if (!s) return;
 const up = () => setStatus('live');
 const down = () => setStatus('reconnecting');
 setStatus(s.connected ? 'live' : 'reconnecting');
 s.on('connect', up);
 s.on('disconnect', down);
 s.on('connect_error', down);
 return () => {
 s.off('connect', up);
 s.off('disconnect', down);
 s.off('connect_error', down);
 release();
 };
 }, []);
 return status;
}
