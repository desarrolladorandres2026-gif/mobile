import { useEffect, useRef } from 'react';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useAdminSocketEvents, useTrailingCallback } from './useAdminSocket';

/**
 * Recursos que el backend anuncia con `invalidate` (ver
 * `backend/src/realtime/invalidate.ts`). Si cambia un nombre allá, cambia aquí.
 */
export type LiveResource =
 | 'orders' | 'users' | 'businesses' | 'drivers' | 'driver-documents'
 | 'finance' | 'support' | 'moderation' | 'coupons' | 'settings'
 | 'pro' | 'campaigns';

const RELOAD_WAIT_MS = 1500;
/** Un `connect` dentro de este margen tras montar es la conexión inicial, no una reconexión. */
const INITIAL_CONNECT_GRACE_MS = 3000;

/**
 * Mantiene una pantalla al día sin botón de actualizar.
 *
 * El socket solo avisa QUÉ recurso cambió; aquí se recarga por REST, donde ya
 * se aplican permisos y filtros. Recarga también al volver a la pestaña y al
 * reconectar el socket, que son los dos momentos en que se pudo perder un aviso.
 * Las ráfagas se agrupan (`useTrailingCallback`) para no provocar un 429.
 */
export function useLiveReload(resources: LiveResource[], load: () => void): void {
 const reload = useTrailingCallback(load, RELOAD_WAIT_MS);
 const key = resources.join('|');
 const mountedAt = useRef(0);
 useEffect(() => {
 mountedAt.current = Date.now();
 }, []);

 useAdminSocketEvents({
 invalidate: (payload: { resource?: LiveResource }) => {
 if (payload?.resource && key.split('|').includes(payload.resource)) reload();
 },
 connect: () => {
 if (Date.now() - mountedAt.current > INITIAL_CONNECT_GRACE_MS) reload();
 },
 });

 useEffect(() => {
 const onVisible = () => {
 if (document.visibilityState === 'visible') reload();
 };
 document.addEventListener('visibilitychange', onVisible);
 return () => document.removeEventListener('visibilitychange', onVisible);
 }, [reload]);
}

/** Variante para pantallas con React Query: invalida en vez de llamar a `load`. */
export function useLiveInvalidate(resources: LiveResource[], queryKey: QueryKey): void {
 const qc = useQueryClient();
 const keyRef = useRef(queryKey);
 useEffect(() => {
 keyRef.current = queryKey;
 });
 useLiveReload(resources, () => {
 void qc.invalidateQueries({ queryKey: keyRef.current });
 });
}
