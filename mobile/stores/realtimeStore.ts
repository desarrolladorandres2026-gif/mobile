import { create } from 'zustand';

/**
 * Si el canal en vivo está arriba.
 *
 * Lo escribe un solo sitio —`useRealtimeOwner`, montado una vez en la raíz—
 * y lo leen todas las pantallas. También lo consulta el sondeo de los
 * pedidos: con el socket conectado, preguntar cada 20 s es redundante.
 *
 * Arranca en `true`: "todavía negociando" no es "sin conexión", y
 * empezar en `false` haría parpadear el aviso en cada arranque.
 */
interface RealtimeState {
  connected: boolean;
  setConnected: (connected: boolean) => void;
}

export const useRealtimeStore = create<RealtimeState>((set) => ({
  connected: true,
  setConnected: (connected) => set({ connected }),
}));

/** Intervalo de sondeo según haya socket o no: la red de seguridad se afloja cuando hay canal. */
export function pollInterval(withSocketMs: number, withoutSocketMs: number): number {
  return useRealtimeStore.getState().connected ? withSocketMs : withoutSocketMs;
}
