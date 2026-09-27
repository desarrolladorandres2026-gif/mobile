import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * La vista previa: la pantalla Explorar de la app de verdad (`mobile/`
 * compilada a web, ruta `/preview/explore`) dentro de un marco de teléfono.
 *
 * El panel resuelve el borrador con su propia sesión y le manda al iframe
 * las secciones ya resueltas por `postMessage`, siempre con el origen del
 * iframe como destino. El iframe no llama a la API ni ve ningún token.
 *
 * `VITE_PREVIEW_URL` apunta a esa ruta: en desarrollo es el Metro de
 * `mobile/` (`npm start` sirve la web en el 8081); en producción, la PWA que
 * sirve el backend.
 */

const PREVIEW_URL = (import.meta.env.VITE_PREVIEW_URL as string | undefined)?.trim()
 || 'http://localhost:8081/preview/explore';

const MESSAGE = {
 ready: 'zipp-explore-preview:ready',
 sections: 'zipp-explore-preview:sections',
} as const;

/** Si el iframe no saluda en este tiempo, se explica por qué en vez de dejar un marco en blanco. */
const READY_TIMEOUT_MS = 10_000;

export function PhonePreview({ sections, loading, large = false }: {
 sections: unknown[] | null;
 loading: boolean;
 large?: boolean;
}) {
 const frame = useRef<HTMLIFrameElement>(null);
 const [ready, setReady] = useState(false);
 const [timedOut, setTimedOut] = useState(false);
 const targetOrigin = useMemo(() => {
 try { return new URL(PREVIEW_URL).origin; } catch { return ''; }
 }, []);

 useEffect(() => {
 const onMessage = (event: MessageEvent) => {
 if (event.origin !== targetOrigin || event.source !== frame.current?.contentWindow) return;
 if ((event.data as { type?: string } | null)?.type === MESSAGE.ready) setReady(true);
 };
 window.addEventListener('message', onMessage);
 // Se muestra solo si el saludo nunca llegó: `ready` gana al pintar.
 const timer = window.setTimeout(() => setTimedOut(true), READY_TIMEOUT_MS);
 return () => {
 window.removeEventListener('message', onMessage);
 window.clearTimeout(timer);
 };
 }, [targetOrigin]);

 useEffect(() => {
 if (!ready || !sections || !targetOrigin) return;
 frame.current?.contentWindow?.postMessage({ type: MESSAGE.sections, sections }, targetOrigin);
 }, [ready, sections, targetOrigin]);

 const width = large ? 390 : 340;
 const height = large ? 800 : 700;

 return (
 <div className="flex flex-col items-center gap-3">
 <div
 className="relative rounded-[2.75rem] border border-[var(--color-border)] p-2.5"
 style={{ width: width + 20 }}
 >
 <iframe
 ref={frame}
 src={PREVIEW_URL}
 title="Vista previa de Explorar"
 className="block rounded-[2.25rem]"
 style={{ width, height, border: 0 }}
 // Sin permisos de más: scripts y mismo origen del iframe (para su
 // propio almacenamiento), nada de navegar el panel ni abrir ventanas.
 sandbox="allow-scripts allow-same-origin"
 />
 </div>
 <p className="text-[11px] text-[var(--color-text-main)] h-4">
 {timedOut && !ready
 ? 'No abre la vista previa: arranca la web de mobile (npm start) o revisa VITE_PREVIEW_URL.'
 : loading
 ? 'Actualizando…'
 : ready
 ? 'Así se verá Explorar. Nada de esto está publicado.'
 : 'Abriendo la vista previa…'}
 </p>
 </div>
 );
}
