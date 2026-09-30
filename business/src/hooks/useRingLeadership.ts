import { useEffect, useState, useSyncExternalStore } from 'react';
import { audioState, primeNotificationSound, subscribeAudioState, type AudioStatus } from '../lib/notificationSound';

/** Estado del audio del navegador: `suspended` hasta que alguien interactúa. */
export function useAudioState(): AudioStatus {
  return useSyncExternalStore(subscribeAudioState, audioState, () => 'suspended' as const);
}

/**
 * Desbloquea el audio con el primer gesto de la persona, sea cual sea.
 *
 * No es `{ once: true }`: un gesto que el navegador no cuenta como
 * activación (un `pointerdown` táctil, por ejemplo) no lo desbloquea, y el
 * siguiente tiene que poder intentarlo. Se quita solo cuando ya suena.
 */
export function useAudioUnlock(status: AudioStatus) {
  useEffect(() => {
    if (status !== 'suspended') return;
    const unlock = () => primeNotificationSound();
    const events = ['pointerdown', 'pointerup', 'keydown'] as const;
    events.forEach((name) => window.addEventListener(name, unlock, true));
    return () => events.forEach((name) => window.removeEventListener(name, unlock, true));
  }, [status]);
}

/**
 * ¿Es esta pestaña la que hace sonar el timbre?
 *
 * Con dos pestañas abiertas del panel, las dos verían el mismo pedido y las
 * dos tocarían el timbre, una encima de la otra. Un candado de Web Locks
 * (por local) deja que suene una sola por navegador; si esa pestaña se
 * cierra, el candado pasa a la siguiente. Solo compiten las pestañas con el
 * audio ya desbloqueado (`eligible`): una pestaña muda no puede quedarse
 * con el candado y dejar la cocina en silencio.
 *
 * Sin Web Locks (http en red local) cada pestaña suena por su cuenta.
 */
export function useRingLeadership(businessId: string | undefined, eligible: boolean): boolean {
  const [leader, setLeader] = useState(false);
  const hasLocks = typeof navigator !== 'undefined' && !!navigator.locks;

  useEffect(() => {
    if (!hasLocks || !businessId || !eligible) return;
    const controller = new AbortController();
    let release: (() => void) | undefined;

    navigator.locks
      .request(`zipp-business-ring:${businessId}`, { signal: controller.signal }, () => {
        setLeader(true);
        // El candado se sostiene hasta que esta pestaña deje de ser elegible
        // o se cierre.
        return new Promise<void>((resolve) => { release = resolve; });
      })
      .catch(() => { /* AbortError: se salió de la cola antes de conseguirlo */ });

    return () => {
      controller.abort();
      release?.();
      setLeader(false);
    };
  }, [hasLocks, businessId, eligible]);

  return hasLocks ? leader && eligible : eligible;
}
